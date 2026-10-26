package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http/httptest"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestRelayVerifiesPublishedProofAgainstRegisteredKey(t *testing.T) {
	v := mustGenerateCoordinator(t).Vectors[0]
	pk := append(word(v.VRF.Proof.PK[0]), word(v.VRF.Proof.PK[1])...)
	keyHash := Hex(fmt.Sprintf("0x%x", crypto.Keccak256(pk)))
	for _, tc := range []struct {
		name    string
		proof   Hex
		keyHash Hex
		alpha   Hex
		want    bool
	}{
		{"valid", v.VRF.ProofBytes, keyHash, v.Alpha, true},
		{"wrong registered key", v.VRF.ProofBytes, hexWord(big.NewInt(1)), v.Alpha, false},
		{"wrong alpha", v.VRF.ProofBytes, keyHash, hexWord(big.NewInt(1)), false},
		{"corrupted scalar", Hex(string(v.VRF.ProofBytes)[:322] + "0000000000000000000000000000000000000000000000000000000000000000" + string(v.VRF.ProofBytes)[386:]), keyHash, v.Alpha, false},
		{"malformed", "0x12", keyHash, v.Alpha, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]Hex{"proofBytes": tc.proof, "registeredKeyHash": tc.keyHash, "alpha": tc.alpha})
			if err != nil {
				t.Fatal(err)
			}
			out := httptest.NewRecorder()
			testRelayHandler().ServeHTTP(out, httptest.NewRequest("POST", "/verify", bytes.NewReader(body)))
			if out.Code != 200 {
				t.Fatalf("status %d: %s", out.Code, out.Body.String())
			}
			var result struct {
				Valid bool `json:"valid"`
				Beta  Hex  `json:"beta"`
			}
			if err := json.Unmarshal(out.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Valid != tc.want {
				t.Fatalf("valid=%v want %v", result.Valid, tc.want)
			}
			if tc.want && result.Beta != v.Beta {
				t.Fatalf("beta=%s want %s", result.Beta, v.Beta)
			}
		})
	}
}
