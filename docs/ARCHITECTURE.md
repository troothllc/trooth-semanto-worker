# trooth-semanto-worker: architecture and house rules

Semanto by Trooth: a company's entire public website in one signed file, built for AI. Every page word for word, every fact tied to its source, signed by the company and witnessed by Trooth. Anyone can check it, offline.

This repository is the Semanto platform: the compiler, the signer, the public log, the server, the monitors and the adapters. It is a Cloudflare Worker (Hono) with D1, R2, KV and Queues. It is private until launch day.

## The one sentence that governs every module

Semanto does not make AI believe a company; it makes what the company said impossible to misquote without anyone being able to tell.

## Layers

| Folder | Owns | Depends on |
| --- | --- | --- |
| `src/core` | Encodings, SHA-256, RFC 8785 canonical JSON, RFC 6962 Merkle trees, Ed25519 JWKs, JWS, RFC 9421 HTTP message signatures with RFC 9530 Content-Digest, Accept negotiation, ids, the Semanto schema and hashing rules | nothing |
| `src/compiler` | Discovery, fetching with SSRF guards, extraction to markdown, fact candidates, JSON-LD write-back, llms.txt and the markdown sitemap, the assembled version | core |
| `src/serve` | Content negotiation, headers, per-page proofs, markdown error pages, delivery settings, host detection, the public routes | core, compiler types, ledger, identity |
| `src/ledger` | The public transparency log (signed tree heads, inclusion and consistency proofs, checkpoints), RFC 3161 timestamps, validity and revocation | core |
| `src/identity` | Key discovery (JWKS and DNS), LEI and vLEI binding, who authorized a signature | core |
| `src/readers` | Web Bot Auth verification, read receipts, agent naming only from proven identity | core |
| `src/monitor` | Surface consistency (signed record vs live HTML vs schema.org vs Merchant Center vs Business Profile vs UCP and ACP feeds), indexability checks, write-back connectors, plain-language alerts | core, compiler, commerce |
| `src/commerce` | Product and variant records, fresh signed offers, feed parity (Merchant Center, ACP, UCP), authorized sellers, nested marketplace signatures, recalls | core |
| `src/gap` | The gap report: buyer prompts, provider adapters, comparison against the signed record, the competitor view | core |
| `src/basic` | Semanto Basic (free tier, domain proof only), first-publication proof, signed Content Signals | core, compiler |
| `src/c2pa` | Mapping a Semanto manifest to C2PA assertions for images and PDFs | core |
| `src/setup` | The setup backend behind the Semanto pages of the trooth.co dashboard: the setup state and step, the WorkspaceDomains port (the workspace's domains confirmed on trooth.co, the one domain proof), the install check; the retired DNS proof modules (Domain Connect, the DNS host, the diagnosis) are kept only for their own tests | core, basic, serve |
| `src/settings` | The delivery settings model and resolver | core |
| `src/os` | The workspace contract of 23 October 2026 (docs/spec/os-api.md): staged key rotation, read receipts with filters, connector keys and the app connect flow, Connect Google, company settings and the audit trail, write-back runs that send, seller lists, recall events to worker-f, C2PA credential jobs; its storage port (`src/os/store.ts`) and routes (`src/serve/os-routes.ts`) | core, identity, readers, monitor, commerce, c2pa, pipeline |
| `src/db` | D1 access, one function per query, no SQL in handlers; hosted keys and the Google refresh token sealed at rest (`src/db/os-d1.ts` for the workspace contract) | |
| `src/pipeline.ts` | The modules wired into one flow: compile, sign, witness, log, the workspace actions, the commerce catalog, the crons, readers and authorization | every module above |
| `adapters/` | Host adapters: Cloudflare Worker, Vercel, Netlify, Fastly, Akamai, Gcore, nginx, Apache, WordPress, head tag, commerce platforms | the public API only |
| `verifier/` | The open verifier kit: JavaScript, Python, Go, a CLI and shared test vectors | the published formats only |
| `web/` | The first React components for the dashboard; the Semanto pages now live in trooth-web (`app/dashboard/semanto`), rebuilt with trooth-web's own components | the public API only |
| `docs/` | Specs, the Internet-Draft, the traceability matrix | |

## House rules (these are not optional)

1. **Provenance words are exactly four:** witnessed, public_record, attested, declared. A declared fact is never shown as witnessed. Three negatives stay apart: `no`, `not_published`, `not_read`.
2. **Trooth witnesses and never judges.** No module produces a number or a verdict about a company. Three words never appear, in code, comments, copy, docs or tests: the noun a ranking gives (s, c, o, r, e), and the past participles of "verify" and "certify". The test in `test/integration.test.ts` builds them from parts and scans every folder for them. Say "checked", "proven", "witnessed", "matches", "mismatch".
3. **Never switch on User-Agent.** Format is chosen by the Accept header or a path suffix. Every representation carries the same content. A test fails if two readers of the same URL and Accept get different bytes.
4. **No sample figure presented as real.** Fixtures are named as fixtures. Copy never cites a number Trooth did not measure.
5. **No ellipses** (the three-dot character or three periods) anywhere: code, comments, copy, docs. Hashes and paths are printed in full.
6. **Every digest is `sha256:` plus 64 lowercase hex.** Every id is a content-addressed `smx_` id from `src/core/ids.ts`.
7. **Every statement Trooth or a company signs carries a `typ` from `JWS_TYPES`** and a validity window where one makes sense. A verifier always checks the type.
8. **Every module is pure where it can be:** handlers turn `{ status, headers, body }` into a Response; logic takes plain values. Tests run in Node with vitest and need no Cloudflare runtime.
9. **Errors are RFC 9457 problems** (`application/problem+json`) with `code`, `retryable`, `next_action`, `terminal`, and a markdown form for `Accept: text/markdown`.
10. **Headers:** `Trooth-Request-Id` on every response (exposed to browsers, not signed), `Trooth-Contract`, `Trooth-Semanto-Version`, `Trooth-Page-Hash`, `Signature-Input`, `Signature`, `Content-Digest`, `Vary: Accept`, `ETag` kept, `x-markdown-tokens` and `x-original-tokens` under Cloudflare's names, `Content-Signal` passed through from the customer's policy. Those two token headers are the only X- names, kept on purpose for compatibility with Cloudflare's converter; no Trooth header ever has an `X-` prefix (RFC 6648).
11. **Copy and UI:** Open Sauce One; Ink #202124, Paper #F7F8F8, blue #1A73E8 on actions only, the dark site canvas #0E1014. Plain words. No jargon in anything a small business owner reads.
12. **File header** on every source file: the SPDX line and the copyright line, then a comment saying what the module is for and which leader's practice it follows, where there is one.
13. **Tests** live in `test/<area>.test.ts`. Every module ships with tests that would fail if its rule were broken.

## Data model (D1)

See `migrations/0001_semanto.sql` to `migrations/0008_review_backend.sql`. From 0007 on, every up migration has a down file in `migrations-down/NNNN_name.down.sql`, outside wrangler's folder so it is never applied by accident. Page bodies, parts, feeds and log tiles live in R2 under `semanto/<trooth_id>/v<version>/`. D1 holds metadata only.

## Public routes (served by `src/serve/routes.ts`, wired in `src/index.ts`)

Every response, problems included, is signed (RFC 9421, tag `trooth-semanto`) with Content-Digest, ETag and `Vary: Accept`. Format is chosen by Accept or path suffix only.

```
GET  /public/semanto/log/tree-head[?size=]              latest (or sized) signed tree head as JSON; the checkpoint text when Accept is text/plain
GET  /public/semanto/log/checkpoint[?size=]             the checkpoint text (signed note)
GET  /public/semanto/log/proof?index=&size=             { index, tree_size, leaf_hash, root_hash, path }
GET  /public/semanto/log/consistency?from=&to=          { from, to, old_root, new_root, path }
GET  /public/semanto/log/leaves/{index}                 { index, leaf, leaf_hash }
GET  /public/semanto/verify?url=&hash=                  one-call verification
GET  /public/semanto/{trooth_id}                        the semanto object (JSON); text/markdown gives llms-full, ld+json gives facts
GET  /public/semanto/{trooth_id}/versions
GET  /public/semanto/{trooth_id}/versions/{n}
GET  /public/semanto/{trooth_id}/pages/{smp_id}[.md|.jsonld|/index.md]    page markdown or JSON-LD, with its proof headers; html gives 303 to the page
GET  /public/semanto/{trooth_id}/pages/{smp_id}/proof   inclusion proof against pages_root and the log (carries the ledger leaf record)
GET  /public/semanto/{trooth_id}/by-path{path}          the page at a path on the company's domain, same negotiation and headers as /pages
GET  /public/semanto/{trooth_id}/facts.jsonld | llms.txt | llms-full.txt | sitemap.md
GET  /public/semanto/{trooth_id}/keys | keys.json | .well-known/trooth-keys.json    the company's JWK Set (the adapters mirror keys.json)
GET  /public/semanto/{trooth_id}/.well-known/trooth.semanto
GET  /public/semanto/{trooth_id}/resolve?path=&accept=  what an adapter should do for a path
GET  /public/semanto/{trooth_id}/products | products/{smk_id} | offers | offers/{sku}
GET  /public/semanto/{trooth_id}/feeds/{merchant-center|merchant-center.tsv|acp|ucp}
GET  /public/semanto/{trooth_id}/.well-known/ucp
GET  /public/semanto/{trooth_id}/sellers?domain=&sku= | synonyms?name=
GET  /public/semanto/{trooth_id}/revocations            the company's signed revocation list
GET  /public/semanto/revocations                        every company's signed revocation list
GET  /public/semanto/.well-known/trooth-keys.json | keys/trooth.json    Trooth's witness JWK Set (the verifier CLIs' default)
POST /public/semanto/catalogs/check                     a nested marketplace catalog, checked layer by layer
GET  /public/semanto/{trooth_id}/credentials/{sha256}   a C2PA manifest made by the credential jobs
POST /public/semanto/connect/sessions                   the app connect flow: open a session (rate group public_connect)
GET  /public/semanto/connect/sessions/{session_id}      poll it with the poll token
POST /public/semanto/connect/uninstall                  an app's signed request revokes its own connector key
GET  /public/semanto/google/callback                    Google's OAuth redirect; always a redirect to the dashboard
GET  /public/semanto/alerts/confirm?token=              the alert address confirmation link; a redirect to the dashboard
OPTIONS *                                               CORS preflight (the /os routes allow https://trooth.co and https://www.trooth.co,
                                                        plus http://localhost in development, with Vary: Origin)

GET  /os/semanto/setup                                  the setup state (a vendor session with no company yet: the read when the workspace has a
                                                        confirmed domain on trooth.co, else the link to trooth.co's domain page)
POST /os/semanto/setup/start | claim                    claim one of the workspace's confirmed domains on trooth.co (fixed from then on); start also queues the read
GET|POST /os/semanto/{trooth_id}/settings               delivery settings (workspace session)
GET  /os/semanto/{trooth_id}/setup | setup/review | keys | writeback | receipts | receipts.csv | reports
POST /os/semanto/{trooth_id}/build | sign | gap-report | monitor/run | keys/rotate | lei | basic/claim | basic/prove | first-publication | connectors
POST /os/semanto/{trooth_id}/withdraw | detect | competitor-report | keys/{kid}/revoke
POST /os/semanto/{trooth_id}/passkeys/options | passkeys | sign/options
                                                        passkeys (W3C WebAuthn Level 3, 7.1 and 7.2): a hosted key is released for
                                                        sign only after a fresh assertion for the exact version and root hash
POST /os/semanto/{trooth_id}/setup/look-again | read-again | choose | confirm | host | install-check | monitoring | save-for-later | resume
                                                        workspace session through worker-f (TROOTH_OS service binding, with trooth.co's DPoP proofs when sent);
                                                        the workspace's domains read the same way (GET /auth/domain-claims); denied by default with a 401 problem;
                                                        every answer Cache-Control: private, no-store (docs/spec/setup-api.md)
POST /os/semanto/{trooth_id}/commerce/catalog           commerce connectors; RFC 9421 signature with tag trooth-connector against a connector key on file

The workspace contract of 23 October 2026 (src/serve/os-routes.ts, docs/spec/os-api.md), every write audited and in rate group os_write:
GET|POST /os/semanto/{trooth_id}/settings | POST settings/preview
GET  keys | POST keys/rotation/start | keys/rotation/options | keys/rotation/confirm | keys/rotation/cancel | keys/binding/check | keys/rotate | keys/{kid}/revoke
GET  receipts | receipts.csv                            filters, cursor, CSV with the injection guard
GET|POST connectors | POST connectors/create | connectors/{kid}/test | connectors/{kid}/revoke
GET  /os/semanto/connect/{session_id} | POST /os/semanto/{trooth_id}/connect/{session_id}/approve | deny
GET  google | POST google/connect | google/disconnect
GET  company | POST company/signing-policy | company/surfaces | company/alerts
GET  writeback | writeback/runs | writeback/runs/{run_id} | POST writeback/send | writeback/runs/{run_id}/retry
GET|POST sellers/lists | POST sellers/lists/options
GET|POST recalls | POST recalls/options                 store a signed recall notice (sent on to worker-f's changes feed)
POST passkeys | sign | withdraw                         the pipeline's handlers, audited here and in os_write
GET  credentials
```

Public routes pass a token bucket per client address and route group (the RateLimitDO bound as RATE; 429 problems with Retry-After). Every POST body is capped at 5 MB (a 413 problem). Nothing is served, signed or witnessed for a company whose domain is not proven. One signup: a domain is proven by its confirmation on trooth.co (`/dashboard/public-page?tab=domain`), read through worker-f; Semanto runs no domain proof of its own (docs/spec/setup-api.md, One signup, one domain proof).

The workspace contract's jobs ride the same queue with no cron of their own: `writeback` (one write-back item to Google), `recall_event` (one recall event to worker-f) and `credential` (one C2PA manifest); a job that should run again is retried with `retry({ delaySeconds })` after 30, 120 and 600 seconds (src/os/jobs.ts). The pipeline behind the `/os` routes, the queue consumer and the crons is `src/pipeline.ts` (the setup flow in `src/pipeline-setup.ts`): a build is split into queue messages of at most 25 pages with a final assembly (`src/compiler/stream.ts`, queue `trooth-semanto-compile`, dead letter queue `trooth-semanto-compile-dlq`); hourly change detection (`15 * * * *`; there is no pending-proof sweep: a domain is proven on trooth.co), nightly tree head, RFC 3161 timestamp when `TSA_URL` is set and every revocation list (`30 1 * * *`), weekly gap reports (`0 6 * * 1`, the same value as `WEEKLY_RUN.cron`). The hourly and weekly crons queue one message per 25 companies.

Read receipts are served to the company only, through the workspace API (`GET /os/semanto/{trooth_id}/receipts` and `/receipts.csv`); there is no public receipts route. `/.well-known/trooth-keys.json` and `/.well-known/trooth.semanto` on a company's own domain are served by the adapters from the hosted copies above.

The company's own domain serves the same bytes through an adapter: a Cloudflare Worker, Vercel middleware, a Netlify edge function, a Fastly or Akamai or Gcore template, an nginx or Apache snippet, the WordPress plugin, or, where no code can run, a head tag pointing at the Trooth-hosted copy.
