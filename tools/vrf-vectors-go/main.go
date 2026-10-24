// Command vrf-vectors-go writes the secp256k1 ECVRF proof vectors that the
// contracts and the worker test against.
//
// Proofs come from Chainlink's own Go implementation (vrfkey), so a match in
// VRF.sol shows that the vendored verifier and the off-chain prover agree. The
// witnesses VRF.sol needs (uWitness, cGammaWitness, sHashWitness, zInv) are
// computed the same way as Chainlink core's SolidityPrecalculations.
//
// Everything is derived from fixed labels, so the output is deterministic and
// CI can regenerate it and fail on any diff. These keys are public test keys.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey/secp256k1"
	"go.dedis.ch/kyber/v3"
)

const (
	// maxTries is the largest hash-to-curve try count we need a vector for.
	maxTries = 5
	// keys is how many secret keys the vectors use.
	keys = 3
	// defaultOut is the committed vector file, relative to this directory.
	defaultOut = "vrf-proofs.json"
)

// Hex is a 0x-prefixed, 32-byte big-endian word (or a 20-byte address).
type Hex string

func hexWord(n *big.Int) Hex {
	return Hex(fmt.Sprintf("0x%064x", n))
}

func point(p kyber.Point) [2]Hex {
	x, y := secp256k1.Coordinates(p)
	return [2]Hex{hexWord(x), hexWord(y)}
}

// Bytes decodes the hex string.
func (h Hex) Bytes() ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(string(h), "0x"))
}

// File is the vector file.
type File struct {
	Comment string   `json:"comment"`
	Vectors []Vector `json:"vectors"`
}

// Vector is one proof, laid out like VRF.sol's Proof struct.
type Vector struct {
	Name             string `json:"name"`
	SecretKey        Hex    `json:"secretKey"`
	Nonce            Hex    `json:"nonce"`
	HashToCurveTries int    `json:"hashToCurveTries"`
	Hash             [2]Hex `json:"hash"`
	Proof            Proof  `json:"proof"`
	Output           Hex    `json:"output"`
}

// Proof mirrors VRF.Proof field for field.
type Proof struct {
	PK            [2]Hex `json:"pk"`
	Gamma         [2]Hex `json:"gamma"`
	C             Hex    `json:"c"`
	S             Hex    `json:"s"`
	Seed          Hex    `json:"seed"`
	UWitness      Hex    `json:"uWitness"`
	CGammaWitness [2]Hex `json:"cGammaWitness"`
	SHashWitness  [2]Hex `json:"sHashWitness"`
	ZInv          Hex    `json:"zInv"`
}

func label(parts ...[]byte) *big.Int {
	return new(big.Int).SetBytes(crypto.Keccak256(parts...))
}

func be32(n *big.Int) []byte {
	b := make([]byte, 32)
	return n.FillBytes(b)
}

func secretKey(k int) *big.Int {
	sk := label([]byte("rsk-vrf/vrf-vectors/secret-key"), be32(big.NewInt(int64(k))))
	return sk.Mod(sk, secp256k1.GroupOrder)
}

func publicKey(sk *big.Int) kyber.Point {
	return vrfkey.Secp256k1Curve.Point().Mul(secp256k1.IntToScalar(sk), nil)
}

// tries counts the candidate x-ordinates hash-to-curve tests for (pk, seed).
func tries(pk kyber.Point, seed *big.Int) (int, kyber.Point, error) {
	n := 0
	h, err := vrfkey.HashToCurve(pk, seed, func(*big.Int) { n++ })
	return n, h, err
}

// seedNeeding walks a fixed keccak chain until it finds a seed whose
// hash-to-curve needs exactly want tries.
func seedNeeding(pk kyber.Point, want int) (*big.Int, error) {
	for i := int64(0); i < 1<<20; i++ {
		seed := label([]byte("rsk-vrf/vrf-vectors/seed"), be32(big.NewInt(i)))
		n, _, err := tries(pk, seed)
		if err != nil {
			return nil, err
		}
		if n == want {
			return seed, nil
		}
	}
	return nil, fmt.Errorf("no seed needs %d tries", want)
}

func prove(name string, sk, seed *big.Int) (Vector, error) {
	key := vrfkey.MustNewV2XXXTestingOnly(sk)
	nonce := label([]byte("rsk-vrf/vrf-vectors/nonce"), be32(sk), be32(seed))
	nonce.Mod(nonce, secp256k1.GroupOrder)
	var p vrfkey.Proof
	for {
		var err error
		p, err = key.GenerateProofWithNonce(seed, nonce)
		if errors.Is(err, vrfkey.ErrCGammaEqualsSHash) {
			nonce = label(be32(nonce))
			nonce.Mod(nonce, secp256k1.GroupOrder)
			continue
		}
		if err != nil {
			return Vector{}, fmt.Errorf("%s: %w", name, err)
		}
		break
	}

	n, h, err := tries(p.PublicKey, seed)
	if err != nil {
		return Vector{}, fmt.Errorf("%s: %w", name, err)
	}

	// Chainlink core's SolidityPrecalculations.
	newPoint := vrfkey.Secp256k1Curve.Point
	c := secp256k1.IntToScalar(p.C)
	s := secp256k1.IntToScalar(p.S)
	u := newPoint().Add(newPoint().Mul(c, p.PublicKey), newPoint().Mul(s, vrfkey.Generator))
	uWitness := secp256k1.EthereumAddress(u)
	cGammaWitness := newPoint().Mul(c, p.Gamma)
	sHashWitness := newPoint().Mul(s, h)
	_, _, z := vrfkey.ProjectiveECAdd(cGammaWitness, sHashWitness)
	zInv := new(big.Int).ModInverse(z, vrfkey.FieldSize)

	return Vector{
		Name:             name,
		SecretKey:        hexWord(sk),
		Nonce:            hexWord(nonce),
		HashToCurveTries: n,
		Hash:             point(h),
		Proof: Proof{
			PK:            point(p.PublicKey),
			Gamma:         point(p.Gamma),
			C:             hexWord(p.C),
			S:             hexWord(p.S),
			Seed:          hexWord(seed),
			UWitness:      Hex("0x" + hex.EncodeToString(uWitness[:])),
			CGammaWitness: point(cGammaWitness),
			SHashWitness:  point(sHashWitness),
			ZInv:          hexWord(zInv),
		},
		Output: hexWord(p.Output),
	}, nil
}

// Generate builds the full vector set.
func Generate() (File, error) {
	file := File{Comment: "Generated by tools/vrf-vectors-go; do not edit. Test keys only."}
	add := func(name string, sk, seed *big.Int) error {
		v, err := prove(name, sk, seed)
		if err == nil {
			file.Vectors = append(file.Vectors, v)
		}
		return err
	}

	sk0 := secretKey(0)
	maxSeed := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	edges := []struct {
		name string
		seed *big.Int
	}{
		{"key0-seed-zero", big.NewInt(0)},
		{"key0-seed-one", big.NewInt(1)},
		{"key0-seed-max", maxSeed},
	}
	for _, e := range edges {
		if err := add(e.name, sk0, e.seed); err != nil {
			return File{}, err
		}
	}
	for want := 1; want <= maxTries; want++ {
		seed, err := seedNeeding(publicKey(sk0), want)
		if err != nil {
			return File{}, err
		}
		if err := add(fmt.Sprintf("key0-tries-%d", want), sk0, seed); err != nil {
			return File{}, err
		}
	}
	for k := 1; k < keys; k++ {
		sk := secretKey(k)
		for want := 1; want <= 2; want++ {
			seed, err := seedNeeding(publicKey(sk), want)
			if err != nil {
				return File{}, err
			}
			if err := add(fmt.Sprintf("key%d-tries-%d", k, want), sk, seed); err != nil {
				return File{}, err
			}
		}
	}
	return file, nil
}

func render(f File) ([]byte, error) {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

func main() {
	out := flag.String("out", defaultOut, "where to write the vector file")
	flag.Parse()
	file, err := Generate()
	if err != nil {
		log.Fatal(err)
	}
	b, err := render(file)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wrote %d vectors to %s\n", len(file.Vectors), *out)
}
