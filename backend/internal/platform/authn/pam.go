package authn

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

type PAMAuthenticator interface {
	Authenticate(ctx context.Context, username string, password string) error
}

type CommandPAM struct {
	command string
	service string
	timeout time.Duration
}

func NewCommandPAM(command string, service string) *CommandPAM {
	return &CommandPAM{command: strings.TrimSpace(command), service: strings.TrimSpace(service), timeout: 10 * time.Second}
}

func (pam *CommandPAM) Authenticate(ctx context.Context, username string, password string) error {
	if pam == nil || pam.command == "" || pam.service == "" || strings.TrimSpace(username) == "" || password == "" {
		return fmt.Errorf("PAM authentication is not configured")
	}
	timeoutContext, cancel := context.WithTimeout(ctx, pam.timeout)
	defer cancel()
	command := exec.CommandContext(timeoutContext, pam.command, pam.service, strings.TrimSpace(username), "authenticate")
	command.Stdin = strings.NewReader(password + "\n")
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("PAM authentication failed")
	}
	return nil
}