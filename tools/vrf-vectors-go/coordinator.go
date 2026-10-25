// Coordinator vectors: the golden request -> fulfill -> read trace for
// VRFCoordinator (issue #27).
//
// Each vector is one request: its requestId, Target Round, a drand signature
// for that round, the Alpha the coordinator derives from it, a VRF proof over
// that Alpha, the resulting Beta and a few derived random words. The contract
// tests replay these against the deployed coordinator, and the worker can use
// them as its own fixtures.
//
// The drand key is a local test key, not evmnet's: we need signatures for
// arbitrary rounds. The scheme is evmnet's (BLS on bn254, signature on G1,
// public key on G2, keccak256 message and hash-to-field), so the same contract
// code verifies the real beacon once the real key is configured (#34).
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math/big"
	"os"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fp"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/ethereum/go-ethereum/crypto"
)

const (
	// coordinatorOut is the committed coordinator vector file.
	coordinatorOut = "coordinator-vectors.json"

	// drandDST is the evmnet hash-to-G1 domain separation tag.
	drandDST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_"
	// evmnet's genesis time and period, in seconds.
	drandGenesis = 1727521075
	drandPeriod  = 3
	// roundOffset is the coordinator's default Target Round offset.
	roundOffset = 40
	// chainID is Rootstock testnet's; the vectors bind to it.
	chainID = 31
)

// CoordinatorFile is the coordinator vector file.
type CoordinatorFile struct {
	Comment string          `json:"comment"`
	Domains Domains         `json:"domains"`
	Drand   DrandConfig     `json:"drand"`
	Vectors []RequestVector `json:"vectors"`
}

// Domains are the domain separation tags, keccak256 of their labels.
type Domains struct {
	Alpha  Hex `json:"alpha"`
	Beta   Hex `json:"beta"`
	Derive Hex `json:"derive"`
}

// DrandConfig is the test beacon. PublicKey uses BLS.sol's G2 layout
// [x.re, x.im, y.re, y.im].
type DrandConfig struct {
	SecretKey Hex    `json:"secretKey"`
	PublicKey [4]Hex `json:"publicKey"`
	Genesis   uint64 `json:"genesis"`
	Period    uint64 `json:"period"`
	DST       string `json:"dst"`
}

// RequestVector is one request's full trace.
type RequestVector struct {
	Name             string       `json:"name"`
	ChainID          uint64       `json:"chainId"`
	Coordinator      Hex          `json:"coordinator"`
	Requester        Hex          `json:"requester"`
	RequesterNonce   uint64       `json:"requesterNonce"`
	Tag              Hex          `json:"tag"`
	RequestTimestamp uint64       `json:"requestTimestamp"`
	RoundOffset      uint64       `json:"roundOffset"`
	TargetRound      uint64       `json:"targetRound"`
	RequestID        Hex          `json:"requestId"`
	DrandSignature   [2]Hex       `json:"drandSignature"`
	DrandRandomness  Hex          `json:"drandRandomness"`
	Alpha            Hex          `json:"alpha"`
	VRF              Vector       `json:"vrf"`
	Beta             Hex          `json:"beta"`
	Derivations      []Derivation `json:"derivations"`
}

// Derivation is one deriveRandomBytes / deriveRandom result.
type Derivation struct {
	Context     Hex `json:"context"`
	RandomBytes Hex `json:"randomBytes"`
	Random      Hex `json:"random"`
}

func label(s string) []byte { return crypto.Keccak256([]byte(s)) }

func address(s string) Hex {
	return Hex(fmt.Sprintf("0x%x", label(s)[12:]))
}

func u64(n uint64) []byte { return be32(new(big.Int).SetUint64(n)) }

// drandHash is evmnet's message hash for a round: hash-to-G1 of
// keccak256(uint64_be(round)), with keccak256 expand_message_xmd (RFC 9380
// 5.3.1) and SvdW, as BLS.sol's hashToPoint computes it.
func drandHash(round uint64) (bn254.G1Affine, error) {
	var r [8]byte
	for i := range 8 {
		r[7-i] = byte(round >> (8 * i))
	}
	msg := crypto.Keccak256(r[:])
	uniform := expandMsgXMDKeccak([]byte(drandDST), msg, 96)
	var u [2]fp.Element
	for i := range u {
		n := new(big.Int).SetBytes(uniform[48*i : 48*(i+1)])
		u[i].SetBigInt(n.Mod(n, fp.Modulus()))
	}
	p0, p1 := bn254.MapToG1(u[0]), bn254.MapToG1(u[1])
	var sum bn254.G1Jac
	sum.FromAffine(&p0)
	sum.AddMixed(&p1)
	var h bn254.G1Affine
	h.FromJacobian(&sum)
	if !h.IsOnCurve() {
		return h, fmt.Errorf("hash of round %d is off the curve", round)
	}
	return h, nil
}

// expandMsgXMDKeccak is RFC 9380 expand_message_xmd with H = keccak256
// (b_in_bytes 32, s_in_bytes 136).
func expandMsgXMDKeccak(dst, msg []byte, n int) []byte {
	dstPrime := append(append([]byte{}, dst...), byte(len(dst)))
	b0 := crypto.Keccak256(make([]byte, 136), msg, []byte{byte(n >> 8), byte(n), 0}, dstPrime)
	out := make([]byte, 0, n)
	bi := crypto.Keccak256(b0, []byte{1}, dstPrime)
	out = append(out, bi...)
	for i := 2; len(out) < n; i++ {
		x := make([]byte, 32)
		for j := range x {
			x[j] = b0[j] ^ bi[j]
		}
		bi = crypto.Keccak256(x, []byte{byte(i)}, dstPrime)
		out = append(out, bi...)
	}
	return out[:n]
}

func g1(p bn254.G1Affine) [2]Hex {
	return [2]Hex{hexWord(p.X.BigInt(new(big.Int))), hexWord(p.Y.BigInt(new(big.Int)))}
}

func drandKey() (*big.Int, bn254.G2Affine) {
	sk := new(big.Int).SetBytes(label("rsk-vrf/coordinator-vectors/drand-secret-key"))
	sk.Mod(sk, fr.Modulus())
	var pk bn254.G2Affine
	pk.ScalarMultiplicationBase(sk)
	return sk, pk
}

// GenerateCoordinator builds the coordinator vector set.
func GenerateCoordinator() (CoordinatorFile, error) {
	drandSK, drandPK := drandKey()
	domains := Domains{
		Alpha:  Hex(fmt.Sprintf("0x%x", label("rsk-vrf/v1/alpha"))),
		Beta:   Hex(fmt.Sprintf("0x%x", label("rsk-vrf/v1/beta"))),
		Derive: Hex(fmt.Sprintf("0x%x", label("rsk-vrf/v1/derive"))),
	}
	file := CoordinatorFile{
		Comment: "Generated by tools/vrf-vectors-go; do not edit. Test keys only; the drand key is not evmnet's.",
		Domains: domains,
		Drand: DrandConfig{
			SecretKey: hexWord(drandSK),
			PublicKey: [4]Hex{
				hexWord(drandPK.X.A0.BigInt(new(big.Int))),
				hexWord(drandPK.X.A1.BigInt(new(big.Int))),
				hexWord(drandPK.Y.A0.BigInt(new(big.Int))),
				hexWord(drandPK.Y.A1.BigInt(new(big.Int))),
			},
			Genesis: drandGenesis,
			Period:  drandPeriod,
			DST:     drandDST,
		},
	}

	coordinator := address("rsk-vrf/coordinator-vectors/coordinator")
	alice := address("rsk-vrf/coordinator-vectors/requester-a")
	bob := address("rsk-vrf/coordinator-vectors/requester-b")
	// Requests in on-chain order, so each requester's nonce counts up from 0.
	requests := []struct {
		name      string
		requester Hex
		nonce     uint64
		tag       []byte
		timestamp uint64
	}{
		{"requester-a-first", alice, 0, make([]byte, 32), 1760000000},
		{"requester-a-second", alice, 1, label("rsk-vrf/coordinator-vectors/tag/lottery"), 1760000007},
		{"requester-b-first", bob, 0, label("rsk-vrf/coordinator-vectors/tag/dice"), 1760000100},
	}
	contexts := [][]byte{make([]byte, 32), label("rsk-vrf/coordinator-vectors/context/1")}

	for _, r := range requests {
		coord, _ := coordinator.Bytes()
		req, _ := r.requester.Bytes()
		requestID := crypto.Keccak256(u64(chainID), leftPad(coord), leftPad(req), u64(r.nonce), r.tag)
		targetRound := (r.timestamp-drandGenesis)/drandPeriod + 1 + roundOffset

		h, err := drandHash(targetRound)
		if err != nil {
			return CoordinatorFile{}, err
		}
		var sig bn254.G1Affine
		sig.ScalarMultiplication(&h, drandSK)
		sigXY := g1(sig)
		sigX, _ := sigXY[0].Bytes()
		sigY, _ := sigXY[1].Bytes()
		randomness := sha256.Sum256(append(sigX, sigY...))

		alphaDomain, _ := domains.Alpha.Bytes()
		alpha := keccakInt(alphaDomain, u64(chainID), leftPad(coord), leftPad(req), requestID, u64(targetRound), randomness[:])

		proof, err := prove(r.name, secretKey(0), alpha)
		if err != nil {
			return CoordinatorFile{}, err
		}
		betaDomain, _ := domains.Beta.Bytes()
		output, _ := proof.Output.Bytes()
		beta := crypto.Keccak256(betaDomain, output)

		deriveDomain, _ := domains.Derive.Bytes()
		var derivations []Derivation
		for _, ctx := range contexts {
			rb := crypto.Keccak256(deriveDomain, ctx, beta)
			derivations = append(derivations, Derivation{
				Context:     Hex(fmt.Sprintf("0x%x", ctx)),
				RandomBytes: Hex(fmt.Sprintf("0x%x", rb)),
				Random:      Hex(fmt.Sprintf("0x%x", rb)),
			})
		}

		file.Vectors = append(file.Vectors, RequestVector{
			Name:             r.name,
			ChainID:          chainID,
			Coordinator:      coordinator,
			Requester:        r.requester,
			RequesterNonce:   r.nonce,
			Tag:              Hex(fmt.Sprintf("0x%x", r.tag)),
			RequestTimestamp: r.timestamp,
			RoundOffset:      roundOffset,
			TargetRound:      targetRound,
			RequestID:        Hex(fmt.Sprintf("0x%x", requestID)),
			DrandSignature:   sigXY,
			DrandRandomness:  Hex(fmt.Sprintf("0x%x", randomness)),
			Alpha:            hexWord(alpha),
			VRF:              proof,
			Beta:             Hex(fmt.Sprintf("0x%x", beta)),
			Derivations:      derivations,
		})
	}
	return file, nil
}

func leftPad(b []byte) []byte {
	return append(make([]byte, 32-len(b)), b...)
}

func writeCoordinator() error {
	file, err := GenerateCoordinator()
	if err != nil {
		return err
	}
	b, err := renderJSON(file)
	if err != nil {
		return err
	}
	if err := os.WriteFile(coordinatorOut, b, 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %d vectors to %s\n", len(file.Vectors), coordinatorOut)
	return nil
}

func renderJSON(v any) ([]byte, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
