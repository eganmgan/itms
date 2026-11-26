package authn

import (
	"strings"
	"testing"
)

func TestEnrollmentTokenRoundTrip(t *testing.T) {
	manager := NewManager("test-secret-with-sufficient-length-123", 0)
	token, err := manager.IssueEnrollmentToken("admin-user")
	if err != nil {
		t.Fatalf("IssueEnrollmentToken: %v", err)
	}
	claims, err := manager.ParseEnrollmentToken(token)
	if err != nil {
		t.Fatalf("ParseEnrollmentToken: %v", err)
	}
	if claims.Subject != "admin-user" || claims.Purpose != enrollmentTokenPurpose {
		t.Fatalf("unexpected claims: %#v", claims)
	}

	accessToken, err := manager.IssueToken(UserTokenInput{UserID: "admin-user", EmpID: "EMP-1"})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if _, err := manager.ParseEnrollmentToken(accessToken); err == nil {
		t.Fatal("ParseEnrollmentToken accepted an access token")
	}
}

func TestValidatePasswordStrengthRejectsLeadingOrTrailingWhitespace(t *testing.T) {
	err := ValidatePasswordStrength(" ValidPass#2026 ")
	if err == nil {
		t.Fatal("ValidatePasswordStrength returned nil error")
	}
	if !strings.Contains(err.Error(), "must not start or end with whitespace") {
		t.Fatalf("error = %q, want whitespace validation error", err.Error())
	}
}

func TestValidatePasswordStrengthMinimum8Characters(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantErr  bool
		errMsg   string
	}{
		{
			name:     "7 characters - too short",
			password: "Ab1$xyz",
			wantErr:  true,
			errMsg:   "at least 8 characters",
		},
		{
			name:     "8 characters - valid",
			password: "Ab1$wxyz",
			wantErr:  false,
		},
		{
			name:     "12 characters - valid",
			password: "Ab1$wxyz9876",
			wantErr:  false,
		},
		{
			name:     "empty password",
			password: "",
			wantErr:  true,
			errMsg:   "at least 8 characters",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePasswordStrength(tt.password)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ValidatePasswordStrength(%q) returned nil, want error containing %q", tt.password, tt.errMsg)
				}
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Fatalf("error = %q, want error containing %q", err.Error(), tt.errMsg)
				}
			} else {
				if err != nil {
					t.Fatalf("ValidatePasswordStrength(%q) returned error: %v, want nil", tt.password, err)
				}
			}
		})
	}
}

func TestValidatePasswordStrengthRequiresComplexity(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantErr  bool
		errMsg   string
	}{
		{
			name:     "missing uppercase",
			password: "abc123!@#xyz",
			wantErr:  true,
			errMsg:   "uppercase",
		},
		{
			name:     "missing lowercase",
			password: "ABC123!@#XYZ",
			wantErr:  true,
			errMsg:   "lowercase",
		},
		{
			name:     "missing digit",
			password: "Abcdefg!@#",
			wantErr:  true,
			errMsg:   "number",
		},
		{
			name:     "missing symbol",
			password: "Abcdefg123",
			wantErr:  true,
			errMsg:   "symbol",
		},
		{
			name:     "has all requirements",
			password: "ValidPass#2026",
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePasswordStrength(tt.password)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ValidatePasswordStrength(%q) returned nil, want error containing %q", tt.password, tt.errMsg)
				}
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Fatalf("error = %q, want error containing %q", err.Error(), tt.errMsg)
				}
			} else {
				if err != nil {
					t.Fatalf("ValidatePasswordStrength(%q) returned error: %v, want nil", tt.password, err)
				}
			}
		})
	}
}