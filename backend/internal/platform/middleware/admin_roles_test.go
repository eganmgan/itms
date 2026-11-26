package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"itms/backend/internal/platform/authn"

	"github.com/gin-gonic/gin"
)

func TestAdminRoleCompatibility(t *testing.T) {
	for _, allowed := range []string{"admin", "super_admin"} {
		for _, role := range []string{"admin", "super_admin", "employee", "it_team", "auditor", "Admin", " admin", "super_admin ", "SUPER_ADMIN", ""} {
			t.Run(allowed+"/"+role, func(t *testing.T) {
				recorder := httptest.NewRecorder()
				context, _ := gin.CreateTestContext(recorder)
				if RequireRoles(context, allowed) || recorder.Code != http.StatusUnauthorized {
					t.Fatal("missing claims must be unauthorized")
				}
				recorder = httptest.NewRecorder()
				context, _ = gin.CreateTestContext(recorder)
				claims := &authn.Claims{Role: role}
				context.Set(ClaimsKey, claims)
				wantAllowed := role == "admin" || role == "super_admin"
				if got := RequireRoles(context, allowed); got != wantAllowed {
					t.Fatalf("allowed = %v, want %v", got, wantAllowed)
				}
				if !wantAllowed && recorder.Code != http.StatusForbidden {
					t.Fatalf("status = %d, want forbidden", recorder.Code)
				}
				if claims.Role != role {
					t.Fatal("authorization must preserve the recorded role")
				}
			})
		}
	}
}