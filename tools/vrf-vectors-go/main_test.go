package main

import (
	"bytes"
	"crypto/sha256"
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

// Known secp256k1 / HMAC-SHA256 RFC 6979 nonces (the widely used Bitcoin
// library vectors), where h1 = SHA-256(message) and h1 < n.
func TestKIsRFC6979OverSecretKeyAndSeed(t *testing.T) {
	n := secp256k1.GroupOrder
	cases := []struct {
		sk  *big.Int
		msg string
		k   string
	}{
		{big.NewInt(1), "Satoshi Nakamoto", "8f8a276c19f4149656b280621e358cce24f5f52542772691ee69063b74f15d15"},
		{big.NewInt(1), "All those moments will be lost in time, like tears in rain. Time to die...", "38aa22d72376b4dbc472e06c3ba403ee0a394da63fc58d88686c611aba98d6b3"},
		{new(big.Int).Sub(n, big.NewInt(1)), "Satoshi Nakamoto", "33a19b60e25fb6f4435af53a3d42d493644827367e6453928554f43e49aa6f90"},
	}
	for _, c := range cases {
		h := sha256.Sum256([]byte(c.msg))
		got := rfc6979K(c.sk, new(big.Int).SetBytes(h[:]), 0)
		if want := toInt(Hex("0x" + c.k)); got.Cmp(want) != 0 {
			t.Errorf("sk=%x %q: k = %x, want %x", c.sk, c.msg, got, want)
		}
	}
}

func TestEveryVectorUsesTheRFC6979K(t *testing.T) {
	for _, v := range mustGenerate(t).Vectors {
		if got, want := toInt(v.K), rfc6979K(toInt(v.SecretKey), toInt(v.Proof.Seed), 0); got.Cmp(want) != 0 {
			t.Errorf("%s: k = %x, want the first RFC 6979 candidate %x", v.Name, got, want)
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
