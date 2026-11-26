package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

const deviceQueryTimeout = 8 * time.Second

const deviceHeartbeatMaxAge = 90 * time.Second

func heartbeatConnectivity(lastHeartbeat *time.Time, now time.Time) deviceConnectivity {
	checkedAt := now.UTC().Format(time.RFC3339Nano)
	result := deviceConnectivity{ConnectivitySource: "agent_heartbeat", ConnectivityCheckedAt: &checkedAt}
	if lastHeartbeat == nil || lastHeartbeat.After(now) {
		return result
	}
	lastContact := lastHeartbeat.UTC().Format(time.RFC3339Nano)
	result.LastHeartbeatAt = &lastContact
	connected := now.Sub(*lastHeartbeat) <= deviceHeartbeatMaxAge
	result.Connected = &connected
	return result
}

type deviceConnectivity struct {
	Connected             *bool               `json:"connected"`
	ConnectivitySource    string              `json:"connectivitySource"`
	ConnectivityCheckedAt *string             `json:"connectivityCheckedAt"`
	LastHeartbeatAt       *string             `json:"lastHeartbeatAt"`
	Salt                  *deviceConnectivity `json:"salt,omitempty"`
}

type deviceConnectivityBatch struct {
	connected map[string]bool
	source    string
	checkedAt *string
}

func (server *apiServer) probeDeviceConnectivity(ctx context.Context, targets []string) deviceConnectivityBatch {
	batch := deviceConnectivityBatch{source: "salt_unconfigured"}
	if server.salt == nil || !server.salt.Enabled() {
		return batch
	}
	unique := make([]string, 0, len(targets))
	seen := make(map[string]bool)
	for _, target := range targets {
		target = strings.TrimSpace(target)
		if target != "" && !seen[target] {
			seen[target] = true
			unique = append(unique, target)
		}
	}
	if len(unique) == 0 {
		return batch
	}
	connected, err := server.salt.ConnectedTargets(ctx, unique)
	checkedAt := time.Now().UTC().Format(time.RFC3339Nano)
	batch.checkedAt = &checkedAt
	batch.source = "salt_unavailable"
	if err == nil {
		batch.connected = connected
		batch.source = "salt_ping"
	}
	return batch
}

func (batch deviceConnectivityBatch) forTarget(target string) deviceConnectivity {
	target = strings.TrimSpace(target)
	if target == "" {
		return deviceConnectivity{ConnectivitySource: "unmanaged"}
	}
	result := deviceConnectivity{ConnectivitySource: batch.source, ConnectivityCheckedAt: batch.checkedAt}
	if batch.source == "salt_ping" {
		connected := batch.connected[target]
		result.Connected = &connected
	}
	return result
}

// This predicate must also constrain asset joins: a visible owner alone does
// not grant access to computers assigned from another entity.
func deviceAssetScope(role string) string {
	if isAdminRole(role) {
		return "TRUE"
	}
	if role == "employee" {
		return "a.assigned_to = $2::uuid"
	}
	return `(a.entity_id = $1::uuid OR EXISTS (
		SELECT 1 FROM user_entity_access uea
		WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
	))`
}

func (server *apiServer) getDeviceConnectivity(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "employee", "auditor") {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	claims := middleware.CurrentClaims(c)
	var target string
	var lastHeartbeat *time.Time
	err := server.db.QueryRowContext(ctx, `
		SELECT COALESCE(a.salt_minion_id, ''), a.last_heartbeat_at
		FROM assets a
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL
		AND a.id = $3::uuid AND a.is_compute = TRUE AND `+deviceAssetScope(claims.Role),
		claims.EntityID, claims.UserID, c.Param("id")).Scan(&target, &lastHeartbeat)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device connectivity unavailable")
		return
	}
	result := heartbeatConnectivity(lastHeartbeat, time.Now())
	if c.Query("presence") == "heartbeat" {
		httpx.JSON(c, http.StatusOK, result)
		return
	}
	batch := server.probeDeviceConnectivity(ctx, []string{target})
	salt := batch.forTarget(target)
	result.Salt = &salt
	httpx.JSON(c, http.StatusOK, result)
}
