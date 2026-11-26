package api

import (
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"itms/backend/internal/app"
	"itms/backend/internal/platform/authn"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gorilla/websocket"
	gossh "golang.org/x/crypto/ssh"
)

func TestSSHWebsocketSurfacesSetupErrorAfterUpgrade(t *testing.T) {
	mock, _, router, request, cleanup := newRoleWebSocketRouteRequest(t, "it_team", "user-1", "entity-1", "/ws/ssh/assets/asset-1")
	defer cleanup()
	expectAssetLookup(mock, "asset-1", "ASSET-1", "Asset One", "asset-one", "Laptop", true, "entity-1", "", "", "in_service", "good")
	server := httptest.NewServer(router)
	defer server.Close()
	conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+request.URL.Path, request.Header)
	if err != nil {
		if response != nil {
			t.Fatalf("setup error rejected upgrade with HTTP %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var message sshWebsocketEnvelope
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "error" || !strings.Contains(message.Message, "not configured") {
		t.Fatalf("expected actionable SSH configuration error, got %+v", message)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSSHWebsocketDrainsUnicodeOutputBeforeExit(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	signer := startupTestSigner(t)
	want := strings.Repeat("\x1b[32m日本語 café 😀\x1b[0m\r\n", 4096)
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		// Target resolution probes TCP reachability before opening SSH.
		probe, err := listener.Accept()
		if err != nil {
			return
		}
		_ = probe.Close()
		raw, err := listener.Accept()
		if err != nil {
			return
		}
		defer raw.Close()
		_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
		config := &gossh.ServerConfig{NoClientAuth: true}
		config.AddHostKey(signer)
		conn, channels, requests, err := gossh.NewServerConn(raw, config)
		if err != nil {
			return
		}
		defer conn.Close()
		go gossh.DiscardRequests(requests)
		for incoming := range channels {
			channel, reqs, err := incoming.Accept()
			if err != nil {
				return
			}
			defer channel.Close()
			for request := range reqs {
				_ = request.Reply(true, nil)
				if request.Type == "shell" {
					_, _ = io.WriteString(channel, want)
					_, _ = channel.SendRequest("exit-status", false, gossh.Marshal(struct{ Status uint32 }{0}))
					return
				}
			}
		}
	}()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	config := app.Config{
		FrontendOrigin:        "http://localhost:5173",
		JWTSecret:             "test-secret-with-sufficient-length-123",
		JWTTTL:                time.Hour,
		SSHTerminalUsername:   "opsuser",
		SSHTerminalPrivateKey: mustGenerateRouterTestPrivateKey(t),
		SSHTerminalPort:       listener.Addr().(*net.TCPAddr).Port,
	}
	expectPortalRouteAccess(mock, "it_team", "user-1", http.MethodGet, "/ws/ssh/assets/asset-1")
	expectAssetLookup(mock, "asset-1", "ASSET-1", "Asset One", "127.0.0.1", "Laptop", true, "entity-1", "", "", "in_service", "good")
	mock.ExpectQuery("SELECT COALESCE\\(logged_in_users_json").WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"logged_in_users_json"}).AddRow([]byte(`[]`)))
	mock.ExpectQuery("SELECT COALESCE\\(netbird_ip").WithArgs("asset-1").WillReturnRows(sqlmock.NewRows([]string{"netbird_ip", "wired_ip", "wireless_ip"}))
	server := httptest.NewServer(NewRouter(db, config, nil))
	defer server.Close()
	token := issueRouterTestToken(t, authn.NewManager(config.JWTSecret, config.JWTTTL), "it_team", "user-1", "entity-1")
	dialer := websocket.Dialer{Subprotocols: []string{sshWebsocketProtocol, "bearer." + base64.RawURLEncoding.EncodeToString([]byte(token))}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/ssh/assets/asset-1", http.Header{"Origin": []string{config.FrontendOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var got strings.Builder
	ready := false
	for {
		var message sshWebsocketEnvelope
		if err := conn.ReadJSON(&message); err != nil {
			t.Fatalf("closed before exit envelope: %v", err)
		}
		switch message.Type {
		case "ready":
			ready = true
		case "output":
			if !ready || !utf8.ValidString(message.Data) {
				t.Fatal("output arrived before ready or contained invalid UTF-8")
			}
			got.WriteString(message.Data)
		case "exit":
			if got.String() != want {
				t.Fatalf("exit overtook or corrupted output: got %d bytes, want %d", got.Len(), len(want))
			}
			if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
				t.Fatalf("expected normal close after exit: %v", err)
			}
			awaitStartupSignal(t, peerDone)
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
			return
		default:
			t.Fatalf("unexpected SSH envelope: %+v", message)
		}
	}
}
