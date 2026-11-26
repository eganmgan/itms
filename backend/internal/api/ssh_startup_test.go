package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

func startupTestSigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := gossh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

// A real loopback SSH peer that can withhold a reply at each startup stage.
func startupTestPeer(t *testing.T, stage string, signer gossh.Signer) (string, <-chan struct{}, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	reached, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		raw, err := listener.Accept()
		if err != nil {
			return
		}
		defer raw.Close()
		_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
		if stage == "handshake" {
			close(reached)
			_, _ = io.Copy(io.Discard, raw)
			return
		}
		config := &gossh.ServerConfig{NoClientAuth: true}
		if stage == "authentication" {
			config.NoClientAuth = false
			config.PublicKeyCallback = func(gossh.ConnMetadata, gossh.PublicKey) (*gossh.Permissions, error) {
				close(reached)
				_, _ = io.Copy(io.Discard, raw)
				return nil, errors.New("authentication peer closed")
			}
		}
		config.AddHostKey(signer)
		conn, channels, requests, err := gossh.NewServerConn(raw, config)
		if err != nil {
			return
		}
		defer conn.Close()
		go gossh.DiscardRequests(requests)
		for incoming := range channels {
			if stage == "session" {
				close(reached)
				_ = conn.Wait()
				return
			}
			channel, reqs, err := incoming.Accept()
			if err != nil {
				return
			}
			defer channel.Close()
			for request := range reqs {
				if (stage == "PTY" && request.Type == "pty-req") || (stage == "shell" && request.Type == "shell") {
					close(reached)
					_ = conn.Wait()
					return
				}
				_ = request.Reply(true, nil)
				if request.Type == "shell" {
					close(reached)
					_, _ = io.Copy(channel, channel)
					return
				}
			}
		}
	}()
	return listener.Addr().String(), reached, done
}

func awaitStartupSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("SSH peer did not progress or close")
	}
}

func TestSSHStartupDeadlineClosesEachStalledStage(t *testing.T) {
	for _, stage := range []string{"handshake", "authentication", "session", "PTY", "shell"} {
		t.Run(stage, func(t *testing.T) {
			signer := startupTestSigner(t)
			address, reached, done := startupTestPeer(t, stage, signer)
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			start := time.Now()
			client, _, _, _, _, err := startSSHSession(ctx, address, &gossh.ClientConfig{User: "test", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.FixedHostKey(signer.PublicKey())})
			failureStage := stage
			if stage == "authentication" {
				failureStage = "handshake"
			}
			if err == nil || client != nil || !strings.Contains(err.Error(), failureStage) {
				t.Fatalf("expected %s failure, got %v", stage, err)
			}
			if time.Since(start) > 2*time.Second {
				t.Fatal("startup exceeded deadline budget")
			}
			awaitStartupSignal(t, reached)
			awaitStartupSignal(t, done)
		})
	}
}

func TestSSHStartupCancellationClosesTransport(t *testing.T) {
	signer := startupTestSigner(t)
	address, reached, done := startupTestPeer(t, "handshake", signer)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-reached; cancel() }()
	_, _, _, _, _, err := startSSHSession(ctx, address, &gossh.ClientConfig{User: "test", HostKeyCallback: gossh.FixedHostKey(signer.PublicKey())})
	if err == nil {
		t.Fatal("cancellation unexpectedly succeeded")
	}
	awaitStartupSignal(t, done)
}

func TestSSHStartupRejectsWrongHostKey(t *testing.T) {
	address, _, done := startupTestPeer(t, "ready", startupTestSigner(t))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, _, _, _, err := startSSHSession(ctx, address, &gossh.ClientConfig{User: "test", HostKeyCallback: gossh.FixedHostKey(startupTestSigner(t).PublicKey())})
	if err == nil || !strings.Contains(err.Error(), "host key") {
		t.Fatalf("host key verification bypassed: %v", err)
	}
	awaitStartupSignal(t, done)
}

func TestSSHStartupClearsDeadlineAfterSuccess(t *testing.T) {
	signer := startupTestSigner(t)
	address, _, done := startupTestPeer(t, "ready", signer)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	client, session, stdin, stdout, _, err := startSSHSession(ctx, address, &gossh.ClientConfig{User: "test", HostKeyCallback: gossh.FixedHostKey(signer.PublicKey())})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	defer session.Close()
	<-ctx.Done() // Expire both the startup context and the original socket deadline.
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatal(ctx.Err())
	}
	if _, err := io.WriteString(stdin, "ok"); err != nil {
		t.Fatalf("live session closed: %v", err)
	}
	buffer := make([]byte, 2)
	if _, err := io.ReadFull(stdout, buffer); err != nil || string(buffer) != "ok" {
		t.Fatalf("session not usable: %q %v", buffer, err)
	}
	_ = client.Close()
	awaitStartupSignal(t, done)
}

func TestSSHStartupUsernameRetriesShareDeadline(t *testing.T) {
	signer := startupTestSigner(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	attempts := make(chan string, 2)
	go func() {
		defer close(done)
		for index := 0; index < 2; index++ {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			_ = raw.SetDeadline(time.Now().Add(3 * time.Second))
			if index == 1 {
				attempts <- "second"
				_, _ = io.Copy(io.Discard, raw)
			} else {
				config := &gossh.ServerConfig{PublicKeyCallback: func(conn gossh.ConnMetadata, key gossh.PublicKey) (*gossh.Permissions, error) {
					attempts <- conn.User()
					return nil, errors.New("rejected test user")
				}}
				config.AddHostKey(signer)
				_, _, _, _ = gossh.NewServerConn(raw, config)
			}
			_ = raw.Close()
		}
	}()
	server, _, cleanup := newTestServer(t)
	defer cleanup()
	server.config.SSHTerminalPrivateKey = mustGenerateRouterTestPrivateKey(t)
	server.config.SSHTerminalStrictHostKey = false
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	_, _, _, _, _, _, err = server.openSSHSession(ctx, sshTargetDetails{Address: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Usernames: []string{"first", "second", "third"}})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected shared startup deadline, got %v", err)
	}
	awaitStartupSignal(t, done)
	if len(attempts) != 2 || <-attempts != "first" || <-attempts != "second" {
		t.Fatal("authentication fallback did not stop at the shared deadline")
	}
}
