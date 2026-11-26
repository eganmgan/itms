package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

// Match assetAllowed's assignment/entity policy, but never swallow SQL errors
// or let the delegated-entity lookup outlive the inventory request deadline.
func (server *apiServer) deviceDetailAllowed(ctx context.Context, c *gin.Context, asset dbAsset) (bool, error) {
	claims := middleware.CurrentClaims(c)
	if claims == nil {
		return false, nil
	}
	if claims.Role == "employee" {
		return claims.UserID == asset.AssignedTo, nil
	}
	if isAdminRole(claims.Role) || claims.EntityID == asset.EntityID {
		return true, nil
	}
	var allowed bool
	err := server.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM user_entity_access WHERE user_id = $1::uuid AND entity_id = $2::uuid)`, claims.UserID, asset.EntityID).Scan(&allowed)
	return allowed, err
}

func deviceDetailError(c *gin.Context, ctx context.Context, err error) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		httpx.Error(c, http.StatusGatewayTimeout, "device inventory request timed out")
		return
	}
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		httpx.Error(c, http.StatusRequestTimeout, "device inventory request canceled")
		return
	}
	httpx.Error(c, http.StatusInternalServerError, "device inventory unavailable")
}

func openSCAPComplianceScore(alerts []gin.H) (int, bool) {
	pairs := regexp.MustCompile(`(?i)([A-Za-z][A-Za-z _-]*)\s*:\s*(\d+)`)
	for _, alert := range alerts {
		source, _ := alert["source"].(string)
		if !strings.EqualFold(strings.TrimSpace(source), "openscap") {
			continue
		}
		detail, _ := alert["detail"].(string)
		checked, passed := 0, -1
		for _, match := range pairs.FindAllStringSubmatch(detail, -1) {
			key := strings.ToLower(strings.TrimSpace(match[1]))
			key = strings.ReplaceAll(key, "-", "_")
			key = strings.ReplaceAll(key, " ", "_")
			value, err := strconv.Atoi(match[2])
			if err != nil {
				continue
			}
			switch key {
			case "rules_checked", "checked":
				checked = value
			case "passed":
				passed = value
			}
		}
		if checked > 0 && passed >= 0 {
			score := (passed*100 + checked/2) / checked
			return score, true
		}
	}
	return 0, false
}
