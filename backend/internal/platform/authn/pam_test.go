package authn

import (
	"context"
	"strings"
	"testing"
)

func TestCommandPAMAuthenticate(t *testing.T) {
	tests := []struct {
		name        string
		pam         *CommandPAM
		username    string
		password    string
		wantError   bool
		errorString string
	}{
		{name: "success", pam: NewCommandPAM("/bin/true", "itms"), username: "alice", password: "secret"},
		{name: "command rejection", pam: NewCommandPAM("/bin/false", "itms"), username: "alice", password: "wrong", wantError: true, errorString: "PAM authentication failed"},
		{name: "missing command", pam: NewCommandPAM("", "itms"), username: "alice", password: "secret", wantError: true, errorString: "PAM authentication is not configured"},
		{name: "missing service", pam: NewCommandPAM("/bin/true", ""), username: "alice", password: "secret", wantError: true, errorString: "PAM authentication is not configured"},
		{name: "missing username", pam: NewCommandPAM("/bin/true", "itms"), password: "secret", wantError: true, errorString: "PAM authentication is not configured"},
		{name: "missing password", pam: NewCommandPAM("/bin/true", "itms"), username: "alice", wantError: true, errorString: "PAM authentication is not configured"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.pam.Authenticate(context.Background(), test.username, test.password)
			if test.wantError && (err == nil || !strings.Contains(err.Error(), test.errorString)) {
				t.Fatalf("Authenticate() error = %v, want containing %q", err, test.errorString)
			}
			if !test.wantError && err != nil {
				t.Fatalf("Authenticate() error = %v", err)
			}
		})
	}
}