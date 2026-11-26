package api

import (
	"errors"
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

type sshChunkReader struct {
	chunks [][]byte
	err    error
}

func (r *sshChunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[0])
	r.chunks[0] = r.chunks[0][n:]
	if len(r.chunks[0]) == 0 {
		r.chunks = r.chunks[1:]
	}
	if len(r.chunks) == 0 {
		return n, r.err
	}
	return n, nil
}

func TestSSHOutputPreservesSplitUTF8AndANSI(t *testing.T) {
	want := "\x1b[32m日本語 café 😀\x1b[0m\r\n$ "
	for split := 1; split < len(want); split++ {
		reader := &sshChunkReader{chunks: [][]byte{[]byte(want[:split]), []byte(want[split:])}, err: io.EOF}
		var got strings.Builder
		err := forwardSSHOutput(reader, func(data string) error {
			if !utf8.ValidString(data) {
				t.Fatalf("invalid UTF-8 at split %d: %q", split, data)
			}
			got.WriteString(data)
			return nil
		})
		if err != io.EOF || got.String() != want {
			t.Fatalf("split %d: got %q, %v", split, got.String(), err)
		}
	}
}

func TestSSHOutputFlushesTruncatedRuneAndReadError(t *testing.T) {
	readErr := errors.New("SSH read failed")
	reader := &sshChunkReader{chunks: [][]byte{{'o', 'k', 0xf0, 0x9f}}, err: readErr}
	var got string
	err := forwardSSHOutput(reader, func(data string) error { got += data; return nil })
	if !errors.Is(err, readErr) || got != "ok\uFFFD" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestSSHOutputStopsOnSendFailure(t *testing.T) {
	sendErr := errors.New("WebSocket closed")
	reader := &sshChunkReader{chunks: [][]byte{[]byte("first"), []byte("second")}}
	err := forwardSSHOutput(reader, func(string) error { return sendErr })
	if !errors.Is(err, sendErr) || len(reader.chunks) != 1 {
		t.Fatalf("output did not stop on failed send: %v", err)
	}
}

func TestSSHOutputPreservesRuneAcrossBufferBoundary(t *testing.T) {
	want := strings.Repeat("x", 4095) + "😀" + strings.Repeat("日", 4096)
	var got strings.Builder
	err := forwardSSHOutput(strings.NewReader(want), func(data string) error { got.WriteString(data); return nil })
	if err != io.EOF || got.String() != want {
		t.Fatalf("large UTF-8 output was corrupted: %v", err)
	}
}
