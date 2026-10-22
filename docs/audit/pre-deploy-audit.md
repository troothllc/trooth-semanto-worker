<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- Pre-deploy audit of the Semanto Worker, 22 October 2026: deploy readiness, security after the 19 review fixes, end-to-end correctness, house rules, product honesty, requirements gaps and test health. Every finding names a file and line, a failure scenario and a severity; proofs are scratch scripts outside the repository. -->

# Pre-deploy audit, 22 October 2026

Scope: this repository only (Worker, adapters, verifier kits, dashboard components), at commit `b3fc2d7`. No repository file was changed. Proof scripts live outside the repository in the session scratchpad, folder `audit2/`:

| Script | What it proves |
| --- | --- |
| `migrate.mjs` | Migrations 0001 to 0004 apply in order to an empty SQLite (node:sqlite) |
| `logbench.mts` | Log append and proof cost at 70,000 leaves |
| `compilebench.mts` | Compiler CPU and memory for 500 pages of 80 KB and 200 pages of 400 KB |
| `e2e.mts` | A company from Basic claim to signed, served, checked, rotated; withdraw attempt; odd inputs on public routes; CORS and cache headers |
| `claimswap.mts` | The Basic domain proof can prove one domain and witness another |
| `ssrf.mts` | The shared SSRF guard against 32 address forms and resolver answers |
| `kit_py.py`, `gokit/main.go` | The Python and Go kits accept real Worker answers |

Severity words: critical (blocks deploy or breaks the trust claim), high (must fix before launch), medium (fix soon), low (tidy).

## Ranked findings

| # | Severity | Finding | Where |
| --- | --- | --- | --- |
| 1 | critical | No code maps a worker-f workspace to a company, so every /os call is refused and onboarding cannot start | `src/index.ts:118-122`, `src/pipeline.ts:1058` |
| 2 | critical | Basic proves the domain the requester names, then witnesses the domain on the company row | `src/pipeline.ts:511-520`, `src/pipeline.ts:173-178` |
| 3 | critical | `REPLACE_WITH_D1_ID` and `REPLACE_WITH_KV_ID` in both environments | `wrangler.toml:22,30,74,82` |
| 4 | high | The compiler holds every fetched page in memory three times; a 500-page site exceeds the 128 MB isolate limit | `src/compiler/discover.ts:253`, `src/pipeline.ts:178-189` |
| 5 | high | Trooth's witness public key is published nowhere this Worker serves; all three CLIs fetch it from `https://api.trooth.co/.well-known/trooth-keys.json` | `verifier/js/cli.mjs:40-41`, `verifier/python/trooth_semanto_verify/cli.py:39,81`, `verifier/go/cmd/semanto-verify/main.go:146-150` |
| 6 | high | Withdraw and revoke do not exist: no action, no route, revocation lists never logged or served | `src/serve/routes.ts:648`, `src/pipeline.ts:785-801` |
| 7 | high | The Internet-Draft and the full mechanism are public before the provisional filing, against the repository's own hold | `docs/INTERNET-DRAFT-README.md:9-11` |
| 8 | high | No rate limit; an unsigned stranger can make the Worker do outbound fetches and KV writes, and every read writes a D1 row | `src/index.ts:126-127`, `src/readers/webbotauth.ts:164-196` |
| 9 | high | Member-supplied monitor surfaces are fetched with no SSRF guard, any scheme, redirects followed, no size cap | `src/pipeline.ts:664`, `src/monitor/ports.ts:129-141` |
| 10 | medium | Authenticated /os answers carry `Cache-Control: public, max-age=300` | `src/serve/headers.ts:178` |
| 11 | medium | Public `POST /first-publication/check` reads an unbounded body | `src/serve/routes.ts:313-315,627-635` |
| 12 | medium | Hourly change detection and weekly gap reports run every company inline in one cron invocation | `src/pipeline.ts:755-783,804-817` |
| 13 | medium | `basic/prove` runs a whole compile inside the HTTP request | `src/pipeline.ts:539-544` |
| 14 | medium | First boot without `TROOTH_WITNESS_KEY`: every request throws, crons throw, queue messages are dropped after 3 retries | `src/index.ts:48-51`, `wrangler.toml:37-40` |
| 15 | medium | Matrix rows marked built whose code is not in the deployed bundle | `docs/REQUIREMENTS-TRACEABILITY.md` |
| 16 | medium | Overclaims a reader could screenshot (eight items) | see section 5 |
| 17 | medium | Delivery settings for a changed page and format toggles are not applied by the API routes | `src/serve/routes.ts:382-417`, `web/semanto/delivery-settings-panel.tsx:82` |
| 18 | medium | The production page fetch has no timeout | `src/compiler/ports.ts:127` |
| 19 | low | First-boot race can stall the log for good | `src/ledger/store-d1.ts:76-88` |
| 20 | low | `GET /{id}/offers/%E0%A4%A` is an unsigned 500 | `src/serve/routes.ts:689` |
| 21 | low | `x-markdown-tokens` and `x-original-tokens` contradict "no X- names" | `src/serve/headers.ts:179-180` |
| 22 | low | House-rule hits in tracked files outside the scan, and nine source files without SPDX | section 4 |
| 23 | low | Stray `forged-file.json` and `forged-page.md` committed at the root | repository root |
| 24 | low | Adapter vouches for a client address any client can set | `adapters/shared/semanto-adapter.mjs:411-418` |
| 25 | low | Agents that sign `@path` or `@target-uri` never prove through an adapter | `src/readers/forwarded.ts:121` |
| 26 | low | Smaller items (eleven) | section 8 |

## 1. Deploy readiness

### Dry run and bundle

`npx wrangler deploy --dry-run --env production --outdir <scratch>/dist` succeeds with wrangler 4.152.0. Total upload 563.83 KiB, gzip 145.74 KiB. Cloudflare's limits page (read 22 October 2026) states 64 MiB uncompressed and no compressed limit; the bundle is far under that and under the older 3 MB and 10 MB compressed figures.

### Bindings read against bindings declared

| Binding | Read in code | Declared (top level and production) |
| --- | --- | --- |
| `DB` (D1) | `src/index.ts`, `src/ledger/log-do.ts` | yes, id is a placeholder |
| `STORE` (R2) | yes | yes |
| `CACHE` (KV) | directory cache, KV nonce fallback | yes, id is a placeholder |
| `COMPILE_QUEUE` producer and consumer | yes | yes; no dead letter queue |
| `TROOTH_OS` service | `troothOsAuthorize` | yes |
| `NONCES`, `LOG` Durable Objects | yes | yes, with `new_sqlite_classes` migration; wrangler treats `migrations` and `triggers` as inheritable, so production gets both |
| Vars `PUBLIC_API_BASE`, `NETWORK_BASE`, `LEDGER_URL` | yes | yes |
| Var `ENVIRONMENT` | never read | declared |
| Vars `TSA_URL`, `ALERT_FROM` | read | not declared |
| Secrets `TROOTH_WITNESS_KEY` (required), `HOSTED_KEY_SEAL_SECRET`, `RECEIPT_IP_SALT_SECRET`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` | read | set with `wrangler secret put`; none documented in `wrangler.toml` |

`src/env.ts:13` says KV holds "rate limits"; nothing writes one.

### Finding 3 (critical): placeholders

`wrangler.toml:22` and `:74` `database_id = "REPLACE_WITH_D1_ID"`; `:30` and `:82` `id = "REPLACE_WITH_KV_ID"`. A real deploy fails on both. The R2 bucket `trooth-semanto` and queue `trooth-semanto-compile` must exist first.

### Routes and worker-f

No copy of trooth-os-worker-f is under `/home/claude`, so its routes were not read. Cloudflare picks the most specific matching route, so `api.trooth.co/public/semanto/*` and `api.trooth.co/os/semanto/*` win over `api.trooth.co/public/*` and over a catch-all `api.trooth.co/*`. Confirmed by the routing rule; two gaps remain:

- `api.trooth.co/public/semanto` with no trailing slash does not match `/public/semanto/*` and goes to worker-f.
- `api.trooth.co/.well-known/trooth-keys.json`, which every verifier CLI fetches for Trooth's keys (finding 5), goes to worker-f.

The top-level and production environments share the script name `trooth-semanto-worker` (`wrangler.toml:1,57`), so a plain `wrangler deploy` replaces the production script with `ENVIRONMENT = "development"` vars.

### Cron and queue

Crons `15 * * * *`, `30 1 * * *`, `0 6 * * 1` map exactly to `runScheduled` (`src/serve/routes.ts:751-755`). The queue consumer takes one message, retries 3 times, and has no `dead_letter_queue`, so a compile that keeps failing is lost silently.

### Migrations

0001 to 0004 apply cleanly to an empty SQLite in order (`migrate.mjs`: 27 tables, `semanto_companies` gains `custody`, `os_company_id`, `os_owner_user_id`, `basic_version`). They are not re-runnable (`ALTER TABLE ADD COLUMN`), which is fine under `wrangler d1 migrations apply`. The test shim never turns on `PRAGMA foreign_keys`, while D1 enforces foreign keys, so a foreign key fault would not show in tests.

### Finding 4 (high): compiler memory

`discover` keeps every successful fetch (`FetchOk` holds the body bytes and the decoded text), the pipeline maps them to `FetchedPage` with the HTML again, and `buildVersion` holds markdown and bodies. Measured in Node (same V8) with `compilebench.mts`:

| Site | Retained after discovery | Build CPU | Discover CPU |
| --- | --- | --- | --- |
| 500 pages of 80 KB (39 MB raw) | about 113 MB (65 MB heap plus 48 MB buffers) | 7.8 s | 1.5 s |
| 200 pages of 400 KB (78 MB raw) | about 175 MB | 16.4 s | 2.0 s |

Memory is about 2.8 times the raw site. A Worker isolate has 128 MB, so a 500-page site whose pages average more than about 90 KB fails with "exceeded memory limit"; the queue retries 3 times and drops it. 500 pages of 400 KB would also need about 46 s of CPU against the 30 s default (no `limits.cpu_ms` in `wrangler.toml`). Failure scenario: a mid-size retailer's first build never completes.

### CPU and subrequests

- Log: 70,000 appends in memory took 78 s (about 1.1 ms each, including the tree head signature); one append reads at most 2 tiles. Inclusion and consistency proofs at 70,000 leaves read at most 21 and 22 tiles in under 61 ms. Sound.
- Compile: each page costs 2 DoH requests (A and AAAA, not cached) plus the GET, plus R2 and D1 writes, about 6 subrequests a page; 500 pages is about 3,000, under the paid limit of 10,000 and far over the free limit of 50. The polite interval of 500 ms per host (`src/compiler/fetch.ts:97`) makes 500 pages take at least 250 s of wall time.
- Finding 12 (medium): `hourlyChangeDetection` (`src/pipeline.ts:755-783`) checks every page of every signed company in one cron invocation, about 4 to 5 subrequests and one 500 ms wait per page. About 2,000 pages in total reach the 10,000 subrequest limit, and about 1,800 reach the 15-minute cron limit. The loop runs in trooth_id order, so once the fleet is past that size the same companies at the end of the alphabet are never checked. `weeklyGapReports` (`:804-817`) runs every provider for every question for every company inline and reaches 15 minutes even sooner.
- Finding 13 (medium): `basic/prove` calls `this.compile` directly (`src/pipeline.ts:539-544`) inside the HTTP request, with the memory and CPU limits above and at least 250 s of waits for 500 pages.

### Finding 14 (medium): first boot with no secrets

`wire()` parses `TROOTH_WITNESS_KEY` before anything else (`src/index.ts:48-51`); without it every fetch throws (Cloudflare error 1101, no problem document, no CORS), every cron throws, and every queue message is retried 3 times and dropped. `LogDO` also throws in its constructor (`src/ledger/log-do.ts:35`). Without `HOSTED_KEY_SEAL_SECRET` hosted signing answers `conflict`; without `RECEIPT_IP_SALT_SECRET` receipts keep no address hash; without `TSA_URL` no tree head is timestamped while `docs/spec/log.md:134` says each one is.

### Finding 1 (critical): nobody can reach the workspace

`troothOsAuthorize` maps worker-f's `companyId` to a trooth_id with `SELECT trooth_id FROM semanto_companies WHERE os_company_id = ?` (`src/index.ts:120`) and refuses when there is no row (`src/pipeline.ts:1058-1059`). No code anywhere writes `os_company_id`: `putCompany` (`src/db/d1.ts:532-541`) does not set it and `basic/claim` cannot run before authorization. Failure scenario: on launch day every dashboard call, including the first Basic claim, is a 401. Until a provisioning path exists, each company needs a hand-written SQL insert, and the domain in that row is then trusted without proof (finding 2). The company-creating branch of `basicClaim` (`src/pipeline.ts:516-518`) is unreachable in production.

## 2. Security after the fixes

### The 19 fixed findings

The regression tests pass twice (section 7) and were read. Spot checks by scratch script, all holding:

- Finding 2, 3, 4, 10, 11, 12: the three kits accept real Worker answers and the 304 path (`e2e.mts`, `kit_py.py`, `gokit`); a version signed before rotation still checks out after rotation with a note-free pass.
- Finding 5 and 9: `ssrf.mts` tries 32 address forms. It refuses all 28 private, loopback, metadata, reserved, local-name and embedded-IPv4 forms (including `127.1`, `0x7f.1`, `2130706433`, NAT64, 6to4 and Teredo metadata and loopback), and passes the 4 public ones. It also refuses resolver answers with any private address, an empty answer and a resolver error.
- Finding 8: a member's sign is a 403; the claimer becomes owner once.
- Finding 15: the Basic object carries `Trooth-Semanto-State: witnessed-not-signed`, is signed by the witness key, and llms.txt says so.
- Finding 16: proofs from tiles agree with the kits.
- Finding 17 and 19: both first-publication routes answer; a catalog nonce is claimed once.

### New code from the fixes

- `src/core/ssrf.ts`: sound as a guard. Its header (`:4-6`) says it is "the one SSRF guard every outbound fetch to a URL someone else chose goes through"; that is not true (finding 9).
- `src/readers/nonce-do.ts`: claims are serialized by an in-object queue plus `blockConcurrencyWhile`. `DurableNonceStore.seen` always answers false (`:124-126`), so the pre-check before the directory fetch never refuses a replay; the claim after the signature still does. Shards are one object per agent key, so one busy agent key funnels every nonce through one object (a throughput ceiling at scale).
- `src/ledger/log-do.ts`: one global instance with an in-object queue; ordering holds even though D1 and R2 calls do not hold the input gate. See finding 19 for the one race left.
- Connector forwarding (`src/readers/forwarded.ts`, `src/pipeline.ts:962-978`): the connector signature is checked before the agent's, and an unsigned forwarded header is ignored. The forwarding signature's nonce is never claimed, so a captured forwarded request replays for 300 s; the agent's own nonce is still claimed, so a replay counts only as an unproven read with the vouched address.
- Roles: enforced as documented. A member may claim a company with no owner and becomes owner; with worker-f sending no `workspaceRole` today, the first member to claim gets signing rights.

### Finding 2 (critical): the Basic domain proof proves the wrong domain

`basicClaim` takes `domain` from the body (`src/pipeline.ts:511`), writes the claim for it (`:519`), but only creates the company row when none exists (`:516-518`). `basicProve` proves the claimed domain, then `buildBasic` calls `compile`, which ignores `job.domain` and reads `company.domain` from the row (`:173-178`). Proof (`claimswap.mts`): with a row for acme.com, a claim for `attacker.example` publishes `_trooth.attacker.example`; prove answers `proved: true, method: dns_txt`; the served record is `witnessed-not-signed` for `acme.com` with Trooth's witness signature. In production the row always exists before a claim (finding 1), so this is the normal path, not an edge case. Separately, `build`, `sign` and `first-publication` never require any domain proof for the full tier: the row's domain is trusted as provisioned.

### Finding 8 (high): no rate limit, and cheap amplification

`rateLimit: undefined` (`src/index.ts:126-127`). Every public read records a receipt (one D1 write). A request with a well-formed but unsigned-by-anyone Web Bot Auth header (any `created` within 300 s, any nonce) and a fresh `Signature-Agent` origin makes the Worker, inside `waitUntil`, do 2 DoH requests, one directory fetch with a 3 s timeout, and one KV write for the failure cache (`src/readers/webbotauth.ts:170-185`). Wildcard subdomains give unlimited fresh origins. Failure scenario: a script at 1,000 requests a second costs a D1 write and a KV write each, exhausts the KV write quota and slows D1 for real readers.

### Finding 9 (high): monitor surfaces fetched unguarded

`monitorRun` accepts `surfaces` from the request body (`src/pipeline.ts:664`, any member). `globalFetchPort` (`src/monitor/ports.ts:129-141`) fetches with `redirect: "follow"`, any scheme, no SSRF check and `res.text()` with no size limit. The same holds for `identity/ports.ts:31-42` (`platformHttp`, used by the domain proof's well-known fetch for a domain that passes only the loose regex at `src/pipeline.ts:512`, which accepts `metadata.google.internal`). Probe: `monitor/run` with `merchant_center.url = http://169.254.169.254/latest/meta-data/` answers 200. Cloudflare cannot reach private networks without a tunnel, which limits impact, but a member can point the Worker at any public URL, have values from it reflected in mismatches, or hand it a multi-gigabyte body to exhaust the isolate.

### Finding 10 (medium): cacheable authenticated answers

`buildResponse` sets `Cache-Control: public, max-age=300, stale-while-revalidate=3600` on every status below 400 (`src/serve/headers.ts:56,178`), including `/os` answers. Probe: `GET /os/semanto/acme/settings` and `POST /os/semanto/acme/keys/rotate` both carry it with `Vary: Accept` only. Under RFC 9111 `public` lets a shared cache store a response to a request with `Authorization`. Use `private, no-store` on `/os`.

### Finding 11 (medium): unbounded public body

`POST /public/semanto/first-publication/check` is unauthenticated and calls `c.req.text()` with no cap (`src/serve/routes.ts:313-315,627-635`). Probe: a 20 MB body is read fully before the 404. Account plans allow 100 MB bodies, close to the 128 MB isolate, and an isolate serves many requests at once.

### CORS on /os

`OPTIONS` answers `Access-Control-Allow-Origin: *` with `Authorization` allowed for every path, and every answer carries `*` (probe: cross-origin `POST /os/semanto/acme/build` answers 200 with `*`). Because `/os` reads only a bearer token (never a cookie, `src/pipeline.ts:1038`), a browser never attaches credentials on its own, so this is not CSRF. Low; restrict `/os` to the dashboard origin anyway.

### Denial of service by input size

Measured with `e2e.mts`: a 30 KB Accept header parses in 31 ms; 5,000 Accept parameters in 11 ms; a 4,000-segment by-path in 9 ms; `log/proof` and `log/leaves` reject out-of-range and non-integer values (`intParam` and `src/serve/ledger-port.ts:69-80`); proofs are logarithmic. Cloudflare caps URL and header size. No issue beyond findings 8 and 11.

### Error answers

Pipeline exceptions are logged with a request id and never sent. Hono has no `onError`, so a thrown handler answers a plain unsigned `Internal Server Error` with no CORS (finding 20). Internal failures are reported as `upstream_unavailable`, whose text says an outside source failed (`src/pipeline.ts:251`, `src/serve/errors.ts:184`), which is untrue for a D1 fault.

### Public repository exposure

- No secret, token or real private key in any tracked file or in the history (scanned for provider key shapes, PEM blocks, `tra_` keys). The four private JWKs are test fixtures named as such (`test/fixtures/verifier/*.fixture.json`), including a fixture witness key. Make sure the production witness key is new and that nobody passes `verifier/test-vectors/v1/keys.json` to a CLI as trusted keys.
- Personal data: the founder's name and `dandre@trooth.co` appear in the Internet-Draft author block (`docs/draft-trooth-signed-web-content-00.md:23-26`, `docs/INTERNET-DRAFT-README.md:39`, `docs/reports/verifier-docs.md:56`). Expected in a draft, but see finding 7.
- Internal planning is public: `docs/AGENT-BRIEF.md`, `docs/reports/*.md` (including the open founder steps and known weak points in `review-fixes.md`).
- No internal URLs beyond the public `api.trooth.co` routes and the service binding name.
- Finding 7 (high): `docs/INTERNET-DRAFT-README.md:9-11` says "Do not upload, post to a mailing list, or push the draft to a public repository before counsel confirms the filing." The draft and the whole mechanism are now in a public repository. Decision D13 (16 October) accepted disclosure at launch; this push is before launch, so the US 12-month inventor grace period and the loss of most foreign rights now run from the push date. Founder decision: confirm with counsel, or make the repository private until the provisional is filed.

### Dependencies

`npm audit --omit=dev`: 0 vulnerabilities (the only runtime dependency is `hono` 4.13.13). Full audit: 3 in development tools only, from `vitest` 3.2.7: `tinypool` (critical, prototype pollution to RCE, GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) and `@vitest/mocker` (moderate, GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8); the fix is vitest 5. Direct packages: `hono` 4.13.13; development `@cloudflare/workers-types` 5.20261022.1, `@types/node` 22.20.5, `tsx` 4.23.15, `typescript` 5.9.3, `vitest` 3.2.7, `wrangler` 4.152.0; three extraneous packages in `node_modules` not in the lockfile. The Python and Go kits have no third-party dependencies.

## 3. Correctness end to end

Walked with `e2e.mts` over `createApp` and the in-memory ports:

| Step | Result |
| --- | --- |
| Basic claim by a member (no owner) | 200, member becomes owner |
| Basic prove (DNS TXT) | 200, version 1 witnessed, served `witnessed-not-signed`, signed by the witness key; JS kit accepts the answer |
| Hosted key, build, sign by member | 403 |
| Build and sign by owner | 200, version 2 signed, witnessed, logged |
| Served: object, 7 pages, proof, version, keys, tree head, checkpoint, consistency | all 200 and signed |
| JS, Python and Go kits on the served answers | every response signature, the page proof (strict), the whole file with all pages, the tree head, the checkpoint and the consistency proof pass in all three |
| `semanto-verify file` CLI in JS, Python and Go on the served file, pages and keys | "Every check passed" in all three |
| Rotate, build, sign version 3 | 200; version 2 still checks out with the new key set |
| `If-None-Match` | 304, signed over status 304, checks out against the cached body |
| Withdraw | impossible (finding 6) |

Route shapes match `docs/spec/log.md` and `docs/spec/verify-endpoint.md` for every route listed there. Gaps against the specs:

- Finding 6 (high): `docs/spec/semanto-file.md:75` defines `withdrawn` ("The company withdrew it"), `docs/spec/log.md:130` says revocation lists "are appended to the log as revocation leaves", and the `semanto_withdrawn` problem says "the withdrawal is recorded in the public log" (`src/serve/errors.ts:104`). There is no withdraw action (`src/serve/routes.ts:648`), nothing writes `semanto_revocations`, `revokeKey` (`src/identity/keys.ts:109`) and `revocationLeaf` are never called, `nightlyCheckpoint` signs the list but appends no leaf (`src/pipeline.ts:796-799`), and no public route serves the list (probes: `/acme/revocations` and `/revocations` are 404). Failure scenario: a company whose hosted key leaks cannot revoke it, and a wrong version cannot be withdrawn.
- Finding 5 (high): no route serves Trooth's witness keys (probe: `GET /public/semanto/keys` and `GET api.trooth.co/.well-known/trooth-keys.json` against this Worker are 404). All three CLIs default to that second URL for the Trooth role, so `semanto-verify page`, `response` and `log` against production fail the witness and tree head steps unless worker-f serves exactly this witness key there.
- `docs/spec/response-signatures.md:57` says a 304 comes "with the same signature headers"; the code signs a new signature over status 304 (`src/serve/headers.ts:164-172`). The code is right and the kits accept it; the sentence should say so.
- The JS CLI's `log --from 0` fails: `tree-head?size=0` is a 404 (`verifier/js/cli.mjs:226-229`).
- A Basic page proof always fails strict mode with `signature_absent`, and the CLIs have no option for a witnessed-only record, so no Basic page can be checked page by page.

## 4. House rules across every tracked file

Scanned all 335 files from `git ls-files`.

- The three banned words (the ranking noun and the two past participles): no hit in `src`, `migrations`, `adapters`, `verifier`, `web`, `docs`. Hits in `test/`, which `docs/ARCHITECTURE.md:37` also forbids ("code, comments, copy, docs or tests") but the scan skips: `test/basic.test.ts:93,150`, `test/c2pa.test.ts:60`, `test/gap.test.ts:65,254,337`, `test/verifier.test.ts:196`. Inflected form: `src/compiler/build.ts:15` ("never" plus the verb form of the ranking noun). The scan's `\b` pattern misses plural and verb forms.
- Ellipses: none outside the test assertions that ban them (`test/basic.test.ts:149`, `test/c2pa.test.ts:61`, `test/gap.test.ts:255,340`, `test/verifier.test.ts:195`, `test/integration.test.ts:994`).
- Provenance words: compiler facts are `declared`, LEI facts `public_record`, connector product records `declared`. Correct.
- User-Agent: never read to choose a format. The Apache and nginx adapters blank it on the proxied request; the WordPress plugin sends its own. Correct.
- Finding 21 (low): no `X-Semanto` header, but the Worker sends `x-markdown-tokens` and `x-original-tokens` (`src/serve/headers.ts:179-180`, copied by `adapters/shared/semanto-adapter.mjs:54-55` and the WordPress plugin), while matrix row 6 says "no X- names" and `docs/reports/adapters.md:74` says "no `X-` prefixed header". They mirror Cloudflare's header for compatibility; say so or rename.
- Finding 22 (low): source files with no SPDX header: `migrations/0001_semanto.sql`, `0002_integration.sql`, `0003_os_company.sql`, `test/basic.test.ts`, `test/c2pa.test.ts`, `test/core.test.ts`, `test/gap.test.ts`, `vitest.config.ts`, `wrangler.toml`, `verifier/python/pyproject.toml`, `adapters/netlify/_redirects`. The SPDX test checks only `.ts` under `src`.
- Sample figures: fixtures are named fixtures; the stray root files are not (finding 23).
- Plain words: problem titles are plain. `upstream_unavailable` text is wrong for internal faults (section 2).

## 5. Product honesty

Finding 16 (medium), each one a sentence a reader could screenshot:

1. `verifier/README.md:3` "without trusting Trooth's servers" and `docs/spec/verify-endpoint.md:9` "check without trusting Trooth", while matrix row 10 says no such claim "until the cosigner signs" and the CLIs fetch Trooth's keys from Trooth's server.
2. `docs/spec/log.md:134` "Each nightly checkpoint is anchored with an RFC 3161 timestamp": only when `TSA_URL` is set, which it is not, and the token's CMS signature is never checked (`signature_checked: false`).
3. `docs/spec/log.md:130` revocation leaves, and `src/serve/errors.ts:104` "the withdrawal is recorded in the public log": never done (finding 6).
4. `docs/METRICS_DEFINITIONS.md:26`, `docs/spec/log.md:145` and `web/semanto/read-receipts-panel.tsx:56,126`: Trooth's own hourly checks fetch served pages, sign with Web Bot Auth and are counted in their own column. The hourly job fetches the company's origin pages unsigned, records no receipt, and Trooth has no agent key directory.
5. `web/semanto/key-binding-panel.tsx:20` "named in your DNS. Both have to agree": nothing checks the `_trooth-keys` record; `bindingStatus` is never called and every build writes `dns_record: false` (`src/pipeline.ts:199`).
6. `web/semanto/delivery-settings-panel.tsx:82` "Readers get the current page without a signature": the API serves the last signed page marked behind whatever the setting (finding 17).
7. Matrix row 18 and `docs/INTERNET-DRAFT-README.md` call the kit "open", but every file is `LicenseRef-Trooth-Proprietary` and the repository has no LICENSE file defining that reference.
8. `src/readers/webbotauth.ts:133` shows "ChatGPT agent (OpenAI)" for `https://chatgpt.com` before anyone has checked OpenAI's documentation (the code comment says so).

No claim of AI preference or Google visibility was found; `src/monitor/indexability.ts:16` and the delivery spec are careful. "Witnessed" is used only where a witness signature exists.

Finding 17 (medium): `when_page_changed` values `serve_live_marked_unsigned` and `prompt_to_sign`, and the `formats` toggles, are read only by the `/resolve` helper (`src/serve/routes.ts:564`). The page, facts and llms routes ignore them (`:382-417`), and the adapters do not call `/resolve`.

## 6. Gaps against the requirements matrix

Finding 15 (medium). Rows marked built whose code is not in the deployed bundle (checked in the dry-run output): no route, job or pipeline step calls it, so only its unit test runs.

| Row | Module not in the bundle | What a customer cannot do |
| --- | --- | --- |
| Google gap 4 | `src/monitor/writeback.ts` | No write-back runs |
| Delivery 10 | `src/serve/detect.ts` | No host detection runs |
| Signatures 12 | `bindingStatus`, `revokeKey` in `src/identity/keys.ts` | No binding level, no revocation |
| Signatures 11 | revocation writer, leaf, route | See finding 6 |
| Signatures 16 | `src/c2pa/bridge.ts` | Library only (row says so) |
| Commerce 19 | `src/commerce/synonyms.ts` | No resolver |
| Commerce 22 | `src/commerce/sellers.ts` | No authorized-seller route |
| Commerce 23 | `src/commerce/nested.ts` | No nested signatures |
| Small business 27 | `src/gap/competitor.ts` | No free competitor report |
| Small business 33 | `src/basic/content-signals.ts` | No robots.txt drift detection (the header is sent) |
| Delivery 19, Signatures 17 | `dailyDigest`, `receiptsCsv` | No digest or CSV route; no /os route reads receipts, gap reports or monitor runs, though `docs/reports/integration.md:112` says the dashboard reads receipts "through the workspace API" |

Rows whose test is too weak:

- Row 9 still lists "founder step: serialize appends" although `LogDO` exists; stale.
- Row 6 "no X- names": no test; the code sends two.
- Row 7 and the house-rule rows: the scan skips `test/` and root files and misses inflections.
- Row 29 (Basic, domain proof): the integration test claims and proves the same domain the row holds, so finding 2 passes every test.
- Row 2 (fetching): `WebFetchHttp` is never exercised (the row says so); it has no timeout (finding 18).
- Rows 11 to 17 (adapters): the shared module is tested with a fake API; the Fastly, Akamai, Gcore, Netlify, Vercel entry files and the PHP plugin are not executed.
- Row 8 (response signatures, "every response is signed"): `OPTIONS` answers and thrown handlers are unsigned; no test covers either.

## 7. Test suite health

| Suite | Result |
| --- | --- |
| `npx vitest run`, first run | 16 files, 438 passed, 25.5 s |
| `npx vitest run`, second run | 16 files, 438 passed, 26.2 s; no flakiness |
| `npx tsc --noEmit` | exit 0 |
| `python3 -m pytest -q` in `verifier/python` | 40 passed in 0.43 s; `__pycache__` and `.pytest_cache` removed |
| `go test` over every package in `verifier/go` | ok (9 top-level tests, 41 passing tests and subtests); `go vet` and `gofmt -l` clean |

The working tree is unchanged apart from `docs/audit/` (this file and `workflow-research.md`, which another session wrote). This file passes the house-rules scan in `test/integration.test.ts`. `workflow-research.md` does not: it uses the banned past participle of "verify" at lines 95, 178, 183 and 315, so committing it as it stands turns the suite red.

## 8. Smaller items (finding 26 and the other lows)

- Finding 18 (medium): `WebFetchHttp.request` (`src/compiler/ports.ts:127`) has no timeout or abort signal; a site that trickles bytes holds a compile until the queue's 15 minutes run out.
- Finding 19 (low): on a fresh database any public `/log/proof` or `/log/consistency` calls `size()`, which backfills and writes the frontier row (`src/ledger/store-d1.ts:76-88`) outside `LogDO`. If the first append commits between that reader's count and its write, the reader's `INSERT OR REPLACE` puts size 0 back. Every later append then computes index 0, overwrites R2 leaf 0 and tile 0, and fails on the primary key: the log stops and leaf 0's body no longer matches its stored hash. Seed the row in a migration (`INSERT OR IGNORE INTO semanto_log_frontier VALUES (1, 0, '[]')`).
- Finding 20 (low): `decodeURIComponent` on the offer sku (`src/serve/routes.ts:689`) throws on `%E0%A4%A`; probe answers an unsigned plain-text 500. Add an `onError` that answers a signed problem.
- Finding 23 (low): `forged-file.json` (a version with a company signature and witness, "Acme" pricing "Everything is free forever") and `forged-page.md` are at the root, committed in `b3fc2d7`, referenced by nothing.
- Finding 24 (low): `clientAddress` (`adapters/shared/semanto-adapter.mjs:411-418`) takes `True-Client-IP`, `X-Real-IP` or the first `X-Forwarded-For` entry, which clients can set on most hosts, and the adapter then signs it as vouched; receipt address hashes can be inflated.
- Finding 25 (low): through an adapter the agent's signature is checked against `https://<forwarded authority><API path>` (`src/readers/forwarded.ts:121`), not the path the agent requested, so an agent that covers `@path` or `@target-uri` is never proven through an adapter.
- The forwarding connector signature carries a nonce that is never claimed (section 2).
- trooth_ids `log`, `verify` and `first-publication` collide with fixed routes and could never be served.
- A plain `wrangler deploy` overwrites production (section 1).
- `ENVIRONMENT` is declared and never read; `src/env.ts:13` mentions KV rate limits that do not exist.
- No dead letter queue on the compile consumer.
- `NonceDO` shards by agent key; one busy agent key is one object.
- Development dependency advisories (section 2).

## What was checked and found sound

- The dry run, the bundle size, and every binding the code reads is declared (apart from the two placeholders and the undeclared optional vars).
- Durable Object migration and inheritance of `migrations` and `triggers` into production.
- Migrations 0001 to 0004 on an empty SQLite.
- Cron strings match `runScheduled`; the queue handler acks and retries correctly.
- Route specificity against worker-f's `api.trooth.co/public/*` and catch-all.
- The shared SSRF guard (32 forms), fail-closed DoH, redirect refusal and caps on the directory fetch.
- Web Bot Auth: one label, parameters before fetch, nonce claimed after the signature, atomic claims.
- The connector signature is checked before any forwarded value is used; unsigned forwarded headers are ignored.
- Roles: viewer, member, owner and admin limits hold; cross-company sessions are a 403.
- Response signatures, page proofs, whole-file checks, tree heads, checkpoints and consistency proofs from the real Worker pass in the JS, Python and Go kits and in all three `file` CLIs.
- Key rotation keeps old versions checkable; 304 answers are signed over 304.
- Log cost is logarithmic in appends and proofs (measured at 70,000 leaves).
- Odd inputs on public routes (bad integers, huge indexes, long paths, 30 KB Accept) answer signed problems quickly, apart from finding 20.
- Pipeline errors never return exception text.
- No secrets in the tree or history; runtime dependencies have no advisories.
- User-Agent is never read to choose a format; provenance words are used correctly; no AI preference or Google visibility promise.
- All test suites pass, twice for vitest, with no flakiness.
