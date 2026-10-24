package main

import (
	"bytes"
	"crypto/sha256"
	"math/big"
	"os"
	"testing"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey"
)

// The real drand evmnet hash-to-G1 output for round 1, taken from drand/kyber,
// gnark-crypto and a spec-derived Python port, all of which agree (see the
// BN254 hash-to-curve research note for issue #14).
func TestDrandHashMatchesEvmnetRound1(t *testing.T) {
	h, err := drandHash(1)
	if err != nil {
		t.Fatal(err)
	}
	wantX, _ := new(big.Int).SetString("3274388634597322850260789370149388140895047873973358019313287818327097230193", 10)
	wantY, _ := new(big.Int).SetString("10513082672822249208187315831936923759893212599696164836629308721715663163524", 10)
	if h.X.BigInt(new(big.Int)).Cmp(wantX) != 0 || h.Y.BigInt(new(big.Int)).Cmp(wantY) != 0 {
		t.Errorf("hash-to-G1 of round 1 = (%v, %v), want evmnet's (%v, %v)", h.X.String(), h.Y.String(), wantX, wantY)
	}
}

func TestDrandSignaturesVerifyUnderTestKey(t *testing.T) {
	file := mustGenerateCoordinator(t)
	pk := toG2(t, file.Drand.PublicKey)
	_, _, _, g2 := bn254.Generators()
	for _, v := range file.Vectors {
		sig := toG1(t, v.DrandSignature)
		h, err := drandHash(v.TargetRound)
		if err != nil {
			t.Fatal(err)
		}
		var negH bn254.G1Affine
		negH.Neg(&h)
		ok, err := bn254.PairingCheck([]bn254.G1Affine{sig, negH}, []bn254.G2Affine{g2, pk})
		if err != nil || !ok {
			t.Errorf("%s: drand signature for round %d does not verify (err=%v)", v.Name, v.TargetRound, err)
		}
		sigBytes := append(word(v.DrandSignature[0]), word(v.DrandSignature[1])...)
		if sum := sha256.Sum256(sigBytes); !bytes.Equal(sum[:], word(v.DrandRandomness)) {
			t.Errorf("%s: drandRandomness is not sha256(signature)", v.Name)
		}
	}
}

// Recomputes requestId, targetRound, Alpha, Beta and the derivations with
// go-ethereum's ABI encoder, independently of the generator's word packing.
func TestCoordinatorVectorsFollowTheSpecEncoding(t *testing.T) {
	ty := func(s string) abi.Type {
		typ, err := abi.NewType(s, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		return typ
	}
	encode := func(types []string, values ...any) []byte {
		args := abi.Arguments{}
		for _, s := range types {
			args = append(args, abi.Argument{Type: ty(s)})
		}
		b, err := args.Pack(values...)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	tag := func(s string) [32]byte { return crypto.Keccak256Hash([]byte(s)) }
	b32 := func(h Hex) [32]byte { return common.BytesToHash(word(h)) }

	file := mustGenerateCoordinator(t)
	for _, v := range file.Vectors {
		coordinator := common.HexToAddress(string(v.Coordinator))
		requester := common.HexToAddress(string(v.Requester))
		chainID := new(big.Int).SetUint64(v.ChainID)

		requestID := crypto.Keccak256(encode([]string{"uint256", "address", "address", "uint256", "bytes32"},
			chainID, coordinator, requester, new(big.Int).SetUint64(v.RequesterNonce), b32(v.Tag)))
		if !bytes.Equal(requestID, word(v.RequestID)) {
			t.Errorf("%s: requestId", v.Name)
		}

		round := (v.RequestTimestamp-file.Drand.Genesis)/file.Drand.Period + 1 + v.RoundOffset
		if round != v.TargetRound {
			t.Errorf("%s: targetRound %d, want %d", v.Name, v.TargetRound, round)
		}

		alpha := crypto.Keccak256(encode([]string{"bytes32", "uint256", "address", "address", "bytes32", "uint64", "bytes32"},
			tag("rsk-vrf/v1/alpha"), chainID, coordinator, requester, b32(v.RequestID), v.TargetRound, b32(v.DrandRandomness)))
		if !bytes.Equal(alpha, word(v.Alpha)) {
			t.Errorf("%s: alpha", v.Name)
		}
		if !bytes.Equal(word(v.VRF.Proof.Seed), alpha) {
			t.Errorf("%s: the proof is not over alpha", v.Name)
		}

		beta := crypto.Keccak256(encode([]string{"bytes32", "uint256"}, tag("rsk-vrf/v1/beta"), toInt(v.VRF.Output)))
		if !bytes.Equal(beta, word(v.Beta)) {
			t.Errorf("%s: beta", v.Name)
		}

		if len(v.Derivations) == 0 {
			t.Errorf("%s: no derivations", v.Name)
		}
		for _, d := range v.Derivations {
			got := crypto.Keccak256(encode([]string{"bytes32", "bytes32", "bytes32"}, tag("rsk-vrf/v1/derive"), b32(d.Context), b32(v.Beta)))
			if !bytes.Equal(got, word(d.RandomBytes)) {
				t.Errorf("%s: deriveRandomBytes for context %s", v.Name, d.Context)
			}
			if new(big.Int).SetBytes(got).Cmp(toInt(d.Random)) != 0 {
				t.Errorf("%s: deriveRandom for context %s", v.Name, d.Context)
			}
		}
	}
}

func TestCoordinatorProofsVerifyUnderVRFKey(t *testing.T) {
	for _, v := range mustGenerateCoordinator(t).Vectors {
		pk, err := toPoint(v.VRF.Proof.PK)
		if err != nil {
			t.Fatal(err)
		}
		gamma, err := toPoint(v.VRF.Proof.Gamma)
		if err != nil {
			t.Fatal(err)
		}
		p := vrfkey.Proof{PublicKey: pk, Gamma: gamma, C: toInt(v.VRF.Proof.C), S: toInt(v.VRF.Proof.S), Seed: toInt(v.Alpha), Output: toInt(v.VRF.Output)}
		if ok, err := p.VerifyVRFProof(); err != nil || !ok {
			t.Errorf("%s: vrfkey rejects the proof over alpha (ok=%v, err=%v)", v.Name, ok, err)
		}
	}
}

func TestVectorsHaveDistinctTargetRounds(t *testing.T) {
	seen := map[uint64]bool{}
	for _, v := range mustGenerateCoordinator(t).Vectors {
		if seen[v.TargetRound] {
			t.Errorf("target round %d repeats; the mismatched-round tests need distinct rounds", v.TargetRound)
		}
		seen[v.TargetRound] = true
	}
}

func TestCommittedCoordinatorFileIsUpToDate(t *testing.T) {
	committed, err := os.ReadFile(coordinatorOut)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := renderJSON(mustGenerateCoordinator(t))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(committed, fresh) {
		t.Errorf("%s is stale; run `go run .`", coordinatorOut)
	}
}

func mustGenerateCoordinator(t *testing.T) CoordinatorFile {
	t.Helper()
	file, err := GenerateCoordinator()
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func toG1(t *testing.T, xy [2]Hex) bn254.G1Affine {
	t.Helper()
	var p bn254.G1Affine
	p.X.SetBigInt(toInt(xy[0]))
	p.Y.SetBigInt(toInt(xy[1]))
	if !p.IsOnCurve() || !p.IsInSubGroup() {
		t.Fatalf("G1 point %v is not in G1", xy)
	}
	return p
}

// toG2 decodes BLS.sol's public key layout [x.re, x.im, y.re, y.im].
func toG2(t *testing.T, k [4]Hex) bn254.G2Affine {
	t.Helper()
	var p bn254.G2Affine
	p.X.A0.SetBigInt(toInt(k[0]))
	p.X.A1.SetBigInt(toInt(k[1]))
	p.Y.A0.SetBigInt(toInt(k[2]))
	p.Y.A1.SetBigInt(toInt(k[3]))
	if !p.IsOnCurve() || !p.IsInSubGroup() {
		t.Fatalf("G2 point %v is not in G2", k)
	}
	return p
}
