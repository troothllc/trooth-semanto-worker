// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// Client reads a company's signed copy and checks it in one call: the page as
// markdown, the company's key set on its domain and Trooth's, the response
// signature (VerifyResponse), and the signing key against the domain's
// _trooth-keys TXT record over DNS over HTTPS. Key sets and DNS answers are
// kept in memory for CacheTTL (five minutes by default).
//
//	c := semanto.NewClient()
//	r, err := c.Read(ctx, "https://acme.com/pricing")
//	if err == nil && r.OK { use(r.Text) }

package semanto

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// TroothAPI and DoHEndpoint are the defaults a Client calls.
const (
	TroothAPI   = "https://api.trooth.co"
	DoHEndpoint = "https://cloudflare-dns.com/dns-query"
)

// Client checks Semanto reads. The zero value is not usable; call NewClient.
type Client struct {
	HTTP     *http.Client
	APIBase  string
	DoH      string // empty turns the DNS check off
	CacheTTL time.Duration
	Now      func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	at    time.Time
	value any
}

// Read is one checked read.
type Read struct {
	OK       bool     `json:"ok"`
	Reason   string   `json:"reason,omitempty"`
	Status   int      `json:"status"`
	Text     string   `json:"text"`
	Version  string   `json:"version,omitempty"`
	SignedBy string   `json:"signed_by,omitempty"`
	KeyID    string   `json:"keyid,omitempty"`
	DNS      *bool    `json:"dns"` // nil when DNS could not be asked or a witness signed
	Checks   []Check  `json:"checks"`
	Notes    []string `json:"notes,omitempty"`
}

// NewClient returns a Client with a 10-second HTTP timeout.
func NewClient() *Client {
	return &Client{HTTP: &http.Client{Timeout: 10 * time.Second}, APIBase: TroothAPI, DoH: DoHEndpoint, CacheTTL: 5 * time.Minute, Now: time.Now, cache: map[string]cached{}}
}

func (c *Client) remember(key string, load func() any) any {
	c.mu.Lock()
	if c.cache == nil {
		c.cache = map[string]cached{}
	}
	if hit, ok := c.cache[key]; ok && c.Now().Sub(hit.at) < c.CacheTTL {
		c.mu.Unlock()
		return hit.value
	}
	c.mu.Unlock()
	v := load()
	c.mu.Lock()
	c.cache[key] = cached{at: c.Now(), value: v}
	c.mu.Unlock()
	return v
}

func (c *Client) get(ctx context.Context, u, accept string) (int, http.Header, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Accept", accept)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	return res.StatusCode, res.Header, b, err
}

type keysAndNotes struct {
	keys  KeySet
	notes []string
}

// KeysFor returns the company's key set from its domain and Trooth's, with a note for each that could not be read.
func (c *Client) KeysFor(ctx context.Context, domain string) (KeySet, []string) {
	v := c.remember("keys:"+domain, func() any {
		raw := map[string]any{"company": map[string]any{"keys": []any{}}, "trooth": map[string]any{"keys": []any{}}}
		var notes []string
		for _, rk := range [][2]string{{"company", "https://" + domain + "/.well-known/trooth-keys.json"}, {"trooth", strings.TrimRight(c.APIBase, "/") + "/public/semanto/.well-known/trooth-keys.json"}} {
			status, _, body, err := c.get(ctx, rk[1], "application/json")
			if err != nil || status != 200 {
				notes = append(notes, fmt.Sprintf("%s could not be read (%v %d)", rk[1], err, status))
				continue
			}
			var j any
			if json.Unmarshal(body, &j) == nil {
				raw[rk[0]] = j
			}
		}
		return keysAndNotes{keys: CollectKeys(raw), notes: notes}
	}).(keysAndNotes)
	return v.keys, v.notes
}

// DNSKeyIDs returns the kids the domain's _trooth-keys TXT record names, or nil when DNS could not be asked.
func (c *Client) DNSKeyIDs(ctx context.Context, domain string) []string {
	if c.DoH == "" {
		return nil
	}
	v := c.remember("dns:"+domain, func() any {
		q := url.Values{"name": {"_trooth-keys." + domain}, "type": {"TXT"}}
		status, _, body, err := c.get(ctx, c.DoH+"?"+q.Encode(), "application/dns-json")
		if err != nil || status != 200 {
			return []string(nil)
		}
		var d struct {
			Answer []struct {
				Type int    `json:"type"`
				Data string `json:"data"`
			} `json:"Answer"`
		}
		if json.Unmarshal(body, &d) != nil {
			return []string(nil)
		}
		txt := []string{}
		for _, a := range d.Answer {
			if a.Type == 16 {
				txt = append(txt, strings.ReplaceAll(strings.Trim(a.Data, `"`), `" "`, ""))
			}
		}
		return ParseDNSKeyRecords(txt)
	}).([]string)
	return v
}

// Read fetches u with Accept: text/markdown and checks it.
func (c *Client) Read(ctx context.Context, u string) (Read, error) {
	return c.ReadAs(ctx, u, "text/markdown")
}

// ReadAs fetches u with the given Accept header and checks it.
func (c *Client) ReadAs(ctx context.Context, u, accept string) (Read, error) {
	parsed, err := url.Parse(u)
	if err != nil {
		return Read{}, err
	}
	status, h, body, err := c.get(ctx, u, accept)
	if err != nil {
		return Read{}, err
	}
	headers := map[string]string{}
	for k, vs := range h {
		headers[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	keys, notes := c.KeysFor(ctx, parsed.Hostname())
	res := VerifyResponse(status, headers, body, keys, c.Now(), ResponseOptions{})
	out := Read{OK: res.OK, Reason: res.Reason, Status: status, Text: string(body), Version: headers["trooth-semanto-version"], SignedBy: headers["trooth-signed-by"], KeyID: res.KeyID, Checks: res.Checks, Notes: notes}
	if res.KeyID != "" && !strings.EqualFold(headers["trooth-signed-by"], "witness") {
		if kids := c.DNSKeyIDs(ctx, parsed.Hostname()); kids != nil {
			found := false
			for _, k := range kids {
				if k == res.KeyID {
					found = true
				}
			}
			out.DNS = &found
		}
	}
	return out, nil
}
