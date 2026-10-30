// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC

package semanto

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type rewrite struct{ to string }

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	req2 := req.Clone(req.Context())
	req2.URL.Scheme = "http"
	req2.URL.Host = strings.TrimPrefix(r.to, "http://")
	req2.Header.Set("X-Original-URL", req.URL.String())
	return http.DefaultTransport.RoundTrip(req2)
}

func TestClientRead(t *testing.T) {
	dir := filepath.Join("..", "..", "test-vectors", "v1")
	var v map[string]any
	var k map[string]any
	b, _ := os.ReadFile(filepath.Join(dir, "response.json"))
	_ = json.Unmarshal(b, &v)
	b, _ = os.ReadFile(filepath.Join(dir, "keys.json"))
	_ = json.Unmarshal(b, &k)
	resp := v["response"].(map[string]any)
	company := k["company"].(map[string]any)
	dnsCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		orig := r.Header.Get("X-Original-URL")
		switch {
		case orig == "https://acme.com/security":
			for h, x := range resp["headers"].(map[string]any) {
				w.Header().Set(h, x.(string))
			}
			w.WriteHeader(int(resp["status"].(float64)))
			_, _ = w.Write([]byte(resp["body"].(string)))
		case orig == "https://acme.com/.well-known/trooth-keys.json":
			_ = json.NewEncoder(w).Encode(company["jwks"])
		case orig == "https://api.trooth.co/public/semanto/.well-known/trooth-keys.json":
			_ = json.NewEncoder(w).Encode(k["trooth"].(map[string]any)["jwks"])
		case strings.HasPrefix(orig, "https://cloudflare-dns.com/dns-query"):
			dnsCalls++
			txt := company["dns_txt"].([]any)[0].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"Answer": []any{map[string]any{"type": 16, "data": `"` + txt + `"`}}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := NewClient()
	c.HTTP = &http.Client{Transport: rewrite{to: srv.URL}}
	now := time.Unix(int64(v["now_epoch"].(float64)), 0)
	c.Now = func() time.Time { return now }
	r, err := c.Read(context.Background(), "https://acme.com/security")
	if err != nil {
		t.Fatal(err)
	}
	if !r.OK || r.DNS == nil || !*r.DNS || r.KeyID != v["expect"].(map[string]any)["keyid"] {
		t.Fatalf("read: %+v", r)
	}
	_, _ = c.Read(context.Background(), "https://acme.com/security")
	if dnsCalls != 1 {
		t.Fatalf("dns asked %d times, want 1 (cached)", dnsCalls)
	}
}
