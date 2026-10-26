package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey"
	"github.com/smartcontractkit/chainlink-common/keystore/corekeys/vrfkey/secp256k1"
)

// verifyPublishedProof checks the public ECVRF transcript with Chainlink's Go
// verifier, independently of the worker. This endpoint is test-relay-only.
// Solidity witness fields are checked separately by the real eth_call tests.
func verifyPublishedProof(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProofBytes        Hex `json:"proofBytes"`
		RegisteredKeyHash Hex `json:"registeredKeyHash"`
		Alpha             Hex `json:"alpha"`
	}
	valid := false
	var beta Hex
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16_384)).Decode(&input); err == nil {
		proof, proofErr := input.ProofBytes.Bytes()
		keyHash, keyErr := input.RegisteredKeyHash.Bytes()
		alpha, alphaErr := input.Alpha.Bytes()
		if proofErr == nil && keyErr == nil && alphaErr == nil && len(proof) == 416 && len(keyHash) == 32 && len(alpha) == 32 &&
			bytes.Equal(crypto.Keccak256(proof[:64]), keyHash) && bytes.Equal(proof[192:224], alpha) {
			pk, pkErr := secp256k1.LongUnmarshal(proof[:64])
			gamma, gammaErr := secp256k1.LongUnmarshal(proof[64:128])
			if pkErr == nil && gammaErr == nil {
				output := crypto.Keccak256(be32(big.NewInt(3)), proof[64:128])
				transcript := vrfkey.Proof{
					PublicKey: pk, Gamma: gamma,
					C: new(big.Int).SetBytes(proof[128:160]), S: new(big.Int).SetBytes(proof[160:192]),
					Seed: new(big.Int).SetBytes(alpha), Output: new(big.Int).SetBytes(output),
				}
				ok, err := transcript.VerifyVRFProof()
				valid = err == nil && ok
				if valid {
					beta = Hex(fmt.Sprintf("0x%s", hex.EncodeToString(crypto.Keccak256(label("rsk-vrf/v1/beta"), output))))
				}
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Valid bool `json:"valid"`
		Beta  Hex  `json:"beta,omitempty"`
	}{valid, beta})
}
