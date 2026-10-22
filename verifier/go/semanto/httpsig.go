// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// HTTP Message Signatures (RFC 9421) with Content-Digest (RFC 9530): the
// Semanto response signature (tag trooth-semanto) and the Web Bot Auth
// request signature (tag web-bot-auth, draft-ietf-webbotauth-httpsig-protocol).
package semanto

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SemantoResponseComponents are the components Semanto covers on every response.
var SemantoResponseComponents = []string{"@status", "content-type", "content-digest", "trooth-semanto-version", "trooth-page-hash"}

// Tags.
const (
	SemantoResponseTag = "trooth-semanto"
	WebBotAuthTag      = "web-bot-auth"
)

// WebBotAuthRequired are the components a Web Bot Auth signature must cover.
var WebBotAuthRequired = []string{"@authority", "signature-agent"}

// Message is a request or response to check.
type Message struct {
	Kind    string // "request" or "response"
	Method  string
	URL     string
	Status  int
	Headers map[string]string
}

// SignatureParams are the parameters of one signature.
type SignatureParams struct {
	Created int64
	Expires int64
	HasExp  bool
	KeyID   string
	Alg     string
	Nonce   string
	Tag     string
}

type sigInput struct {
	Components []string
	Params     SignatureParams
	Raw        string
}

// HeaderGet reads a header case-insensitively.
func HeaderGet(h map[string]string, name string) (string, bool) {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			return v, true
		}
	}
	return "", false
}

var (
	inputRe = regexp.MustCompile(`([A-Za-z0-9_*.-]+)=\(((?:\s*"(?:[^"\\]|\\.)*")*)\s*\)((?:;[A-Za-z*][A-Za-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))?)*)`)
	compRe  = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)
	paramRe = regexp.MustCompile(`;([A-Za-z*][A-Za-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|[^;,\s]+))?`)
	sigRe   = regexp.MustCompile(`([A-Za-z0-9_*.-]+)=:([A-Za-z0-9+/=]+):`)
	unescRe = regexp.MustCompile(`\\(.)`)
	foldRe  = regexp.MustCompile("[\r\n]+[ \t]+")
)

// ParseSignatureInput parses a Signature-Input field.
func ParseSignatureInput(value string) map[string]sigInput {
	out := map[string]sigInput{}
	for _, m := range inputRe.FindAllStringSubmatch(value, -1) {
		label, compsRaw, paramsRaw := m[1], m[2], m[3]
		var comps []string
		for _, c := range compRe.FindAllStringSubmatch(compsRaw, -1) {
			comps = append(comps, unescRe.ReplaceAllString(c[1], "$1"))
		}
		var p SignatureParams
		hasCreated := false
		for _, pm := range paramRe.FindAllStringSubmatch(paramsRaw, -1) {
			k, v := pm[1], pm[2]
			if strings.HasPrefix(v, `"`) {
				v = unescRe.ReplaceAllString(v[1:len(v)-1], "$1")
			}
			switch k {
			case "created":
				if n, err := strconv.ParseInt(v, 10, 64); err == nil {
					p.Created = n
					hasCreated = true
				}
			case "expires":
				if n, err := strconv.ParseInt(v, 10, 64); err == nil {
					p.Expires = n
					p.HasExp = true
				}
			case "keyid":
				p.KeyID = v
			case "alg":
				p.Alg = v
			case "nonce":
				p.Nonce = v
			case "tag":
				p.Tag = v
			}
		}
		if !hasCreated || p.KeyID == "" {
			continue
		}
		out[label] = sigInput{Components: comps, Params: p, Raw: "(" + strings.TrimSpace(compsRaw) + ")" + paramsRaw}
	}
	return out
}

// ParseSignature parses a Signature field.
func ParseSignature(value string) map[string][]byte {
	out := map[string][]byte{}
	for _, m := range sigRe.FindAllStringSubmatch(value, -1) {
		if b, err := base64.StdEncoding.DecodeString(m[2]); err == nil {
			out[m[1]] = b
		}
	}
	return out
}

func sfString(s string) (string, error) {
	for _, r := range s {
		if r < 0x20 || r > 0x7e {
			return "", fmt.Errorf("non-ASCII in structured field string")
		}
	}
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`, nil
}

func derived(name string, m Message) (string, error) {
	var u *url.URL
	if m.URL != "" {
		var err error
		if u, err = url.Parse(m.URL); err != nil {
			return "", err
		}
	}
	switch name {
	case "@method":
		if m.Kind != "request" || m.Method == "" {
			return "", fmt.Errorf("@method needs a request")
		}
		return strings.ToUpper(m.Method), nil
	case "@target-uri":
		if u == nil {
			return "", fmt.Errorf("@target-uri needs a url")
		}
		return m.URL, nil
	case "@authority":
		if u == nil {
			return "", fmt.Errorf("@authority needs a url")
		}
		return strings.ToLower(u.Host), nil
	case "@scheme":
		if u == nil {
			return "", fmt.Errorf("@scheme needs a url")
		}
		return strings.ToLower(u.Scheme), nil
	case "@path":
		if u == nil {
			return "", fmt.Errorf("@path needs a url")
		}
		if u.Path == "" {
			return "/", nil
		}
		return u.EscapedPath(), nil
	case "@query":
		if u == nil {
			return "", fmt.Errorf("@query needs a url")
		}
		if u.RawQuery == "" {
			return "?", nil
		}
		return "?" + u.RawQuery, nil
	case "@status":
		if m.Kind != "response" || m.Status == 0 {
			return "", fmt.Errorf("@status needs a response")
		}
		return strconv.Itoa(m.Status), nil
	}
	return "", fmt.Errorf("unsupported derived component %s", name)
}

// SignatureBase builds the RFC 9421 signature base.
func SignatureBase(m Message, components []string, rawParams string) (string, error) {
	var lines []string
	seen := map[string]bool{}
	for _, c := range components {
		key := strings.ToLower(c)
		if seen[key] {
			return "", fmt.Errorf("duplicate component %s", c)
		}
		seen[key] = true
		var value string
		if strings.HasPrefix(c, "@") {
			v, err := derived(c, m)
			if err != nil {
				return "", err
			}
			value = v
		} else {
			v, ok := HeaderGet(m.Headers, c)
			if !ok {
				return "", fmt.Errorf("missing header %s", c)
			}
			value = strings.TrimSpace(foldRe.ReplaceAllString(v, " "))
		}
		k, err := sfString(key)
		if err != nil {
			return "", err
		}
		lines = append(lines, k+": "+value)
	}
	lines = append(lines, `"@signature-params": `+rawParams)
	return strings.Join(lines, "\n"), nil
}

var contentDigestRe = regexp.MustCompile(`sha-256=:([A-Za-z0-9+/=]+):`)

// VerifyContentDigest checks an RFC 9530 sha-256 Content-Digest against the body.
func VerifyContentDigest(header string, body []byte) bool {
	m := contentDigestRe.FindStringSubmatch(header)
	if m == nil {
		return false
	}
	s := sha256.Sum256(body)
	return m[1] == base64.StdEncoding.EncodeToString(s[:])
}

// MessageResult is the outcome of VerifyMessage.
type MessageResult struct {
	OK         bool
	Reason     string
	Label      string
	KeyID      string
	Params     SignatureParams
	Components []string
	Agent      string
}

// VerifyOptions tune VerifyMessage.
type VerifyOptions struct {
	Required      []string
	Tag           string
	Now           int64 // unix seconds; zero means the clock
	MaxAgeSeconds int64 // zero means no limit
	SkewSeconds   int64 // zero means 60
}

// VerifyMessage checks the signatures on a message and returns the first that passes.
func VerifyMessage(m Message, keys KeySet, opts VerifyOptions) MessageResult {
	si, ok1 := HeaderGet(m.Headers, "signature-input")
	sg, ok2 := HeaderGet(m.Headers, "signature")
	if !ok1 || !ok2 || si == "" || sg == "" {
		return MessageResult{Reason: "no_signature"}
	}
	inputs := ParseSignatureInput(si)
	sigs := ParseSignature(sg)
	now := opts.Now
	if now == 0 {
		now = time.Now().Unix()
	}
	skew := opts.SkewSeconds
	if skew == 0 {
		skew = 60
	}
	last := MessageResult{Reason: "malformed"}
	found := false
	for label, in := range inputs {
		sig, ok := sigs[label]
		if !ok {
			continue
		}
		found = true
		p := in.Params
		if p.Alg != "" && p.Alg != "ed25519" {
			last = MessageResult{Reason: "unsupported_alg"}
			continue
		}
		if opts.Tag != "" && p.Tag != opts.Tag {
			last = MessageResult{Reason: "wrong_tag"}
			continue
		}
		missing := false
		for _, r := range opts.Required {
			found := false
			for _, c := range in.Components {
				if strings.EqualFold(c, r) {
					found = true
				}
			}
			if !found {
				missing = true
			}
		}
		if missing {
			last = MessageResult{Reason: "missing_component"}
			continue
		}
		if p.HasExp && now >= p.Expires {
			last = MessageResult{Reason: "expired"}
			continue
		}
		if p.Created > now+skew {
			last = MessageResult{Reason: "not_yet_valid"}
			continue
		}
		if opts.MaxAgeSeconds > 0 && now-p.Created > opts.MaxAgeSeconds {
			last = MessageResult{Reason: "too_old"}
			continue
		}
		jwk := keys.Resolve(p.KeyID)
		if jwk == nil {
			last = MessageResult{Reason: "unknown_key"}
			continue
		}
		if r := KeyValidAt(*jwk, time.Unix(now, 0).UTC()); r != "" {
			last = MessageResult{Reason: r}
			continue
		}
		base, err := SignatureBase(m, in.Components, in.Raw)
		if err != nil {
			last = MessageResult{Reason: "missing_component"}
			continue
		}
		if !Ed25519Verify(*jwk, sig, []byte(base)) {
			last = MessageResult{Reason: "bad_signature"}
			continue
		}
		return MessageResult{OK: true, Label: label, KeyID: p.KeyID, Params: p, Components: in.Components}
	}
	if !found {
		return MessageResult{Reason: "malformed"}
	}
	return last
}
