// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// Runs every shared vector in verifier/test-vectors/v1 through the Go
// verifier, positive and negative, plus the RFC 6962 known roots and the
// RFC 8785 cases the other kits test. Run: go test ./semanto/
package semanto

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var vectorDir = filepath.Join("..", "..", "test-vectors", "v1")

func readVector(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorDir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var v map[string]any
	if err := DecodeJSON(b, &v); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return v
}

func at(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := ParseTime(s)
	if err != nil {
		t.Fatalf("time %q: %v", s, err)
	}
	return tm
}

type outcome struct {
	ok        bool
	reason    string
	state     string
	keyid     string
	agent     string
	versionID string
	notes     []string
}

func run(t *testing.T, v map[string]any, keys KeySet, semanto map[string]any) outcome {
	now := getStr(v, "now")
	// A vector may carry its own keys (a rotated or revoked key) and its own page bytes (a forged page).
	if own := getMap(v, "keys"); own != nil {
		keys = CollectKeys(own)
	}
	switch getStr(v, "kind") {
	case "semanto-file":
		byURL := getMap(v, "pages_by_url")
		if byURL == nil {
			byURL = getMap(readVector(t, "pages.json"), "by_url")
		}
		pages := map[string][]byte{}
		for url, md := range byURL {
			pages[url] = []byte(md.(string))
		}
		r := VerifySemanto(getMap(v, "file"), pages, keys, at(t, now), nil)
		return outcome{r.OK, r.Reason, r.State, "", "", r.VersionID, r.Notes}
	case "tree-head":
		r := VerifyTreeHead(getMap(v, "tree_head"), keys, at(t, now))
		return outcome{ok: r.OK, reason: r.Reason}
	case "page-proof":
		r := VerifyPageProof(getMap(v, "proof"), []byte(getStr(v, "page_markdown")), keys, at(t, now), getMap(v, "header"))
		return outcome{ok: r.OK, reason: r.Reason, versionID: r.VersionID}
	case "response":
		resp := getMap(v, "response")
		status, _ := getInt(resp, "status")
		headers := map[string]string{}
		for k, val := range getMap(resp, "headers") {
			headers[k] = val.(string)
		}
		nowEpoch, _ := getInt(v, "now_epoch")
		r := VerifyResponse(status, headers, []byte(getStr(resp, "body")), keys, time.Unix(int64(nowEpoch), 0), ResponseOptions{})
		return outcome{ok: r.OK, reason: r.Reason, keyid: r.KeyID}
	case "web-bot-auth-request":
		req := getMap(v, "request")
		headers := map[string]string{}
		for k, val := range getMap(req, "headers") {
			headers[k] = val.(string)
		}
		nowEpoch, _ := getInt(v, "now_epoch")
		r := VerifyWebBotAuthRequest(getStr(req, "method"), getStr(req, "url"), headers, keys, time.Unix(int64(nowEpoch), 0))
		return outcome{ok: r.OK, reason: r.Reason, keyid: r.KeyID, agent: r.Agent}
	case "offer":
		r, _ := VerifyOffer(getStr(v, "jws"), keys, at(t, now))
		return outcome{ok: r.OK, reason: r.Reason}
	case "witness":
		r := VerifyJWS(getStr(v, "jws"), keys, JWSTypes["witness"], getMap(v, "payload"), at(t, now))
		return outcome{ok: r.OK, reason: r.Reason}
	case "revocations":
		l := VerifyRevocationList(getStr(v, "jws"), keys, at(t, now))
		var payload map[string]any
		if l.OK {
			payload, _ = l.Payload.(map[string]any)
		}
		return outcome{ok: l.OK, reason: l.Reason, state: StateOf(getMap(semanto, "file"), at(t, now), payload, 0)}
	case "log":
		incl := VerifyInclusionInLog(getMap(v, "inclusion"), "")
		cons := VerifyConsistency(getMap(v, "consistency"))
		heads := getMap(v, "tree_heads")
		th3 := VerifyTreeHead(getMap(heads, "3"), keys, at(t, now))
		th5 := VerifyTreeHead(getMap(heads, "5"), keys, at(t, now))
		cp := VerifyCheckpoint(getStr(v, "checkpoint"), keys, getStr(v, "origin"))
		ok := incl && cons && th3.OK && th5.OK && cp.OK && cp.RootHash == getStr(getMap(v, "inclusion"), "root_hash")
		if !ok {
			t.Logf("incl=%v cons=%v th3=%+v th5=%+v cp=%+v", incl, cons, th3, th5, cp)
			return outcome{reason: "log_check_failed"}
		}
		return outcome{ok: true}
	case "pages":
		return outcome{ok: true}
	}
	t.Fatalf("unknown vector kind %q", getStr(v, "kind"))
	return outcome{}
}

func TestVectors(t *testing.T) {
	keys := CollectKeys(readVector(t, "keys.json"))
	if len(keys.Keys) != 3 {
		t.Fatalf("expected 3 keys, got %d", len(keys.Keys))
	}
	semanto := readVector(t, "semanto.json")
	manifest := readVector(t, "manifest.json")
	for _, f := range getStrList(manifest, "files") {
		if f == "keys.json" {
			continue
		}
		name := f
		t.Run(name, func(t *testing.T) {
			v := readVector(t, name)
			expect := getMap(v, "expect")
			got := run(t, v, keys, semanto)
			if wantOK, _ := expect["ok"].(bool); got.ok != wantOK {
				t.Fatalf("%s: ok=%v want %v (reason %q)", name, got.ok, wantOK, got.reason)
			}
			if r := getStr(expect, "reason"); r != "" && got.reason != r {
				t.Fatalf("%s: reason %q want %q", name, got.reason, r)
			}
			if s := getStr(expect, "state"); s != "" && got.state != s {
				t.Fatalf("%s: state %q want %q", name, got.state, s)
			}
			if k := getStr(expect, "keyid"); k != "" && got.keyid != k {
				t.Fatalf("%s: keyid %q want %q", name, got.keyid, k)
			}
			if a := getStr(expect, "agent"); a != "" && got.agent != a {
				t.Fatalf("%s: agent %q want %q", name, got.agent, a)
			}
			if id := getStr(expect, "version_id"); id != "" && got.versionID != id {
				t.Fatalf("%s: version_id %q want %q", name, got.versionID, id)
			}
			if n := getStr(expect, "note"); n != "" {
				found := false
				for _, x := range got.notes {
					if strings.Contains(x, n) {
						found = true
					}
				}
				if !found {
					t.Fatalf("%s: no note containing %q in %v", name, n, got.notes)
				}
			}
		})
	}
}

func TestCanonicalJSON(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"b":1,"a":[true,null,"x"],"é":2,"A":3}`, `{"A":3,"a":[true,null,"x"],"b":1,"é":2}`},
		{`{"s":"line\nbreak\t\"q\"\\"}`, `{"s":"line\nbreak\t\"q\"\\"}`},
		{`{"n":49.0,"m":-0}`, `{"m":0,"n":49}`},
		{`{"！":1,"😀":2}`, `{"😀":2,"！":1}`},
	}
	for _, c := range cases {
		var v any
		if err := DecodeJSON([]byte(c.in), &v); err != nil {
			t.Fatal(err)
		}
		got, err := Canonicalize(v)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("canonicalize(%s) = %s want %s", c.in, got, c.want)
		}
	}
	var v any
	_ = DecodeJSON([]byte(`{"price":49.99}`), &v)
	if _, err := Canonicalize(v); err == nil {
		t.Error("a non-integer number must be an error")
	}
}

func TestHashesMatchTheFile(t *testing.T) {
	doc := readVector(t, "semanto.json")
	file := getMap(doc, "file")
	h := getMap(file, "header")
	if r, _ := RootHash(h); r != getStr(file, "root_hash") {
		t.Errorf("root_hash %s want %s", r, getStr(file, "root_hash"))
	}
	if p, _ := PagesRoot(getList(h, "pages_manifest")); p != getStr(h, "pages_root") {
		t.Errorf("pages_root %s", p)
	}
	if f, _ := FactsRoot(getList(file, "facts")); f != getStr(h, "facts_root") {
		t.Errorf("facts_root %s", f)
	}
	if VersionID(getStr(file, "root_hash")) != getStr(getMap(doc, "expect"), "version_id") {
		t.Errorf("version id")
	}
	for _, k := range CollectKeys(readVector(t, "keys.json")).Keys {
		if Thumbprint(k) != k.Kid {
			t.Errorf("kid %s is not the RFC 7638 thumbprint", k.Kid)
		}
	}
}

func TestRFC6962KnownRoots(t *testing.T) {
	leaves := [][]byte{{}, {0x00}, {0x10}, {0x20, 0x21}, {0x30, 0x31}, {0x40, 0x41, 0x42, 0x43}, {0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57}, {0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f}}
	var hashed [][]byte
	for _, l := range leaves {
		hashed = append(hashed, LeafHash(l))
	}
	if got := hex.EncodeToString(RootFromLeafHashes(hashed)); got != "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328" {
		t.Errorf("root of 8: %s", got)
	}
	if got := hex.EncodeToString(RootFromLeafHashes(hashed[:3])); got != "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77" {
		t.Errorf("root of 3: %s", got)
	}
	if got := hex.EncodeToString(RootFromLeafHashes(nil)); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Errorf("empty root: %s", got)
	}
}

func TestTamperingInEachLayer(t *testing.T) {
	keys := CollectKeys(readVector(t, "keys.json"))
	v := readVector(t, "page-proof.json")
	now := at(t, getStr(v, "now"))
	swapped := readVector(t, "page-proof.json")
	path := getList(getMap(getMap(swapped, "proof"), "inclusion"), "path")
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	if r := VerifyPageProof(getMap(swapped, "proof"), []byte(getStr(v, "page_markdown")), keys, now, getMap(v, "header")); r.OK || r.Reason != "pages_root_mismatch" {
		t.Errorf("swapped path: %+v", r)
	}
	edited := readVector(t, "page-proof.json")
	getMap(edited, "header")["org"] = "Acme Incorporated"
	if r := VerifyPageProof(getMap(v, "proof"), []byte(getStr(v, "page_markdown")), keys, now, getMap(edited, "header")); r.OK || r.Reason != "root_hash_mismatch" {
		t.Errorf("edited header: %+v", r)
	}
	wrongLeaf := readVector(t, "page-proof.json")
	getMap(getMap(getMap(wrongLeaf, "proof"), "ledger"), "leaf")["hash"] = Digest([]byte("another root"))
	if r := VerifyPageProof(getMap(wrongLeaf, "proof"), []byte(getStr(v, "page_markdown")), keys, now, getMap(v, "header")); r.Reason != "log_leaf_mismatch" {
		t.Errorf("wrong leaf: %+v", r)
	}
	// Strict: without the version header the proof is not tied to a signed version.
	if r := VerifyPageProof(getMap(v, "proof"), []byte(getStr(v, "page_markdown")), keys, now, nil); r.OK || r.Reason != "header_absent" {
		t.Errorf("no header must fail with header_absent: %+v", r)
	}
	resp := readVector(t, "response.json")
	rr := getMap(resp, "response")
	headers := map[string]string{}
	for k, val := range getMap(rr, "headers") {
		headers[k] = val.(string)
	}
	nowEpoch, _ := getInt(resp, "now_epoch")
	if r := VerifyResponse(200, headers, []byte(getStr(rr, "body")+" "), keys, time.Unix(int64(nowEpoch), 0), ResponseOptions{}); r.Reason != "content_digest_mismatch" {
		t.Errorf("changed body: %+v", r)
	}
	if r := VerifyResponse(200, headers, []byte(getStr(rr, "body")), keys, time.Unix(int64(nowEpoch), 0), ResponseOptions{Tag: "web-bot-auth"}); r.Reason != "wrong_tag" {
		t.Errorf("wrong tag: %+v", r)
	}
	wba := readVector(t, "web-bot-auth-request.json")
	req := getMap(wba, "request")
	rh := map[string]string{}
	for k, val := range getMap(req, "headers") {
		rh[k] = val.(string)
	}
	ne, _ := getInt(wba, "now_epoch")
	if r := VerifyWebBotAuthRequest("GET", "https://other.example/security", rh, keys, time.Unix(int64(ne), 0)); r.Reason != "bad_signature" {
		t.Errorf("other authority: %+v", r)
	}
}

func TestStateOf(t *testing.T) {
	file := getMap(readVector(t, "semanto.json"), "file")
	smv := VersionID(getStr(file, "root_hash"))
	if s := StateOf(file, at(t, "2026-10-22T12:00:10Z"), nil, 0); s != "current" {
		t.Errorf("current: %s", s)
	}
	if s := StateOf(file, at(t, "2026-10-01T00:00:00Z"), nil, 0); s != "behind" {
		t.Errorf("behind: %s", s)
	}
	if s := StateOf(file, at(t, "2027-03-01T00:00:00Z"), nil, 0); s != "expired" {
		t.Errorf("expired: %s", s)
	}
	if s := StateOf(file, at(t, "2026-10-22T12:00:10Z"), nil, 2); s != "superseded" {
		t.Errorf("superseded: %s", s)
	}
	rev := map[string]any{"revocations": []any{map[string]any{"kind": "version", "ref": smv, "revoked_at": "2026-10-22T12:00:05Z"}}}
	if s := StateOf(file, at(t, "2026-10-22T12:00:10Z"), rev, 0); s != "withdrawn" {
		t.Errorf("withdrawn: %s", s)
	}
	later := map[string]any{"revocations": []any{map[string]any{"kind": "version", "ref": smv, "revoked_at": "2026-10-23T00:00:00Z"}}}
	if s := StateOf(file, at(t, "2026-10-22T12:00:10Z"), later, 0); s != "current" {
		t.Errorf("future revocation: %s", s)
	}
}

// Review finding 19: the kit's registry matches src/core/jws.ts JWS_TYPES, marketplaceCatalog included.
func TestJWSTypesIncludeEveryCoreType(t *testing.T) {
	if JWSTypes["marketplaceCatalog"] != "https://trooth.co/types/marketplace-catalog" || len(JWSTypes) != 13 {
		t.Fatalf("JWSTypes: %v", JWSTypes)
	}
}
