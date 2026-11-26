package api

import "testing"

func TestCalculatedWarrantyExpiry(t *testing.T) {
	tests := []struct {
		name     string
		start    string
		months   string
		fallback string
		want     string
	}{
		{name: "clamps to end of month", start: "2026-01-31", months: "1", want: "2026-02-28"},
		{name: "supports leap year", start: "2024-01-31", months: "1", want: "2024-02-29"},
		{name: "keeps legacy explicit expiry", fallback: "2027-06-30", want: "2027-06-30"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := calculatedWarrantyExpiry(test.start, test.months, test.fallback)
			if err != nil {
				t.Fatalf("calculatedWarrantyExpiry() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("calculatedWarrantyExpiry() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCalculatedWarrantyExpiryRejectsNegativeDuration(t *testing.T) {
	if _, err := calculatedWarrantyExpiry("2026-01-01", "-1", ""); err == nil {
		t.Fatal("calculatedWarrantyExpiry() accepted a negative duration")
	}
}
