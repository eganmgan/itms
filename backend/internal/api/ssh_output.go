package api

import (
	"io"
	"strings"
	"unicode/utf8"
)

// SSH reads are byte chunks, not character boundaries. Keep an incomplete rune
// until the next read rather than letting JSON replace each fragment separately.
// Each stdout/stderr stream must have its own decoder state.
func forwardSSHOutput(reader io.Reader, send func(string) error) error {
	buffer := make([]byte, 4096+utf8.UTFMax)
	pending := 0
	for {
		count, readErr := reader.Read(buffer[pending:4096])
		total := pending + count
		end := 0
		for end < total && utf8.FullRune(buffer[end:total]) {
			_, size := utf8.DecodeRune(buffer[end:total])
			end += size
		}
		if readErr != nil {
			end = total // Flush a truncated final rune as a replacement character.
		}
		if end > 0 {
			if err := send(strings.ToValidUTF8(string(buffer[:end]), "\uFFFD")); err != nil {
				return err
			}
		}
		pending = copy(buffer, buffer[end:total])
		if readErr != nil {
			return readErr
		}
	}
}
