package api

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

const sshStartupTimeout = 15 * time.Second

func sshStartupContextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// A socket deadline can fire before the context timer goroutine is scheduled.
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

// The caller shares one deadline across username attempts. ClientConfig.Timeout
// alone only bounds TCP dialing, not SSH authentication or channel requests.
func startSSHSession(ctx context.Context, address string, config *gossh.ClientConfig) (*gossh.Client, *gossh.Session, io.WriteCloser, io.Reader, io.Reader, error) {
	dialer := net.Dialer{Timeout: config.Timeout}
	raw, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh dial: %w", err)
	}
	ready := false
	defer func() {
		if !ready {
			// Close transport first: channel Close can itself block on a stalled peer.
			_ = raw.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		if err := raw.SetDeadline(deadline); err != nil {
			return nil, nil, nil, nil, nil, err
		}
	}
	closed := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = raw.Close()
		close(closed)
	})
	watcherStopped := false
	defer func() {
		if !watcherStopped && !stop() {
			<-closed
		}
	}()
	connection, channels, requests, err := gossh.NewClientConn(raw, address, config)
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh handshake: %w", err)
	}
	client := gossh.NewClient(connection, channels, requests)
	session, err := client.NewSession()
	if err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh session: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	modes := gossh.TerminalModes{gossh.ECHO: 1, gossh.TTY_OP_ISPEED: 14400, gossh.TTY_OP_OSPEED: 14400}
	if err := session.RequestPty("xterm-256color", 36, 120, modes); err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh PTY: %w", err)
	}
	if err := session.Shell(); err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh shell: %w", err)
	}
	// Synchronize with cancellation before handing off ownership; cancellation
	// must never close an apparently successful session after it is returned.
	if !stop() {
		<-closed
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh startup: %w", ctx.Err())
	}
	watcherStopped = true
	if err := sshStartupContextError(ctx); err != nil {
		return nil, nil, nil, nil, nil, fmt.Errorf("ssh startup: %w", err)
	}
	if err := raw.SetDeadline(time.Time{}); err != nil {
		return nil, nil, nil, nil, nil, err
	}
	ready = true
	return client, session, stdin, stdout, stderr, nil
}
