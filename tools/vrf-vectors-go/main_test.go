package main

import (
	"bytes"
	"math/big"
	"os"
	"testing"

	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey/secp256k1"
	"go.dedis.ch/kyber/v3"
)

func TestVectorsCoverMultiTryHashToCurve(t *testing.T) {
	file := mustGenerate(t)
	seen := map[int]bool{}
	for _, v := range file.Vectors {
		seen[v.HashToCurveTries] = true
	}
	for tries := 1; tries <= maxTries; tries++ {
		if !seen[tries] {
			t.Errorf("no vector needs exactly %d hash-to-curve tries", tries)
		}
	}
}

func TestEveryVectorVerifiesUnderVRFKey(t *testing.T) {
	for _, v := range mustGenerate(t).Vectors {
		pk, err := toPoint(v.Proof.PK)
		if err != nil {
			t.Fatalf("%s: pk: %v", v.Name, err)
		}
		gamma, err := toPoint(v.Proof.Gamma)
		if err != nil {
			t.Fatalf("%s: gamma: %v", v.Name, err)
		}
		p := vrfkey.Proof{
			PublicKey: pk,
			Gamma:     gamma,
			C:         toInt(v.Proof.C),
			S:         toInt(v.Proof.S),
			Seed:      toInt(v.Proof.Seed),
			Output:    toInt(v.Output),
		}
		ok, err := p.VerifyVRFProof()
		if err != nil || !ok {
			t.Errorf("%s: vrfkey rejects the vector (ok=%v, err=%v)", v.Name, ok, err)
		}
	}
}

func TestCommittedFileIsUpToDate(t *testing.T) {
	committed, err := os.ReadFile(defaultOut)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := render(mustGenerate(t))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(committed, fresh) {
		t.Errorf("%s is stale; run `go run .`", defaultOut)
	}
}

func mustGenerate(t *testing.T) File {
	t.Helper()
	file, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	return file
}

// toPoint decodes an (x, y) coordinate pair.
func toPoint(xy [2]Hex) (kyber.Point, error) {
	return secp256k1.LongUnmarshal(append(word(xy[0]), word(xy[1])...))
}

func toInt(h Hex) *big.Int {
	return new(big.Int).SetBytes(word(h))
}

func word(h Hex) []byte {
	b, err := h.Bytes()
	if err != nil {
		panic(err)
	}
	return b
}
