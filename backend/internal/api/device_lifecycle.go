package api

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var lifecycleCost = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`)

func validateLifecycleFields(fields map[string]*string) error {
	for key, value := range fields {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(*value)
		if text == "" {
			continue
		}
		switch key {
		case "supplierName":
			if !utf8.ValidString(text) || utf8.RuneCountInString(text) > 150 || strings.ContainsRune(text, 0) {
				return fmt.Errorf("invalid supplier name")
			}
		case "cost":
			if !lifecycleCost.MatchString(text) {
				return fmt.Errorf("value must be a nonnegative decimal with at most two decimal places")
			}
		case "warrantyDurationMonths":
			months, err := strconv.Atoi(text)
			if err != nil || months < 0 || months > 1200 {
				return fmt.Errorf("warranty duration must be between 0 and 1200 months")
			}
		default:
			date, err := time.Parse("2006-01-02", text)
			if err != nil || date.Year() < 1 || date.Year() > 9999 {
				return fmt.Errorf("invalid %s date", key)
			}
		}
	}
	return nil
}

func canEditLifecycle(role string, used bool) bool {
	return role == "super_admin" || (role == "it_team" && !used)
}

func lifecycleEditUsed(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, assetID string) (bool, error) {
	var used bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM asset_history WHERE asset_id = $1::uuid AND action = 'it_team_lifecycle_saved')`, assetID).Scan(&used)
	return used, err
}

func lockLifecycleEdit(ctx context.Context, tx *sql.Tx, assetID string) (string, bool, error) {
	var entityID string
	if err := tx.QueryRowContext(ctx, `SELECT entity_id::text FROM assets WHERE id = $1::uuid AND is_compute = TRUE FOR UPDATE`, assetID).Scan(&entityID); err != nil {
		return "", false, err
	}
	used, err := lifecycleEditUsed(ctx, tx, assetID)
	return entityID, used, err
}
