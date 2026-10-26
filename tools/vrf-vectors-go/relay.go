// Offline test beacon using the same public test key and independent Go prover
// as coordinator-vectors.json. Never configure this beacon in production.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/ethereum/go-ethereum/crypto"
)

type relayExpected struct {
	Alpha      Hex `json:"alpha"`
	Beta       Hex `json:"beta"`
	Random     Hex `json:"random"`
	ProofBytes Hex `json:"proofBytes"`
}

func testSignature(round uint64) ([2]Hex, error) {
	h, err := drandHash(round)
	if err != nil {
		return [2]Hex{}, err
	}
	sk, _ := drandKey()
	var sig bn254.G1Affine
	sig.ScalarMultiplication(&h, sk)
	return g1(sig), nil
}

func expectedRequest(r *http.Request) (relayExpected, error) {
	var out relayExpected
	q := r.URL.Query()
	chain, err := strconv.ParseUint(q.Get("chainId"), 10, 64)
	if err != nil {
		return out, err
	}
	round, err := strconv.ParseUint(q.Get("round"), 10, 64)
	if err != nil || round == 0 {
		return out, fmt.Errorf("invalid round")
	}
	fields := make([][]byte, 4)
	for i, name := range []string{"coordinator", "requester", "requestId", "context"} {
		b, e := hex.DecodeString(strings.TrimPrefix(q.Get(name), "0x"))
		size := 32
		if i < 2 {
			size = 20
		}
		if e != nil || len(b) != size {
			return out, fmt.Errorf("invalid %s", name)
		}
		fields[i] = b
	}
	sig, err := testSignature(round)
	if err != nil {
		return out, err
	}
	raw, _ := hex.DecodeString(strings.TrimPrefix(string(sig[0]), "0x") + strings.TrimPrefix(string(sig[1]), "0x"))
	randomness := sha256.Sum256(raw)
	alpha := crypto.Keccak256(label("rsk-vrf/v1/alpha"), u64(chain), leftPad(fields[0]), leftPad(fields[1]), fields[2], u64(round), randomness[:])
	v, err := prove("live-regtest", secretKey(0), new(big.Int).SetBytes(alpha))
	if err != nil {
		return out, err
	}
	output, _ := hex.DecodeString(strings.TrimPrefix(string(v.Output), "0x"))
	beta := crypto.Keccak256(label("rsk-vrf/v1/beta"), output)
	random := crypto.Keccak256(label("rsk-vrf/v1/derive"), fields[3], beta)
	return relayExpected{Hex(fmt.Sprintf("0x%x", alpha)), Hex(fmt.Sprintf("0x%x", beta)), Hex(fmt.Sprintf("0x%x", random)), v.ProofBytes}, nil
}

func testRelayHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /verify", verifyPublishedProof)
	mux.HandleFunc("GET /public/{round}", func(w http.ResponseWriter, r *http.Request) {
		round, err := strconv.ParseUint(r.PathValue("round"), 10, 64)
		if err != nil || round == 0 {
			http.Error(w, "invalid round", 400)
			return
		}
		sig, err := testSignature(round)
		if err != nil {
			http.Error(w, "signing failed", 500)
			return
		}
		raw, _ := hex.DecodeString(strings.TrimPrefix(string(sig[0]), "0x") + strings.TrimPrefix(string(sig[1]), "0x"))
		randomness := sha256.Sum256(raw)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"round": round, "signature": hex.EncodeToString(raw), "randomness": hex.EncodeToString(randomness[:])})
	})
	mux.HandleFunc("GET /expected", func(w http.ResponseWriter, r *http.Request) {
		out, err := expectedRequest(r)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})
	return mux
}

func serveTestRelay(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("test relay must bind a loopback IP")
	}
	server := http.Server{Addr: address, Handler: testRelayHandler(), ReadHeaderTimeout: 5 * time.Second}
	return server.ListenAndServe()
}
