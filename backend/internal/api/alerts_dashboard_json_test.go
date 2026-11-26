package api

import (
	"encoding/json"
	"testing"
)

func TestAlertsDashboardTrendBucketJSONContract(t *testing.T) {
	payload, err := json.Marshal(alertsDashboardTrendBucket{Date: "2026-08-11", Count: 3})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(payload) != `{"date":"2026-08-11","count":3}` {
		t.Fatalf("payload = %s", payload)
	}
}