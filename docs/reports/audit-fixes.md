<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- What was changed for each finding of the pre-deploy audit (docs/audit/pre-deploy-audit.md), the regression test for it, the setup backend added beside it (docs/spec/setup-api.md), and the founder steps still open. -->

# Pre-deploy audit fixes

The pre-deploy audit raised 26 findings. Two are founder decisions and are left as they were (findings 3 and 7, below). Every other finding is fixed, and each fix has a regression test. Most are in `test/audit-fixes.test.ts`, one `describe` per finding, named by its number; a few live in the module's own test file where that is natural. The setup backend the wizard needs (the six screens and nine steps of `docs/audit/workflow-research.md`, sections 5 and 6) was built with the fixes, and its contract is `docs/spec/setup-api.md`.

Every suite passes after the changes:

- `npx vitest run`: 17 files, 475 tests
- `npx tsc --noEmit`
- `python3 -m pytest -q` in `verifier/python`
- `gofmt -l .`, then `go vet` and `go test` over every package, in `verifier/go`
- `npx wrangler deploy --dry-run --env production`

## Critical

### 1. No code mapped a worker-f workspace to a company

- New `POST /os/semanto/claim {domain, org}` and `POST /os/semanto/setup/start {org, domain}`, authorized by the claim variant `troothOsSession` (a valid vendor session, no company yet). The claim creates the company, or links the session's company to it, and writes `os_company_id` and `os_owner_user_id`. The Trooth ID is worker-f's `companySlug` when free, else the domain's first label, else the host with hyphens, never a reserved route name.
- A domain held by another workspace is a 409 `domain_claimed_elsewhere` problem in plain words.
- The existing `troothOsAuthorize` mapping now finds the company through `getCompanyByOsCompany`.
- Test: "finding 1" (claim, owner and member roles, 409 elsewhere, `domain_fixed`, buyer and no token refused, slug rule and reserved names).

### 2. Basic proved the domain the requester named

- The domain is fixed at the claim (`putCompany` never updates it; `basic/claim` with another domain is a 409 `domain_fixed`). The proof is checked only at `_trooth-challenge.<company domain>`.
- Build, sign and first publication answer 409 `domain_not_proven` until `domain_proven_at` is set; serving is gated the same way (`load()` in `src/serve/routes.ts`). A read may start before the proof: it is held (stored, not served, witnessed or logged) and promoted when the proof is recorded.
- Migration 0005 adds `domain_proven_at` and `domain_proof_method`.
- Test: "finding 2", the `claimswap.mts` scenario: a proof published at the attacker's domain proves nothing, nothing is built, signed, witnessed or served, and the served record names `acme.com` once the real proof is in.

### 3. `REPLACE_WITH_` placeholders in `wrangler.toml` (founder decision, unchanged)

The ids stay as placeholders. A comment block at the top of `wrangler.toml` lists the founder steps (create the D1 database and KV namespace, paste their ids, set the secrets).

## High

### 4. The compiler held every page in memory

- New streaming compiler, `src/compiler/stream.ts`: a `discover` message fetches and stages each page as it arrives (raw bytes in R2 or the staging store, metadata in `semanto_build_fetched`), `render` messages handle at most 25 pages each (`PAGES_PER_MESSAGE`), and an `assemble` message builds the manifest, facts and roots from the staged renders. `llms-full.txt` is built only under 8 MB.
- Chrome detection works on block keys (`blockKey` in `src/compiler/extract.ts`), so no message needs every page's HTML. `buildVersion` is recomposed from the same `planBuild`, `renderPage` and `assembleVersion` functions, so one-shot and streamed builds agree.
- `D1BuildStaging` (production) and `MemoryBuildStaging` (tests, with a meter of the raw bytes read per message).
- Test: "finding 4": 500 synthetic pages of about 18 KB each; 20 render messages of at most 25 pages; the peak raw bytes read in one message is at most 25 pages; staging is empty after assembly; `pages_root`, `facts_root` and `root_hash` equal a one-shot `buildVersion` of the same pages.

### 5. Trooth's witness public key was served nowhere

- This Worker serves the witness JWK Set at `/public/semanto/.well-known/trooth-keys.json` and `/public/semanto/keys/trooth.json`, with earlier keys from `TROOTH_WITNESS_PREVIOUS_KEYS` and their `exp` or `revoked_at`.
- The JavaScript, Python and Go CLIs default to `https://api.trooth.co/public/semanto`. `verifier/README.md` notes worker-f may also serve `https://api.trooth.co/.well-known/trooth-keys.json` (a founder step).
- Test: "finding 5" (both routes, no private member, previous keys honored, the three CLI defaults).

### 6. Withdraw and revoke did not exist

- `POST /os/semanto/{id}/withdraw {version, reason}` and `POST /os/semanto/{id}/keys/{kid}/revoke {reason, compromised_at?}` (owner or admin). Each appends a revocation leaf to the log, re-signs the revocation list and serves it at `/public/semanto/{id}/revocations` (and `/public/semanto/revocations` for every company). `compromised_at` backdates `revoked_at` and cannot be in the future. A withdrawn version answers 410 `semanto_withdrawn` and the newest earlier signed version becomes current.
- The nightly checkpoint re-signs every list, so a list never expires while it is served.
- `allowUnsigned` added to the three kits (and a CLI flag), so a Semanto Basic page proof can be accepted knowingly.
- Test: "finding 6": withdraw end to end, the served list read by the JavaScript kit, the Python kit (run with `python3`) and the Go kit (`go test -run TestServedRevocationList` with `SEMANTO_SERVED_REVOCATIONS`), all reading the version as withdrawn; key revocation backdated, refused without a reason or with a future time, re-signed nightly.

### 7. The Internet-Draft is public (founder decision, unchanged)

The draft was not deleted or moved.

### 8. No rate limit, and cheap amplification

- `RateLimitDO` (bound as `RATE`, migration tag `v2-rate-limit-durable-object`) holds a token bucket per client address and route group: `read`, `log`, `check` (`RATE_LIMITS` in `src/readers/rate-limit.ts`). Over the limit is a signed 429 `rate_limited` problem with `Retry-After`. `/os` is not limited here.
- Read receipts are counted per minute in the same object class and flushed to D1 once a minute, one row per key and minute with a `count` (migration 0005 adds `count` and `minute`). Digests and the CSV weight by `count`.
- The Web Bot Auth directory fetch is limited per directory origin and per client (`deps.limit` in `src/readers/webbotauth.ts`).
- Test: "finding 8" (429 and `Retry-After` per group and per client, `/os` untouched; receipts counted by minute through the object's alarm into a real D1 schema, a second flush adding to the row; directory fetch refused with no request sent).

### 9. Monitor surfaces fetched with no SSRF guard

- `guardedGet` and `guardedFetchPort` in `src/monitor/ports.ts`: https only, `checkUrlResolved` from `src/core/ssrf.ts` before each hop, redirects followed by hand and re-checked, 2 MB cap, a timeout signal. Write-back sends only to the known connector hosts. `globalFetchPort` is the guarded port.
- Test: "finding 9" (http, metadata, link-local and private resolution refused before any fetch; a redirect to `http://127.0.0.1` refused; a 3 MB body cut at 2 MB; a member's monitor run at the metadata address reads nothing).

## Medium

### 10. Cacheable authenticated answers

Every `/os` answer carries `Cache-Control: private, no-store`, and `/os` CORS allows `https://trooth.co` and `https://www.trooth.co` (plus `http://localhost` in development), with `Vary: Origin` (updated with docs/reports/passkey-signing.md). Test: "finding 10".

### 11. Unbounded public body

Every POST body is capped at 5 MB: refused on `Content-Length`, and cut off at the cap when streamed, as a 413 `payload_too_large` problem (`readCapped`). Test: "finding 11".

### 12. Crons ran every company inline

The hourly change check and weekly gap reports queue one `companies` message per 25 companies (`COMPANIES_PER_MESSAGE`); the consumer does the work. Test: "finding 12" (60 companies, messages of 25, 25 and 10, no fetch in the cron).

### 13. `basic/prove` compiled inside the request

It records the proof and queues the read (or promotes a finished held read). Test: "finding 13".

### 14. First boot without a witness key

- `TROOTH_WITNESS_KEY` is optional. Routes that sign or witness answer a 503 `witness_key_missing` problem (unsigned, since the signing key is the missing one); everything else keeps working. `WitnessKeyMissingError` is the one addition to `src/core` (below).
- A dead letter queue, `trooth-semanto-compile-dlq`, in both environments; the consumer records a failed build on the last attempt.
- Test: "finding 14".

### 15. Matrix rows marked built whose code was not deployed

Each module is now reached through a route or job, or its row was changed: write-back preview (`GET writeback`), host detection (`POST detect` and the install step), binding status and key revocation (`GET keys`, `POST keys/{kid}/revoke`), the competitor report (`POST competitor-report`), the receipts digest and CSV (`GET receipts`, `GET receipts.csv`), Content Signals drift (in `monitor/run`), sellers, nested catalogs and synonyms (public commerce routes). `docs/REQUIREMENTS-TRACEABILITY.md` rows updated to match; the C2PA bridge stays a library and says so. Test: "finding 15".

### 16. Eight overclaims

1. "without trusting Trooth's servers" removed from `verifier/README.md` and `docs/spec/verify-endpoint.md`.
2. `docs/spec/log.md`: the RFC 3161 anchor is described as conditional on `TSA_URL`, with its signature not checked.
3. Revocation leaves now exist (finding 6), so the log spec and the problem text are true.
4. `docs/METRICS_DEFINITIONS.md`, `docs/spec/log.md` and `web/semanto/read-receipts-panel.tsx` say the hourly check reads the company's own pages and is not counted.
5. `web/semanto/key-binding-panel.tsx` no longer says the DNS record is checked against the key; the keys route reports `bindingStatus`.
6. `web/semanto/delivery-settings-panel.tsx` copy matches what the API does now (finding 17).
7. `verifier/` is Apache-2.0 (`verifier/LICENSE`, SPDX headers, `pyproject.toml`, stated in `verifier/README.md`); the rest of the repository stays proprietary.
8. `KNOWN_DIRECTORIES` is empty: a reader is named by the host of its own directory until a vendor's documentation is checked.

Test: the open-source and overclaim test in "findings 19 to 26", plus `test/readers.test.ts` for item 8.

### 17. Delivery settings not applied

A format turned off is a 404 `representation_not_offered` problem on the page, llms, sitemap and JSON-LD routes. `serve_live_marked_unsigned` answers a signed 303 to the live page with state `unsigned`; `prompt_to_sign` serves the last signed page marked `behind`. Test: "finding 17".

### 18. No page fetch timeout

`WebFetchHttp` passes `AbortSignal.timeout(15000)` (`PAGE_FETCH_TIMEOUT_MS`). Test: "finding 18".

## Low

- 19. Migration 0005 seeds the log frontier (`INSERT OR IGNORE INTO semanto_log_frontier VALUES (1, 0, '[]')`), so no reader writes it. Test: "finding 19".
- 20. Malformed percent-encoding is a signed 400 problem (`safeDecode` and a middleware check); `onError` answers a signed 500 `internal_error` for any other fault. Test: "finding 20" and `test/review-fixes.test.ts` finding 19.
- 21. `x-markdown-tokens` and `x-original-tokens` stay; the docs now say those two are the only X- names. Test: "finding 21".
- 22. Banned words removed from `test/` (and `docs/audit/workflow-research.md`); the house-rule scan now covers `test/`, root files and inflections; SPDX headers added to the migrations, `vitest.config.ts`, the test files that lacked them and `adapters/netlify/_redirects`. Test: the scans in `test/integration.test.ts`.
- 23. `forged-file.json` and `forged-page.md` removed with `git rm`. Test: "finding 23".
- 24. The adapter uses only `config.clientAddress`, which each platform entry sets from its own connecting address (Cloudflare `CF-Connecting-IP`, Fastly `event.client.address`). Test: "finding 24" and `test/review-fixes.test.ts` finding 7.
- 25. Adapters send `Trooth-Forwarded-Path`, covered by the connector signature; the API uses it as `@path` only when covered. The forwarding nonce is claimed once. Test: "finding 25".
- 26. Smaller items: reserved names (`log`, `verify`, `first-publication`, `setup`, `claim`, `keys`, `revocations`, `well-known`) are never given as a Trooth ID; the top-level `wrangler.toml` name is `trooth-semanto-worker-dev`, so a plain deploy is not production; `ENVIRONMENT` is read (inline builds outside production); the stale KV rate-limit comment is gone; the dead letter queue exists; `NonceDO` spreads one agent key over 16 objects (`nonceShard`); the dependency advisories are a founder step. Tests: the two "finding 26" tests.

## The setup backend (docs/spec/setup-api.md)

- One proof format: `_trooth-challenge.<domain>` TXT, value `trooth-domain-challenge=` and 48 hex characters. `_trooth.<domain>` is reserved for the pointer `v=trooth1; id=; key=` and never read as proof.
- `src/setup/`: Domain Connect (ported, `ONBOARDED` empty, RS256 apply links through WebCrypto), DNS host names and manual steps from NS records, the DNS diagnosis (with `propagating`: the proof needs every answering resolver), the install check (three checks, plain messages, success line "Your site answers in markdown and the signature checks out."), and the setup state (`decideStep`, `nextAction`, ETA, left-out reasons in plain words).
- `src/pipeline-setup.ts`: `setup/start`, the state with a live DNS check at most once in 10 seconds, held reads promoted on proof, save for later and resume, the review document and confirm, host choice, install check, monitoring start, and an email when a read longer than 60 seconds finishes.
- `SETUP_STEPS` has nine steps; Basic (1 to 4) targets 600 seconds, full (1 to 9) 900, measured from server timestamps.
- Shopify, Webflow, Squarespace and Wix are detected ahead of the CDN they sit behind, with guide ids. Their signals are not yet confirmed on live sites.
- The flows blueprint (`/home/claude/flows-blueprint`) step ids and the tracker header match.
- Tests: the "setup" and "setup modules" describes in `test/audit-fixes.test.ts`, and `test/basic.test.ts`.

## The one change in src/core

`src/core/keys.ts` gains an error class so the ledger and the routes can tell a missing witness key from any other fault:

```ts
/** Thrown when Trooth's witness key is needed and the deployment has none; the Worker answers a 503 problem instead of failing to start. */
export class WitnessKeyMissingError extends Error {
  constructor() {
    super("TROOTH_WITNESS_KEY is not set. Set the witness private JWK as a Worker secret.");
    this.name = "WitnessKeyMissingError";
  }
}
```

## Founder steps still open

1. Create the D1 database and KV namespace and replace the `REPLACE_WITH_` ids in `wrangler.toml`.
2. Decide, with counsel, on the public Internet-Draft before the provisional filing.
3. Set the secrets: `TROOTH_WITNESS_KEY`, optionally `TROOTH_WITNESS_PREVIOUS_KEYS`, `RECEIPT_IP_SALT_SECRET`, `DOMAIN_CONNECT_PRIVATE_KEY` (only once a DNS provider onboards the template), `TSA_URL` if timestamps are wanted.
4. Add a worker-f route for `https://api.trooth.co/.well-known/trooth-keys.json` if that address should answer too.
5. Confirm the Shopify, Webflow, Squarespace and Wix detection signals on live sites.
6. Review the development dependency advisories.
