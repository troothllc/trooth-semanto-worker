// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The top-level Semanto checks: a whole file offline, a per-page proof, a
// signed response, tree heads, log inclusion and consistency, checkpoints,
// offers, revocation lists, and the state of a version at an instant. Results
// are lists of named checks in plain words; nothing here produces a number or
// a verdict about a company.
package semanto

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SchemaURL is the only schema this verifier reads.
const SchemaURL = "https://trooth.co/schemas/semanto/v1.json"

// Check is one line of what was checked.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Result is the outcome of a top-level check.
type Result struct {
	OK        bool    `json:"ok"`
	Reason    string  `json:"reason,omitempty"`
	Checks    []Check `json:"checks"`
	State     string  `json:"state,omitempty"`
	VersionID string  `json:"version_id,omitempty"`
	KeyID     string  `json:"key_id,omitempty"`
	Issues    []Issue `json:"issues,omitempty"`
}

// Issue is a structural problem found before hashing.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type checks struct {
	list   []Check
	reason string
}

func (c *checks) add(name string, ok bool, detail, reason string) bool {
	c.list = append(c.list, Check{name, ok, detail})
	if !ok && c.reason == "" {
		if reason == "" {
			reason = name
		}
		c.reason = reason
	}
	return ok
}

func (c *checks) note(name, detail string) { c.list = append(c.list, Check{name, true, detail}) }

func (c *checks) result() Result {
	ok := true
	for _, x := range c.list {
		ok = ok && x.OK
	}
	r := Result{OK: ok, Checks: c.list}
	if !ok {
		r.Reason = c.reason
	}
	return r
}

// ---------------------------------------------------------------- JSON access helpers

func getMap(m map[string]any, k string) map[string]any {
	v, _ := m[k].(map[string]any)
	return v
}

func getStr(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func getList(m map[string]any, k string) []any {
	v, _ := m[k].([]any)
	return v
}

func getInt(m map[string]any, k string) (int, bool) {
	switch v := m[k].(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		if v == float64(int(v)) {
			return int(v), true
		}
	case json.Number:
		if n, err := strconv.Atoi(string(v)); err == nil {
			return n, true
		}
	}
	return 0, false
}

func getStrList(m map[string]any, k string) []string {
	var out []string
	for _, x := range getList(m, k) {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func digestList(list []string) ([][]byte, error) {
	out := make([][]byte, 0, len(list))
	for _, s := range list {
		b, err := DigestBytes(s)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

// ---------------------------------------------------------------- ids and hashing

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567"

// SemantoID builds a content-addressed id: prefix, underscore, 26 base32 characters of the digest.
func SemantoID(prefix, d string) (string, error) {
	b, err := DigestBytes(d)
	if err != nil {
		return "", err
	}
	var bits strings.Builder
	for _, x := range b {
		bits.WriteString(fmt.Sprintf("%08b", x))
	}
	s := bits.String()
	var out strings.Builder
	for i := 0; i+5 <= len(s) && out.Len() < 26; i += 5 {
		n, _ := strconv.ParseInt(s[i:i+5], 2, 8)
		out.WriteByte(base32Alphabet[n])
	}
	return prefix + "_" + out.String(), nil
}

// VersionID is the smv_ id of a root_hash.
func VersionID(root string) string {
	id, _ := SemantoID("smv", root)
	return id
}

// PagesRoot is the RFC 6962 root over the manifest's page hashes in order.
func PagesRoot(manifest []any) (string, error) {
	var leaves [][]byte
	for _, p := range manifest {
		m, _ := p.(map[string]any)
		b, err := DigestBytes(getStr(m, "hash"))
		if err != nil {
			return "", err
		}
		leaves = append(leaves, LeafHash(b))
	}
	return "sha256:" + hex.EncodeToString(RootFromLeafHashes(leaves)), nil
}

// FactsRoot is the RFC 6962 root over canonical facts in id order.
func FactsRoot(facts []any) (string, error) {
	sorted := append([]any{}, facts...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, _ := sorted[i].(map[string]any)
		b, _ := sorted[j].(map[string]any)
		return getStr(a, "id") < getStr(b, "id")
	})
	var leaves [][]byte
	for _, f := range sorted {
		cb, err := CanonicalBytes(f)
		if err != nil {
			return "", err
		}
		leaves = append(leaves, LeafHash(cb))
	}
	return "sha256:" + hex.EncodeToString(RootFromLeafHashes(leaves)), nil
}

// TierHash is the digest of a tier's canonical JSON.
func TierHash(v any) (string, error) {
	cb, err := CanonicalBytes(v)
	if err != nil {
		return "", err
	}
	return Digest(cb), nil
}

// RootHash is the digest of the canonical header.
func RootHash(header map[string]any) (string, error) { return TierHash(header) }

// FactID is the smf_ id of a fact (its canonical form without id).
func FactID(fact map[string]any) (string, error) {
	rest := map[string]any{}
	for k, v := range fact {
		if k != "id" {
			rest[k] = v
		}
	}
	d, err := TierHash(rest)
	if err != nil {
		return "", err
	}
	return SemantoID("smf", d)
}

// ---------------------------------------------------------------- state

// StateOf returns the state at now in the ledger's words: current, superseded,
// behind (not yet valid), expired, withdrawn or unsigned. revocations is a
// signed revocation list payload ({ "revocations": [] }); latest is the newest
// version number known (0 when unknown), so an older version reads as superseded.
func StateOf(version map[string]any, now time.Time, revocations map[string]any, latest int) string {
	header := getMap(version, "header")
	hasHeader := header != nil
	if header == nil {
		header = version
	}
	root := getStr(version, "root_hash")
	if root == "" {
		root = getStr(header, "root_hash")
	}
	smv := ""
	if IsDigest(root) {
		smv = VersionID(root)
	}
	if revocations != nil {
		entries := getList(revocations, "revocations")
		if entries == nil {
			entries = getList(revocations, "entries")
		}
		if entries == nil {
			entries = getList(getMap(revocations, "payload"), "revocations")
		}
		for _, e := range entries {
			em, _ := e.(map[string]any)
			if getStr(em, "kind") != "version" {
				continue
			}
			ref := getStr(em, "ref")
			if (smv != "" && ref == smv) || (root != "" && ref == root) {
				ra := getStr(em, "revoked_at")
				if ra == "" {
					return "withdrawn"
				}
				if t, err := ParseTime(ra); err == nil && !now.Before(t) {
					return "withdrawn"
				}
			}
		}
	}
	state := getStr(header, "state")
	switch state {
	case "withdrawn":
		return "withdrawn"
	case "read", "confirmed":
		return "unsigned"
	}
	if state == "signed" && hasHeader && version["signature"] == nil {
		return "unsigned"
	}
	if na := getStr(header, "not_after"); na != "" {
		if t, err := ParseTime(na); err == nil && !now.Before(t) {
			return "expired"
		}
	}
	if nb := getStr(header, "not_before"); nb != "" {
		if t, err := ParseTime(nb); err == nil && now.Before(t) {
			return "behind"
		}
	}
	if v, ok := getInt(header, "version"); ok && latest > v {
		return "superseded"
	}
	if state == "signed" {
		return "current"
	}
	return "unsigned"
}

// ---------------------------------------------------------------- structure

var isoRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`)

func validate(file map[string]any) []Issue {
	var out []Issue
	push := func(p, m string) { out = append(out, Issue{p, m}) }
	h := getMap(file, "header")
	if h == nil {
		return []Issue{{"header", "missing"}}
	}
	if getStr(h, "schema") != SchemaURL {
		push("header.schema", "unknown schema")
	}
	if c, ok := getInt(h, "contract"); !ok || c != 1 {
		push("header.contract", "expected 1")
	}
	if getStr(h, "org") == "" {
		push("header.org", "required")
	}
	if len(getList(h, "domains")) == 0 {
		push("header.domains", "at least one domain")
	}
	if v, ok := getInt(h, "version"); !ok || v < 1 {
		push("header.version", "positive integer")
	}
	if !isoRe.MatchString(getStr(h, "built_at")) {
		push("header.built_at", "ISO 8601 UTC")
	}
	switch getStr(h, "state") {
	case "read", "confirmed", "signed", "withdrawn":
	default:
		push("header.state", "unknown state")
	}
	if !IsDigest(h["pages_root"]) {
		push("header.pages_root", "digest")
	}
	if !IsDigest(h["facts_root"]) {
		push("header.facts_root", "digest")
	}
	if _, ok := h["tiers"].([]any); !ok {
		push("header.tiers", "array")
	}
	manifest, ok := h["pages_manifest"].([]any)
	if !ok {
		push("header.pages_manifest", "array")
	} else {
		for i, p := range manifest {
			pm, _ := p.(map[string]any)
			if !IsDigest(pm["hash"]) {
				push(fmt.Sprintf("header.pages_manifest[%d].hash", i), "digest")
			}
			if !strings.HasPrefix(getStr(pm, "url"), "https://") {
				push(fmt.Sprintf("header.pages_manifest[%d].url", i), "https url")
			}
		}
	}
	facts, ok := file["facts"].([]any)
	if !ok {
		push("facts", "array")
	} else {
		for i, f := range facts {
			fm, _ := f.(map[string]any)
			switch getStr(fm, "provenance") {
			case "witnessed", "public_record", "attested", "declared":
			default:
				push(fmt.Sprintf("facts[%d].provenance", i), "unknown provenance")
			}
			if getStr(getMap(fm, "evidence"), "url") == "" {
				push(fmt.Sprintf("facts[%d].evidence.url", i), "required")
			}
		}
	}
	if getStr(getMap(file, "controls"), "when_unknown") == "" {
		push("controls.when_unknown", "required")
	}
	if !IsDigest(file["root_hash"]) {
		push("root_hash", "digest")
	}
	return out
}

// ---------------------------------------------------------------- VerifySemanto

// VerifySemanto checks a whole Semanto file offline. pages maps a page url (or
// id) to its bytes and may be empty; keys are the company's and Trooth's JWK
// Sets; revocations is an optional revocation list payload.
func VerifySemanto(file map[string]any, pages map[string][]byte, keys KeySet, now time.Time, revocations map[string]any) Result {
	c := &checks{}
	h := getMap(file, "header")
	if h == nil {
		c.add("structure", false, "The file has no header.", "malformed")
		return c.result()
	}
	issues := validate(file)
	if len(issues) > 0 {
		var parts []string
		for _, i := range issues {
			parts = append(parts, i.Path+": "+i.Message)
		}
		c.add("structure", false, strings.Join(parts, "; "), "malformed")
		r := c.result()
		r.Issues = issues
		return r
	}
	c.add("structure", true, "The file has every required field.", "")

	root, err := RootHash(h)
	if err != nil {
		c.add("root_hash", false, "The header cannot be canonicalized: "+err.Error(), "malformed")
		return c.result()
	}
	fileRoot := getStr(file, "root_hash")
	c.add("root_hash", root == fileRoot, ternary(root == fileRoot, "root_hash is the digest of the canonical header: "+root, "root_hash "+fileRoot+" is not the digest of the header, which is "+root), "root_hash_mismatch")
	manifest := getList(h, "pages_manifest")
	pr, _ := PagesRoot(manifest)
	c.add("pages_root", pr == getStr(h, "pages_root"), ternary(pr == getStr(h, "pages_root"), fmt.Sprintf("pages_root matches the %d page hashes in the manifest.", len(manifest)), "pages_root does not match the manifest (computed "+pr+")."), "pages_root_mismatch")
	facts := getList(file, "facts")
	fr, _ := FactsRoot(facts)
	c.add("facts_root", fr == getStr(h, "facts_root"), ternary(fr == getStr(h, "facts_root"), fmt.Sprintf("facts_root matches the %d facts.", len(facts)), "facts_root does not match the facts (computed "+fr+")."), "facts_root_mismatch")

	tiers := map[string]any{"facts": file["facts"], "controls": file["controls"], "question_map": file["question_map"], "documents": file["documents"], "products": file["products"], "pages": h["pages_manifest"]}
	for _, t := range getList(h, "tiers") {
		tm, _ := t.(map[string]any)
		name := getStr(tm, "name")
		if name == "header" {
			continue
		}
		v, ok := tiers[name]
		if !ok || v == nil {
			c.add("tier."+name, false, "The header lists a "+name+" tier that is not in the file.", "tier_missing")
			continue
		}
		th, _ := TierHash(v)
		c.add("tier."+name, th == getStr(tm, "hash"), ternary(th == getStr(tm, "hash"), "The "+name+" tier matches its hash.", "The "+name+" tier does not match its hash in the header."), "tier_hash_mismatch")
	}

	var bad []string
	for _, f := range facts {
		fm, _ := f.(map[string]any)
		id, _ := FactID(fm)
		if id != getStr(fm, "id") {
			bad = append(bad, getStr(fm, "id"))
		}
	}
	c.add("fact_ids", len(bad) == 0, ternary(len(bad) == 0, "Every fact id is the digest of its fact.", "These fact ids do not match their facts: "+strings.Join(bad, ", ")), "fact_id_mismatch")

	checked := 0
	var wrong []string
	for _, p := range manifest {
		pm, _ := p.(map[string]any)
		b, ok := pages[getStr(pm, "url")]
		if !ok {
			b, ok = pages[getStr(pm, "id")]
		}
		if !ok {
			continue
		}
		checked++
		if Digest(b) != getStr(pm, "hash") {
			wrong = append(wrong, getStr(pm, "url"))
		}
	}
	if checked > 0 {
		c.add("page_bytes", len(wrong) == 0, ternary(len(wrong) == 0, fmt.Sprintf("%d of %d pages were given and every one matches its hash.", checked, len(manifest)), "These pages do not match their hash: "+strings.Join(wrong, ", ")), "page_hash_mismatch")
	} else {
		c.note("page_bytes", "No page bytes were given, so page bytes were not checked.")
	}

	if sig := getMap(file, "signature"); sig != nil {
		v := VerifyJWS(getStr(sig, "jws"), keys, JWSTypes["semantoVersion"], h, now)
		c.add("company_signature", v.OK, ternary(v.OK, "The header is signed by key "+v.Kid+" (typ semanto-version).", "The company's signature did not check out: "+v.Reason+"."), v.Reason)
	} else {
		signedState := getStr(h, "state") == "signed"
		c.add("company_signature", !signedState, ternary(signedState, "The file says it is signed but carries no signature.", "The file is not signed yet; that matches its state."), "unsigned")
	}

	if w := getMap(file, "witness"); w != nil {
		payload := map[string]any{"root_hash": fileRoot, "witnessed_at": getStr(w, "at")}
		v := VerifyJWS(getStr(w, "jws"), keys, JWSTypes["witness"], payload, now)
		c.add("witness", v.OK, ternary(v.OK, "Trooth witnessed root_hash at "+getStr(w, "at")+" with key "+v.Kid+".", "The witness statement did not check out: "+v.Reason+"."), "witness_"+v.Reason)
	} else {
		c.note("witness", "No witness statement in the file.")
	}

	state := StateOf(file, now, revocations, 0)
	c.add("state", state == "current" || getStr(h, "state") != "signed", "State at "+now.UTC().Format(time.RFC3339)+": "+state+".", state)
	r := c.result()
	r.State = state
	if IsDigest(fileRoot) {
		r.VersionID = VersionID(fileRoot)
	}
	return r
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// ---------------------------------------------------------------- VerifyPageProof

// VerifyPageProof checks a semanto.proof document (what /pages/{id}/proof
// returns) against the page's bytes. header is the version header fetched
// beside the proof; with it the proof is tied to root_hash and the company's
// signature is checked. nil skips those two checks and says so.
func VerifyPageProof(proof map[string]any, page []byte, keys KeySet, now time.Time, header map[string]any) Result {
	c := &checks{}
	inc := getMap(proof, "inclusion")
	pageHash := getStr(proof, "page_hash")
	pagesRoot := getStr(proof, "pages_root")
	proofRoot := getStr(proof, "root_hash")
	if getStr(proof, "object") != "semanto.proof" || !IsDigest(pageHash) || !IsDigest(pagesRoot) || !IsDigest(proofRoot) || inc == nil {
		c.add("structure", false, "The proof is not a semanto.proof with full digests and an inclusion block.", "malformed")
		return c.result()
	}
	d := Digest(page)
	c.add("page_hash", d == pageHash, ternary(d == pageHash, "The page bytes hash to "+d+", the hash in the manifest.", "The page bytes hash to "+d+"; the proof says "+pageHash+". The page is not the one that was signed."), "page_hash_mismatch")

	index, _ := getInt(inc, "index")
	size, _ := getInt(inc, "size")
	leafB, err := DigestBytes(pageHash)
	path, err2 := digestList(getStrList(inc, "path"))
	rootB, err3 := DigestBytes(pagesRoot)
	inPages := err == nil && err2 == nil && err3 == nil && VerifyInclusion(LeafHash(leafB), index, size, path, rootB)
	c.add("pages_root", inPages, ternary(inPages, fmt.Sprintf("Page %d of %d is in pages_root %s.", index+1, size, pagesRoot), "The inclusion proof does not lead to pages_root."), "pages_root_mismatch")

	if header != nil {
		manifest := getList(header, "pages_manifest")
		var entry map[string]any
		if index >= 0 && index < len(manifest) {
			entry, _ = manifest[index].(map[string]any)
		}
		root, _ := RootHash(header)
		hv, _ := getInt(header, "version")
		pv, _ := getInt(proof, "version")
		bound := getStr(header, "pages_root") == pagesRoot && root == proofRoot && entry != nil && getStr(entry, "id") == getStr(proof, "page_id") && getStr(entry, "hash") == pageHash && hv == pv
		switch {
		case bound:
			c.add("header", true, fmt.Sprintf("The version header hashes to root_hash %s and lists this page at index %d.", root, index), "")
		case root != proofRoot:
			c.add("header", false, "The header hashes to "+root+", not the proof's root_hash "+proofRoot+".", "root_hash_mismatch")
		default:
			c.add("header", false, "The header does not list this page at that index with this hash.", "manifest_mismatch")
		}
		sig := VerifyJWS(getStr(proof, "signature"), keys, JWSTypes["semantoVersion"], header, now)
		c.add("company_signature", sig.OK, ternary(sig.OK, "The header is signed by key "+sig.Kid+" (typ semanto-version).", "The company's signature did not check out: "+sig.Reason+"."), sig.Reason)
	} else {
		c.note("header", "No version header was given, so the proof was not tied to the signed header and the company signature was not checked.")
	}

	if w := getStr(proof, "witness"); w != "" {
		payload := map[string]any{"root_hash": proofRoot, "witnessed_at": getStr(proof, "witnessed_at")}
		v := VerifyJWS(w, keys, JWSTypes["witness"], payload, now)
		c.add("witness", v.OK, ternary(v.OK, "Trooth witnessed this root_hash at "+getStr(proof, "witnessed_at")+" with key "+v.Kid+".", "The witness statement did not check out: "+v.Reason+"."), "witness_"+v.Reason)
	}

	if l := getMap(proof, "ledger"); l != nil {
		leafH, _ := DigestBytes(getStr(l, "leaf_hash"))
		if leaf := getMap(l, "leaf"); leaf != nil {
			cb, _ := CanonicalBytes(leaf)
			recomputed := hex.EncodeToString(LeafHash(cb)) == strings.TrimPrefix(getStr(l, "leaf_hash"), "sha256:")
			names := getStr(leaf, "hash") == proofRoot && getStr(leaf, "kind") == "semanto_version"
			detail := "The leaf record does not hash to leaf_hash."
			if recomputed {
				detail = ternary(names, "The log leaf is the canonical leaf record and names this root_hash.", "The log leaf names a different root_hash.")
			}
			c.add("log_leaf", recomputed && names, detail, "log_leaf_mismatch")
		} else {
			c.note("log_leaf", "The proof carries only the leaf hash, so the leaf record was not recomputed.")
		}
		lIndex, _ := getInt(l, "index")
		lSize, _ := getInt(l, "tree_size")
		lPathRaw := getStrList(l, "inclusion_path")
		if lPathRaw == nil {
			lPathRaw = getStrList(l, "path")
		}
		lPath, _ := digestList(lPathRaw)
		headRoot, _ := DigestBytes(getStr(l, "root_hash"))
		inLog := leafH != nil && headRoot != nil && VerifyInclusion(leafH, lIndex, lSize, lPath, headRoot)
		c.add("log_inclusion", inLog, ternary(inLog, fmt.Sprintf("Leaf %d is in the log of size %d with root %s.", lIndex, lSize, getStr(l, "root_hash")), "The log inclusion proof does not lead to the tree head."), "log_inclusion_failed")
		thIn := map[string]any{"jws": getStr(l, "tree_head_jws")}
		if th := getMap(l, "tree_head"); th != nil {
			thIn = th
		}
		tr := VerifyTreeHead(thIn, keys, now)
		same := tr.OK && tr.TreeSize == lSize && tr.RootHash == getStr(l, "root_hash")
		detail := "The tree head signature did not check out: " + tr.Reason + "."
		if tr.OK {
			detail = ternary(same, fmt.Sprintf("The tree head of size %d is signed by Trooth (key %s).", tr.TreeSize, tr.Kid), "The signed tree head names a different tree.")
		}
		c.add("tree_head", same, detail, ternary(tr.OK, "tree_head_mismatch", "tree_head_"+tr.Reason))
	}

	r := c.result()
	r.VersionID = getStr(proof, "version_id")
	if r.VersionID == "" && IsDigest(proofRoot) {
		r.VersionID = VersionID(proofRoot)
	}
	return r
}

// ---------------------------------------------------------------- VerifyResponse

// ResponseOptions tune VerifyResponse.
type ResponseOptions struct {
	Tag           string
	Required      []string
	MaxAgeSeconds int64
}

// VerifyResponse checks a signed HTTP response: Content-Digest, the RFC 9421
// signature with tag trooth-semanto, and Trooth-Page-Hash against the body.
func VerifyResponse(status int, headers map[string]string, body []byte, keys KeySet, now time.Time, opts ResponseOptions) Result {
	c := &checks{}
	cd, _ := HeaderGet(headers, "content-digest")
	ok := VerifyContentDigest(cd, body)
	c.add("content_digest", ok, ternary(ok, "Content-Digest matches the body.", "Content-Digest does not match the body, or is missing."), "content_digest_mismatch")
	tag := opts.Tag
	if tag == "" {
		tag = SemantoResponseTag
	}
	req := opts.Required
	if req == nil {
		req = SemantoResponseComponents
	}
	v := VerifyMessage(Message{Kind: "response", Status: status, Headers: headers}, keys, VerifyOptions{Required: req, Tag: tag, Now: now.Unix(), MaxAgeSeconds: opts.MaxAgeSeconds})
	c.add("signature", v.OK, ternary(v.OK, "The response is signed by key "+v.KeyID+" with tag "+v.Params.Tag+", covering "+strings.Join(v.Components, ", ")+".", "The response signature did not check out: "+v.Reason+"."), v.Reason)
	if ph, ok := HeaderGet(headers, "trooth-page-hash"); ok && ph != "" {
		d := Digest(body)
		c.add("page_hash", d == ph, ternary(d == ph, "Trooth-Page-Hash is the digest of the body: "+d, "Trooth-Page-Hash "+ph+" is not the digest of the body ("+d+")."), "page_hash_mismatch")
	}
	r := c.result()
	if v.OK {
		r.KeyID = v.KeyID
	}
	return r
}

// VerifyWebBotAuthRequest checks a Web Bot Auth signed request and returns the Signature-Agent it names.
func VerifyWebBotAuthRequest(method, url string, headers map[string]string, keys KeySet, now time.Time) MessageResult {
	v := VerifyMessage(Message{Kind: "request", Method: method, URL: url, Headers: headers}, keys, VerifyOptions{Required: WebBotAuthRequired, Tag: WebBotAuthTag, Now: now.Unix()})
	if !v.OK {
		return v
	}
	agent, _ := HeaderGet(headers, "signature-agent")
	v.Agent = strings.Trim(strings.TrimSpace(agent), `"`)
	return v
}

// ---------------------------------------------------------------- log

// TreeHeadResult is the outcome of VerifyTreeHead.
type TreeHeadResult struct {
	OK       bool
	Reason   string
	Kid      string
	TreeSize int
	RootHash string
	Payload  map[string]any
}

// VerifyTreeHead checks a signed tree head: a compact JWS (typ signed-tree-head)
// over { tree_size, root_hash, signed_at }, given as { "jws" } or { "payload", "jws" }.
func VerifyTreeHead(th map[string]any, keys KeySet, now time.Time) TreeHeadResult {
	if th == nil {
		return TreeHeadResult{Reason: "malformed"}
	}
	jws := getStr(th, "jws")
	if jws == "" {
		jws = getStr(th, "tree_head_jws")
	}
	payload := getMap(th, "payload")
	var p any
	if payload != nil {
		p = payload
	}
	v := VerifyJWS(jws, keys, JWSTypes["treeHead"], p, now)
	if !v.OK {
		return TreeHeadResult{Reason: v.Reason}
	}
	pm, _ := v.Payload.(map[string]any)
	if payload != nil && MustCanonicalize(payload) != MustCanonicalize(pm) {
		return TreeHeadResult{Reason: "payload_mismatch"}
	}
	size, ok := getInt(pm, "tree_size")
	if !ok || !IsDigest(pm["root_hash"]) {
		return TreeHeadResult{Reason: "malformed"}
	}
	if given := getStr(th, "root_hash"); given != "" {
		if given != getStr(pm, "root_hash") {
			return TreeHeadResult{Reason: "payload_mismatch"}
		}
		if ts, has := getInt(th, "tree_size"); has && ts != size {
			return TreeHeadResult{Reason: "payload_mismatch"}
		}
	}
	return TreeHeadResult{OK: true, Kid: v.Kid, TreeSize: size, RootHash: getStr(pm, "root_hash"), Payload: pm}
}

// VerifyInclusionInLog checks { leaf_hash | leaf, index, tree_size, path, root_hash }.
func VerifyInclusionInLog(proof map[string]any, rootOverride string) bool {
	var leafH []byte
	if lh := getStr(proof, "leaf_hash"); lh != "" {
		leafH, _ = DigestBytes(lh)
	} else if leaf := getMap(proof, "leaf"); leaf != nil {
		cb, _ := CanonicalBytes(leaf)
		leafH = LeafHash(cb)
	}
	root := rootOverride
	if root == "" {
		root = getStr(proof, "root_hash")
	}
	rootB, err := DigestBytes(root)
	raw := getStrList(proof, "path")
	if raw == nil {
		raw = getStrList(proof, "inclusion_path")
	}
	path, err2 := digestList(raw)
	index, _ := getInt(proof, "index")
	size, _ := getInt(proof, "tree_size")
	return leafH != nil && err == nil && err2 == nil && VerifyInclusion(leafH, index, size, path, rootB)
}

// VerifyConsistency checks { from, to, old_root, new_root, path }.
func VerifyConsistency(proof map[string]any) bool {
	from, _ := getInt(proof, "from")
	to, _ := getInt(proof, "to")
	oldR, err := DigestBytes(getStr(proof, "old_root"))
	newR, err2 := DigestBytes(getStr(proof, "new_root"))
	path, err3 := digestList(getStrList(proof, "path"))
	return err == nil && err2 == nil && err3 == nil && VerifyConsistencyProof(from, to, oldR, newR, path)
}

// CheckpointResult is the outcome of VerifyCheckpoint.
type CheckpointResult struct {
	OK       bool
	Reason   string
	Origin   string
	Name     string
	TreeSize int
	RootHash string
	Kid      string
}

// VerifyCheckpoint checks a signed note (golang.org/x/mod/sumdb/note): origin,
// size, base64 root, a blank line, then signature lines "\u2014 name base64(keyhash4||sig)",
// keyhash4 being the first 4 bytes of SHA-256(name || "\n" || 0x01 || pubkey).
// The signer name is the log operator's (Trooth: "trooth.co"); the origin is the log's.
func VerifyCheckpoint(text string, keys KeySet, expectedOrigin string) CheckpointResult {
	split := strings.Index(text, "\n\n")
	if split < 0 {
		return CheckpointResult{Reason: "malformed"}
	}
	body, sigBlock := text[:split+1], text[split+2:]
	lines := strings.Split(body, "\n")
	if len(lines) < 3 {
		return CheckpointResult{Reason: "malformed"}
	}
	origin := lines[0]
	if expectedOrigin != "" && origin != expectedOrigin {
		return CheckpointResult{Reason: "wrong_origin"}
	}
	size, err := strconv.Atoi(lines[1])
	root, err2 := base64.StdEncoding.DecodeString(lines[2])
	if err != nil || err2 != nil {
		return CheckpointResult{Reason: "malformed"}
	}
	sawLine := false
	for _, line := range strings.Split(sigBlock, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[0] != "\u2014" {
			continue
		}
		sawLine = true
		name := fields[1]
		blob, err := base64.StdEncoding.DecodeString(fields[2])
		if err != nil || len(blob) < 5 {
			continue
		}
		keyHash, sig := blob[:4], blob[4:]
		for _, jwk := range keys.Keys {
			pub, err := jwk.PublicKey()
			if err != nil {
				continue
			}
			h := sha256.New()
			h.Write([]byte(name))
			h.Write([]byte{'\n', 0x01})
			h.Write(pub)
			if !bytes.Equal(h.Sum(nil)[:4], keyHash) {
				continue
			}
			if Ed25519Verify(jwk, sig, []byte(body)) {
				return CheckpointResult{OK: true, Origin: origin, Name: name, TreeSize: size, RootHash: "sha256:" + hex.EncodeToString(root), Kid: jwk.Kid}
			}
			return CheckpointResult{Reason: "bad_signature"}
		}
	}
	if !sawLine {
		return CheckpointResult{Reason: "malformed"}
	}
	return CheckpointResult{Reason: "unknown_key"}
}

// ---------------------------------------------------------------- offers and revocations

// VerifyOffer checks a signed offer (typ signed-offer) at now and returns its id.
func VerifyOffer(jws string, keys KeySet, now time.Time) (JWSResult, string) {
	v := VerifyJWS(jws, keys, JWSTypes["offer"], nil, now)
	if !v.OK {
		return v, ""
	}
	d, err := TierHash(v.Payload)
	if err != nil {
		return JWSResult{Reason: "malformed"}, ""
	}
	id, _ := SemantoID("smo", d)
	return v, id
}

// VerifyRevocationList checks a signed revocation list (typ revocation-list) and returns its payload.
func VerifyRevocationList(jws string, keys KeySet, now time.Time) JWSResult {
	return VerifyJWS(jws, keys, JWSTypes["revocation"], nil, now)
}

// ParseLink reads a Link header into (url, params) pairs.
func ParseLink(value string) []struct {
	URL    string
	Params map[string]string
} {
	var out []struct {
		URL    string
		Params map[string]string
	}
	re := regexp.MustCompile(`<([^>]*)>((?:\s*;\s*[A-Za-z0-9-]+=(?:"[^"]*"|[^;,]*))*)`)
	pre := regexp.MustCompile(`;\s*([A-Za-z0-9-]+)=("([^"]*)"|[^;,]*)`)
	for _, m := range re.FindAllStringSubmatch(value, -1) {
		params := map[string]string{}
		for _, pm := range pre.FindAllStringSubmatch(m[2], -1) {
			if pm[3] != "" || strings.HasPrefix(pm[2], `"`) {
				params[strings.ToLower(pm[1])] = pm[3]
			} else {
				params[strings.ToLower(pm[1])] = strings.TrimSpace(pm[2])
			}
		}
		out = append(out, struct {
			URL    string
			Params map[string]string
		}{m[1], params})
	}
	return out
}
