package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const catalogScriptCreate = `{"entityId":"` + adminTestEntity + `","name":"Example application","type":"sh","os":"Ubuntu","body":"#!/bin/sh\necho example\n","description":"Review before use"}`

func TestInstallationScriptCategory(t *testing.T) {
	for _, value := range []string{`"application"`, `"service"`, `"other"`, `""`, `null`, `true`} {
		_, err := decodeAdminCatalog(strings.NewReader(`{"category":`+value+`}`), adminScripts, false)
		valid := value == `"application"` || value == `"service"`
		if (err == nil) != valid {
			t.Fatalf("category %s: %v", value, err)
		}
	}
}

func catalogFixture(catalog adminCatalog) map[string]any {
	if !catalog.scoped {
		return map[string]any{"id": adminTestAsset, "name": "Supplier", "contactInfo": "Business contact"}
	}
	var result map[string]any
	_ = json.Unmarshal([]byte(catalogScriptCreate), &result)
	result["id"] = adminTestAsset
	return result
}

func expectCatalogLoad(mock sqlmock.Sqlmock, catalog adminCatalog, role string, lock bool, item map[string]any) {
	query := catalog.selectSQL(true) + " WHERE x.id = $1::uuid AND TRUE"
	if catalog.scoped && !isAdminRole(role) {
		query = catalog.selectSQL(true) + " WHERE x.id = $1::uuid AND (x.entity_id IS NULL OR (x.entity_id = NULLIF($2, '')::uuid OR EXISTS (SELECT 1 FROM user_entity_access uea WHERE uea.user_id = $3::uuid AND uea.entity_id = x.entity_id)))"
	}
	if lock {
		query += " FOR UPDATE OF x"
	}
	expected := mock.ExpectQuery(regexp.QuoteMeta(query))
	if catalog.scoped && !isAdminRole(role) {
		expected.WithArgs(adminTestAsset, adminTestEntity, adminTestUser)
	} else {
		expected.WithArgs(adminTestAsset)
	}
	rows := sqlmock.NewRows([]string{"record"})
	if item != nil {
		raw, _ := json.Marshal(item)
		rows.AddRow(raw)
	}
	expected.WillReturnRows(rows)
}

func TestAdminCatalogRoleMatrix(t *testing.T) {
	for _, role := range []string{"", "employee", "auditor", "it_team", "operator", "Admin", "SUPER_ADMIN", "admin", "super_admin"} {
		for _, catalog := range []adminCatalog{adminSuppliers, adminScripts} {
			path := "/api/admin/suppliers"
			if catalog.scoped {
				path = "/api/admin/scripts"
			}
			for _, route := range []struct{ method, suffix string }{{"GET", ""}, {"GET", "/" + adminTestAsset}, {"POST", ""}, {"PATCH", "/" + adminTestAsset}} {
				t.Run(role+path+route.method+route.suffix, func(t *testing.T) {
					mock, rec, router, req, cleanup := adminRoute(t, role, route.method, path+route.suffix, `{}`)
					defer cleanup()
					want := http.StatusForbidden
					if role == "" {
						want = http.StatusUnauthorized
					} else if isAdminRole(role) {
						want = http.StatusBadRequest
						if route.method == "GET" {
							want = http.StatusOK
							if route.suffix == "" {
								mock.ExpectQuery("SELECT json_build_object.*FROM " + catalog.table + " x.*LIMIT 51 OFFSET").WillReturnRows(sqlmock.NewRows([]string{"record"}))
							} else {
								expectCatalogLoad(mock, catalog, role, false, catalogFixture(catalog))
							}
						}
					}
					router.ServeHTTP(rec, req)
					assertRouteResult(t, mock, rec, want, "catalog role boundary")
				})
			}
		}
	}
}

func TestAdminCatalogCreateAndSparseEdit(t *testing.T) {
	for _, tc := range []struct {
		catalog          adminCatalog
		role, path, body string
	}{
		{adminSuppliers, "super_admin", "/api/admin/suppliers", `{"name":"Supplier","contactInfo":"Business contact"}`},
		{adminScripts, "admin", "/api/admin/scripts", catalogScriptCreate},
		{adminScripts, "super_admin", "/api/admin/scripts", catalogScriptCreate},
	} {
		for _, create := range []bool{true, false} {
			method, path, body := "POST", tc.path, tc.body
			if !create {
				method, path, body = "PATCH", path+"/"+adminTestAsset, `{"name":"Renamed"}`
			}
			t.Run(tc.role+path+method, func(t *testing.T) {
				mock, rec, router, req, cleanup := adminRoute(t, tc.role, method, path, body)
				defer cleanup()
				mock.ExpectBegin()
				item := catalogFixture(tc.catalog)
				if !create {
					expectCatalogLoad(mock, tc.catalog, tc.role, true, item)
					item["name"] = "Renamed"
				}
				entity := ""
				if tc.catalog.scoped {
					entity = adminTestEntity
					expectAdminEntity(mock, true)
				}
				if create {
					query := mock.ExpectQuery("INSERT INTO " + tc.catalog.table)
					if tc.catalog.scoped {
						query.WithArgs(adminTestEntity, "Example application", "sh", "Ubuntu", "#!/bin/sh\necho example\n", "Review before use", adminTestUser)
					} else {
						query.WithArgs("Supplier", "Business contact")
					}
					query.WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
				} else {
					mock.ExpectExec(regexp.QuoteMeta("UPDATE "+tc.catalog.table+" SET name = $2, updated_at = NOW() WHERE id = $1::uuid")).WithArgs(adminTestAsset, "Renamed").WillReturnResult(sqlmock.NewResult(0, 1))
				}
				action, fields := "_updated", `{"fields":["name"]}`
				if create {
					action = "_created"
					fields = `{"fields":["name","contactInfo"]}`
					if tc.catalog.scoped {
						fields = `{"fields":["entityId","name","type","os","body","description"]}`
					}
				}
				mock.ExpectExec("INSERT INTO audit_log").WithArgs(adminTestUser, entity, tc.catalog.target+action, tc.catalog.target, adminTestAsset, fields).WillReturnResult(sqlmock.NewResult(0, 1))
				expectCatalogLoad(mock, tc.catalog, tc.role, false, item)
				mock.ExpectCommit()
				router.ServeHTTP(rec, req)
				want := 200
				if create {
					want = 201
				}
				assertRouteResult(t, mock, rec, want, "catalog create/edit")
				var result map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &result)
				if result["id"] != adminTestAsset || (tc.catalog.scoped && result["body"] != item["body"]) {
					t.Fatal("sparse update lost script body")
				}
			})
		}
	}
}

func TestAdminCatalogMalformedPayloads(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `{`, `{}`, `{"name":"a"} {}`, `{"name":"a","name":"b"}`, `{"Name":"x"}`, `{"unknown":"x"}`, `{"name":1}`, `{"name":null}`, `{"name":" "}`, `{"name":"\u0000"}`, `{"type":"powershell"}`, `{"os":"Windows"}`, `{"entityId":"bad"}`, `{"body":true}`, `{"body":"  "}`, `{"name":"` + strings.Repeat("x", 151) + `"}`, `{"body":"` + strings.Repeat("x", 48001) + `"}`, "{\"name\":\"\xff\"}", `{"name":"x"}` + strings.Repeat(" ", 262144)} {
		mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/scripts/"+adminTestAsset, body)
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 400, "strict catalog payload")
		cleanup()
	}
	for _, catalog := range []adminCatalog{adminSuppliers, adminScripts} {
		for _, field := range catalog.fields {
			if !field.required {
				continue
			}
			input := catalogFixture(catalog)
			delete(input, "id")
			delete(input, field.key)
			raw, _ := json.Marshal(input)
			if _, err := decodeAdminCatalog(bytesReader(raw), catalog, true); err == nil {
				t.Errorf("accepted missing %s", field.key)
			}
		}
	}
}

func bytesReader(raw []byte) *strings.Reader { return strings.NewReader(string(raw)) }

func TestAdminCatalogEntityBoundaries(t *testing.T) {
	for _, method := range []string{"GET", "PATCH"} {
		t.Run("hidden-"+method, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, "admin", method, "/api/admin/scripts/"+adminTestAsset, `{"name":"escape"}`)
			defer cleanup()
			if method == "PATCH" {
				mock.ExpectBegin()
			}
			expectCatalogLoad(mock, adminScripts, "admin", method == "PATCH", nil)
			if method == "PATCH" {
				mock.ExpectRollback()
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 404, "hidden out-of-scope target")
		})
	}
	for _, method := range []string{"POST", "PATCH", "GET"} {
		t.Run("escape-"+method, func(t *testing.T) {
			path, body := "/api/admin/scripts", strings.ReplaceAll(catalogScriptCreate, adminTestEntity, adminTestOther)
			if method == "PATCH" {
				path += "/" + adminTestAsset
				body = `{"entityId":"` + adminTestOther + `"}`
			} else if method == "GET" {
				path += "?entityId=" + adminTestOther
			}
			mock, rec, router, req, cleanup := adminRoute(t, "it_team", method, path, body)
			defer cleanup()
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, 403, "non-admin catalog access")
		})
	}
}

func TestAdminCatalogScopedListAndDelegation(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "GET", "/api/admin/scripts?page=2&entityId="+adminTestOther, "")
	defer cleanup()
	query := adminScripts.selectSQL(false) + " WHERE TRUE AND x.entity_id = $1::uuid ORDER BY x.name, x.id LIMIT 51 OFFSET $2"
	if strings.Contains(query, "'body'") {
		t.Fatal("script list selects bodies")
	}
	mock.ExpectQuery(regexp.QuoteMeta(query)).WithArgs(adminTestOther, 50).WillReturnRows(sqlmock.NewRows([]string{"record"}).AddRow(`{"id":"` + adminTestAsset + `","name":"Application"}`))
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 200, "delegated list")
	if strings.Contains(rec.Body.String(), `"body"`) || !strings.Contains(rec.Body.String(), `"canWrite":true`) {
		t.Fatal(rec.Body.String())
	}
}

func TestAdminCatalogAtomicAuditFailure(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "POST", "/api/admin/suppliers", `{"name":"Supplier"}`)
	defer cleanup()
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO suppliers").WithArgs("Supplier").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
	mock.ExpectExec("INSERT INTO audit_log").WillReturnError(errors.New("sensitive database connection detail"))
	mock.ExpectRollback()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 500, "audit failure rolls back mutation")
	if strings.Contains(rec.Body.String(), "sensitive") {
		t.Fatal("internal error leaked")
	}
}

func TestAdminCatalogMissingAndInvalidIDs(t *testing.T) {
	for _, path := range []string{"/api/admin/suppliers/bad", "/api/admin/scripts/bad", "/api/admin/scripts?page=0", "/api/admin/scripts?entityId=bad"} {
		mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "GET", path, "")
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 400, "invalid parameters")
		cleanup()
	}
	mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "GET", "/api/admin/suppliers/"+adminTestAsset, "")
	defer cleanup()
	mock.ExpectQuery("SELECT json_build_object.*FROM suppliers").WillReturnError(sql.ErrNoRows)
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 404, "missing supplier")
}

func TestAdminCatalogDelegatedTransferAndClear(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/scripts/"+adminTestAsset, `{"entityId":"`+adminTestOther+`","description":null}`)
	defer cleanup()
	mock.ExpectBegin()
	item := catalogFixture(adminScripts)
	expectCatalogLoad(mock, adminScripts, "admin", true, item)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT EXISTS(SELECT 1 FROM entities WHERE id = $1::uuid AND is_active)")).WithArgs(adminTestOther).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE admin_installation_scripts SET entity_id = $2::uuid, description = $3, updated_at = NOW() WHERE id = $1::uuid")).WithArgs(adminTestAsset, adminTestOther, nil).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO audit_log").WithArgs(adminTestUser, adminTestOther, "admin_installation_script_updated", "admin_installation_script", adminTestAsset, `{"fields":["entityId","description"]}`).WillReturnResult(sqlmock.NewResult(0, 1))
	item["entityId"], item["description"] = adminTestOther, nil
	expectCatalogLoad(mock, adminScripts, "admin", false, item)
	mock.ExpectCommit()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 200, "delegated transfer and explicit null")
	if !strings.Contains(rec.Body.String(), `"description":null`) || !strings.Contains(rec.Body.String(), `"body":"#!/bin/sh\necho example\n"`) {
		t.Fatal("clear changed unrelated body")
	}
}

func TestAdminCatalogScopeFailureIsNotAuthorization(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "POST", "/api/admin/scripts", strings.ReplaceAll(catalogScriptCreate, adminTestEntity, adminTestOther))
	defer cleanup()
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT EXISTS.*entities.*is_active").WithArgs(adminTestOther).WillReturnError(errors.New("private entity lookup failure"))
	mock.ExpectRollback()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 500, "scope failure fails closed")
	if strings.Contains(rec.Body.String(), "private") {
		t.Fatal("scope error leaked")
	}
}

func TestAdminCatalogSupplierValidation(t *testing.T) {
	for _, body := range []string{`{"contactInfo":12}`, `{"contactInfo":"\u0000"}`, `{"contactInfo":"` + strings.Repeat("x", 4001) + `"}`, `{"entityId":"` + adminTestEntity + `"}`, `{"name":"x","contactInfo":false}`} {
		mock, rec, router, req, cleanup := adminRoute(t, "super_admin", "PATCH", "/api/admin/suppliers/"+adminTestAsset, body)
		router.ServeHTTP(rec, req)
		assertRouteResult(t, mock, rec, 400, "supplier validation")
		cleanup()
	}
}

func TestAdminCatalogSharedScript(t *testing.T) {
	body := strings.Replace(catalogScriptCreate, `"entityId":"`+adminTestEntity+`",`, "", 1)
	for _, role := range []string{"admin", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			mock, rec, router, req, cleanup := adminRoute(t, role, "POST", "/api/admin/scripts", body)
			defer cleanup()
			mock.ExpectBegin()
			want := 403
			if isAdminRole(role) {
				want = 201
				mock.ExpectQuery("INSERT INTO admin_installation_scripts").WithArgs("Example application", "sh", "Ubuntu", "#!/bin/sh\necho example\n", "Review before use", adminTestUser).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(adminTestAsset))
				mock.ExpectExec("INSERT INTO audit_log").WithArgs(adminTestUser, "", "admin_installation_script_created", "admin_installation_script", adminTestAsset, `{"fields":["name","type","os","body","description"]}`).WillReturnResult(sqlmock.NewResult(0, 1))
				item := catalogFixture(adminScripts)
				item["entityId"] = nil
				expectCatalogLoad(mock, adminScripts, role, false, item)
				mock.ExpectCommit()
			} else {
				mock.ExpectRollback()
			}
			router.ServeHTTP(rec, req)
			assertRouteResult(t, mock, rec, want, "shared script creation")
		})
	}
	if _, err := decodeAdminCatalog(strings.NewReader(`{"type":"sls"}`), adminScripts, false); err == nil {
		t.Fatal("accepted a non-shell script")
	}
}

func TestAdminCatalogSharedScriptCanBeManagedByAdmin(t *testing.T) {
	mock, rec, router, req, cleanup := adminRoute(t, "admin", "PATCH", "/api/admin/scripts/"+adminTestAsset, `{"entityId":"`+adminTestEntity+`","body":"echo changed"}`)
	defer cleanup()
	item := catalogFixture(adminScripts)
	item["entityId"] = nil
	mock.ExpectBegin()
	expectCatalogLoad(mock, adminScripts, "admin", true, item)
	mock.ExpectQuery("SELECT EXISTS.*entities.*is_active").WithArgs(adminTestEntity).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE admin_installation_scripts SET entity_id = $2::uuid, body = $3, updated_at = NOW() WHERE id = $1::uuid")).WithArgs(adminTestAsset, adminTestEntity, "echo changed").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO audit_log").WithArgs(adminTestUser, adminTestEntity, "admin_installation_script_updated", "admin_installation_script", adminTestAsset, `{"fields":["entityId","body"]}`).WillReturnResult(sqlmock.NewResult(0, 1))
	item["entityId"], item["body"] = adminTestEntity, "echo changed"
	expectCatalogLoad(mock, adminScripts, "admin", false, item)
	mock.ExpectCommit()
	router.ServeHTTP(rec, req)
	assertRouteResult(t, mock, rec, 200, "admin can manage shared scripts")
}
