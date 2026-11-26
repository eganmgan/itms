package database

import (
	"database/sql"
	"fmt"
	"strings"

	"itms/backend/internal/app"
)

type PasswordHasher func(string) (string, error)

// Seed adds missing defaults; it must not reconcile away user-managed records
// or overwrite their metadata. Built-in roles retain their required permissions.
func Seed(db *sql.DB, config app.Config, hashPassword PasswordHasher) error {
	if err := seedEntities(db); err != nil {
		return err
	}
	if err := seedDepartments(db); err != nil {
		return err
	}
	if err := seedTicketCategories(db); err != nil {
		return err
	}
	if err := seedRolesAndPermissions(db); err != nil {
		return err
	}
	if err := seedDefaultAdmin(db, config, hashPassword); err != nil {
		return err
	}
	return nil
}

func seedEntities(db *sql.DB) error {
	entities := []struct {
		ShortCode string
		FullName  string
	}{
		{"ZBL", "Zerodha Broking Limited"},
		{"ZC", "Zerodha Commodities"},
		{"ETS", "ETS"},
		{"NKS", "NK Square"},
		{"ZCAP", "Zerodha Capital"},
		{"RM", "Rainmatter"},
		{"ZTEC", "Zerodha Technology"},
	}

	for _, entity := range entities {
		if _, err := db.Exec(`
			INSERT INTO entities (short_code, full_name)
			VALUES ($1, $2)
			ON CONFLICT (short_code) DO NOTHING
		`, entity.ShortCode, entity.FullName); err != nil {
			return fmt.Errorf("seed entity %s: %w", entity.ShortCode, err)
		}
	}

	locations := []struct {
		EntityCode   string
		LocationCode string
		FullName     string
		City         string
		State        string
	}{
		{"ZBL", "ZBL-BLR-HO", "ZBL Head Office, Bangalore", "Bangalore", "Karnataka"},
		{"ZBL", "ZBL-BLR-SO", "ZBL Support Office, Bangalore", "Bangalore", "Karnataka"},
		{"ZBL", "ZBL-BGM-SO", "ZBL Support Office, Belgaum", "Belgaum", "Karnataka"},
	}

	for _, location := range locations {
		if _, err := db.Exec(`
			INSERT INTO locations (entity_id, location_code, full_name, city, state)
			SELECT id, $2, $3, $4, $5
			FROM entities
			WHERE short_code = $1
			ON CONFLICT (location_code) DO NOTHING
		`, location.EntityCode, location.LocationCode, location.FullName, location.City, location.State); err != nil {
			return fmt.Errorf("seed location %s: %w", location.LocationCode, err)
		}
	}

	return nil
}

func seedDepartments(db *sql.DB) error {
	departments := []struct {
		EntityCode  string
		Name        string
		ShortCode   string
		Description string
	}{
		{"ZBL", "IT Team", "ITTEAM", "Endpoint management, infrastructure, and internal IT support"},
		{"ZBL", "Support", "SUPPORT", "Employee and customer support"},
		{"ZBL", "Accounts", "ACCOUNTS", "Accounting, finance controls, and reconciliation operations"},
		{"ZBL", "Sales", "SALES", "Sales operations"},
		{"ZBL", "Quality", "QUALITY", "Quality reviews, training alignment, and process assurance"},
		{"ZBL", "Human Resources (HR)", "HRESOURCE", "Human resources and people operations"},
		{"ZBL", "Mutual Funds", "MFUNDS", "Mutual fund operations, servicing, and support"},
		{"ZBL", "BOCO", "BOCO", "Business operations coordination and workflow management"},
		{"ZBL", "Z-Team", "ZTEAM", "Z-Team operations"},
		{"ZBL", "ACOP", "ACOP", "ACOP operations"},
		{"ZBL", "Process", "PROCESS", "Operational process ownership and execution support"},
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin department seed: %w", err)
	}
	defer tx.Rollback()

	// Either the name or short code may belong to a customized department.
	// Skip conflicts on either unique key, preserving its ID and assignments.
	for _, department := range departments {
		if _, err := tx.Exec(`
			INSERT INTO departments (entity_id, name, short_code, description)
			SELECT id, $2, $3, $4
			FROM entities
			WHERE short_code = $1
			ON CONFLICT DO NOTHING
		`, department.EntityCode, department.Name, department.ShortCode, department.Description); err != nil {
			return fmt.Errorf("seed department %s: %w", department.Name, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit department seed: %w", err)
	}
	return nil
}

func seedTicketCategories(db *sql.DB) error {
	categories := []struct {
		Name        string
		Description string
	}{
		{"Hardware", "Hardware failure, replacement, and peripheral requests"},
		{"Software", "Software installation, licensing, and application support"},
		{"Access", "Account, permission, VPN, and shared resource access"},
		{"Network", "Connectivity, Wi-Fi, DNS, and network access"},
		{"Security", "Security incident, malware, phishing, and compliance support"},
		{"General Support", "General service desk requests"},
	}

	for _, category := range categories {
		if _, err := db.Exec(`
			INSERT INTO ticket_categories (entity_id, name, description)
			SELECT id, $1, $2
			FROM entities
			WHERE short_code = 'ZBL'
			ON CONFLICT (entity_id, name) DO NOTHING
		`, category.Name, category.Description); err != nil {
			return fmt.Errorf("seed ticket category %s: %w", category.Name, err)
		}
	}

	return nil
}

func seedRolesAndPermissions(db *sql.DB) error {
	roles := []struct {
		Name   string
		System bool
		Perms  []string
	}{
		{
			Name:   "super_admin",
			System: true,
			Perms: []string{
				"assets.view", "assets.edit", "assets.delete", "assets.assign",
				"patches.run", "scripts.run", "terminal.open", "remote.open",
				"users.view", "users.manage", "audit.view",
				"gatepass.create", "gatepass.approve",
				"dept.manage", "location.manage", "entity.manage", "roles.manage",
			},
		},
		{
			Name:   "it_team",
			System: true,
			Perms: []string{
				"assets.view", "assets.edit", "assets.assign",
				"patches.run", "scripts.run", "terminal.open", "remote.open",
				"users.view", "audit.view",
				"gatepass.create", "gatepass.approve",
			},
		},
		{
			Name:   "employee",
			System: true,
			Perms: []string{
				"assets.view", "gatepass.create",
			},
		},
		{
			Name:   "auditor",
			System: true,
			Perms: []string{
				"assets.view", "audit.view",
			},
		},
	}

	permissionLabels := map[string]string{
		"assets.view":      "View assets",
		"assets.edit":      "Edit assets",
		"assets.delete":    "Delete assets",
		"assets.assign":    "Assign assets",
		"patches.run":      "Run patches",
		"scripts.run":      "Run scripts",
		"terminal.open":    "Open terminal",
		"remote.open":      "Open remote sessions",
		"users.view":       "View users",
		"users.manage":     "Manage users",
		"audit.view":       "View audit log",
		"gatepass.create":  "Create gatepass",
		"gatepass.approve": "Approve gatepass",
		"dept.manage":      "Manage departments",
		"location.manage":  "Manage locations",
		"entity.manage":    "Manage entities",
		"roles.manage":     "Manage roles",
	}

	for key, label := range permissionLabels {
		if _, err := db.Exec(`
			INSERT INTO permissions (key, label)
			VALUES ($1, $2)
			ON CONFLICT (key) DO NOTHING
		`, key, label); err != nil {
			return fmt.Errorf("seed permission %s: %w", key, err)
		}
	}

	for _, role := range roles {
		// System-role identity and minimum grants are required for authorization.
		// Preserve any additional grants rather than deleting and rebuilding them.
		if _, err := db.Exec(`
			INSERT INTO roles (name, is_system)
			VALUES ($1, $2)
			ON CONFLICT (name) DO UPDATE SET is_system = EXCLUDED.is_system
		`, role.Name, role.System); err != nil {
			return fmt.Errorf("seed role %s: %w", role.Name, err)
		}

		for _, key := range role.Perms {
			if _, err := db.Exec(`
				INSERT INTO role_permissions (role_id, permission_id)
				SELECT r.id, p.id
				FROM roles r
				JOIN permissions p ON p.key = $2
				WHERE r.name = $1
				ON CONFLICT (role_id, permission_id) DO NOTHING
			`, role.Name, key); err != nil {
				return fmt.Errorf("map permission %s to %s: %w", key, role.Name, err)
			}
		}
	}

	return nil
}

func seedDefaultAdmin(db *sql.DB, config app.Config, hashPassword PasswordHasher) error {
	var exists bool
	if err := db.QueryRow(`
		SELECT EXISTS(
			SELECT 1
			FROM users u
			LEFT JOIN roles r ON r.id = u.role_id
			WHERE lower(u.email) = $1 OR r.name IN ('admin', 'super_admin')
		)
	`, strings.ToLower(config.DefaultAdminEmail)).Scan(&exists); err != nil {
		return fmt.Errorf("check default admin: %w", err)
	}
	if exists {
		return nil
	}

	hash, err := hashPassword(config.DefaultAdminPassword)
	if err != nil {
		return fmt.Errorf("hash default admin password: %w", err)
	}

	if _, err := db.Exec(`
		INSERT INTO users (
			emp_id, full_name, email, entity_id, location_id, role_id, password_hash, is_active
		)
		SELECT
			'EMP001',
			$1,
			$2,
			e.id,
			l.id,
			r.id,
			$3,
			TRUE
		FROM entities e
		JOIN roles r ON r.name = 'super_admin'
		LEFT JOIN locations l ON l.location_code = 'ZBL-BLR-HO'
		WHERE e.short_code = 'ZBL'
	`, config.DefaultAdminName, strings.ToLower(config.DefaultAdminEmail), hash); err != nil {
		return fmt.Errorf("insert default admin: %w", err)
	}

	return nil
}
