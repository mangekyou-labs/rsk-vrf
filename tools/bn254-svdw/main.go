// Generates BN254 hash-to-G1 vectors for drand evmnet rounds.
// The map is gnark-crypto bn254.MapToCurve1. expand_message_xmd is local
// Keccak-256 (RFC 9380); gnark's fp.Hash is SHA-256 XMD and is not the oracle.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"runtime/debug"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fp"
	"golang.org/x/crypto/sha3"
)

const (
	gnarkPath   = "github.com/consensys/gnark-crypto"
	gnarkCommit = "550a513d798df79d8324697332e085498285bb63"
	dstSVDW     = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_"
	xmdLen      = 96
	fieldL      = 48
)

var rounds = []uint64{1, 2, 1000, 10000000}

type roundPoint struct {
	Round uint64 `json:"round"`
	X     string `json:"x"`
	Y     string `json:"y"`
	XHex  string `json:"x_hex"`
	YHex  string `json:"y_hex"`
}

type vectorsFile struct {
	GnarkModule string       `json:"gnark_module"`
	Version     string       `json:"gnark_version"`
	Commit      string       `json:"gnark_commit"`
	Map         string       `json:"map"`
	DST         string       `json:"dst"`
	Message     string       `json:"message"`
	Rounds      []roundPoint `json:"rounds"`
}

func main() {
	version := gnarkVersion()
	dst := []byte(dstSVDW)
	out := vectorsFile{
		GnarkModule: gnarkPath,
		Version:     version,
		Commit:      gnarkCommit,
		Map:         "bn254.MapToCurve1",
		DST:         dstSVDW,
		Message:     "keccak256(uint64 big-endian round)",
	}
	for _, round := range rounds {
		msg := keccak256(roundBE(round))
		x, y := hashToG1(msg, dst)
		pt := roundPoint{
			Round: round,
			X:     x.String(),
			Y:     y.String(),
			XHex:  fmt.Sprintf("%064x", x),
			YHex:  fmt.Sprintf("%064x", y),
		}
		out.Rounds = append(out.Rounds, pt)
		fmt.Printf("round %d x %s y %s\n", round, pt.X, pt.Y)
		fmt.Printf("round %d x_hex %s y_hex %s\n", round, pt.XHex, pt.YHex)
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fatal(err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile("vectors.json", raw, 0o644); err != nil {
		fatal(err)
	}
}

func gnarkVersion() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		fatal(fmt.Errorf("no build info"))
	}
	for _, dep := range bi.Deps {
		if dep.Path == gnarkPath {
			if dep.Version == "" {
				fatal(fmt.Errorf("empty gnark-crypto version"))
			}
			return dep.Version
		}
	}
	fatal(fmt.Errorf("%s not in build info", gnarkPath))
	return ""
}

func roundBE(round uint64) []byte {
	var be [8]byte
	binary.BigEndian.PutUint64(be[:], round)
	return be[:]
}

func keccak256(msg []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write(msg)
	return h.Sum(nil)
}

// expandMessageXMD is RFC 9380 expand_message_xmd with H = Keccak-256
// (legacy padding, rate 136). n is the output length in bytes.
func expandMessageXMD(msg, dst []byte, n int) []byte {
	const bIn = 32
	ell := (n + bIn - 1) / bIn
	dstPrime := append(append([]byte{}, dst...), byte(len(dst)))
	h := sha3.NewLegacyKeccak256()
	_, _ = h.Write(make([]byte, 136))
	_, _ = h.Write(msg)
	_, _ = h.Write([]byte{byte(n >> 8), byte(n)})
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(dstPrime)
	b0 := h.Sum(nil)

	h.Reset()
	_, _ = h.Write(b0)
	_, _ = h.Write([]byte{1})
	_, _ = h.Write(dstPrime)
	bi := h.Sum(nil)
	out := append([]byte{}, bi...)
	for i := 2; i <= ell; i++ {
		xored := make([]byte, len(b0))
		for j := range b0 {
			xored[j] = b0[j] ^ bi[j]
		}
		h.Reset()
		_, _ = h.Write(xored)
		_, _ = h.Write([]byte{byte(i)})
		_, _ = h.Write(dstPrime)
		bi = h.Sum(nil)
		out = append(out, bi...)
	}
	return out[:n]
}

func hashToG1(msg, dst []byte) (*big.Int, *big.Int) {
	uniform := expandMessageXMD(msg, dst, xmdLen)
	var u0, u1 fp.Element
	u0.SetBigInt(new(big.Int).SetBytes(uniform[:fieldL]))
	u1.SetBigInt(new(big.Int).SetBytes(uniform[fieldL:]))
	p0 := bn254.MapToCurve1(&u0)
	p1 := bn254.MapToCurve1(&u1)
	var j0, j1 bn254.G1Jac
	j0.FromAffine(&p0)
	j1.FromAffine(&p1).AddAssign(&j0)
	var sum bn254.G1Affine
	sum.FromJacobian(&j1)
	return sum.X.BigInt(new(big.Int)), sum.Y.BigInt(new(big.Int))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
