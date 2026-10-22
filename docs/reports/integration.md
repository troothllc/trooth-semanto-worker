<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- Area report for the integration pass, per docs/AGENT-BRIEF.md rule 10: the modules wired into one Worker, the cross-module gaps closed, file by file, and what still needs a founder step. -->

# Integration report: one Worker

Date: 2026-10-22. Scope: wire the eight modules into one working Worker and close the gaps between them. Nothing was committed.

Checks at the end of the pass:

```
npx vitest run                                   15 files, 382 tests, all pass (348 before, 34 new in test/integration.test.ts)
npx tsc --noEmit                                 clean
cd verifier/python && python3 -m pytest -q       22 passed
cd verifier/go && go test ./semanto/             ok
node verifier/js/cli.mjs file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages    every check passed
npx wrangler deploy --dry-run                    bundles (524 KiB, 135 KiB gzip), TROOTH_OS binding listed
```

The test vectors were not regenerated: they already carried the ledger's leaf record, so only `src/serve` had to change.

## The gaps, and how each was closed

### 1. One log leaf format

The ledger owns it: canonical JSON of `{ kind, trooth_id, ref, hash, at }` (`src/ledger/ports.ts`). `src/serve/proof.ts` now carries `ledger.leaf` in every proof; `verifyProof` recomputes the RFC 6962 leaf hash from the record, and requires `leaf.hash` to equal the proof's `root_hash` and `leaf.kind` to be `semanto_version` (new check `ledger_leaf`). The serving layer's log is the ledger itself: `src/serve/ledger-port.ts` (`LedgerLogPort`) adapts `TransparencyLog` to the serve `LogPort`, and `MemoryLog` is now that adapter over `MemoryLogStore`. The old `leafHash(utf8(root_hash))` code and the `D1Log` skeleton are gone. Tests: serve's `verifyProof` accepts the kit's `page-proof.json` vector and fails a changed, wrong-kind or missing leaf record.

### 2. Public log routes

`src/serve/routes.ts` serves, before the `/{trooth_id}` routes and signed by the witness key:

- `GET /public/semanto/log/tree-head[?size=]`: `{ tree_size, root_hash, signed_at, jws }`, or the checkpoint text when Accept names `text/plain` at least as strongly as JSON (`prefersPlainText`)
- `GET /public/semanto/log/checkpoint[?size=]`: the signed note
- `GET /public/semanto/log/proof?index=&size=`: `{ index, tree_size, leaf_hash, root_hash, path }`
- `GET /public/semanto/log/consistency?from=&to=`: `{ from, to, old_root, new_root, path }`
- `GET /public/semanto/log/leaves/{index}`: `{ index, leaf, leaf_hash }` (added to `docs/spec/log.md`)

Out-of-range numbers answer the new `log_entry_not_found` problem (404), non-numbers `invalid_request` (400). Production backs them with `D1LogStore` (`src/ledger/store-d1.ts`).

### 3. The routes the adapters assume

- `GET /public/semanto/{trooth_id}/by-path{path}` (and `/by-path` for the home page): the path is negotiated with the same `negotiateRoute` as `/pages` (suffixes `.md`, `/index.md`, `.jsonld` work), looked up in the current manifest (with and without a trailing slash) and served by the same `servePage`, so bytes and headers are identical to `/pages/{smp_id}`; HTML gives 303 to the page, a missing path the markdown or JSON `page_not_found` problem.
- `GET /public/semanto/{trooth_id}/keys.json`: added beside `/keys` and `/.well-known/trooth-keys.json` (`API_PATHS.keys` in `adapters/shared/semanto-adapter.mjs`).
- `POST /os/semanto/{trooth_id}/commerce/catalog`: checked with `src/core/httpsig.ts` (`verifyMessage` with the four connector components, tag `trooth-connector`, 300 seconds, and `verifyContentDigest`) against connector keys on file; the document from `adapters/wordpress-plugin/README.md` becomes variant-level `ProductRecord` and `Offer` inputs (`catalogToInputs` in `src/pipeline.ts`), signed with the company's hosted key, stored through `CommerceStore`, and new product records are appended to the log as `product_record` leaves. Answer: 202 with the record and offer ids. Customer custody answers 202 with `signed: false` and publishes nothing (Trooth holds no key to sign with). Connector public keys are added with `POST /os/semanto/{trooth_id}/connectors`.
- The commerce public routes from `src/commerce/routes.ts` are on the app, signed like every other response: `/products`, `/products/{smk_id}`, `/offers`, `/offers/{sku}`, `/feeds/{merchant-center|merchant-center.tsv|acp|ucp}`, `/.well-known/ucp`. Commerce problems are passed through as RFC 9457, in markdown when asked.

### 4. The pipeline

`src/pipeline.ts` (`Pipeline`) implements `WorkspaceHandlers` and the `JobPort`:

- compile: `discover`, fetch, `buildVersion` (incremental from the latest stored version), registry facts merged and re-hashed (`rehashFile`), `generateJsonLd`, bodies and files stored, change state recorded; state `read`.
- `POST /sign`: approval through `roleFromWorkspace`, recorded per built root hash; `mayBeSigned` with the company's `signing` policy (two-officer answers 202 until a second distinct person approves). The signed header gets `state: signed` and `identity.authorized_by`. Hosted custody: the company key (created on first use) signs the exact `versionSigningInput`, assembled with `assembleJws` and checked with `checkAssembledJws`. Customer custody: the first call stores and returns the signing input; the second call takes the 64-byte signature, assembles and checks it (422 `signature_invalid` otherwise). Then Trooth's witness JWS, the `semanto_version` and `witness` leaves, the tree head the ledger signs, an RFC 3161 timestamp when `TSA_URL` is set (token kept in R2, noted on the tree head row), `ledger` written into the file, state `signed`.
- `POST /build` (queued when the queue is bound, inline otherwise), `/gap-report` (`runGapReport` with `allAdapters` and the Env keys), `/monitor/run` (`runMonitor` against the signed file plus the commerce records and offers), `/keys/rotate` (hosted rotation with the 30-day overlap, or a customer public key; a `key` leaf each time), `/lei` (`lookupLei`, `leiFacts` kept as `public_record` facts for the next build, `compareLegalName`), `/basic/claim` and `/basic/prove` (`claim`, `proveDomain`, `buildBasic` with the compiler, `measureSetup`, `basicResponse` and `basicHeaders`), `/first-publication` (the page is fetched and extracted by Trooth, `createFirstPublication` appended to the log, the dispute statement returned).
- scheduled: hourly `ChangeDetector` over every signed company's pages, change state stored (which drives the serve `behind` state), changed urls queued as `change_detected`; nightly tree head, timestamp and a re-signed revocation list (R2 `semanto/revocations/latest.jws`); weekly gap reports for the kinds each company asked for. One schedule: `wrangler.toml` crons `["15 * * * *", "30 1 * * *", "0 6 * * 1"]`, `WEEKLY_RUN.cron` changed from `0 9 * * 1` to `0 6 * * 1` (`nextMondayNine` renamed `nextWeeklyRun`), and a test fails if they disagree.
- readers: `webBotAuthReaders` puts `verifyWebBotAuth` behind the receipt middleware; a receipt says `web_bot_auth`, with the key id, only when the key was proven. `ReaderReceipts` stores through `recordRead`: the `cf-connecting-ip` address is hashed with the daily salt from `RECEIPT_IP_SALT_SECRET` and never kept.
- `/os` authorization: `troothOsAuthorize` asks worker-f's session check through the `TROOTH_OS` service binding (`GET /auth/session` with the bearer token) and returns `{ trooth_id, role, user_id, name }`. Without the hook, without a token or with a refused token the route answers a 401 problem; a session for another company answers 403. Only owners and admins sign, rotate keys, change settings, bind an LEI, claim a domain or add a connector key.

### 5. The end-to-end test

`test/integration.test.ts`, in-memory ports and the compiler fixture site: build, sign with the hosted key, witness, log; a page with `Accept: text/markdown` through `app.request`; the response signature checked with `src/core/httpsig.ts` and with `verifier/js/verify.mjs` `verifyResponse`; the page proof checked with `src/serve/proof.ts` `verifyProof` and `verifyPageProof`; the log inclusion proof checked against the signed tree head (and the checkpoint, the consistency proof and the leaf record); byte-identical bytes, ETag and signature for two user agents. Then a signed connector catalog, the monitor against a Merchant Center fixture whose price differs (`product.ANV-100.price`, trust) and a Business Profile fixture whose phone differs (`contact.phone`, carrying the compiler's fact id), and the gap compare against a fixture answer (`local.phone` finds the same fact id). A second test runs the same flow through the Worker's own `src/db/d1.ts` and `src/ledger/store-d1.ts` classes over Node's SQLite with both migrations applied and a Map for R2 (`test/fixtures/integration/fixture-d1-shim.ts`), so the SQL the Worker runs is exercised.

Other tests in the file: two-officer signing, customer custody, hosted key rotation, LEI, Basic with the setup measurement, first publication, the queue, hourly, nightly (with a fixture TSA), weekly, Web Bot Auth receipts, the authorization rules and `troothOsAuthorize`, key sealing, catalog mapping, and a repository-wide house-rule scan (banned words, ellipses, `X-Semanto-` headers, User-Agent reads, any mention-seeding feature, the SPDX header on every source file).

### The shared fact keys

The compiler wrote `contact.telephone`, the monitor read `contact.phone` and the gap report asked for `local.phone`, so the three never met. `src/core/fact-keys.ts` (new) holds the one vocabulary and its aliases; the compiler now writes `contact.phone`; the monitor (`signedFacts`) and the gap compare read signed facts through `canonicalFactKey`. The end-to-end test proves it with one fact id across the three modules.

### 6. Docs

`docs/ARCHITECTURE.md`: the route list now matches what `routes.ts` serves, `src/pipeline.ts` is in the layer table, the second migration is named. `docs/REQUIREMENTS-TRACEABILITY.md`: requirement 7 (never do mention-seeding: a product rule enforced by the absence of any such feature plus the house-rule scan), requirement 34 (ten-minute setup, measured: `SETUP_CHECKLIST` and `measureSetup`, returned by `/basic/prove`), delivery 19 (read analytics: `src/readers`), requirement 26 and the notes A, B, D resolved, note E (fact keys) added, the founder-step statuses brought up to date. `docs/spec/log.md`: the two "to confirm" notes resolved and the leaves route added.

## File by file

New:

- `src/pipeline.ts`: the pipeline, the catalog mapping, `withCompanies` (the commerce store answers `company()` from the company rows), `webBotAuthReaders`, `ReaderReceipts`, `troothOsAuthorize`.
- `src/pipeline-store.ts`: the `PipelineStore` port, `CompanyConfig` and `MemoryPipelineStore` (writes through to `MemoryVersionStore` so the routes read what the pipeline built).
- `src/serve/ledger-port.ts`: `LedgerLogPort`.
- `src/core/fact-keys.ts`: the shared fact-key vocabulary (a new file in `src/core`; it exports two functions and one table and changes nothing else in core).
- `src/db/key-seal.ts`: AES-256-GCM sealing of hosted private keys, key per kid by HKDF-SHA-256 from `HOSTED_KEY_SEAL_SECRET`.
- `migrations/0002_integration.sql`: `semanto_companies.custody`, `semanto_change_state.lastmod`, `semanto_company_config`, `semanto_authorizations`, `semanto_pending_signatures`, `semanto_connector_keys`, `semanto_basic`, `semanto_revocation_lists`.
- `test/integration.test.ts` (34 tests) and `test/fixtures/integration/` (`fixture-merchant-center.tsv`, `fixture-business-profile.json`, `fixture-catalog.json`, `fixture-gap-answers.json`, `fixture-d1-shim.ts`).

Changed:

- `src/index.ts`: builds every port from Env (D1, R2, KV, Queue, TROOTH_OS) and wires the pipeline, readers, authorize and commerce into the app; exports `wire(env)`.
- `src/env.ts`: `RECEIPT_IP_SALT_SECRET`, `HOSTED_KEY_SEAL_SECRET`, `TROOTH_OS` (all optional), and a file comment.
- `wrangler.toml`: the `TROOTH_OS` service binding to `trooth-os-worker-f` (top level and production); the cron comment.
- `src/serve/routes.ts`: log routes, `/by-path`, `/keys.json`, the commerce public routes, the `/os` actions and the catalog endpoint, deny-by-default `workspaceFor` (401 and 403 problems, settings now need owner or admin), receipts carry the key id and the address for hashing, CORS allows POST and Authorization, `prefersPlainText`.
- `src/serve/ports.ts`: `LogPort` and `LogInclusion` in the ledger's shapes (leaf record included), `LogInclusionProof`, `LogConsistencyProof`, `WorkspaceAuth`, `WorkspaceAction`, `WorkspaceResult`, `WorkspaceHandlers`, `SignedRequest`; `ReceiptInput.keyid` and `.address` (optional).
- `src/serve/proof.ts`: the ledger leaf in `PageProof` and the `ledger_leaf` check.
- `src/serve/memory-ports.ts`: `MemoryLog` is the ledger over `MemoryLogStore` (store exposed).
- `src/serve/errors.ts`: problems `unauthorized`, `forbidden`, `invalid_request`, `conflict`, `signature_invalid`, `log_entry_not_found`, `upstream_unavailable`.
- `src/serve/headers.ts`: representations `text` (checkpoint) and `tsv` (Merchant Center feed).
- `src/db/d1.ts`: `D1Log` removed; company custody falls back to the new column; `D1Keys` opens sealed keys; new `D1PipelineStore`, `D1CommerceStore`, `D1MonitorStore`; `D1ReceiptStore` re-exported.
- `src/compiler/facts.ts`, `src/compiler/jsonld.ts`: `contact.phone` instead of `contact.telephone`.
- `src/monitor/surfaces.ts`: signed fact keys read through `canonicalFactKey`. `src/monitor/ports.ts`: `resendEmailPort`.
- `src/gap/compare.ts`: facts found through `sameFactKey`. `src/gap/report.ts`: `WEEKLY_RUN` at `0 6 * * 1`, `nextWeeklyRun`.
- `src/core/merkle.ts`: one comment word changed to "checked" (house rule 2, found by the new scan), line 16: "Both are checked offline."
- `test/fixtures/serve/fixture.ts`: appends ledger leaf records. `test/compiler.test.ts`: `contact.phone`. `test/gap.test.ts`: the 06:00 schedule.
- `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS-TRACEABILITY.md`, `docs/spec/log.md`, this report.

## Still needing a founder step

1. Secrets: `TROOTH_WITNESS_KEY` (already required), `HOSTED_KEY_SEAL_SECRET` (32 characters or more; without it no hosted key can be created and hosted signing fails with a plain message), `RECEIPT_IP_SALT_SECRET` (16 or more; without it receipts fall back to the old row with no address hash), provider keys, `TSA_URL`, `RESEND_API_KEY` and `ALERT_FROM`.
2. Apply `migrations/0002_integration.sql` to D1 (`wrangler d1 migrations apply trooth_semanto --env production`), and set the real D1 and KV ids in `wrangler.toml`.
3. worker-f's session check: `troothOsAuthorize` calls `GET /auth/session` through the binding and reads `trooth_id` (top level, `company.trooth_id` or `user.trooth_id`) and `workspace_role` (or `role`). Confirm the path and that the answer carries the company's Trooth ID and the workspace role (owner, admin, member, viewer); a role it does not recognize reads as member, which cannot sign. If worker-f answers in another shape, it is one function in `src/pipeline.ts`.
4. Dashboard fields in trooth-web: the connector key (`POST /os/semanto/{id}/connectors`), the signing policy and connected surfaces (`semanto_company_config`; there is no route to edit them yet, so they are set in D1 or by a follow-up route), and the customer-custody signing step (show `signing_input`, post back `signature`).
5. Log appends: still serialized by nothing but the D1 row count (the ledger report's note). Put a Durable Object in front of `appendLeaf`, or run signing only from one consumer, before launch. `TransparencyLog.inclusionProof` reads every leaf hash from D1; switch to the R2 tiles when the log grows.
6. Rate limiting (`RouteDeps.rateLimit`) is still not wired.
7. Witness public keys: this Worker's routes cover `/public/semanto/*` and `/os/semanto/*`; `https://api.trooth.co/.well-known/trooth-keys.json`, which the verifier CLIs fetch by default, must be served (by worker-f or a route added here).
8. Not wired here: the recall change entry into the company changes feed (worker-f), `GET /public/semanto/{trooth_id}/receipts` (receipts are stored; the dashboard reads them through the workspace API).
9. Content of other reports: `docs/reports/gap-basic-c2pa.md` still names `0 9 * * 1` and `nextMondayNine`; this report supersedes it. The readers module's `ip_hash` is 64 hex without the `sha256:` prefix (a keyed hash, not a content digest); left as built.
