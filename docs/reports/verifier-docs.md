<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- Area report for the open verifier kit, the Internet-Draft, the dashboard components and the documentation, per docs/AGENT-BRIEF.md rule 10. -->

# Verifier kit, Internet-Draft, dashboard components and docs: report

Date: 2026-10-22. Folders: `verifier/`, `web/`, `docs/` (not `docs/reports` written by others), `test/verifier.test.ts`, `test/fixtures/verifier/`. `src/core` was not changed. No file outside these folders was touched.

Tests: `npx vitest run test/verifier.test.ts` (25 pass), `cd verifier/python && python3 -m pytest` (22 pass), `cd verifier/go && go test ./semanto/` (pass, `go vet` clean, `gofmt` clean), `npx tsc -p web/tsconfig.json --noEmit` (clean). The vector generator is byte-stable: two runs produce identical SHA-256 sums for every file.

## What was built, file by file

### A. Test vectors (`verifier/test-vectors/`)

`generate.ts`
: Deterministic generator, run with `npx tsx verifier/test-vectors/generate.ts`. Reads four fixture keys from `test/fixtures/verifier/` (Acme's signing key, a fixture witness key, a fixture agent key, an unknown key; all made once and committed, none is a production key), fixes every instant to 2026-10-22T12:00:00Z and judges at 12:00:10Z, uses no `Date.now()` and no randomness. Builds through `src/core` (the only place the kit imports it): 3 pages with markdown bytes, 4 facts (two `declared` with schema.org mappings, one `declared` boolean, one `public_record` from GLEIF with a plainly fictional LEI), controls, empty question map, documents and products tiers; the company's detached JWS over the header; Trooth's witness JWS; a five-leaf log with Acme at index 3, signed tree heads at sizes 3 and 5, a signed-note checkpoint (origin `trooth.co/semanto/log/v1`, signer `trooth.co`, matching `src/ledger/log.ts`), an inclusion proof and a 3-to-5 consistency proof; the page proof in the `semanto.proof` shape `src/serve/proof.ts` serves, with the leaf record added; a signed response with the full header set over `SEMANTO_RESPONSE_COMPONENTS` and tag `trooth-semanto`; a Web Bot Auth request; a signed offer; a signed revocation list in the ledger's shape; and seven negatives.

`v1/` (17 JSON files, three page files, `README.md`)
: `manifest.json`, `keys.json`, `semanto.json`, `pages.json`, `pages/<smp_id>.md`, `witness.json`, `log.json`, `page-proof.json`, `response.json`, `web-bot-auth-request.json`, `offer.json`, `revocations.json`, and under `negative/`: `page-tampered` (one byte changed, `page_hash_mismatch`), `fact-tampered` (`facts_root_mismatch`), `signature-expired` (`expired`), `unknown-key` (`unknown_key`), `offer-expired` (`expired`), `version-withdrawn` (state `withdrawn`), `witness-mismatch` (`bad_signature`). Every file carries `expect` so each language's test reads the same expectation. The README lists each file and what a verifier must conclude, the reason codes, the state words, and how to run and regenerate.

### B. JavaScript verifier (`verifier/js/`)

`verify.mjs`
: One dependency-free ES module on WebCrypto (Node 20+, browsers). Re-implements RFC 8785 canonical JSON, SHA-256, RFC 6962 leaf and node hashing with inclusion and consistency checks, RFC 7638 thumbprints, RFC 7515 and RFC 8037 JWS (compact and detached), RFC 9421 message verification with RFC 9530 Content-Digest, the signed-note checkpoint, Semanto ids and hashing (`pagesRoot`, `factsRoot`, `tierHash`, `rootHash`, `factId`, `versionId`). Top-level: `verifySemanto`, `verifyPageProof` (takes the header in `opts.header`), `verifyResponse`, `verifyWebBotAuthRequest`, `verifyTreeHead` (string, `{ jws }`, `{ payload, jws }` or a stored head), `verifyInclusionInLog`, `verifyConsistency`, `verifyCheckpoint`, `verifyOffer`, `verifyRevocationList`, `stateOf(version, now, revocations, latest)`, `parseLink`, `keyResolver`. Every result is `{ ok, reason, checks: [{ name, ok, detail }] }` in plain words, first failure wins, later checks never shown as passed when an earlier one failed.

`verify.d.mts`
: Type declarations for the module.

`cli.mjs`
: `semanto-verify file <semanto.json> --pages <dir> [--keys] [--now] [--revocations]` (offline; finds `keys.json` and `pages/` beside the vectors), `page <url>` (fetches with `Accept: text/markdown`, the JWK Sets from the domain and Trooth, the `_trooth-keys` TXT record, the proof from `Link rel="https://trooth.co/rel/proof"`, the version header from `/versions/{n}`, verifies everything, prints each check), `response <url>`, `log --from <n> --to <m>`. Exit 0 only when every check passed.

`README.md`
: Usage in Node and in a browser.

### C. Python verifier (`verifier/python/`)

`trooth_semanto_verify/canonical.py`
: RFC 8785 by hand: UTF-16 code unit key order (UTF-16-BE byte comparison), the exact escape set, integers only; a non-integer float raises `CanonicalizeError` saying to use minor units or a string; integers at or above 2^53 raise.

`merkle.py`, `jws.py`, `httpsig.py`, `verify.py`
: The same functions as the JavaScript module, same names in snake_case, same reason codes and state words. Standard library plus `cryptography` for Ed25519.

`cli.py`, `__main__.py`, `pyproject.toml`
: The same four commands; `pip install .` gives `semanto-verify`; `python3 -m trooth_semanto_verify` works without installing.

`test_vectors.py`
: pytest over every vector plus the RFC 8785 cases (including a surrogate-pair ordering case), the RFC 6962 known roots, tampering in each layer, the state rules and the CLI. `pytest` was installed here with `pip --break-system-packages`; `cryptography` 50.0.1 was present.

### D. Go verifier (`verifier/go/`)

`go.mod` (module `github.com/troothllc/trooth-semanto-verify`, Go 1.22), `semanto/canonical.go` (RFC 8785 with `json.Number` preserved by `DecodeJSON`, UTF-16 ordering, integers only), `merkle.go`, `jws.go` (`KeySet`, `CollectKeys` over any JSON shape, `VerifyJWS`), `httpsig.go`, `verify.go` (`VerifySemanto`, `VerifyPageProof`, `VerifyResponse`, `VerifyWebBotAuthRequest`, `VerifyTreeHead`, `VerifyInclusionInLog`, `VerifyConsistency`, `VerifyCheckpoint`, `VerifyOffer`, `VerifyRevocationList`, `StateOf`, `ParseLink`), `vectors_test.go`, `cmd/semanto-verify/main.go` (the same four commands with Go flags). Standard library only.

### E. Internet-Draft (`docs/`)

`draft-trooth-signed-web-content-00.md`
: kramdown-rfc markdown, 424 lines: front matter (title "Signed Web Content Responses", abbrev, docname, `category: std`, `ipr: trust200902`, area Web and Internet Transport, workgroup Web Bot Auth with a note that it is an individual submission, author Trooth LLC, dandre@trooth.co, date 2026-10); the problem; the mechanism (RFC 9421 response signatures, tag `signed-web-content`, required components `@status`, `content-type`, `content-digest`, `Content-Version`, `Content-Hash`, no request-derived components, Ed25519 only) with Trooth's names as implementation notes; a worked example from the vectors with the real signature; key discovery (JWK Set at `/.well-known/signed-web-content-keys.json`, `_swc` TXT record, rotation); validity and revocation (Deprecation and Sunset windows, the revocation list); proofs (RFC 6962 leaves, tree heads, the C2SP checkpoint, the proof document, log endpoints, monitors); the verification procedure; security considerations (replay, downgrade, key compromise, cloaking and the same-content requirement, reader privacy, canonicalization); IANA considerations (two header fields, the tag, two link relations, the well-known URI, the `_swc` node name); references to RFC 9421, 9530, 6962, 8785, 7515, 7638, 8037, 8615, 8288, 8552, 9110, 2119, 8174, and informatively draft-ietf-webbotauth-httpsig-protocol, draft-ietf-httpapi-deprecation-header, RFC 8594, 9457, 6648 and the C2SP checkpoint.

`INTERNET-DRAFT-README.md`
: How to build with `gem install kramdown-rfc` and `pip install xml2rfc`, `idnits`, how to submit on the Datatracker and where to announce, revision rules, and the hold: filed only after the provisional patent.

### F. Dashboard components (`web/`)

`semanto/delivery-settings-panel.tsx`, `consistency-monitor-panel.tsx`, `read-receipts-panel.tsx`, `key-binding-panel.tsx`, `basic-upgrade-card.tsx`, `format.ts`, `index.ts`
: React 19 TypeScript, `"use client"`, lucide-react icons, the token classes from `semanto-record-panel.tsx`, blue (`btn-primary`) once per panel on the action, plain words throughout. Props are plain data and callbacks; nothing fetches. The data shapes mirror the modules they display: `DeliverySettings` and `HostKind` from `src/settings/delivery.ts` (three markdown-source modes with the proof-only warning, three when-changed choices, the AI use switches, the locked always-on rows), `Mismatch`, `MismatchKind` and `Severity` (`trust`, `visibility`, `note`) from `src/monitor/types.ts`, `Classification` and the provider summary from `src/gap/compare.ts` and `report.ts`, proven and unproven readers with Trooth's own checks in their own column from `src/readers/receipts.ts`, binding levels from `src/identity/keys.ts`.

`types/react-shim.d.ts`, `tsconfig.json`, `README.md`
: The shim and config exist only so the components typecheck in this repository, which ships no React; they are not copied to trooth-web.

### G. Docs (`docs/`)

`spec/semanto-file.md` (format, hashing rules, ids, provenance, states, signatures, verification order), `spec/response-signatures.md` (what is signed, every header, the verification steps, the worked example, Web Bot Auth, errors), `spec/delivery.md` (the governing rule, the negotiation table, the settings model and cross-field rules, the three modes, the when-changed choices, the no-duplicate rule, the host table), `spec/log.md` (leaves, tree heads, checkpoints, proofs, the proof document, revocation, time, monitors), `spec/verify-endpoint.md`, `METRICS_DEFINITIONS.md` (every number and how it is counted, including that agent reads include Trooth's own hourly checks), `REQUIREMENTS-TRACEABILITY.md` (delivery items 1 to 20 and requirements 1 to 34 mapped to files, tests and status, with "to confirm at review" where the number or the file could not be seen).

## Requirement numbers covered

Signatures 18 (the open verifier kit, the vectors and the Internet-Draft; numbering reconstructed from the area reports, to confirm), and the dashboard and documentation parts of delivery 18 (the settings panel) and of requirements 2, 12, 17, 25 and 29 (their panels). The traceability matrix covers the whole list.

## Findings for review (things another module should look at)

1. **The log leaf for a version.** `src/ledger/ports.ts` defines the leaf as canonical JSON of `{ kind, trooth_id, ref, hash, at }`; `src/serve/proof.ts` `verifyProof` expects `leafHash(utf8(root_hash))` and its `PageProof.ledger` carries no leaf record. The vectors and all three kits follow the ledger and add `ledger.leaf` to the proof document. Serve should carry `leaf` and compute the expected leaf hash the ledger's way, or the ledger should change; the ledger owns the format.
2. **Root typecheck and `web/`.** The root `tsconfig.json` includes `web/` but has no `jsx` option, so `npx tsc --noEmit` at the root reports TS17004 on every `.tsx` file. With the flag, my files are clean (`npx tsc --noEmit --jsx react-jsx` prints nothing outside `src/`). The one-line fix, for the coordinator who owns the file:

   ```diff
    "compilerOptions": {
      "target": "ES2022",
   +  "jsx": "react-jsx",
   ```

   Until then, `npx tsc -p web/tsconfig.json --noEmit` is the check for the components. (At the time of writing, root `tsc` also fails on `src/readers/webbotauth.ts` line 174, another agent's file in progress.)
3. **Two DNS names.** Host detection reads `_trooth.<domain>` (a pointer, `src/serve/detect.ts`); key binding reads `_trooth-keys.<domain>` (`src/identity/keys.ts`). The docs and the CLIs use `_trooth-keys` for the key and `_trooth` for the pointer. The Internet-Draft's implementation note names `_trooth-keys`.
4. **Public log routes.** `docs/ARCHITECTURE.md` lists `/public/semanto/log/tree-head`, `/log/proof`, `/log/consistency`; the handlers were not in `src/serve/routes.ts` when I looked. `docs/spec/log.md` states the shapes the three `semanto-verify log` commands expect: `tree-head?size=n` returning the stored head `{ tree_size, root_hash, signed_at, jws }`, `consistency?from&to` returning `{ from, to, old_root, new_root, path }`. The CLIs also accept a head given as `{ payload, jws }`.
5. **Requirement numbering.** The two execution lists were not in the repository or the project documents I could search. The matrix reconstructs each number from the area reports and marks 7, 19 and 34 (claimed by no report) and the double reading of 26 (adapters say the platform connectors; commerce says the monitor).
6. **Python caches.** `__pycache__` and `.pytest_cache` under `verifier/python` were deleted after the run; `.gitignore` (coordinator's file) could add `__pycache__/` and `.pytest_cache/`.

## Stubbed, or needs a founder step

- The Internet-Draft is built locally only. Filing on the Datatracker waits for the provisional patent (D13). Steps in `docs/INTERNET-DRAFT-README.md`.
- `kramdown-rfc` and `xml2rfc` are not installed here; the draft was written to their format but not rendered. Run `kdrfc docs/draft-trooth-signed-web-content-00.md` once the gems are installed and fix any reference it cannot fetch.
- The CLIs' `page`, `response` and `log` commands need the live routes; they were exercised only for their offline paths (`file`) against the vectors. Run `node verifier/js/cli.mjs page https://<a signed domain>/<page>` on the first served company.
- The Trooth witness public key set at `https://api.trooth.co/.well-known/trooth-keys.json` must exist for the CLIs' default key fetch; the vectors ship a fixture set.
- Publishing: the kit is meant to be public (`npx semanto-verify`, `pip install trooth-semanto-verify`, `go install github.com/troothllc/trooth-semanto-verify/cmd/semanto-verify@latest`). Package names, the npm bin entry and the public repository are founder steps on launch day; nothing may instruct an install that 404s before then.
- The dashboard panels are dropped into trooth-web at integration; the parent pages that fetch and save are written there.

## How to run the tests

```
npx tsx verifier/test-vectors/generate.ts          # regenerates verifier/test-vectors/v1 (byte-stable)
npx vitest run test/verifier.test.ts               # JavaScript kit against every vector, plus the CLI
cd verifier/python && python3 -m pytest            # Python kit (pip install cryptography pytest)
cd verifier/go && go vet ./semanto/ ./cmd/semanto-verify/ && go test ./semanto/   # Go kit
npx tsc -p web/tsconfig.json --noEmit              # dashboard components
node verifier/js/cli.mjs file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages
```
