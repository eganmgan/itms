package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/httpx"
	"itms/backend/internal/platform/middleware"
)

type deviceDirectoryUser struct {
	ID                   string                 `json:"id"`
	FullName             string                 `json:"fullName,omitempty"`
	Email                string                 `json:"email,omitempty"`
	EmployeeCode         string                 `json:"employeeCode,omitempty"`
	DepartmentID         string                 `json:"departmentId,omitempty"`
	DepartmentName       string                 `json:"departmentName,omitempty"`
	BranchID             string                 `json:"branchId,omitempty"`
	BranchName           string                 `json:"branchName,omitempty"`
	AssetCount           int                    `json:"assetCount,omitempty"`
	NewAssetCount        int                    `json:"newAssetCount,omitempty"`
	UngroupedCount       int                    `json:"ungroupedAssetCount,omitempty"`
	FlaggedCount         int                    `json:"flaggedAssetCount,omitempty"`
	Status               string                 `json:"status"`
	ConnectivitySource   string                 `json:"connectivitySource,omitempty"`
	ConnectivityCheckedAt *time.Time             `json:"connectivityCheckedAt,omitempty"`
	PrimaryAssetID       string                 `json:"primaryAssetId,omitempty"`
	Assets               []deviceDirectoryAsset `json:"assets,omitempty"`
}

type deviceDirectoryAsset struct {
	ID                   string     `json:"id"`
	Name                 string     `json:"name"`
	Hostname             string     `json:"hostname"`
	AssetTag             string     `json:"assetTag"`
	Category             string     `json:"category"`
	Status               string     `json:"status"`
	LastHeartbeatAt      *time.Time `json:"lastHeartbeatAt,omitempty"`
	ConnectivitySource   string     `json:"connectivitySource,omitempty"`
	ConnectivityCheckedAt *time.Time `json:"connectivityCheckedAt,omitempty"`
	SaltMinionID         string     `json:"saltMinionId,omitempty"`
}

type deviceDirectoryCount struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DeviceCount int    `json:"deviceCount"`
}

func deviceDirectoryScope(role string) string {
	if isAdminRole(role) || role == "super_admin" {
		return "TRUE"
	}
	return `(u.entity_id = $1::uuid OR EXISTS (
		SELECT 1 FROM user_entity_access uea
		WHERE uea.user_id = $2::uuid AND uea.entity_id = u.entity_id
	))`
}

func (server *apiServer) listDeviceDirectory(c *gin.Context) {
	if !server.requireRoles(c, "admin", "super_admin", "it_team", "employee", "auditor") {
		return
	}
	c.Header("Cache-Control", "no-store")
	claims := middleware.CurrentClaims(c)
	scope := deviceDirectoryScope(claims.Role)
	assetScope := "TRUE"
	if claims.Role == "employee" {
		scope = "u.id = $2::uuid"
		assetScope = "a.assigned_to = $2::uuid"
	} else if !isAdminRole(claims.Role) && claims.Role != "super_admin" {
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
	}
	ctx := c.Request.Context()

	rows, err := server.db.QueryContext(ctx, `
		SELECT u.id::text, u.full_name, u.email, u.emp_id,
		       COALESCE(d.id::text, ''), COALESCE(d.name, 'Unassigned'),
		       COALESCE(l.id::text, ''), COALESCE(l.full_name, 'Unassigned'),
		       COUNT(a.id)::int,
		       COUNT(a.id) FILTER (WHERE a.created_at >= NOW() - INTERVAL '7 days')::int,
		       COUNT(a.id) FILTER (WHERE a.dept_id IS NULL)::int,
		       COUNT(a.id) FILTER (WHERE EXISTS (SELECT 1 FROM asset_alerts aa WHERE aa.asset_id = a.id AND aa.is_resolved = FALSE))::int,
		       CASE
		         WHEN COUNT(a.id) = 0 THEN 'unassigned'
		         WHEN BOOL_OR(cd.last_seen >= NOW() - INTERVAL '7 hours') THEN 'online'
		         ELSE 'offline'
		       END,
		       COALESCE(MIN(a.id::text), ''),
		       COALESCE(
		         JSONB_AGG(JSONB_BUILD_OBJECT(
		           'id', a.id::text,
		           'name', a.name,
		           'hostname', COALESCE(a.hostname, ''),
		           'assetTag', a.asset_tag,
		           'category', a.category,
		           'saltMinionId', COALESCE(a.salt_minion_id, ''),
		           'status', CASE WHEN cd.last_seen >= NOW() - INTERVAL '7 hours' THEN 'online' ELSE 'offline' END
		         ) ORDER BY a.asset_tag) FILTER (WHERE a.id IS NOT NULL),
		         '[]'::jsonb
		       )
		FROM users u
		LEFT JOIN departments d ON d.id = u.dept_id
		LEFT JOIN locations l ON l.id = u.location_id
		LEFT JOIN assets a ON a.assigned_to = u.id AND a.is_compute = TRUE AND `+assetScope+`
		LEFT JOIN asset_compute_details cd ON cd.asset_id = a.id
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND u.is_active = TRUE AND `+scope+`
		GROUP BY u.id, u.full_name, u.email, u.emp_id, d.id, d.name, l.id, l.full_name
		ORDER BY u.full_name
	`, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
		return
	}
	defer rows.Close()

	users := make([]deviceDirectoryUser, 0)
	for rows.Next() {
		var user deviceDirectoryUser
		var assetsJSON []byte
		if err := rows.Scan(&user.ID, &user.FullName, &user.Email, &user.EmployeeCode, &user.DepartmentID, &user.DepartmentName, &user.BranchID, &user.BranchName, &user.AssetCount, &user.NewAssetCount, &user.UngroupedCount, &user.FlaggedCount, &user.Status, &user.PrimaryAssetID, &assetsJSON); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
			return
		}
		if err := json.Unmarshal(assetsJSON, &user.Assets); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
			return
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
		return
	}

	applyDeviceDirectoryConnectivity(users, time.Now().UTC())

	departments, err := server.deviceDirectoryGroups(ctx, claims.EntityID, claims.UserID, claims.Role, "departments", "u.dept_id")
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
		return
	}
	branches, err := server.deviceDirectoryGroups(ctx, claims.EntityID, claims.UserID, claims.Role, "locations", "u.location_id")
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
		return
	}

	var allDevices, newDevices, ungroupedDevices, flaggedDevices int
	assetScope = "TRUE"
	if claims.Role == "employee" {
		assetScope = "a.assigned_to = $2::uuid"
	} else if !isAdminRole(claims.Role) && claims.Role != "super_admin" {
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
	}
	err = server.db.QueryRowContext(ctx, `
		SELECT COUNT(*)::int,
		       COUNT(*) FILTER (WHERE a.created_at >= NOW() - INTERVAL '7 days')::int,
		       COUNT(*) FILTER (WHERE a.dept_id IS NULL)::int,
		       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM asset_alerts aa WHERE aa.asset_id = a.id AND aa.is_resolved = FALSE))::int
		FROM assets a
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND a.is_compute = TRUE AND `+assetScope,
		claims.EntityID, claims.UserID,
	).Scan(&allDevices, &newDevices, &ungroupedDevices, &flaggedDevices)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory unavailable")
		return
	}

	adminAccess := isAdminRole(claims.Role)
	httpx.JSON(c, http.StatusOK, gin.H{
		"summary": gin.H{"all": allDevices, "new": newDevices, "ungrouped": ungroupedDevices, "flagged": flaggedDevices},
		"capabilities": gin.H{
			"addDevice":    claims.Role == "admin" || adminAccess,
			"installAgent": claims.Role == "it_team" || adminAccess,
			"manageStock":  claims.Role == "it_team" || adminAccess,
		},
		"departments": departments,
		"branches":    branches,
		"users":       users,
	})
}

func (server *apiServer) listDeviceDirectoryConnectivity(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "admin", "it_team", "employee", "auditor") {
		return
	}
	c.Header("Cache-Control", "no-store")

	claims := middleware.CurrentClaims(c)
	if claims == nil {
		httpx.Error(c, http.StatusUnauthorized, "authentication required")
		return
	}

	assetScope := "TRUE"
	userScope := "TRUE"
	if claims.Role == "employee" {
		assetScope = "a.assigned_to = $2::uuid"
		userScope = "u.id = $2::uuid"
	} else if !isAdminRole(claims.Role) {
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
		userScope = `(u.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = u.entity_id
		))`
	}

	rows, err := server.db.QueryContext(c.Request.Context(), `
		SELECT u.id::text, COALESCE(a.id::text, ''), a.last_heartbeat_at
		FROM users u
		LEFT JOIN assets a ON a.assigned_to = u.id AND a.is_compute = TRUE AND `+assetScope+`
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND u.is_active = TRUE AND `+userScope+`
		ORDER BY u.id, a.id
	`, claims.EntityID, claims.UserID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory connectivity unavailable")
		return
	}
	defer rows.Close()

	usersByID := make(map[string]*deviceDirectoryUser)
	order := make([]string, 0)
	for rows.Next() {
		var userID, assetID string
		var lastHeartbeat *time.Time
		if err := rows.Scan(&userID, &assetID, &lastHeartbeat); err != nil {
			httpx.Error(c, http.StatusInternalServerError, "device directory connectivity unavailable")
			return
		}
		user, exists := usersByID[userID]
		if !exists {
			user = &deviceDirectoryUser{ID: userID, Status: "unknown"}
			usersByID[userID] = user
			order = append(order, userID)
		}
		if assetID == "" {
			continue
		}
		asset := deviceDirectoryAsset{ID: assetID, LastHeartbeatAt: lastHeartbeat}
		user.Assets = append(user.Assets, asset)
	}
	if err := rows.Err(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "device directory connectivity unavailable")
		return
	}

	users := make([]deviceDirectoryUser, 0, len(order))
	for _, userID := range order {
		user := usersByID[userID]
		if len(user.Assets) == 0 {
			user.Status = "unassigned"
		}
		users = append(users, *user)
	}
	applyDeviceDirectoryConnectivity(users, time.Now().UTC())
	httpx.JSON(c, http.StatusOK, gin.H{"users": users})
}

func applyDeviceDirectoryConnectivity(users []deviceDirectoryUser, probe any) {
	if users == nil {
		return
	}
	checkedAt := time.Now().UTC()
	switch typed := probe.(type) {
	case time.Time:
		checkedAt = typed.UTC()
	case *time.Time:
		if typed != nil {
			checkedAt = typed.UTC()
		}
	case map[string]bool:
		for userIndex := range users {
			if len(users[userIndex].Assets) == 0 {
				users[userIndex].Status = "unassigned"
				users[userIndex].ConnectivitySource = "agent_heartbeat"
				users[userIndex].ConnectivityCheckedAt = &checkedAt
				continue
			}
			userOnline := false
			userUnknown := false
			for assetIndex := range users[userIndex].Assets {
				asset := &users[userIndex].Assets[assetIndex]
				if asset.SaltMinionID != "" {
					if typed[asset.SaltMinionID] {
						asset.Status = "online"
					} else {
						asset.Status = "offline"
					}
				}
				asset.ConnectivitySource = "agent_heartbeat"
				asset.ConnectivityCheckedAt = &checkedAt
				asset.SaltMinionID = ""
				if asset.Status == "online" {
					userOnline = true
				} else if asset.Status == "offline" {
					continue
				} else if asset.Status == "unknown" {
					userUnknown = true
				}
			}
			if userOnline {
				users[userIndex].Status = "online"
			} else if userUnknown {
				users[userIndex].Status = "unknown"
			} else if len(users[userIndex].Assets) > 0 {
				users[userIndex].Status = "offline"
			}
			users[userIndex].ConnectivitySource = "agent_heartbeat"
			users[userIndex].ConnectivityCheckedAt = &checkedAt
		}
		return
	case nil:
		// Fall through to heartbeat-based aggregation so the directory still reports
		// a useful user/asset status even without a live Salt probe.
	}

	for userIndex := range users {
		users[userIndex].ConnectivitySource = "agent_heartbeat"
		users[userIndex].ConnectivityCheckedAt = &checkedAt
		if len(users[userIndex].Assets) == 0 {
			users[userIndex].Status = "unassigned"
			continue
		}
		userUnknown := false
		userOnline := false
		userOffline := false
		for assetIndex := range users[userIndex].Assets {
			asset := &users[userIndex].Assets[assetIndex]
			asset.ConnectivitySource = "agent_heartbeat"
			asset.ConnectivityCheckedAt = &checkedAt
			asset.SaltMinionID = ""
			if asset.LastHeartbeatAt == nil {
				asset.Status = "unknown"
				userUnknown = true
				continue
			}
			if asset.LastHeartbeatAt.After(checkedAt) {
				asset.Status = "unknown"
				userUnknown = true
				continue
			}
			if checkedAt.Sub(*asset.LastHeartbeatAt) > 90*time.Second {
				asset.Status = "offline"
				userOffline = true
				continue
			}
			asset.Status = "online"
			userOnline = true
		}
		if userOnline {
			users[userIndex].Status = "online"
		} else if userOffline && !userUnknown {
			users[userIndex].Status = "offline"
		} else {
			users[userIndex].Status = "unknown"
		}
	}
}

func (server *apiServer) deviceDirectoryGroups(ctx context.Context, entityID string, userID string, role string, table string, userColumn string) ([]deviceDirectoryCount, error) {
	nameColumn := "name"
	if table == "locations" {
		nameColumn = "full_name"
	}
	groupScope := "TRUE"
	assetScope := "TRUE"
	if role == "employee" {
		groupScope = "u.id = $2::uuid"
		assetScope = "a.assigned_to = $2::uuid"
	} else if !isAdminRole(role) && role != "super_admin" {
		groupScope = `(g.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = g.entity_id
		))`
		assetScope = `(a.entity_id = $1::uuid OR EXISTS (
			SELECT 1 FROM user_entity_access uea
			WHERE uea.user_id = $2::uuid AND uea.entity_id = a.entity_id
		))`
	}
	query := fmt.Sprintf(`
		SELECT g.id::text, g.%s, COUNT(a.id)::int
		FROM %s g
		LEFT JOIN users u ON %s = g.id AND u.is_active = TRUE
		LEFT JOIN assets a ON a.assigned_to = u.id AND a.is_compute = TRUE AND %s
		WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND %s
		GROUP BY g.id, g.%s
		ORDER BY g.%s
	`, nameColumn, table, userColumn, assetScope, groupScope, nameColumn, nameColumn)
	rows, err := server.db.QueryContext(ctx, query, entityID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := make([]deviceDirectoryCount, 0)
	for rows.Next() {
		var group deviceDirectoryCount
		if err := rows.Scan(&group.ID, &group.Name, &group.DeviceCount); err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

func (server *apiServer) createDeviceInstallCommand(c *gin.Context) {
	if !server.requireRoles(c, "super_admin", "it_team") {
		return
	}
	c.Header("Cache-Control", "no-store")
	var input struct {
		UserID string `json:"userId"`
		OS     string `json:"os"`
	}
	if err := bindJSONWithLimit(c, &input, 16<<10); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid install command request")
		return
	}
	userID := strings.TrimSpace(input.UserID)
	if userID == "" {
		claims := middleware.CurrentClaims(c)
		if claims == nil {
			httpx.Error(c, http.StatusUnauthorized, "authentication required")
			return
		}
		userID = claims.UserID
	}
	user, err := server.fetchUserByID(userID)
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "user not found")
		return
	}
	if !server.userVisibleByEntity(c, user.EntityID, user.ID) {
		httpx.Error(c, http.StatusForbidden, "forbidden")
		return
	}
	serverURL := strings.TrimRight(strings.TrimSpace(server.config.PublicServerURL), "/")
	if serverURL == "" {
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		}
		serverURL = scheme + "://" + c.Request.Host
	}
	linuxURL := serverURL + "/installers/install-itms-agent.sh"
	macOSURL := serverURL + "/installers/install-itms-agent-macos.sh"
	windowsURL := serverURL + "/installers/install-itms-agent.ps1"
	managerHost := c.Request.URL.Hostname()
	if parsedServerURL, parseErr := url.Parse(serverURL); parseErr == nil && parsedServerURL.Hostname() != "" {
		managerHost = parsedServerURL.Hostname()
	}
	departmentName := ""
	if strings.TrimSpace(user.DeptID) != "" {
		_ = server.db.QueryRow(`SELECT COALESCE(name, '') FROM departments WHERE id = $1::uuid`, user.DeptID).Scan(&departmentName)
	}
	osName := strings.ToLower(strings.TrimSpace(input.OS))
	if strings.TrimSpace(server.config.InventoryIngestToken) == "" {
		httpx.Error(c, http.StatusServiceUnavailable, "inventory enrollment is not configured")
		return
	}
	enrollmentToken, err := server.auth.IssueEnrollmentToken(user.ID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "failed to create inventory enrollment")
		return
	}
	command := ""
	if osName == "windows" {
		scriptPath := "$p"
		command = fmt.Sprintf(`$p = Join-Path $env:TEMP 'itms-agent.ps1'; Invoke-RestMethod '%s' -OutFile %s; try { & %s -ServerUrl '%s' -EnrollmentToken '%s' -AssignedToEmail '%s' -AssignedToName '%s' -EmployeeCode '%s' -DepartmentName '%s' -SaltMaster '%s' -WazuhManager '%s' -UseDetailedHardwareInventory $true } finally { Remove-Item %s -ErrorAction SilentlyContinue }`, powershellQuote(windowsURL), scriptPath, scriptPath, powershellQuote(serverURL), powershellQuote(enrollmentToken), powershellQuote(user.Email), powershellQuote(user.FullName), powershellQuote(user.EmpID), powershellQuote(departmentName), powershellQuote(managerHost), powershellQuote(managerHost), scriptPath)
	} else if osName == "linux" || osName == "fedora" || osName == "macos" {
		authorizedKey, keyErr := server.sshConfiguredAuthorizedKey()
		if keyErr != nil {
			httpx.Error(c, http.StatusServiceUnavailable, "SSH signing key is not configured")
			return
		}
		installerURL := linuxURL
		if osName == "macos" {
			installerURL = macOSURL
		}
		postInstallCommand := ""
		if osName != "macos" {
			postInstallCommand = " && (sudo systemctl start itms-openscap-scan.service || true)"
		}
		command = fmt.Sprintf(`curl -fsSL %s | sudo bash -s -- --server-url %s --enrollment-token %s --assigned-to-email %s --assigned-to-name %s --employee-code %s --department-name %s --salt-master %s --wazuh-manager %s --require-salt --ssh-user %s --authorized-key %s --install-cve-scanner%s`, shellQuote(installerURL), shellQuote(serverURL), shellQuote(enrollmentToken), shellQuote(user.Email), shellQuote(user.FullName), shellQuote(user.EmpID), shellQuote(departmentName), shellQuote(managerHost), shellQuote(managerHost), shellQuote("itms-remote"), shellQuote(authorizedKey), postInstallCommand)
	} else {
		httpx.Error(c, http.StatusBadRequest, "unsupported operating system")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"command": command, "user": gin.H{"id": user.ID, "fullName": user.FullName, "email": user.Email, "employeeCode": user.EmpID, "departmentName": departmentName}, "os": osName})
}

func (server *apiServer) exchangeInventoryEnrollmentToken(c *gin.Context) {
	authorization := strings.TrimSpace(c.GetHeader("Authorization"))
	if !strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		httpx.Error(c, http.StatusUnauthorized, "inventory enrollment token is required")
		return
	}
	if _, err := server.auth.ParseEnrollmentToken(strings.TrimSpace(authorization[7:])); err != nil {
		httpx.Error(c, http.StatusUnauthorized, "invalid or expired inventory enrollment token")
		return
	}
	ingestToken := strings.TrimSpace(server.config.InventoryIngestToken)
	if ingestToken == "" {
		httpx.Error(c, http.StatusServiceUnavailable, "inventory ingest token is not configured")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.String(http.StatusOK, "%s", ingestToken)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func powershellQuote(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}
