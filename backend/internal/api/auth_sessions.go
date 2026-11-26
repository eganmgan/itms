package api

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"itms/backend/internal/platform/authn"
	"itms/backend/internal/platform/httpx"
)

const refreshCookieName = "itms_refresh_token"

func randomSessionToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := hex.EncodeToString(raw)
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:]), nil
}

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func (server *apiServer) setRefreshCookie(c *gin.Context, token string) {
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(refreshCookieName, token, int(server.config.RefreshTokenTTL.Seconds()), "/api", "", server.config.RefreshCookieSecure, true)
}

func (server *apiServer) issueRefreshCookie(c *gin.Context, userID string) error {
	token, hash, err := randomSessionToken()
	if err != nil {
		return err
	}
	_, err = server.db.Exec(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, NOW() + $3 * INTERVAL '1 second')`, userID, hash, int64(server.config.RefreshTokenTTL.Seconds()))
	if err != nil {
		return err
	}
	server.setRefreshCookie(c, token)
	return nil
}

func (server *apiServer) revokeRefreshCookie(c *gin.Context) {
	if token, err := c.Cookie(refreshCookieName); err == nil && token != "" {
		_, _ = server.db.Exec(`DELETE FROM refresh_tokens WHERE token_hash = $1`, tokenHash(token))
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(refreshCookieName, "", -1, "/api", "", server.config.RefreshCookieSecure, true)
}

func (server *apiServer) refreshSession(c *gin.Context) {
	token, err := c.Cookie(refreshCookieName)
	if err != nil || strings.TrimSpace(token) == "" {
		httpx.Error(c, http.StatusUnauthorized, "refresh token is required")
		return
	}
	var userID string
	err = server.db.QueryRow(`DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id`, tokenHash(token)).Scan(&userID)
	if err != nil {
		server.revokeRefreshCookie(c)
		httpx.Error(c, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	user, err := server.fetchUserByID(userID)
	if err != nil || !user.IsActive {
		server.revokeRefreshCookie(c)
		httpx.Error(c, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	server.issueAuthResponse(c, user, "refresh_token")
}

func (server *apiServer) fetchUserAuthState(userID string) (string, string, int, sql.NullTime, error) {
	var authType, pamUsername string
	var failedAttempts int
	var lockedUntil sql.NullTime
	err := server.db.QueryRow(`SELECT auth_type, COALESCE(pam_username, emp_id), failed_login_attempts, locked_until FROM users WHERE id = $1::uuid`, userID).Scan(&authType, &pamUsername, &failedAttempts, &lockedUntil)
	return authType, pamUsername, failedAttempts, lockedUntil, err
}

func (server *apiServer) recordDatabaseLoginFailure(userID string, previousFailures int) {
	lockAccount := previousFailures+1 >= 5
	_, _ = server.db.Exec(`UPDATE users SET failed_login_attempts = failed_login_attempts + 1, locked_until = CASE WHEN $2 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END WHERE id = $1::uuid`, userID, lockAccount)
}

func (server *apiServer) clearDatabaseLoginFailures(userID string) {
	_, _ = server.db.Exec(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1::uuid`, userID)
}

func (server *apiServer) requestPasswordReset(c *gin.Context) {
	var input struct {
		Email string `json:"email"`
	}
	if err := bindJSONWithLimit(c, &input, 16<<10); err != nil || strings.TrimSpace(input.Email) == "" {
		httpx.Error(c, http.StatusBadRequest, "email is required")
		return
	}
	var userID string
	resetToken := ""
	err := server.db.QueryRow(`SELECT id FROM users WHERE lower(email) = lower($1) AND is_active = TRUE AND auth_type = 'local'`, strings.TrimSpace(input.Email)).Scan(&userID)
	if err == nil {
		token, hash, tokenErr := randomSessionToken()
		if tokenErr == nil {
			_, _ = server.db.Exec(`DELETE FROM password_reset_tokens WHERE user_id = $1::uuid OR expires_at <= NOW()`, userID)
			if _, insertErr := server.db.Exec(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, NOW() + INTERVAL '30 minutes')`, userID, hash); insertErr == nil {
				resetToken = token
			}
		}
	}
	response := gin.H{"message": "If the account supports password reset, reset instructions will be sent."}
	if !server.config.EnforceSecurity && resetToken != "" {
		response["resetToken"] = resetToken
	}
	httpx.JSON(c, http.StatusAccepted, response)
}

func (server *apiServer) confirmPasswordReset(c *gin.Context) {
	var input struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := bindJSONWithLimit(c, &input, 16<<10); err != nil || strings.TrimSpace(input.Token) == "" {
		httpx.Error(c, http.StatusBadRequest, "token and newPassword are required")
		return
	}
	hash, err := authn.HashPassword(input.NewPassword)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	tx, err := server.db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "password reset unavailable")
		return
	}
	defer tx.Rollback()
	var resetID, userID string
	err = tx.QueryRow(`SELECT p.id, p.user_id FROM password_reset_tokens p JOIN users u ON u.id = p.user_id WHERE p.token_hash = $1 AND p.used_at IS NULL AND p.expires_at > NOW() AND u.auth_type = 'local' FOR UPDATE`, tokenHash(strings.TrimSpace(input.Token))).Scan(&resetID, &userID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid or expired reset token")
		return
	}
	if _, err = tx.Exec(`UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1::uuid`, userID, hash); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "password reset unavailable")
		return
	}
	if _, err = tx.Exec(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1::uuid`, resetID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "password reset unavailable")
		return
	}
	if _, err = tx.Exec(`DELETE FROM refresh_tokens WHERE user_id = $1::uuid`, userID); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "password reset unavailable")
		return
	}
	if err = tx.Commit(); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "password reset unavailable")
		return
	}
	httpx.JSON(c, http.StatusOK, gin.H{"status": "password_reset"})
}