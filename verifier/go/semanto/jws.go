// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ed25519 JWKs (RFC 8037, RFC 7638 thumbprints as key ids) and JWS compact
// serialization (RFC 7515) over RFC 8785 payloads, with crypto/ed25519 only.
package semanto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// JWSTypes are the Trooth statement types a verifier checks before trusting a signature's meaning.
var JWSTypes = map[string]string{
	"semantoVersion":    "https://trooth.co/types/semanto-version",
	"witness":           "https://trooth.co/types/witness-statement",
	"receipt":           "https://trooth.co/types/coverage-receipt",
	"treeHead":          "https://trooth.co/types/signed-tree-head",
	"offer":             "https://trooth.co/types/signed-offer",
	"productRecord":     "https://trooth.co/types/product-record",
	"sellerAttestation": "https://trooth.co/types/seller-attestation",
	"recall":            "https://trooth.co/types/recall-notice",
	"firstPublication":  "https://trooth.co/types/first-publication",
	"readReceipt":       "https://trooth.co/types/read-receipt",
	"revocation":        "https://trooth.co/types/revocation-list",
	"contentSignals":    "https://trooth.co/types/content-signals",
}

// JWK is an Ed25519 public key as published in a JWK Set.
type JWK struct {
	Kty       string `json:"kty"`
	Crv       string `json:"crv"`
	X         string `json:"x"`
	Kid       string `json:"kid"`
	Alg       string `json:"alg,omitempty"`
	Use       string `json:"use,omitempty"`
	Nbf       string `json:"nbf,omitempty"`
	Exp       string `json:"exp,omitempty"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

// KeySet holds every key a verifier may trust. Build one with CollectKeys.
type KeySet struct {
	Keys []JWK
}

// CollectKeys walks any JSON shape (a JWKS, a list of JWKS, a map of names to
// JWKS, or the vectors' keys.json) and gathers the Ed25519 keys in it.
func CollectKeys(v any) KeySet {
	var ks KeySet
	collectKeys(v, &ks)
	return ks
}

func collectKeys(v any, ks *KeySet) {
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			collectKeys(e, ks)
		}
	case map[string]any:
		if list, ok := x["keys"].([]any); ok {
			for _, e := range list {
				if m, ok := e.(map[string]any); ok {
					if j, ok := jwkFromMap(m); ok {
						ks.Keys = append(ks.Keys, j)
					}
				}
			}
			return
		}
		if j, ok := x["jwks"]; ok {
			collectKeys(j, ks)
			return
		}
		if x["kty"] == "OKP" {
			if j, ok := jwkFromMap(x); ok {
				ks.Keys = append(ks.Keys, j)
			}
			return
		}
		for _, e := range x {
			collectKeys(e, ks)
		}
	case KeySet:
		ks.Keys = append(ks.Keys, x.Keys...)
	case *KeySet:
		if x != nil {
			ks.Keys = append(ks.Keys, x.Keys...)
		}
	case JWK:
		ks.Keys = append(ks.Keys, x)
	}
}

func jwkFromMap(m map[string]any) (JWK, bool) {
	b, err := json.Marshal(m)
	if err != nil {
		return JWK{}, false
	}
	var j JWK
	if err := json.Unmarshal(b, &j); err != nil || j.Kty != "OKP" || j.Crv != "Ed25519" || j.X == "" {
		return JWK{}, false
	}
	return j, true
}

// Resolve finds the key with this kid, or nil.
func (ks KeySet) Resolve(kid string) *JWK {
	for i := range ks.Keys {
		if ks.Keys[i].Kid == kid {
			return &ks.Keys[i]
		}
	}
	return nil
}

// PublicKey decodes the key's x member.
func (j JWK) PublicKey() (ed25519.PublicKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(j.X)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errBadKey
	}
	return ed25519.PublicKey(b), nil
}

type verifyError string

func (e verifyError) Error() string { return string(e) }

const errBadKey = verifyError("bad key")

// Thumbprint is the RFC 7638 thumbprint of an OKP key.
func Thumbprint(j JWK) string {
	s := MustCanonicalize(map[string]any{"crv": j.Crv, "kty": j.Kty, "x": j.X})
	h := sha256.Sum256([]byte(s))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// Ed25519Verify checks a raw signature with a JWK.
func Ed25519Verify(j JWK, sig, data []byte) bool {
	pub, err := j.PublicKey()
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, data, sig)
}

// ParseTime reads ISO 8601 UTC with or without fractional seconds.
func ParseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

// KeyValidAt returns "" when the key may be used at t, else a reason code.
func KeyValidAt(j JWK, t time.Time) string {
	if j.Nbf != "" {
		if nbf, err := ParseTime(j.Nbf); err == nil && t.Before(nbf) {
			return "key_not_yet_valid"
		}
	}
	if j.Exp != "" {
		if exp, err := ParseTime(j.Exp); err == nil && !t.Before(exp) {
			return "key_expired"
		}
	}
	if j.RevokedAt != "" {
		if r, err := ParseTime(j.RevokedAt); err == nil && !t.Before(r) {
			return "key_revoked"
		}
	}
	return ""
}

var dnsKeyRe = regexp.MustCompile(`^v=trooth1;\s*kid=([A-Za-z0-9_-]{43})$`)

// ParseDNSKeyRecords reads the kids out of _trooth TXT records.
func ParseDNSKeyRecords(txt []string) []string {
	var out []string
	for _, t := range txt {
		t = strings.Trim(strings.TrimSpace(t), `"`)
		if m := dnsKeyRe.FindStringSubmatch(t); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// JWSResult is the outcome of VerifyJWS.
type JWSResult struct {
	OK      bool
	Reason  string
	Header  map[string]any
	Payload any
	Kid     string
}

// VerifyJWS checks a compact (h.p.s) or detached (h..s) JWS. For a detached
// JWS pass the payload; its canonical bytes are what was signed.
func VerifyJWS(jws string, keys KeySet, expectTyp string, payload any, at time.Time) JWSResult {
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return JWSResult{Reason: "malformed"}
	}
	h, pGiven, s := parts[0], parts[1], parts[2]
	hb, err := base64.RawURLEncoding.DecodeString(h)
	if err != nil {
		return JWSResult{Reason: "malformed"}
	}
	var header map[string]any
	if err := DecodeJSON(hb, &header); err != nil {
		return JWSResult{Reason: "malformed"}
	}
	kid, _ := header["kid"].(string)
	if header["alg"] != "EdDSA" || kid == "" {
		return JWSResult{Reason: "malformed"}
	}
	if expectTyp != "" && header["typ"] != expectTyp {
		return JWSResult{Reason: "wrong_type"}
	}
	p := pGiven
	if p == "" {
		if payload == nil {
			return JWSResult{Reason: "malformed"}
		}
		cb, err := CanonicalBytes(payload)
		if err != nil {
			return JWSResult{Reason: "malformed"}
		}
		p = base64.RawURLEncoding.EncodeToString(cb)
	}
	jwk := keys.Resolve(kid)
	if jwk == nil {
		return JWSResult{Reason: "unknown_key"}
	}
	if r := KeyValidAt(*jwk, at); r != "" {
		return JWSResult{Reason: r}
	}
	sig, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return JWSResult{Reason: "malformed"}
	}
	if !Ed25519Verify(*jwk, sig, []byte(h+"."+p)) {
		return JWSResult{Reason: "bad_signature"}
	}
	if nbf, ok := header["nbf"].(string); ok && nbf != "" {
		if t, err := ParseTime(nbf); err == nil && at.Before(t) {
			return JWSResult{Reason: "not_yet_valid"}
		}
	}
	if exp, ok := header["exp"].(string); ok && exp != "" {
		if t, err := ParseTime(exp); err == nil && !at.Before(t) {
			return JWSResult{Reason: "expired"}
		}
	}
	pb, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return JWSResult{Reason: "malformed"}
	}
	var body any
	if err := DecodeJSON(pb, &body); err != nil {
		return JWSResult{Reason: "malformed"}
	}
	return JWSResult{OK: true, Header: header, Payload: body, Kid: kid}
}
