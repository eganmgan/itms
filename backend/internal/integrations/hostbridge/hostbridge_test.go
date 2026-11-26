package hostbridge

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

func TestDialContextDirectDialSucceedsWithoutGatewayFallback(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	accepted := make(chan struct{}, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		accepted <- struct{}{}
		_ = conn.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, err := DialContext(ctx, "tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("dial direct target: %v", err)
	}
	_ = conn.Close()

	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("direct listener did not accept connection")
	}
}

func TestDecodeRouteHexIPv4(t *testing.T) {
	t.Parallel()

	ip, err := decodeRouteHexIPv4("0101A8C0")
	if err != nil {
		t.Fatalf("decode route hex: %v", err)
	}
	if ip != "192.168.1.1" {
		t.Fatalf("unexpected decoded ip: got %s want 192.168.1.1", ip)
	}

	if _, err := decodeRouteHexIPv4("bad"); err == nil {
		t.Fatal("expected error for malformed route hex")
	}
}

func TestNormalizeHost(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "trim spaces", in: "  LocalHost  ", want: "localhost"},
		{name: "strip ipv6 brackets", in: "[::1]", want: "::1"},
		{name: "preserve normal host", in: "example.internal", want: "example.internal"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := normalizeHost(tt.in)
			if got != tt.want {
				t.Fatalf("normalizeHost(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestGatewayHostForNonLoopbackHostReturnsEmpty(t *testing.T) {
	t.Parallel()

	if got := gatewayHostFor("example.internal"); got != "" {
		t.Fatalf("gatewayHostFor(non-loopback) = %q, want empty", got)
	}

	// Ensure casing and bracket normalization do not accidentally map non-loopback hosts.
	if got := gatewayHostFor(strings.ToUpper("[example.internal]")); got != "" {
		t.Fatalf("gatewayHostFor(normalized non-loopback) = %q, want empty", got)
	}
}
