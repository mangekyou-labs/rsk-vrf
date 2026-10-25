package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestRelayMatchesCommittedGoldenRound(t *testing.T) {
	v := mustGenerateCoordinator(t).Vectors[0]
	url := fmt.Sprintf("/expected?chainId=%d&round=%d&coordinator=%s&requester=%s&requestId=%s&context=%s", v.ChainID, v.TargetRound, v.Coordinator, v.Requester, v.RequestID, v.Derivations[0].Context)
	out := httptest.NewRecorder()
	testRelayHandler().ServeHTTP(out, httptest.NewRequest("GET", url, nil))
	if out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	var got relayExpected
	if err := json.Unmarshal(out.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Alpha != v.Alpha || got.Beta != v.Beta || got.Random != v.Derivations[0].Random || got.ProofBytes != v.VRF.ProofBytes {
		t.Fatalf("relay diverged from golden vector: %+v", got)
	}
}
