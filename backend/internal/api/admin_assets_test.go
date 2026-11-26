package api

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gin-gonic/gin"
	"github.com/lib/pq"
)

const adminTestEntity = "10000000-0000-0000-0000-000000000001"
const adminTestOther = "20000000-0000-0000-0000-000000000002"
const adminTestAsset = "30000000-0000-0000-0000-000000000003"
const adminTestUser = "40000000-0000-0000-0000-000000000004"
const adminTestCreate = `{"entityId":"` + adminTestEntity + `","assetTag":"PC-1","name":"Manual computer","category":"desktop"}`

var adminTestIP atomic.Uint32

func adminRoute(t *testing.T, role, method, target, body string) (sqlmock.Sqlmock, *httptest.ResponseRecorder, http.Handler, *http.Request, func()) {
	t.Helper()
	previousMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(previousMode) })
	mock, rec, router, req, cleanup := newRoleRouteRequest(t, role, adminTestUser, adminTestEntity, method, target, body)
	// The production limiter is process-global; never consume another test's IP.
	n := adminTestIP.Add(1)
	req.RemoteAddr = fmt.Sprintf("198.19.%d.%d:1234", n/250, n%250+1)
	if role == "" {
		req.Header.Del("Authorization")
	}
	return mock, rec, router, req, cleanup
}

func adminFixture() map[string]any {
	result := map[string]any{"id": adminTestAsset, "isCompute": true, "warrantyUntil": nil}
	for _, field := range adminAssetFields {
		result[field.key] = nil
	}
	result["entityId"], result["assetTag"], result["name"] = adminTestEntity, "PC-1", "Manual computer"
	result["category"], result["status"] = "desktop", "in_use"
	return result
}

func expectAdminLoad(mock sqlmock.Sqlmock, data map[string]any, lock bool) {
	query := adminAssetSelect() + " WHERE a.id = $1::uuid AND a.is_compute = TRUE"
	if lock {
		query += " FOR UPDATE OF a"
	}
	raw, _ := json.Marshal(data)
	mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs(adminTestAsset).
		WillReturnRows(sqlmock.NewRows([]string{"computer"}).AddRow(raw))
}

func expectAdminEntity(mock sqlmock.Sqlmock, valid bool) {
	mock.ExpectQuery(regexp.QuoteMeta("SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active)")).
		WithArgs(adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(valid))
}

func expectAdminCreateRow(mock sqlmock.Sqlmock) *sqlmock.ExpectedQuery {
	return mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO assets (entity_id, asset_tag, name, category, status, warranty_until, is_compute, manually_managed) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::date, TRUE, TRUE) RETURNING id::text")).
		WithArgs(adminTestEntity, "PC-1", "Manual computer", "desktop", "in_use", nil)
}

func expectAdminHistory(mock sqlmock.Sqlmock, action string) *sqlmock.ExpectedExec {
	return mock.ExpectExec(regexp.QuoteMeta("INSERT INTO asset_history (asset_id, actor_id, action, detail) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)")).
		WithArgs(adminTestAsset, adminTestUser, action, sqlmock.AnyArg())
}

func TestAdminAssetsRoleMatrix(t *testing.T) {
	for _, role := range []string{"", "employee", "auditor", "it_team", "technician", "Admin", "SUPER_ADMIN", "administrator", "admin", "super_admin"} {
		for _, route := range []struct{ method, path string }{
			{"GET", "/api/admin/assets"}, {"GET", "/api/admin/assets/options"},
			{"GET", "/api/admin/assets/" + adminTestAsset}, {"POST", "/api/admin/assets"},
			{"PATCH", "/api/admin/assets/" + adminTestAsset},
		} {
			t.Run(role+route.method+route.path, func(t *testing.T) {
				mock, rec, router, req, cleanup := adminRoute(t, role, route.method, route.path, `{}`)
				defer cleanup()
				want := http.StatusForbidden
				if role == "" {
					want = http.StatusUnauthorized
				} else if role == "admin" || isAdminRole(role) {
					want = http.StatusBadRequest
					if route.method == "GET" {
						want = http.StatusOK
						switch route.path {
						case "/api/admin/assets":
							mock.ExpectQuery("SELECT COUNT\\(\\*\\) FROM assets a WHERE a.is_compute = TRUE AND ").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
							mock.ExpectQuery("SELECT json_build_object.*LIMIT.*OFFSET").WillReturnRows(sqlmock.NewRows([]string{"computer"}))
						case "/api/admin/assets/options":
							for range 6 {
								mock.ExpectQuery("SELECT x.id::text,").WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))
							}
						default:
							expectAdminLoad(mock, adminFixture(), false)
						}
					}
				}
				router.ServeHTTP(rec, req)
				assertRouteResult(t, mock, rec, want, "admin role boundary")
			})
		}
	}
}

func TestAdminAssetsCreateAndSparsePatch(t *testing.T) {
	for _, role := range []string{"admin", "super_admin"} {
		t.Run(role+"/create", func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, role, "POST", "/api/admin/assets", adminTestCreate)
			defer cleanup()
			mock.ExpectBegin()
			expectAdminEntity(mock, true)
			expectAdminCreateRow(mock).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
			mock.ExpectExec("INSERT INTO asset_compute_details").WithArgs(adminTestAsset, nil, nil, false, false).WillReturnResult(sqlmock.NewResult(0, 1))
			expectAdminHistory(mock, "asset_created").WillReturnResult(sqlmock.NewResult(0, 1))
			expectAdminLoad(mock, adminFixture(), false)
			mock.ExpectCommit()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, http.StatusCreated, "admin create")
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["id"] != adminTestAsset || body["isCompute"] != true || body["assignedUserId"] != nil {
				t.Fatalf("unexpected contract: %v", body)
			}
			for _, field := range adminAssetFields {
				if _, ok := body[field.key]; !ok {
					t.Errorf("missing camelCase field %s", field.key)
				}
			}
		})
		t.Run(role+"/patch", func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, role, "PATCH", "/api/admin/assets/"+adminTestAsset, `{"name":"Renamed"}`)
			defer cleanup()
			before := adminFixture()
			before["osName"], before["cost"], before["notes"] = "Linux", "9007199254.99", "keep"
			mock.ExpectBegin()
			expectAdminLoad(mock, before, true)
			expectAdminEntity(mock, true)
			mock.ExpectExec(regexp.QuoteMeta("UPDATE assets SET name = $2::text, is_compute = TRUE, manually_managed = TRUE, updated_at = NOW() WHERE id = $1::uuid")).
				WithArgs(adminTestAsset, "Renamed").WillReturnResult(sqlmock.NewResult(0, 1))
			expectAdminHistory(mock, "asset_updated").WillReturnResult(sqlmock.NewResult(0, 1))
			before["name"] = "Renamed"
			expectAdminLoad(mock, before, false)
			mock.ExpectCommit()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, http.StatusOK, "sparse patch")
			if !strings.Contains(rec.Body.String(), `"cost":"9007199254.99"`) || !strings.Contains(rec.Body.String(), `"notes":"keep"`) {
				t.Fatal(rec.Body.String())
			}
		})
	}
}

func TestAdminAssetsRejectMalformedPayloads(t *testing.T) {
	for _, body := range []string{
		`null`, `[]`, `{`, `{}`, `{"name":"x"} {}`, `{"name":"x",}`, `{"name":"x","name":"y"}`,
		`{"Name":"x"}`, `{"asset_tag":"x"}`, `{"isCompute":false}`, `{"saltMinionId":"fake"}`,
		`{"warrantyUntil":"2026-01-01"}`, `{"cost":1.23}`, `{"cost":"1e2"}`, `{"cost":"-1"}`,
		`{"cost":"0.001"}`, `{"cost":"10000000000"}`, `{"purchaseDate":"2025-02-29"}`,
		`{"purchaseDate":"0000-01-01"}`, `{"purchaseDate":"2026-1-1"}`, `{"warrantyDurationMonths":-1}`,
		`{"warrantyDurationMonths":1.5}`, `{"warrantyDurationMonths":"12"}`, `{"warrantyDurationMonths":1201}`,
		`{"entityId":null}`, `{"name":null}`, `{"status":""}`, `{"locationId":"bad"}`, `{"hostname":"BAD HOST"}`,
		`{"name":"` + strings.Repeat("x", 151) + `"}`, `{"notes":"\u0000"}`, `{"name":"ok"}` + strings.Repeat(" ", 65536),
		"{\"name\":\"\xff\"}",
	} {
		t.Run(fmt.Sprintf("case-%d", len(body))+body[:min(len(body), 30)], func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/assets/"+adminTestAsset, body)
			defer cleanup()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, http.StatusBadRequest, "strict payload")
		})
	}
	for _, key := range []string{"entityId", "assetTag", "name", "category"} {
		var data map[string]any
		_ = json.Unmarshal([]byte(adminTestCreate), &data)
		delete(data, key)
		raw, _ := json.Marshal(data)
		if _, err := decodeAdminAsset(strings.NewReader(string(raw)), true); err == nil {
			t.Errorf("POST accepted missing %s", key)
		}
	}
}

func TestAdminAssetsNullablePatchAndWarranty(t *testing.T) {
	for _, field := range adminAssetFields {
		if field.required {
			continue
		}
		t.Run(field.key, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/assets/"+adminTestAsset, `{"`+field.key+`":null}`)
			defer cleanup()
			before := adminFixture()
			before["warrantyStartDate"], before["warrantyDurationMonths"], before["warrantyUntil"] = "2024-01-31", 1, "2024-02-29"
			mock.ExpectBegin()
			expectAdminLoad(mock, before, true)
			expectAdminEntity(mock, true)
			set := ""
			args := []driver.Value{adminTestAsset}
			if !field.compute {
				set = field.column + " = $2::" + field.cast + ", "
				args = append(args, nil)
			}
			if field.key == "warrantyStartDate" || field.key == "warrantyDurationMonths" {
				set += "warranty_until = $3::date, "
				args = append(args, nil)
				before["warrantyUntil"] = nil
			}
			mock.ExpectExec(regexp.QuoteMeta("UPDATE assets SET " + set + "is_compute = TRUE, manually_managed = TRUE, updated_at = NOW() WHERE id = $1::uuid")).WithArgs(args...).WillReturnResult(sqlmock.NewResult(0, 1))
			if field.compute {
				mock.ExpectExec("INSERT INTO asset_compute_details").WithArgs(adminTestAsset, nil, nil, field.key == "osName", field.key == "architecture").WillReturnResult(sqlmock.NewResult(0, 1))
			}
			expectAdminHistory(mock, "asset_updated").WillReturnResult(sqlmock.NewResult(0, 1))
			before[field.key] = nil
			expectAdminLoad(mock, before, false)
			mock.ExpectCommit()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, http.StatusOK, "nullable patch")
		})
	}
	for _, tc := range []struct {
		start  string
		months int
		want   string
	}{
		{"2024-01-31", 1, "2024-02-29"}, {"2025-01-31", 1, "2025-02-28"},
		{"2024-02-29", 12, "2025-02-28"}, {"2024-01-31", 0, "2024-01-31"},
		{"9999-12-31", 0, "9999-12-31"}, {"9999-12-31", 1, ""},
	} {
		got, err := adminWarranty(map[string]any{"warrantyStartDate": tc.start, "warrantyDurationMonths": tc.months})
		if tc.want == "" {
			if err == nil {
				t.Fatal("accepted overflowing warranty")
			}
		} else if err != nil || got != tc.want {
			t.Errorf("warranty %s + %d = %v, %v; want %s", tc.start, tc.months, got, err, tc.want)
		}
	}
}

func TestAdminAssetsNonAdminEntityRoutesDenied(t *testing.T) {
	for _, route := range []struct {
		method, path, body string
		want               int
	}{
		{"GET", "/api/admin/assets?entityId=" + adminTestOther, "", 403},
		{"GET", "/api/admin/assets/options?entity=" + adminTestOther, "", 403},
		{"GET", "/api/admin/assets/" + adminTestAsset, "", 404},
		{"POST", "/api/admin/assets", strings.ReplaceAll(adminTestCreate, adminTestEntity, adminTestOther), 403},
		{"PATCH", "/api/admin/assets/" + adminTestAsset, `{"name":"escape"}`, 404},
		{"PATCH", "/api/admin/assets/" + adminTestAsset, `{"entityId":"` + adminTestOther + `"}`, 403},
	} {
		t.Run(route.method+route.path+route.body, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "it_team", route.method, route.path, route.body)
			defer cleanup()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 403, "non-admin entity route")
		})
	}
}

func TestAdminAssetsRelationshipValidation(t *testing.T) {
	for _, key := range []string{"locationId", "deptId", "groupInChargeId", "assignedUserId", "technicianInChargeId", "supplierId"} {
		t.Run(key, func(t *testing.T) {
			body := strings.TrimSuffix(adminTestCreate, "}") + `,"` + key + `":"` + adminTestOther + `"}`
			mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/assets", body)
			defer cleanup()
			mock.ExpectBegin()
			expectAdminEntity(mock, true)
			if key == "supplierId" {
				mock.ExpectQuery("SELECT EXISTS.*suppliers.*id = \\$1::uuid").WithArgs(adminTestOther).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
			} else {
				pattern := "SELECT EXISTS.*entity_id = \\$2::uuid"
				if key == "technicianInChargeId" {
					pattern += ".*r.name IN \\('super_admin', 'admin', 'it_team'\\)"
				}
				mock.ExpectQuery(pattern).WithArgs(adminTestOther, adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
			}
			mock.ExpectRollback()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 400, "invalid relationship")
		})
	}
}

func TestAdminAssetsTransactionFailures(t *testing.T) {
	for _, stage := range []string{"begin", "relationship", "insert", "conflict", "compute", "history", "readback", "commit", "serialization"} {
		t.Run(stage, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/assets", adminTestCreate)
			defer cleanup()
			boom := errors.New("internal database failure must not be disclosed")
			want := 500
			if stage == "begin" {
				mock.ExpectBegin().WillReturnError(boom)
			} else {
				mock.ExpectBegin()
				if stage == "relationship" {
					mock.ExpectQuery("SELECT EXISTS.*entities").WillReturnError(boom)
				} else {
					expectAdminEntity(mock, true)
					switch stage {
					case "insert":
						expectAdminCreateRow(mock).WillReturnError(boom)
					case "conflict":
						expectAdminCreateRow(mock).WillReturnError(&pq.Error{Code: "23505"})
						want = 409
					default:
						expectAdminCreateRow(mock).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
						exec := mock.ExpectExec("INSERT INTO asset_compute_details")
						if stage == "compute" {
							exec.WillReturnError(boom)
						} else {
							exec.WillReturnResult(sqlmock.NewResult(0, 1))
							history := expectAdminHistory(mock, "asset_created")
							if stage == "history" {
								history.WillReturnError(boom)
							} else {
								history.WillReturnResult(sqlmock.NewResult(0, 1))
								if stage == "readback" {
									mock.ExpectQuery("SELECT json_build_object").WillReturnError(boom)
								} else {
									expectAdminLoad(mock, adminFixture(), false)
								}
							}
						}
					}
				}
				if stage == "commit" {
					mock.ExpectCommit().WillReturnError(boom)
				} else if stage == "serialization" {
					mock.ExpectCommit().WillReturnError(&pq.Error{Code: "40001"})
					want = 409
				} else {
					mock.ExpectRollback()
				}
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, want, "atomic failure")
			if strings.Contains(rec.Body.String(), "internal database") {
				t.Fatal("database error disclosed")
			}
		})
	}
}

func TestAdminAssetsListScopeAndPagination(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "GET", "/api/admin/assets?page=2&pageSize=1&assigned=false", "")
	defer cleanup()
	where := "a.is_compute = TRUE AND TRUE AND a.assigned_to IS NULL"
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM assets a WHERE "+where)).WithArgs().WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))
	raw, _ := json.Marshal(adminFixture())
	mock.ExpectQuery(regexp.QuoteMeta(adminAssetSelect()+" WHERE "+where+" ORDER BY a.asset_tag, a.id LIMIT $1 OFFSET $2")).WithArgs(1, 1).WillReturnRows(sqlmock.NewRows([]string{"computer"}).AddRow(raw))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 200, "paginated unassigned computers")
	if !strings.Contains(rec.Body.String(), `"total":2`) || !strings.Contains(rec.Body.String(), `"page":2`) {
		t.Fatal(rec.Body.String())
	}
}

func TestAdminAssetsOptionsScoped(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "GET", "/api/admin/assets/options?entityId="+adminTestEntity, "")
	defer cleanup()
	for _, table := range []string{"entities", "locations", "departments", "users", "users"} {
		column := "x.entity_id"
		if table == "entities" {
			column = "x.id"
		}
		pattern := "SELECT x.id::text, .* FROM " + table + " x.*WHERE " + regexp.QuoteMeta("TRUE AND "+column+" = $1::uuid")
		mock.ExpectQuery(pattern).WithArgs(adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).AddRow(adminTestOther, "Option"))
	}
	mock.ExpectQuery("SELECT x.id::text, x.name FROM suppliers x WHERE TRUE ORDER BY x.name, x.id").WithArgs().WillReturnRows(sqlmock.NewRows([]string{"id", "name"}))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 200, "scoped options")
	var options map[string][]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &options); err != nil {
		t.Fatal(err)
	}
	if len(options) != 6 {
		t.Fatalf("unexpected option keys: %v", options)
	}
	for _, key := range []string{"entities", "locations", "departments", "users", "technicians", "suppliers"} {
		items, present := options[key]
		if !present || items == nil {
			t.Fatalf("%s must be an array, including when empty", key)
		}
		for _, item := range items {
			if len(item) != 2 || item["id"] == "" || item["name"] == "" {
				t.Fatalf("invalid %s option: %v", key, item)
			}
		}
	}
}

func TestAdminAssetsMissingAndInvalidQueries(t *testing.T) {
	for _, target := range []string{
		"/api/admin/assets/bad", "/api/admin/assets?entityId=bad", "/api/admin/assets/options?entity=bad",
		"/api/admin/assets?page=0", "/api/admin/assets?pageSize=201", "/api/admin/assets?assigned=maybe",
	} {
		mock, rec, router, req, cleanup := adminRoute(t, "admin", "GET", target, "")
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 400, "invalid query")
		cleanup()
	}
	for _, method := range []string{"GET", "PATCH"} {
		mock, rec, router, req, cleanup := adminRoute(t, "super_admin", method, "/api/admin/assets/"+adminTestAsset, `{"name":"new"}`)
		if method == "PATCH" {
			mock.ExpectBegin()
		}
		mock.ExpectQuery("SELECT json_build_object.*a.is_compute = TRUE").WillReturnError(sql.ErrNoRows)
		if method == "PATCH" {
			mock.ExpectRollback()
		}
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 404, "missing computer")
		cleanup()
	}
}

func TestAdminAssetsFullManagementCreate(t *testing.T) {
	data := adminFixture()
	delete(data, "id")
	delete(data, "isCompute")
	delete(data, "warrantyUntil")
	for _, key := range []string{"locationId", "deptId", "assignedUserId", "technicianInChargeId", "groupInChargeId", "supplierId"} {
		data[key] = adminTestOther
	}
	data["hostname"], data["manufacturer"], data["model"], data["serialNumber"] = "pc-1", "Vendor", "Model", "SERIAL-1"
	data["purchaseDate"], data["cost"], data["warrantyStartDate"], data["warrantyDurationMonths"] = "2024-01-31", "9999999999.99", "2024-01-31", 1
	data["updateSources"], data["osName"], data["architecture"], data["notes"] = "Managed", "Linux", "x86_64", "Manual notes"
	raw, _ := json.Marshal(data)
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/assets", string(raw))
	defer cleanup()
	mock.ExpectBegin()
	expectAdminEntity(mock, true)
	for range 5 {
		mock.ExpectQuery("SELECT EXISTS.*entity_id = \\$2::uuid").WithArgs(adminTestOther, adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	}
	mock.ExpectQuery("SELECT EXISTS.*suppliers").WithArgs(adminTestOther).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	args := []driver.Value{}
	for _, field := range adminAssetFields {
		if !field.compute {
			args = append(args, data[field.key])
		}
	}
	args = append(args, "2024-02-29")
	mock.ExpectQuery("INSERT INTO assets .*is_compute, manually_managed.*TRUE, TRUE.*RETURNING id::text").WithArgs(args...).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
	mock.ExpectExec("INSERT INTO asset_compute_details").WithArgs(adminTestAsset, "Linux", "x86_64", true, true).WillReturnResult(sqlmock.NewResult(0, 1))
	expectAdminHistory(mock, "asset_created").WillReturnResult(sqlmock.NewResult(0, 1))
	data["id"], data["isCompute"], data["warrantyUntil"] = adminTestAsset, true, "2024-02-29"
	expectAdminLoad(mock, data, false)
	mock.ExpectCommit()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 201, "full management contract")
	if !strings.Contains(rec.Body.String(), `"cost":"9999999999.99"`) || !strings.Contains(rec.Body.String(), `"warrantyUntil":"2024-02-29"`) {
		t.Fatal(rec.Body.String())
	}
}

func TestAdminAssetsDelegatedAndGlobalReads(t *testing.T) {
	for _, role := range []string{"admin", "super_admin"} {
		mock, rec, router, req, cleanup := adminRoute(t, role, "GET", "/api/admin/assets/"+adminTestAsset, "")
		data := adminFixture()
		data["entityId"] = adminTestOther
		expectAdminLoad(mock, data, false)
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 200, "delegated or global scope")
		cleanup()
	}
}

func TestAdminAssetsPatchWarrantyAndFailure(t *testing.T) {
	for _, stage := range []string{"success", "conflict", "history"} {
		t.Run(stage, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/assets/"+adminTestAsset, `{"warrantyDurationMonths":12}`)
			defer cleanup()
			data := adminFixture()
			data["warrantyStartDate"], data["warrantyDurationMonths"] = "2024-02-29", 1
			mock.ExpectBegin()
			expectAdminLoad(mock, data, true)
			expectAdminEntity(mock, true)
			update := mock.ExpectExec(regexp.QuoteMeta("UPDATE assets SET warranty_duration_months = $2::integer, warranty_until = $3::date, is_compute = TRUE, manually_managed = TRUE, updated_at = NOW() WHERE id = $1::uuid")).WithArgs(adminTestAsset, 12, "2025-02-28")
			want := 200
			if stage == "conflict" {
				update.WillReturnError(&pq.Error{Code: "23505"})
				mock.ExpectRollback()
				want = 409
			} else {
				update.WillReturnResult(sqlmock.NewResult(0, 1))
				history := expectAdminHistory(mock, "asset_updated")
				if stage == "history" {
					history.WillReturnError(errors.New("failed"))
					mock.ExpectRollback()
					want = 500
				} else {
					history.WillReturnResult(sqlmock.NewResult(0, 1))
					data["warrantyDurationMonths"], data["warrantyUntil"] = 12, "2025-02-28"
					expectAdminLoad(mock, data, false)
					mock.ExpectCommit()
				}
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, want, "atomic warranty patch")
		})
	}
}

func TestAdminAssetsLegacyComputerGuards(t *testing.T) {
	for _, route := range []struct{ method, path, body string }{
		{"POST", "/api/assets", `{"is_compute":true,"category":"desktop"}`},
		{"POST", "/api/assets", `{"is_compute":false,"category":"Laptop"}`},
		{"PATCH", "/api/assets/" + adminTestAsset, `{"is_compute":false,"category":"accessory"}`},
		{"DELETE", "/api/assets/" + adminTestAsset, ""},
		{"POST", "/api/assets/" + adminTestAsset + "/assign", `{"user_id":"` + adminTestUser + `"}`},
		{"POST", "/api/assets/" + adminTestAsset + "/unassign", ""},
	} {
		t.Run(route.method+route.path+route.body, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "it_team", route.method, route.path, route.body)
			defer cleanup()
			if strings.Contains(route.path, adminTestAsset) {
				expectAssetLookup(mock, adminTestAsset, "PC-1", "Computer", "pc-1", "desktop", true, adminTestEntity, "", "", "in_use", "good")
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 403, "legacy computer role bypass")
		})
	}
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	c, _ := newTestContext("POST", "/api/assets", newTestClaims("it_team", adminTestUser, adminTestEntity))
	if !server.allowManualComputerMutation(c, false, "accessory") {
		t.Fatal("unrelated non-compute management denied")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	payload := server.userAuthPayload(dbUser{Role: "admin", EntityID: adminTestEntity})
	if payload["role"] != "admin" || payload["default_portal"] != "/admin/dashboard" {
		t.Fatal("literal admin role was not preserved")
	}
}

func TestAdminAssetsScopeLookupFailures(t *testing.T) {
	server, mock, cleanup := newTestServer(t)
	defer cleanup()
	context, _ := newTestContext("GET", "/", newTestClaims("it_team", adminTestUser, adminTestEntity))
	mock.ExpectQuery("SELECT EXISTS.*user_entity_access").WithArgs(adminTestUser, adminTestOther).
		WillReturnError(errors.New("private database failure"))
	allowed, err := adminAssetEntityAllowed(context, server.db, adminTestOther)
	if allowed || err == nil {
		t.Fatal("scoped authorization lookup must fail closed")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAdminAssetsTransferValidatesRetainedRelationships(t *testing.T) {
	for _, key := range []string{"locationId", "deptId", "assignedUserId", "technicianInChargeId", "groupInChargeId"} {
		t.Run(key, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/assets/"+adminTestAsset, `{"entityId":"`+adminTestOther+`"}`)
			defer cleanup()
			before := adminFixture()
			before[key] = adminTestUser
			mock.ExpectBegin()
			expectAdminLoad(mock, before, true)
			mock.ExpectQuery("SELECT EXISTS.*entities.*is_active").WithArgs(adminTestOther).
				WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
			mock.ExpectQuery("SELECT EXISTS.*entity_id = \\$2::uuid").WithArgs(adminTestUser, adminTestOther).
				WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
			mock.ExpectRollback()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 400, "retained relationships must belong to destination entity")
			if !strings.Contains(rec.Body.String(), key) {
				t.Fatalf("missing relationship validation error: %s", rec.Body.String())
			}
		})
	}
}

func TestAdminAssetsTransferClearsRelationships(t *testing.T) {
	for _, role := range []string{"admin", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			body := `{"entityId":"` + adminTestOther + `","locationId":null,"deptId":null,"assignedUserId":null,"technicianInChargeId":null,"groupInChargeId":null}`
			mock, rec, router, req, cleanup := adminRoute(t, role, "PATCH", "/api/admin/assets/"+adminTestAsset, body)
			defer cleanup()
			before := adminFixture()
			keys := []string{"locationId", "deptId", "assignedUserId", "technicianInChargeId", "groupInChargeId"}
			for _, key := range keys {
				before[key] = adminTestUser
			}
			mock.ExpectBegin()
			expectAdminLoad(mock, before, true)
			mock.ExpectQuery("SELECT EXISTS.*entities.*is_active").WithArgs(adminTestOther).
				WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
			mock.ExpectExec(regexp.QuoteMeta("UPDATE assets SET entity_id = $2::uuid, location_id = $3::uuid, dept_id = $4::uuid, assigned_to = $5::uuid, technician_in_charge_id = $6::uuid, group_in_charge_id = $7::uuid, is_compute = TRUE, manually_managed = TRUE, updated_at = NOW() WHERE id = $1::uuid")).
				WithArgs(adminTestAsset, adminTestOther, nil, nil, nil, nil, nil).WillReturnResult(sqlmock.NewResult(0, 1))
			expectAdminHistory(mock, "asset_updated").WillReturnResult(sqlmock.NewResult(0, 1))
			before["entityId"] = adminTestOther
			for _, key := range keys {
				before[key] = nil
			}
			expectAdminLoad(mock, before, false)
			mock.ExpectCommit()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 200, "delegated or global transfer with explicit clearing")
		})
	}
}

func TestAdminAssetsDelegatedCreate(t *testing.T) {
	body := strings.ReplaceAll(adminTestCreate, adminTestEntity, adminTestOther)
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/assets", body)
	defer cleanup()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT EXISTS.*entities.*is_active").WithArgs(adminTestOther).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery("INSERT INTO assets .*RETURNING id::text").
		WithArgs(adminTestOther, "PC-1", "Manual computer", "desktop", "in_use", nil).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
	mock.ExpectExec("INSERT INTO asset_compute_details").WithArgs(adminTestAsset, nil, nil, false, false).WillReturnResult(sqlmock.NewResult(0, 1))
	expectAdminHistory(mock, "asset_created").WillReturnResult(sqlmock.NewResult(0, 1))
	data := adminFixture()
	data["entityId"] = adminTestOther
	expectAdminLoad(mock, data, false)
	mock.ExpectCommit()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 201, "delegated create")
}
