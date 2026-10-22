// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// semanto-verify for Go: the same commands as the JavaScript and Python
// command lines. Prints one line per check in plain words and exits 0 only
// when every check passed.
//
//	semanto-verify file <semanto.json> [-pages <dir>] [-keys <keys.json>] [-now <iso>] [-revocations <file>]
//	semanto-verify page <url> [-trooth <base>] [-now <iso>] [-allow-unwitnessed] [-allow-unlogged] [-allow-unsigned]
//	semanto-verify response <url> [-keys <keys.json>]
//	semanto-verify log -from <n> -to <m> [-log <url>] [-keys <keys.json>]
//
// Flags may come before or after the file path or url. Keys are kept apart by
// role: the company's JWK Set (from its domain) checks company signatures,
// Trooth's checks witness statements, tree heads and revocation lists. `page`
// is strict: the version header must be fetched, and a missing witness
// statement or log entry fails unless allowed.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/troothllc/trooth-semanto-verify/semanto"
)

const troothAPI = "https://api.trooth.co"

// troothKeysBase serves Trooth's witness keys at /.well-known/trooth-keys.json (the Semanto Worker); -trooth overrides it.
const troothKeysBase = troothAPI + "/public/semanto"
const defaultLog = troothAPI + "/public/semanto/log"

var proofRe = regexp.MustCompile(`/pages/[^/]+/proof$`)

func usage() {
	fmt.Fprintln(os.Stderr, "semanto-verify: check a Semanto file, a page, a signed response or the public log.")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "  semanto-verify file <semanto.json> [-pages <dir>] [-keys <keys.json>] [-now <iso>] [-revocations <file>]")
	fmt.Fprintln(os.Stderr, "  semanto-verify page <url> [-trooth <base>] [-now <iso>] [-allow-unwitnessed] [-allow-unlogged] [-allow-unsigned]")
	fmt.Fprintln(os.Stderr, "  semanto-verify response <url> [-keys <keys.json>]")
	fmt.Fprintln(os.Stderr, "  semanto-verify log -from <n> -to <m> [-log <url>] [-keys <keys.json>]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Exit code 0 means every check passed. 1 means at least one failed. 2 means the command was wrong.")
	os.Exit(2)
}

func readJSON(path string) map[string]any {
	b, err := os.ReadFile(path)
	if err != nil {
		fail(err)
	}
	var v map[string]any
	if err := semanto.DecodeJSON(b, &v); err != nil {
		fail(fmt.Errorf("%s: %v", path, err))
	}
	return v
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "semanto-verify: %v\n", err)
	os.Exit(1)
}

func fetch(u, accept string) (int, map[string]string, []byte, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "semanto-verify/0.1 (go)")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, nil, err
	}
	headers := map[string]string{}
	for k, v := range resp.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	return resp.StatusCode, headers, body, nil
}

func fetchJSON(u string) (map[string]any, error) {
	status, _, body, err := fetch(u, "application/json")
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("%s answered %d", u, status)
	}
	var v map[string]any
	if err := semanto.DecodeJSON(body, &v); err != nil {
		return nil, err
	}
	return v, nil
}

func printResult(title string, r semanto.Result) bool {
	fmt.Println(title)
	for _, c := range r.Checks {
		mark := "FAIL"
		if c.OK {
			mark = "ok  "
		}
		fmt.Printf("  %s %s: %s\n", mark, c.Name, c.Detail)
	}
	for _, n := range r.Notes {
		fmt.Printf("  note %s\n", n)
	}
	if r.OK {
		fmt.Println("Every check passed.")
	} else {
		fmt.Printf("Failed: %s.\n", r.Reason)
	}
	fmt.Println()
	return r.OK
}

func parseNow(s string) time.Time {
	if s == "" {
		return time.Now().UTC()
	}
	t, err := semanto.ParseTime(s)
	if err != nil {
		fail(fmt.Errorf("-now must be ISO 8601 UTC, got %q", s))
	}
	return t
}

func loadKeys(domain, keysPath, troothBase string) semanto.KeySet {
	if keysPath != "" {
		return semanto.CollectKeys(readJSON(keysPath))
	}
	if troothBase == "" {
		troothBase = troothKeysBase
	}
	sets := map[string]any{"company": map[string]any{"keys": []any{}}, "trooth": map[string]any{"keys": []any{}}}
	for _, src := range []struct{ role, url string }{{"company", "https://" + domain + "/.well-known/trooth-keys.json"}, {"trooth", troothBase + "/.well-known/trooth-keys.json"}} {
		j, err := fetchJSON(src.url)
		if err != nil {
			fmt.Printf("  note %s could not be read (%v)\n", src.url, err)
			continue
		}
		fmt.Printf("  ok   fetched the %s JWK Set at %s\n", src.role, src.url)
		sets[src.role] = j
	}
	return semanto.CollectKeys(sets)
}

func dnsNote(domain, kid string) {
	if kid == "" {
		return
	}
	txt, err := net.LookupTXT("_trooth-keys." + domain)
	if err != nil {
		fmt.Printf("DNS binding\n  note _trooth-keys.%s could not be resolved (%v).\n\n", domain, err)
		return
	}
	kids := semanto.ParseDNSKeyRecords(txt)
	for _, k := range kids {
		if k == kid {
			fmt.Printf("DNS binding\n  ok   _trooth-keys.%s TXT names key %s.\n\n", domain, kid)
			return
		}
	}
	if len(kids) > 0 {
		fmt.Printf("DNS binding\n  note _trooth-keys.%s TXT names %s, not the signing key %s.\n\n", domain, strings.Join(kids, ", "), kid)
		return
	}
	fmt.Printf("DNS binding\n  note _trooth-keys.%s has no v=trooth1 record.\n\n", domain)
}

func cmdFile(args []string) int {
	fs := flag.NewFlagSet("file", flag.ExitOnError)
	pagesDir := fs.String("pages", "", "folder holding <page id>.md files")
	keysPath := fs.String("keys", "", "keys json (JWK Sets)")
	nowS := fs.String("now", "", "instant to judge validity at, ISO 8601 UTC")
	revPath := fs.String("revocations", "", "signed revocation list json")
	offline := fs.Bool("offline", false, "never fetch keys")
	trooth := fs.String("trooth", "", "Trooth API base")
	pos, _ := semanto.ParseInterspersed(fs, args)
	if len(pos) < 1 {
		usage()
	}
	path := pos[0]
	doc := readJSON(path)
	file := doc
	if f, ok := doc["file"].(map[string]any); ok {
		file = f
	}
	dir := filepath.Dir(path)
	header, _ := file["header"].(map[string]any)
	var keys semanto.KeySet
	switch {
	case *keysPath != "":
		keys = semanto.CollectKeys(readJSON(*keysPath))
	case fileExists(filepath.Join(dir, "keys.json")):
		keys = semanto.CollectKeys(readJSON(filepath.Join(dir, "keys.json")))
	case *offline:
	default:
		identity, _ := header["identity"].(map[string]any)
		domain, _ := identity["domain"].(string)
		keys = loadKeys(domain, "", *trooth)
	}
	if *pagesDir == "" && dirExists(filepath.Join(dir, "pages")) {
		*pagesDir = filepath.Join(dir, "pages")
	}
	pages := map[string][]byte{}
	if *pagesDir != "" {
		manifest, _ := header["pages_manifest"].([]any)
		for _, p := range manifest {
			pm, _ := p.(map[string]any)
			id, _ := pm["id"].(string)
			u, _ := pm["url"].(string)
			if b, err := os.ReadFile(filepath.Join(*pagesDir, id+".md")); err == nil {
				pages[u] = b
			}
		}
		fmt.Printf("Pages: %d of %d found in %s.\n", len(pages), len(manifest), *pagesDir)
	}
	nowStr := *nowS
	if nowStr == "" {
		nowStr, _ = doc["now"].(string)
	}
	now := parseNow(nowStr)
	var revocations map[string]any
	if *revPath != "" {
		r := readJSON(*revPath)
		jws, _ := r["jws"].(string)
		v := semanto.VerifyRevocationList(jws, keys, now)
		if v.OK {
			fmt.Println("Revocation list: signed by Trooth.")
			revocations, _ = v.Payload.(map[string]any)
		} else {
			fmt.Printf("Revocation list: not accepted (%s).\n", v.Reason)
		}
	}
	r := semanto.VerifySemanto(file, pages, keys, now, revocations)
	vid := r.VersionID
	if vid == "" {
		vid = "unknown"
	}
	if printResult(fmt.Sprintf("Semanto file %s (version %s)", path, vid), r) {
		return 0
	}
	return 1
}

func cmdResponse(args []string, alsoProof bool) int {
	fs := flag.NewFlagSet("response", flag.ExitOnError)
	keysPath := fs.String("keys", "", "keys json")
	nowS := fs.String("now", "", "instant to judge validity at")
	trooth := fs.String("trooth", "", "Trooth API base")
	allowUnwitnessed := fs.Bool("allow-unwitnessed", false, "accept a proof with no witness statement")
	allowUnlogged := fs.Bool("allow-unlogged", false, "accept a proof with no log entry")
	allowUnsigned := fs.Bool("allow-unsigned", false, "accept a proof with no company signature (a Semanto Basic page)")
	pos, _ := semanto.ParseInterspersed(fs, args)
	if len(pos) < 1 {
		usage()
	}
	target := pos[0]
	status, headers, body, err := fetch(target, "text/markdown")
	if err != nil {
		fail(err)
	}
	fmt.Printf("GET %s with Accept: text/markdown answered %d %s\n", target, status, headers["content-type"])
	u, err := url.Parse(target)
	if err != nil {
		fail(err)
	}
	keys := loadKeys(u.Hostname(), *keysPath, *trooth)
	now := parseNow(*nowS)
	resp := semanto.VerifyResponse(status, headers, body, keys, now, semanto.ResponseOptions{})
	ok := printResult("Signed response", resp)
	dnsNote(u.Hostname(), resp.KeyID)
	if alsoProof {
		var proofURL string
		for _, l := range semanto.ParseLink(headers["link"]) {
			for _, rel := range strings.Fields(l.Params["rel"]) {
				if rel == "proof" || rel == "https://trooth.co/rel/proof" {
					proofURL = l.URL
				}
			}
		}
		if proofURL == "" {
			fmt.Print("Proof\n  FAIL the response has no Link rel=\"https://trooth.co/rel/proof\".\n\n")
			ok = false
		} else {
			if ref, err := url.Parse(proofURL); err == nil {
				proofURL = u.ResolveReference(ref).String()
			}
			doc, err := fetchJSON(proofURL)
			if err != nil {
				fmt.Printf("Proof\n  FAIL %s could not be read (%v).\n\n", proofURL, err)
				ok = false
			} else {
				proof := doc
				if p, isMap := doc["proof"].(map[string]any); isMap {
					proof = p
				}
				header, _ := doc["header"].(map[string]any)
				if header == nil {
					if n, isNum := proof["version"].(json.Number); isNum {
						versionURL := proofRe.ReplaceAllString(proofURL, "/versions/"+n.String())
						if vdoc, err := fetchJSON(versionURL); err == nil {
							header, _ = vdoc["header"].(map[string]any)
							fmt.Printf("  ok   fetched the version header at %s\n", versionURL)
						} else {
							// Strict: a header that cannot be fetched is a failure, not a skip.
							fmt.Printf("  FAIL %s could not be read (%v); without the header the proof is not tied to a signed version.\n", versionURL, err)
						}
					}
				}
				pr := semanto.VerifyPageProofWith(proof, body, keys, now, header, semanto.PageProofOptions{AllowUnwitnessed: *allowUnwitnessed, AllowUnlogged: *allowUnlogged, AllowUnsigned: *allowUnsigned})
				ok = printResult("Proof at "+proofURL, pr) && ok
				if header != nil {
					fmt.Printf("State now: %s.\n\n", semanto.StateOf(map[string]any{"header": header, "root_hash": proof["root_hash"], "signature": proof["signature"]}, now, nil, 0))
				}
			}
		}
	}
	if ok {
		return 0
	}
	return 1
}

func cmdLog(args []string) int {
	fs := flag.NewFlagSet("log", flag.ExitOnError)
	from := fs.Int("from", -1, "older tree size")
	to := fs.Int("to", -1, "newer tree size")
	logURL := fs.String("log", defaultLog, "log base url")
	keysPath := fs.String("keys", "", "keys json")
	nowS := fs.String("now", "", "instant to judge validity at")
	trooth := fs.String("trooth", troothKeysBase, "Trooth key base")
	_, _ = semanto.ParseInterspersed(fs, args)
	if *from < 0 || *to < *from {
		usage()
	}
	var keys semanto.KeySet
	if *keysPath != "" {
		keys = semanto.CollectKeys(readJSON(*keysPath))
	} else {
		j, err := fetchJSON(*trooth + "/.well-known/trooth-keys.json")
		if err != nil {
			fail(err)
		}
		// Tree heads are Trooth's statements: only Trooth's keys check them.
		keys = semanto.CollectKeys(map[string]any{"trooth": j})
	}
	now := parseNow(*nowS)
	oldHead, err := fetchJSON(fmt.Sprintf("%s/tree-head?size=%d", *logURL, *from))
	if err != nil {
		fail(err)
	}
	newHead, err := fetchJSON(fmt.Sprintf("%s/tree-head?size=%d", *logURL, *to))
	if err != nil {
		fail(err)
	}
	cons, err := fetchJSON(fmt.Sprintf("%s/consistency?from=%d&to=%d", *logURL, *from, *to))
	if err != nil {
		fail(err)
	}
	ok := true
	for _, h := range []struct {
		name string
		head map[string]any
	}{{fmt.Sprintf("Tree head at size %d", *from), oldHead}, {fmt.Sprintf("Tree head at size %d", *to), newHead}} {
		v := semanto.VerifyTreeHead(h.head, keys, now)
		if v.OK {
			fmt.Printf("%s: signed by Trooth key %s, root %s\n", h.name, v.Kid, v.RootHash)
		} else {
			fmt.Printf("%s: FAIL %s\n", h.name, v.Reason)
			ok = false
		}
	}
	rootOf := func(head map[string]any) any {
		if p, isMap := head["payload"].(map[string]any); isMap && p["root_hash"] != nil {
			return p["root_hash"]
		}
		return head["root_hash"]
	}
	path := cons["path"]
	if path == nil {
		path = cons
	}
	c := semanto.VerifyConsistency(map[string]any{"from": *from, "to": *to, "old_root": rootOf(oldHead), "new_root": rootOf(newHead), "path": path})
	if c {
		fmt.Printf("Consistency %d to %d: the older tree is a prefix of the newer one; nothing was removed or rewritten\n", *from, *to)
	} else {
		fmt.Printf("Consistency %d to %d: FAIL the proof does not connect the two roots\n", *from, *to)
	}
	if ok && c {
		return 0
	}
	return 1
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var code int
	switch os.Args[1] {
	case "file":
		code = cmdFile(os.Args[2:])
	case "page":
		code = cmdResponse(os.Args[2:], true)
	case "response":
		code = cmdResponse(os.Args[2:], false)
	case "log":
		code = cmdLog(os.Args[2:])
	default:
		usage()
	}
	os.Exit(code)
}
