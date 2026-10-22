# Serving layer report: src/serve, src/settings, src/db, src/index.ts

Date: 2026-10-22. Tests: `npx vitest run test/serve.test.ts test/settings.test.ts` (50 tests, all pass). Types: `npx tsc --noEmit` is clean for every file listed here.

## What was built, file by file

### src/serve/ports.ts
The interfaces the server needs from the rest of the platform, so handlers never import compiler, ledger, identity or readers code:
- `VersionStore`: `getCompany`, `getCompanyByDomain`, `getCurrent` (the current signed `SemantoFile`), `getVersion`, `listVersions`, `getPage(trooth_id, page_id)` (bytes, `PageEntry`, version, original tokens, live state), `getPageByUrl`, `getFacts`, `getJsonLd`, `getLlms(kind)`.
- `LogPort.getInclusion(index)`: leaf hash, tree size, tree head root, tree head JWS and the inclusion path.
- `KeyPort`: the company JWKS, the company's hosted private key (null when custody is with the customer), Trooth's witness key, `resolve(kid)`.
- `ReceiptPort.record(ReceiptInput)`: representation, page, `Signature-Agent` url, proof (`web_bot_auth` or `none`), time. No user agent field exists.
- `SettingsPort`, `JobPort` (hourly, nightly, weekly, compile), `ServeConfig`, and `now()` so signatures are stable in tests.

### src/serve/memory-ports.ts
In-memory implementation of every port, used by the tests. `MemoryLog` is a small RFC 6962 log whose leaf for a version is the leaf hash of the `root_hash` text and whose tree heads are signed with the witness key (`typ` signed-tree-head, payload `{ tree_size, root_hash, signed_at }`).

### src/serve/negotiate-route.ts
`negotiateRoute(pathname, accept)` returns `{ rep, basePath, forcedByPath }`. Offered order is markdown, jsonld, html through `src/core/negotiate.ts`, so `text/*` resolves to markdown as Cloudflare documents; `*/*` and no Accept resolve to html (passthrough); `.md`, `/index.md`, `.jsonld`, `/facts.jsonld` force the format. User-Agent is never read anywhere in the folder.

### src/serve/headers.ts
`buildResponse(spec, { ifNoneMatch })` produces `{ status, headers, body }` for every response, including problems:
Content-Type, `Vary: Accept`, strong `ETag` (quoted digest of the bytes served), `Cache-Control: public, max-age=300, stale-while-revalidate=3600` (`no-store` on problems), `x-markdown-tokens`, `x-original-tokens`, `Trooth-Contract`, `Trooth-Semanto-Version` (the smv_ id, or `none` before a first signature), `Trooth-Page-Hash`, `Link` (canonical, two alternates, `https://trooth.co/rel/semanto`, `rel/trust-profile`, `rel/proof`, `rel/keys`), `Content-Signal` from the company's settings, `Trooth-Semanto-State: behind` when applicable, `Retry-After`, `Trooth-Signed-By: witness` when the witness key signs, `Content-Digest` (RFC 9530), then `Signature-Input` and `Signature` (RFC 9421, `SEMANTO_RESPONSE_COMPONENTS`, tag `trooth-semanto`, 300 seconds), `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers` naming every Trooth header. A matching `If-None-Match` on a 200 gives a 304 with the same headers, a signature over status 304, and no body. `toResponse` is the only place that touches the runtime `Response`.

### src/serve/errors.ts
RFC 9457 problems with `code`, `retryable`, `next_action`, `terminal`, and the markdown form (front matter `error_code`, `http_status`, `retryable`, `retry_after` when present, `terminal`; then "What happened" and "What you should do"). Codes: `semanto_not_found` 404, `semanto_not_signed` 409, `semanto_version_not_found` 404, `page_not_found` 404, `page_behind` 200, `semanto_withdrawn` 410, `invalid_trooth_id` 400, `unsupported_contract_version` 406, `rate_limited` 429 with `Retry-After`. `behindNotice` and `stripBehindNotice`: when a live page changed after the last signature, the last signed bytes are served with a `trooth_state: behind` front matter block in front; `Trooth-Page-Hash` still names the signed bytes, `ETag` and `Content-Digest` cover what was sent, no `Warning` header is used, and `verifyProof` strips the notice before hashing.

### src/serve/proof.ts
- `buildPageProof(file, page_id, log, signed_at)`: `{ object: "semanto.proof", page_id, page_hash, version, version_id, pages_root, inclusion: { index, size, path }, root_hash, signed_at, witnessed_at, signature, witness, ledger }`. The path is `src/core/merkle.inclusionProof` over the manifest's leaf hashes in manifest order, the same leaves `pagesRoot` folds.
- `verifyProof(proof, bytes, { header?, resolveKey?, at? })`: recomputes the page hash, the inclusion against `pages_root`, the header binding (`pages_root`, `rootHash(header)`, manifest entry), the company JWS (typ semanto-version, detached over the header), the witness JWS (typ witness-statement over `{ root_hash, witnessed_at }`), the log inclusion and the signed tree head. A check is `not_checked` only when its input was not given; any run check that fails makes `ok` false.
- `verifyUrl(store, base, url, hash, signedAt)`: `matches | differs | unknown_url | not_signed` with `version`, `signed_at`, `signer { kid, domain, lei? }`, `signed_hash` and `proof_url`.

### src/serve/represent.ts
Derived representations: a page's JSON-LD (schema.org `WebPage` whose `text` is the page's full text and whose `trooth:facts` are the facts witnessed on that url), the facts tier as JSON-LD, the `/.well-known/trooth.semanto` pointer, fallback `llms.txt`, `llms-full.txt` and `sitemap.md` from the manifest when the compiler stored none, and the `markdownToText`, `htmlToText`, `sentences` helpers behind the same-content test.

### src/serve/detect.ts
`detectHost(domain, ports)` fetches `/` with `text/html` and with `text/markdown`, the two well-known paths, `/wp-json/`, and the `_trooth` TXT record (DNS over HTTPS to 1.1.1.1, RFC 8484, behind `dnsTxt`). Result: `{ host, cloudflare_markdown, well_known_served, well_known_matches, dns_pointer, conflicts, suggested_markdown_source, evidence, checked_at }`. `x-markdown-tokens` on the markdown request means Cloudflare's converter is on and raises the `double_markdown` conflict; the suggestion is then `semanto_then_cloudflare_for_unsigned`, otherwise `semanto_only`. `classifyHost` reads `cf-ray`, `server`, `x-vercel-id`, `x-nf-request-id`, `x-served-by`, `x-akamai-*`, Gcore, nginx, Apache and the WordPress generator meta. `liveFetcher` and `dohTxtResolver` are the production ports.

### src/serve/routes.ts
`createApp({ ports, readers?, authorize?, rateLimit? })` is the Hono app:
```
GET /public/semanto/verify?url=&hash=
GET /public/semanto/{trooth_id}                      JSON file; text/markdown gives llms-full; ld+json gives facts
GET /public/semanto/{trooth_id}/versions
GET /public/semanto/{trooth_id}/versions/{n}        410 withdrawn, 409 unsigned, 404 missing
GET /public/semanto/{trooth_id}/pages/{smp_id}[.md|.jsonld|/index.md]   negotiated; html gives 303 to the canonical page
GET /public/semanto/{trooth_id}/pages/{smp_id}/proof
GET /public/semanto/{trooth_id}/facts.jsonld | llms.txt | llms-full.txt | sitemap.md
GET /public/semanto/{trooth_id}/keys and /.well-known/trooth-keys.json and /.well-known/trooth.semanto (hosted copies the adapters mirror)
GET /public/semanto/{trooth_id}/resolve?path=&accept=   what an adapter should do for a path on the company's domain
GET|POST /os/semanto/{trooth_id}/settings           section D, validated, behind the authorize hook
OPTIONS *                                            CORS preflight
```
Every response goes through `headers.ts`. The hosted company key signs when custody is hosted; otherwise the witness key signs with `Trooth-Signed-By: witness`. The receipt middleware computes the `ReceiptInput` after the response is built and hands it to `ReceiptPort.record` through `executionCtx.waitUntil` when present, otherwise fire and forget. `runScheduled(ports, cron)` maps the three crons in `wrangler.toml` to `JobPort`; `runQueue` acks or retries per message.

### src/settings/delivery.ts
The settings model exactly as specified (`where`, `host`, `formats`, `markdown_source`, `when_page_changed`, `content_signals`), `DEFAULT_SETTINGS`, `withDefaults`, `validateSettings` (plain messages, plus three cross-field rules: converter modes need Cloudflare, markdown off needs the proof-only mode, a host adapter needs own domain on), `contentSignalHeader`, `describeMode` (with `PROOF_ONLY_WARNING`: "Individual pages cannot be checked in this mode, because the converter's bytes change on every request") and `resolve(settings, request)` returning `serve_semanto | fall_through_host | passthrough` with what to serve, the state header, the prompt flag and the mode text. The no-duplicate rule: in every mode where a converter is present, a signed page is answered by Semanto first.

### src/db/d1.ts
One function per query against `migrations/0001_semanto.sql` (companies, versions, pages, change state, facts, keys, settings, host detection, log rows and tree heads, read receipts), the R2 key layout under `semanto/<trooth_id>/v<version>/`, and `D1VersionStore`, `D1Keys`, `D1Log`, `D1Receipts`, `D1Settings` implementing the ports. The signed `SemantoFile` is read whole from R2 (`semanto.json`), never rebuilt from rows.

### src/index.ts
Builds the D1 and R2 ports from `Env`, creates the app once per isolate, exports `fetch`, `scheduled` and `queue`.

### Tests and fixtures
`test/serve.test.ts` (37 tests): the negotiation table, every header and signature verification with `verifyMessage`, witness signing, ETag and 304, html redirect, markdown and JSON problems for every code, version problems, the behind state, proofs that verify offline and fail on a changed byte or a moved index, the four verify statuses, the same-content guarantee (markdown sentences equal HTML sentences equal JSON-LD text sentences for all three fixture pages), byte-identical bodies and headers across user agents, the other routes, settings over the workspace route, CORS, receipts (with and without a readers module), crons and queue, rate limiting, host detection (Cloudflare fixture flagged, Vercel fixture, header classification, DoH parsing).
`test/settings.test.ts` (13 tests): defaults, filling, validation messages, cross-field rules, Content-Signal, mode descriptions, the resolver for each mode and each when-changed option, format switches.
`test/fixtures/serve/`: Acme Inc (acme.com) pages as `.md` and `.html` pairs, Cloudflare and Vercel response fixtures, and `fixture.ts`, which builds real signed versions (hashes, ids, Merkle roots, JWS, a log entry) from those files at test time. No figure in a fixture is a measurement.

## Requirement numbers covered
Delivery 5 to 10 (negotiation, headers, ETag and 304, markdown problems, per-page proofs, host detection), 18 (settings resolver and the no-duplicate rule), 20 (headers for parts: every served representation, including llms and sitemap, carries the full header set); settings panel section D; signature items 8 (response signatures, RFC 9421 with RFC 9530) and 15 (the verify endpoint).

## Stubbed, or needs a founder step
- `TROOTH_WITNESS_KEY` secret (a private Ed25519 JWK) must be set; `src/index.ts` refuses to start without it. Hosted company private keys are read from R2 at `keys/<trooth_id>/<kid>.jwk`; the identity module owns their encryption at rest, so until it is wired `D1Keys.getCompanySigningKey` should be treated as a placeholder and responses are witness-signed.
- `RouteDeps.readers` (Web Bot Auth verification, src/readers), `RouteDeps.authorize` (workspace auth for /os, src/identity) and `RouteDeps.rateLimit` (KV) are hooks; without them receipts record `proof: none`, every /os call answers 401, and no limit applies.
- `JobPort` in `src/index.ts` is four empty functions for the monitor, ledger, gap and compiler modules.
- `D1Log.getInclusion` recomputes the path from the `semanto_log` rows; the ledger module should replace it with its tile-based function. Assumption to confirm with the ledger: the log leaf for a version is the RFC 6962 leaf hash of the `root_hash` text, and the tree head JWS is compact with payload `{ tree_size, root_hash, signed_at }`.
- `selectPageLiveState` derives `behind` from `semanto_change_state.raw_hash` differing from the page's `source_hash` after `signed_at`; the monitor module fills that table.
- Page JSON-LD, facts JSON-LD, llms and sitemap are built from the manifest when R2 has no compiler copy; once the compiler stores them, the stored bytes win.
- `custody` is read from the newest unrevoked row in `semanto_keys`; the companies table has no custody column.
- `src/core` was not changed.

## How to run
```
npx vitest run test/serve.test.ts test/settings.test.ts
npx tsc --noEmit
```
