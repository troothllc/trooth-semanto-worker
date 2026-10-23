// SPDX-License-Identifier: Apache-2.0
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
	"semantoVersion":     "https://trooth.co/types/semanto-version",
	"witness":            "https://trooth.co/types/witness-statement",
	"receipt":            "https://trooth.co/types/coverage-receipt",
	"treeHead":           "https://trooth.co/types/signed-tree-head",
	"offer":              "https://trooth.co/types/signed-offer",
	"productRecord":      "https://trooth.co/types/product-record",
	"sellerAttestation":  "https://trooth.co/types/seller-attestation",
	"recall":             "https://trooth.co/types/recall-notice",
	"marketplaceCatalog": "https://trooth.co/types/marketplace-catalog",
	"firstPublication":   "https://trooth.co/types/first-publication",
	"readReceipt":        "https://trooth.co/types/read-receipt",
	"revocation":         "https://trooth.co/types/revocation-list",
	"contentSignals":     "https://trooth.co/types/content-signals",
	"sellerList":         "https://trooth.co/types/seller-list",
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

// KeySet holds the keys a verifier may trust, kept apart by role. Build one
// with CollectKeys. Keys holds every key; Company, Trooth and Agent hold the
// role sets when the input named them ({ "company", "trooth", "agent" }, the
// vectors' keys.json shape).
type KeySet struct {
	Keys     []JWK
	Company  []JWK
	Trooth   []JWK
	Agent    []JWK
	HasRoles bool
}

var roleNames = []string{"company", "trooth", "agent"}

// CollectKeys walks any JSON shape (a JWKS, a list of JWKS, a map of names to
// JWKS, or the vectors' keys.json) and gathers the Ed25519 keys in it. A map
// with company, trooth or agent members keeps those sets apart by role.
func CollectKeys(v any) KeySet {
	var ks KeySet
	if m, ok := v.(map[string]any); ok {
		for _, r := range roleNames {
			if _, has := m[r]; has {
				ks.HasRoles = true
			}
		}
		if ks.HasRoles {
			for _, r := range roleNames {
				var part KeySet
				collectKeys(m[r], &part)
				switch r {
				case "company":
					ks.Company = part.Keys
				case "trooth":
					ks.Trooth = part.Keys
				case "agent":
					ks.Agent = part.Keys
				}
				for _, k := range part.Keys {
					ks.Keys = append(ks.Keys, k)
				}
			}
			return ks
		}
	}
	collectKeys(v, &ks)
	return ks
}

// Role returns the keys for one role: company signatures resolve only against
// the company's set, witness statements, tree heads, checkpoints and
// revocation lists only against Trooth's, Web Bot Auth requests only against
// the agent's. A set without roles is used as given (the caller chose it for
// this one check).
func (ks KeySet) Role(role string) KeySet {
	if !ks.HasRoles {
		return KeySet{Keys: ks.Keys}
	}
	switch role {
	case "company":
		return KeySet{Keys: ks.Company}
	case "trooth":
		return KeySet{Keys: ks.Trooth}
	case "agent":
		return KeySet{Keys: ks.Agent}
	}
	return KeySet{}
}

// StrictRole is Role for checks of two roles at once: a set without roles is
// the company's, and Trooth's is then empty, so no company key passes as a witness.
func (ks KeySet) StrictRole(role string) KeySet {
	if ks.HasRoles {
		return ks.Role(role)
	}
	if role == "company" {
		return KeySet{Keys: ks.Keys}
	}
	return KeySet{}
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
		for _, k := range x.Keys {
			ks.Keys = append(ks.Keys, k)
		}
	case *KeySet:
		if x != nil {
			for _, k := range x.Keys {
				ks.Keys = append(ks.Keys, k)
			}
		}
	case nil:
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

// KeyCheck is the outcome of KeyValidAtSigning.
type KeyCheck struct {
	OK     bool
	Reason string
	Notes  []string
}

// KeyValidAtSigning judges a key at the moment the statement was signed (its
// iat), not when it is checked. A key valid at iat verifies after rotation; a
// key revoked at or before iat fails; a key revoked after iat verifies with
// the note "key revoked after signing on <date>". Revocation for compromise
// backdates revoked_at to the compromise, which invalidates later signatures.
func KeyValidAtSigning(j JWK, iat time.Time) KeyCheck {
	parse := func(s string) (time.Time, bool, bool) {
		if s == "" {
			return time.Time{}, false, true
		}
		t, err := ParseTime(s)
		return t, err == nil, err == nil
	}
	nbf, hasNbf, ok1 := parse(j.Nbf)
	exp, hasExp, ok2 := parse(j.Exp)
	rev, hasRev, ok3 := parse(j.RevokedAt)
	if !ok1 || !ok2 || !ok3 {
		return KeyCheck{Reason: "malformed"}
	}
	if hasNbf && iat.Before(nbf) {
		return KeyCheck{Reason: "key_not_yet_valid"}
	}
	if hasExp && !iat.Before(exp) {
		return KeyCheck{Reason: "key_expired"}
	}
	if hasRev && !iat.Before(rev) {
		return KeyCheck{Reason: "key_revoked"}
	}
	var notes []string
	if hasRev {
		notes = append(notes, "key revoked after signing on "+j.RevokedAt)
	}
	return KeyCheck{OK: true, Notes: notes}
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
	// Notes are sentences a reader can weigh, such as a key revoked after signing.
	Notes []string
}

// headerTime reads an optional ISO 8601 member: absent is fine, present must be a string that parses.
func headerTime(h map[string]any, k string) (time.Time, bool, bool) {
	v, present := h[k]
	if !present || v == nil {
		return time.Time{}, false, true
	}
	s, isStr := v.(string)
	if !isStr {
		return time.Time{}, false, false
	}
	t, err := ParseTime(s)
	if err != nil {
		return time.Time{}, false, false
	}
	return t, true, true
}

// VerifyJWS checks a compact (h.p.s) or detached (h..s) JWS against keys.Keys.
// When the caller passes the payload it expects, the JWS payload segment must
// be empty or byte-equal to base64url(canonical(payload)); anything else is
// "payload_mismatch". Without it, the embedded payload is returned and the
// caller compares it. The key is judged at the statement's iat; nbf and exp
// at `at`. A header that is not a JSON object, or whose iat, nbf or exp does
// not parse, is malformed.
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
	if err := DecodeJSON(hb, &header); err != nil || header == nil {
		return JWSResult{Reason: "malformed"}
	}
	kid, _ := header["kid"].(string)
	if header["alg"] != "EdDSA" || kid == "" {
		return JWSResult{Reason: "malformed"}
	}
	if expectTyp != "" && header["typ"] != expectTyp {
		return JWSResult{Reason: "wrong_type"}
	}
	iat, hasIat, ok1 := headerTime(header, "iat")
	nbf, hasNbf, ok2 := headerTime(header, "nbf")
	exp, hasExp, ok3 := headerTime(header, "exp")
	if !ok1 || !ok2 || !ok3 {
		return JWSResult{Reason: "malformed"}
	}
	var p string
	if payload != nil {
		cb, err := CanonicalBytes(payload)
		if err != nil {
			return JWSResult{Reason: "malformed"}
		}
		expected := base64.RawURLEncoding.EncodeToString(cb)
		if pGiven != "" && pGiven != expected {
			return JWSResult{Reason: "payload_mismatch"}
		}
		p = expected
	} else {
		if pGiven == "" {
			return JWSResult{Reason: "malformed"}
		}
		p = pGiven
	}
	jwk := keys.Resolve(kid)
	if jwk == nil {
		return JWSResult{Reason: "unknown_key"}
	}
	sig, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return JWSResult{Reason: "malformed"}
	}
	if !Ed25519Verify(*jwk, sig, []byte(h+"."+p)) {
		return JWSResult{Reason: "bad_signature"}
	}
	signedAt := at
	if hasIat {
		signedAt = iat
	}
	kv := KeyValidAtSigning(*jwk, signedAt)
	if !kv.OK {
		return JWSResult{Reason: kv.Reason}
	}
	if hasNbf && at.Before(nbf) {
		return JWSResult{Reason: "not_yet_valid"}
	}
	if hasExp && !at.Before(exp) {
		return JWSResult{Reason: "expired"}
	}
	pb, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return JWSResult{Reason: "malformed"}
	}
	var body any
	if err := DecodeJSON(pb, &body); err != nil {
		return JWSResult{Reason: "malformed"}
	}
	return JWSResult{OK: true, Header: header, Payload: body, Kid: kid, Notes: kv.Notes}
}
