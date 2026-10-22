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
| `src/settings` | The delivery settings model and resolver | core |
| `src/db` | D1 access, one function per query, no SQL in handlers; hosted keys sealed at rest | |
| `src/pipeline.ts` | The modules wired into one flow: compile, sign, witness, log, the workspace actions, the commerce catalog, the crons, readers and authorization | every module above |
| `adapters/` | Host adapters: Cloudflare Worker, Vercel, Netlify, Fastly, Akamai, Gcore, nginx, Apache, WordPress, head tag, commerce platforms | the public API only |
| `verifier/` | The open verifier kit: JavaScript, Python, Go, a CLI and shared test vectors | the published formats only |
| `web/` | React components for the trooth-web dashboard (dropped into trooth-web at integration) | the public API only |
| `docs/` | Specs, the Internet-Draft, the traceability matrix | |

## House rules (these are not optional)

1. **Provenance words are exactly four:** witnessed, public_record, attested, declared. A declared fact is never shown as witnessed. Three negatives stay apart: `no`, `not_published`, `not_read`.
2. **Trooth witnesses and never judges.** No module produces a number or a verdict about a company. The words "score", "verified" and "certified" never describe a company, a fact or a record, in code, comments, copy or tests. Say "checked", "proven", "witnessed", "matches", "mismatch".
3. **Never switch on User-Agent.** Format is chosen by the Accept header or a path suffix. Every representation carries the same content. A test fails if two readers of the same URL and Accept get different bytes.
4. **No sample figure presented as real.** Fixtures are named as fixtures. Copy never cites a number Trooth did not measure.
5. **No ellipses** (the three-dot character or three periods) anywhere: code, comments, copy, docs. Hashes and paths are printed in full.
6. **Every digest is `sha256:` plus 64 lowercase hex.** Every id is a content-addressed `smx_` id from `src/core/ids.ts`.
7. **Every statement Trooth or a company signs carries a `typ` from `JWS_TYPES`** and a validity window where one makes sense. A verifier always checks the type.
8. **Every module is pure where it can be:** handlers turn `{ status, headers, body }` into a Response; logic takes plain values. Tests run in Node with vitest and need no Cloudflare runtime.
9. **Errors are RFC 9457 problems** (`application/problem+json`) with `code`, `retryable`, `next_action`, `terminal`, and a markdown form for `Accept: text/markdown`.
10. **Headers:** `Trooth-Contract`, `Trooth-Semanto-Version`, `Trooth-Page-Hash`, `Signature-Input`, `Signature`, `Content-Digest`, `Vary: Accept`, `ETag` kept, `x-markdown-tokens` and `x-original-tokens` under Cloudflare's names, `Content-Signal` passed through from the customer's policy. No `X-Semanto-*` header, ever (RFC 6648).
11. **Copy and UI:** Open Sauce One; Ink #202124, Paper #F7F8F8, blue #1A73E8 on actions only, the dark site canvas #0E1014. Plain words. No jargon in anything a small business owner reads.
12. **File header** on every source file: the SPDX line and the copyright line, then a comment saying what the module is for and which leader's practice it follows, where there is one.
13. **Tests** live in `test/<area>.test.ts`. Every module ships with tests that would fail if its rule were broken.

## Data model (D1)

See `migrations/0001_semanto.sql` and `migrations/0002_integration.sql`. Page bodies, parts, feeds and log tiles live in R2 under `semanto/<trooth_id>/v<version>/`. D1 holds metadata only.

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
OPTIONS *                                               CORS preflight

GET|POST /os/semanto/{trooth_id}/settings               delivery settings (workspace session)
POST /os/semanto/{trooth_id}/build | sign | gap-report | monitor/run | keys/rotate | lei | basic/claim | basic/prove | first-publication | connectors
                                                        workspace session through worker-f (TROOTH_OS service binding); denied by default with a 401 problem
POST /os/semanto/{trooth_id}/commerce/catalog           commerce connectors; RFC 9421 signature with tag trooth-connector against a connector key on file
```

The pipeline behind the `/os` routes, the queue consumer and the crons is `src/pipeline.ts`: compile on the queue (`trooth-semanto-compile`), hourly change detection (`15 * * * *`), nightly tree head, RFC 3161 timestamp and revocation list (`30 1 * * *`), weekly gap reports (`0 6 * * 1`, the same value as `WEEKLY_RUN.cron`).

Planned, not served by this Worker: `/public/semanto/{trooth_id}/receipts` (read receipts are stored; the dashboard reads them through the workspace API). `/.well-known/trooth-keys.json` and `/.well-known/trooth.semanto` on a company's own domain are served by the adapters from the hosted copies above.

The company's own domain serves the same bytes through an adapter: a Cloudflare Worker, Vercel middleware, a Netlify edge function, a Fastly or Akamai or Gcore template, an nginx or Apache snippet, the WordPress plugin, or, where no code can run, a head tag pointing at the Trooth-hosted copy.
