<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The traceability matrix: every requirement from the two execution lists, the files that implement it, the test that proves it, and its status. Follows the requirements-traceability practice of DO-178C style matrices and the per-requirement coverage tables the launch checklist (16 October 2026) uses. -->

# Requirements traceability

Two execution lists govern this release: the delivery list (items 1 to 20) and the numbered requirements (1 to 34: Google gap 1 to 7, signatures 8 to 18, commerce 19 to 26, small business 27 to 34). This matrix maps each one to the files that implement it, the test that proves it, and its status.

How to read the status column:

- **built**: the code and its test are in this repository and the test passes.
- **built, founder step**: built, but a key, account, secret, DNS record or platform registration must be done by the founder before it runs in production; the step is named.
- **stubbed**: a port or placeholder exists and says so; the real implementation is a named follow-up.
- **not in this release**: with the reason.
- **to confirm at review**: the file is owned by another agent working at the same time and was listed by folder name; or the requirement's wording could not be read from a shared document and was reconstructed from the area reports. These rows are marked so the coordinator can correct them in one pass.

The requirement wording below was reconstructed from `docs/reports/*.md` (each area's own coverage statement) and the agent brief; the lists themselves were not in this repository. Numbers that no report claimed are marked.

## Delivery items 1 to 20

| # | Item (wording to confirm) | Files | Test | Status |
| --- | --- | --- | --- | --- |
| 1 | One discovery list: sitemaps, full link crawl, llms.txt, earlier reads, owner additions | `src/compiler/discover.ts`, `src/compiler/url.ts` | `test/compiler.test.ts` | built |
| 2 | Fetching with SSRF guards, validators and the coverage receipt | `src/compiler/fetch.ts`, `src/compiler/ports.ts`, `src/compiler/build.ts` | `test/compiler.test.ts` | built; `WebFetchHttp` (the production fetch) is not exercised without network |
| 3 | Verbatim extraction to markdown, parts for long pages, index signals | `src/compiler/extract.ts`, `src/compiler/html.ts` | `test/compiler.test.ts` | built |
| 4 | Fact candidates, JSON-LD write-back, llms.txt, llms-full.txt, sitemap.md, the assembled version | `src/compiler/facts.ts`, `src/compiler/jsonld.ts`, `src/compiler/llms.ts`, `src/compiler/build.ts` | `test/compiler.test.ts` | built |
| 5 | Content negotiation on Accept or path suffix, never User-Agent | `src/core/negotiate.ts`, `src/serve/negotiate-route.ts`, `src/serve/represent.ts` | `test/core.test.ts` (negotiation table), `test/serve.test.ts` (byte-identical across user agents) | built |
| 6 | The header set: Trooth-Contract, Trooth-Semanto-Version, Trooth-Page-Hash, Content-Digest, Signature, Content-Signal, Link, token headers, no X- names | `src/serve/headers.ts` | `test/serve.test.ts` | built |
| 7 | ETag kept across hosts, 304 on If-None-Match with the same signature headers | `src/serve/headers.ts`, `src/serve/routes.ts` | `test/serve.test.ts` | built |
| 8 | Errors as RFC 9457 problems with a markdown form | `src/serve/errors.ts` | `test/serve.test.ts` | built |
| 9 | Per-page proofs that verify offline | `src/serve/proof.ts`, `src/serve/ledger-port.ts` | `test/serve.test.ts`, `test/verifier.test.ts`, `test/integration.test.ts` ("1. one log leaf format" and the end-to-end proof checked by `src/serve/proof.ts` and `verifier/js/verify.mjs`) | built; the proof carries the ledger's leaf record (note A) |
| 10 | Host detection (headers, body, DNS-over-HTTPS) | `src/serve/detect.ts` | `test/serve.test.ts` | built |
| 11 | Cloudflare Worker adapter | `adapters/cloudflare-worker/` | `test/adapters.test.ts` | built, founder step: the public adapters repository and the Deploy button target on launch day |
| 12 | Vercel adapter (middleware, route handler, static well-known files) | `adapters/vercel/` | `test/adapters.test.ts` | built, founder step: confirm the static well-known file on a real Vercel project; a Deploy Hook URL field in Delivery |
| 13 | Netlify adapter (edge function or `_redirects`) | `adapters/netlify/` | `test/adapters.test.ts` | built |
| 14 | Fastly Compute adapter | `adapters/fastly-compute/` | `test/adapters.test.ts` | built |
| 15 | Akamai EdgeWorkers adapter | `adapters/akamai-edgeworkers/` | `test/adapters.test.ts` | built |
| 16 | Gcore FastEdge adapter | `adapters/gcore-fastedge/` | `test/adapters.test.ts` | built |
| 17 | nginx and Apache snippets | `adapters/nginx/`, `adapters/apache/` | `test/adapters.test.ts` | built |
| 18 | Delivery settings model and resolver, the three markdown-source modes, the three when-changed choices, the no-duplicate rule | `src/settings/delivery.ts`; the dashboard panel `web/semanto/delivery-settings-panel.tsx` | `test/settings.test.ts` | built; the panel typechecks (`npx tsc -p web/tsconfig.json`) and is dropped into trooth-web at integration |
| 19 | Read analytics: proven readers named only from a proven Web Bot Auth key, read receipts with a daily-salted address hash, the daily digest and the CSV | `src/readers/webbotauth.ts`, `src/readers/receipts.ts`, `src/readers/ports.ts`, wired by `src/pipeline.ts` (`webBotAuthReaders`, `ReaderReceipts`) into the receipt middleware of `src/serve/routes.ts`; the panel `web/semanto/read-receipts-panel.tsx` | `test/readers.test.ts`; `test/integration.test.ts` ("readers: Web Bot Auth behind the receipt middleware") | built, founder step: `RECEIPT_IP_SALT_SECRET` |
| 20 | Every served representation, including parts, llms and sitemap, carries the full header set | `src/serve/headers.ts`, `src/serve/routes.ts`, `src/compiler/build.ts` (parts) | `test/serve.test.ts` | built |

## Google gap, requirements 1 to 7

| # | Requirement (wording to confirm) | Files | Test | Status |
| --- | --- | --- | --- | --- |
| 1 | Verbatim capture with a signed coverage receipt: what was read, what was left out and why | `src/compiler/build.ts` (receipt, `smr_` id), `src/compiler/extract.ts` | `test/compiler.test.ts` | built |
| 2 | Consistency across Merchant Center, Business Profile and the site | `src/monitor/consistency.ts`, `src/monitor/surfaces.ts`, `src/monitor/normalize.ts`, `src/monitor/run.ts`; the panel `web/semanto/consistency-monitor-panel.tsx` | `test/monitor.test.ts` | built, founder step: Google Cloud project, Content API and Business Profile API enabled, OAuth client; customer tokens through `TokenPort` |
| 3 | Indexed and snippet-eligible pages, structured data present | `src/compiler/html.ts` (index signals in the manifest), `src/monitor/indexability.ts` | `test/compiler.test.ts`, `test/monitor.test.ts` | built |
| 4 | Write-back of the signed truth to every surface | `src/monitor/writeback.ts`, `src/compiler/jsonld.ts` | `test/monitor.test.ts` | built, founder step: the same Google OAuth as 2 |
| 5 | Google AI Mode and AI Overviews as providers in the gap report, Gemini through its API | `src/gap/providers.ts`, `src/gap/ports.ts` (`SerpPort`) | `test/gap.test.ts` | built, founder step: pick a licensed SERP data provider and write its one adapter; `GEMINI_API_KEY` |
| 6 | Change detection and incremental rebuild without a cadence promise | `src/compiler/build.ts` (`previous`, `changed_urls`), `src/compiler/fetch.ts` (`ChangeDetector`), `src/pipeline.ts` (`hourlyChangeDetection`), `src/monitor/run.ts` (page_changed alert) | `test/compiler.test.ts`, `test/monitor.test.ts`, `test/integration.test.ts` ("hourly: detects a changed signed page") | built; the hourly cron is in `wrangler.toml` |
| 7 | Never do mention-seeding: Semanto does not post, plant or pay for mentions of a company anywhere | A product rule enforced by absence: no module, route or job writes to a third-party site except the company's own surfaces through write-back with its own token (`src/monitor/writeback.ts`) | `test/integration.test.ts` ("6. house rules across every source file" scans every file in `src` and `migrations` for any mention-seeding feature, with the banned words and ellipses) | built (a rule, not a feature) |

## Signatures, requirements 8 to 18

| # | Requirement (wording to confirm) | Files | Test | Status |
| --- | --- | --- | --- | --- |
| 8 | Response signatures: RFC 9421 with RFC 9530 Content-Digest, tag trooth-semanto, over the Semanto components; key custody (hosted or customer) | `src/core/httpsig.ts`, `src/serve/headers.ts`, `src/identity/keys.ts`; spec `docs/spec/response-signatures.md` | `test/core.test.ts`, `test/serve.test.ts`, `test/identity.test.ts`; the vectors `response.json`, `negative/signature-expired.json`, `negative/unknown-key.json` in all three kits | built, founder step: `TROOTH_WITNESS_KEY` and `HOSTED_KEY_SEAL_SECRET` secrets; hosted company keys are sealed with AES-256-GCM (`src/db/key-seal.ts`); signing paths in `src/pipeline.ts`, tested in `test/integration.test.ts` |
| 9 | The public log: signed tree heads, inclusion and consistency proofs, tiles, checkpoints | `src/ledger/log.ts`, `src/ledger/ports.ts`, `src/ledger/store-d1.ts`; spec `docs/spec/log.md` | `test/ledger.test.ts`; the vector `log.json` in all three kits; `test/integration.test.ts` (the log routes) | built, founder step: serialize appends (a Durable Object or a single consumer) before launch; publish the witness public key with origin `trooth.co/semanto/log/v1` and signer name `trooth.co`; routes served by `src/serve/routes.ts` over `src/serve/ledger-port.ts` |
| 10 | Third-party time: RFC 3161 timestamps and a cosigning witness | `src/ledger/timestamp.ts`, `src/ledger/log.ts` (`prepareCosignatureLeaf`, `acceptCosignature`) | `test/ledger.test.ts` | built, founder step: `TSA_URL` and the TSA certificate chain; a Sigsum or Armored Witness cosigner. No "check without trusting Trooth" claim until the cosigner signs |
| 11 | Validity windows and revocation: states, the signed revocation list | `src/ledger/revocation.ts`; `stateOf` in each verifier kit | `test/ledger.test.ts`; the vectors `revocations.json`, `negative/version-withdrawn.json` | built |
| 12 | Key discovery and domain binding: the JWK Set at /.well-known/trooth-keys.json, the `_trooth-keys` TXT record, binding levels, rotation | `src/identity/keys.ts`, `src/identity/ports.ts`; the panel `web/semanto/key-binding-panel.tsx` | `test/identity.test.ts`, `test/core.test.ts` (DNS record parsing) | built, founder step: dashboard copy quotes `dnsKeyRecord(kid)` verbatim |
| 13 | LEI and vLEI binding | `src/identity/lei.ts`, `src/identity/ports.ts` (`VleiVerifier`) | `test/identity.test.ts` | built for LEI (GLEIF lookup, no account); stubbed for vLEI (`VleiNotWired` answers "presented, not checked") until a KERI/ACDC verifier is wired |
| 14 | Who authorized a signature: OOR and ECR roles, owners and admins, two-officer policy | `src/identity/roles.ts` | `test/identity.test.ts` | built; which workspaces are two-officer is a settings question |
| 15 | The one-call verify endpoint | `src/serve/proof.ts` (`verifyUrl`), `src/serve/routes.ts`; spec `docs/spec/verify-endpoint.md` | `test/serve.test.ts` (the four statuses) | built |
| 16 | C2PA bridge for images and PDFs | `src/c2pa/bridge.ts` | `test/c2pa.test.ts` | built for manifest definitions; signing and embedding need `c2patool` or the c2pa SDK and a certificate outside the Worker (founder step) |
| 17 | Proven readers: Web Bot Auth verification, read receipts, agent names only from proven identity, the CSV | `src/readers/webbotauth.ts`, `src/readers/receipts.ts`, `src/readers/ports.ts`; the panel `web/semanto/read-receipts-panel.tsx`; `docs/METRICS_DEFINITIONS.md` | `test/readers.test.ts`; the vector `web-bot-auth-request.json` in all three kits | built, founder step: `RECEIPT_IP_SALT_SECRET`; check `KNOWN_DIRECTORIES` against operators' documentation; a Durable Object for the nonce store |
| 18 | The open verifier kit in three languages with shared test vectors, and the Internet-Draft | `verifier/js/verify.mjs`, `verifier/js/cli.mjs`, `verifier/python/trooth_semanto_verify/`, `verifier/go/semanto/`, `verifier/go/cmd/semanto-verify/`, `verifier/test-vectors/generate.ts`, `verifier/test-vectors/v1/`; `docs/draft-trooth-signed-web-content-00.md`, `docs/INTERNET-DRAFT-README.md` | `test/verifier.test.ts` (25), `verifier/python/test_vectors.py` (22), `verifier/go/semanto/vectors_test.go`; every vector positive and negative in each | built; the draft is filed only after the provisional patent (founder step); numbering to confirm |

## Commerce, requirements 19 to 26

| # | Requirement (wording to confirm) | Files | Test | Status |
| --- | --- | --- | --- | --- |
| 19 | Variant-level product records and the resolver | `src/commerce/product-record.ts`, `src/commerce/synonyms.ts` | `test/commerce.test.ts` | built |
| 20 | Fresh signed offers | `src/commerce/offers.ts`; `verifyOffer` in each kit | `test/commerce.test.ts`; the vectors `offer.json`, `negative/offer-expired.json` | built |
| 21 | Feed parity across Merchant Center, ACP and UCP | `src/commerce/feeds.ts` | `test/commerce.test.ts` | built, founder step: Merchant Center upload, ACP registration with OpenAI, UCP registration with Google, each with the merchant account |
| 22 | Authorized sellers and listing comparison | `src/commerce/sellers.ts` | `test/commerce.test.ts` | built |
| 23 | Nested marketplace signatures | `src/commerce/nested.ts`, `src/commerce/synonyms.ts`; `JWS_TYPES.marketplaceCatalog` added to `src/core/jws.ts` by the commerce agent | `test/commerce.test.ts` | built |
| 24 | Recall notices | `src/commerce/recalls.ts` | `test/commerce.test.ts` | built; recalls are stored and served through `CommerceStore` (`src/db/d1.ts` `D1CommerceStore`). Not wired here: `recallChangeEntry` into the company changes feed, which worker-f serves (a follow-up on that side) |
| 25 | The gap report: question sets, providers, line-by-line comparison, corrections with the signed source, weekly run, before and after | `src/gap/prompts.ts`, `src/gap/providers.ts`, `src/gap/compare.ts`, `src/gap/report.ts`; the panel `web/semanto/gap-report-panel.tsx` | `test/gap.test.ts` | built, founder step: provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`); one weekly schedule `0 6 * * 1` in `wrangler.toml`, `WEEKLY_RUN` and `runScheduled`, run by `src/pipeline.ts` `weeklyGapReports` |
| 26 | Commerce platform connectors: the WordPress plugin with WooCommerce product send, the head tag for no-code hosts, Shopify and other platform hooks, and the API that receives them | `adapters/wordpress-plugin/`, `adapters/head-tag/`, `adapters/commerce-platforms/`; the receiver `POST /os/semanto/{trooth_id}/commerce/catalog` (`src/serve/routes.ts`, `src/pipeline.ts` `catalog`, RFC 9421 tag `trooth-connector`) and `POST /os/semanto/{trooth_id}/connectors` for the public key | `test/adapters.test.ts`; `test/integration.test.ts` (signed catalog accepted, tampered and unknown-key catalogs refused) | built, founder step: WordPress.org listing needs a GPL-compatible license decision; the dashboard field that posts a connector key to `/connectors`. The monitor's reading of feed parity is requirement 2 and 21 |

## Small business, requirements 27 to 34

| # | Requirement (wording to confirm) | Files | Test | Status |
| --- | --- | --- | --- | --- |
| 27 | The free competitor report | `src/gap/competitor.ts` | `test/gap.test.ts` | built, same provider keys as 25 |
| 28 | The shared adapter module and request signer every adapter uses | `adapters/shared/semanto-adapter.mjs`, `adapters/shared/sign-request.mjs` | `test/adapters.test.ts` | built (numbered 28 by the adapters report; to confirm it sits in this group) |
| 29 | Semanto Basic: the free tier, domain proof only, witnessed and not signed in every response | `src/basic/tier.ts`, `src/basic/ports.ts`; the card `web/semanto/basic-upgrade-card.tsx` | `test/basic.test.ts` | built; the Worker's `DomainProofPort` is DNS over HTTPS (`src/identity/ports.ts` `dohDns`) in `src/index.ts` |
| 30 | The local question set (hours, address, phone, services, parking, accessibility, appointments) | `src/gap/prompts.ts` | `test/gap.test.ts` | built |
| 31 | Plain-language alerts and the monitor run | `src/monitor/alerts.ts`, `src/monitor/run.ts` | `test/monitor.test.ts` | built, founder step: `RESEND_API_KEY` and `ALERT_FROM`; runs and alerts in D1 through `src/db/d1.ts` `D1MonitorStore`, email through `src/monitor/ports.ts` `resendEmailPort` |
| 32 | First-publication proof, signed and logged, with the dispute export | `src/basic/first-publication.ts` | `test/basic.test.ts` | built; appended to the ledger by `POST /os/semanto/{trooth_id}/first-publication` (`src/pipeline.ts`), tested in `test/integration.test.ts` |
| 33 | Signed Content Signals with the header, robots.txt and drift detection | `src/basic/content-signals.ts`, `src/settings/delivery.ts` (`contentSignalHeader`) | `test/basic.test.ts`, `test/settings.test.ts` | built |
| 34 | Ten-minute setup target, measured: six steps with targets summing to 600 seconds, the time spent per step taken from timestamps | `src/basic/tier.ts` (`SETUP_CHECKLIST`, `measureSetup`), returned by `POST /os/semanto/{trooth_id}/basic/prove` (`src/pipeline.ts`) | `test/basic.test.ts`; `test/integration.test.ts` ("Semanto Basic: claims, proves by DNS, builds the witnessed record and measures the setup") | built; `within_ten_minutes` stays null until every step has a timestamp (the head tag and first report steps are stamped by the dashboard) |

## Notes

**A. The log leaf for a version.** Resolved at integration: the ledger owns the format (`src/ledger/ports.ts`, canonical JSON of `{ kind, trooth_id, ref, hash, at }`). `src/serve/proof.ts` carries `ledger.leaf` in every proof and `verifyProof` recomputes the leaf hash from it, requires `kind` `semanto_version` and `hash` equal to the proof's `root_hash`. The vectors already had this shape and were not regenerated.

**B. The dashboard typecheck.** The root `tsconfig.json` now sets `"jsx": "react-jsx"`, so `npx tsc --noEmit` at the root covers `web/` too.

**C. Host detection reads `_trooth.<domain>`** (`src/serve/detect.ts`) while key binding reads `_trooth-keys.<domain>` (`src/identity/keys.ts`). Both records exist with different purposes (a pointer and a key); the dashboard and the docs name them separately. The verifier CLIs check `_trooth-keys`. Semanto Basic's claim record also lives at `_trooth.<domain>` (`v=trooth1; claim=<token>`), a third value at the pointer name.

**D. Public log routes.** Resolved at integration: `src/serve/routes.ts` serves `/public/semanto/log/tree-head`, `/log/checkpoint`, `/log/proof`, `/log/consistency` and `/log/leaves/{index}` in the shapes of `docs/spec/log.md`, tested in `test/integration.test.ts`.

**E. One fact-key vocabulary.** `src/core/fact-keys.ts` names the keys every module shares (`contact.phone`, `contact.address`, `contact.website`, `hours.<day>`, `identity.legal_name`, `product.<id>.<field>`) and lists the older spellings once as aliases (`contact.telephone`, `identity.url`, `local.phone`, `local.address`, `products.<id>`). The compiler writes `contact.phone`; the monitor and the gap report read signed facts through `canonicalFactKey`. The end-to-end test shows the compiler's phone fact found by the monitor (Business Profile mismatch) and by the gap report (`local.phone` finding) under the same fact id.
