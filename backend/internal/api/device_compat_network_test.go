package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"
)

// These are stored collector values, not generated IDs or live network probes.
// Keep the existing API's camelCase compute and snake_case network contract.
func TestDeviceCompatRemoteAndNetworkInventory(t *testing.T) {
	for _, tc := range []struct {
		name, stats string
		missing     bool
	}{
		{"linux-map", `{"eth0":{"mtu":0,"state":"UP","mac":"02:00:00:00:00:01","addresses":["192.0.2.10","2001:db8::10"],"rx_bytes":0}}`, false},
		{"macos-map", `{"en0":{"state":"UP","mac":"02:00:00:00:00:02","addresses":["192.0.2.11"],"hardware_port":"Wi-Fi"}}`, false},
		{"array", `[{"ifname":"eth0","addr_info":[{"local":"192.0.2.10"}],"stats64":{"rx":{"bytes":0}}},null]`, false},
		{"null", `null`, false},
		{"empty-map", `{}`, false},
		{"empty-array", `[]`, false},
		{"empty-columns", `null`, false},
		{"missing-rows", `null`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, mock, cleanup := newTestServer(t)
			defer cleanup()
			c, recorder := newTestContext(http.MethodGet, "/api/devices/asset-1", newTestClaims("admin", "user-1", "entity-1"))
			c.Params = gin.Params{{Key: "id", Value: "asset-1"}}
			fixtures := deviceDetailFixtures("entity-1", "user-1", "0.00", nil)
			fixtures[1].values[15], fixtures[1].values[16] = "001234567", "0"
			fixtures[2].values[0], fixtures[2].values[1], fixtures[2].values[2] = "192.0.2.10/24", "192.0.2.11", "100.64.0.10"
			fixtures[2].values[3], fixtures[2].values[4], fixtures[2].values[5] = "192.0.2.53, 192.0.2.54", "192.0.2.1", []byte(tc.stats)
			if tc.name == "empty-columns" {
				fixtures[1].values[6], fixtures[1].values[15], fixtures[1].values[16] = "", "", ""
				for i := 0; i < 5; i++ {
					fixtures[2].values[i] = ""
				}
				fixtures[2].values[5] = nil
			}
			if tc.missing {
				fixtures[1].values, fixtures[2].values = nil, nil
			}
			for _, fixture := range fixtures {
				expectDeviceDetailQuery(mock, fixture).WillReturnRows(fixture.rows()).RowsWillBeClosed()
			}
			server.getDeviceCompat(c)
			assertRouteResult(t, mock, recorder, http.StatusOK, "remote and network inventory")
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if tc.missing || tc.name == "empty-columns" {
				for _, key := range []string{"anydeskId", "rustdeskId", "macAddress", "lastSeenAt"} {
					if value, exists := body[key]; !exists || value != nil {
						t.Errorf("missing %s must remain null", key)
					}
				}
				network, ok := body["network"].(map[string]any)
				if !ok || (tc.missing && len(network) != 0) {
					t.Error("missing network row must remain empty")
				}
				for key, value := range network {
					if value != nil {
						t.Errorf("missing network %s must remain null", key)
					}
				}
				return
			}
			if body["anydeskId"] != "001234567" || body["rustdeskId"] != "0" || body["macAddress"] != "MAC" {
				t.Error("stored IDs/MAC must remain exact, including leading and literal zeros")
			}
			var stats any
			if err := json.Unmarshal([]byte(tc.stats), &stats); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"wired_ip": "192.0.2.10/24", "wireless_ip": "192.0.2.11", "netbird_ip": "100.64.0.10", "dns": "192.0.2.53, 192.0.2.54", "gateway": "192.0.2.1", "interface_stats": stats}
			if !reflect.DeepEqual(body["network"], want) {
				t.Error("stored network fields or collector shape lost")
			}
			if body["lastSeenAt"] != nil || body["connected"] != nil || body["connectivityCheckedAt"] != nil {
				t.Error("network inventory must not fabricate timestamps or live connectivity")
			}
		})
	}
}
