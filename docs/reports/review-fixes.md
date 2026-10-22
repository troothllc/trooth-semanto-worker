<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- What was changed for each of the 19 findings of the independent review, the regression test that proves it, and the founder steps still open. -->

# Review fixes

An independent review of this repository raised 19 findings. Every one is fixed below. Each fix has a regression test that failed before the change and passes after it. Most of these tests are in `test/review-fixes.test.ts` and are named by finding number. Fixes to the verifier kits also have new vectors: `verifier/test-vectors/generate.ts` builds them, and the JavaScript, Python and Go kits all run them.

Every suite passes after the changes:

- `npx vitest run`: 438 tests
- `npx tsc --noEmit`
- `python3 -m pytest -q` in `verifier/python`: 40 tests
- `gofmt -l .`, `go vet` over every package and `go test ./semanto/` in `verifier/go`

The house-rules scan in `test/integration.test.ts` now covers `src`, `migrations`, `adapters`, `verifier`, `web` and `docs`. It checks for banned words, ellipses and the X- header prefix.

Behavior changes are written into these documents:

- `docs/spec/response-signatures.md`
- `docs/spec/semanto-file.md`
- `docs/spec/log.md`
- `docs/spec/delivery.md`
- `docs/spec/verify-endpoint.md`
- `docs/draft-trooth-signed-web-content-00.md`
- `adapters/README.md`
- `verifier/README.md`
- `verifier/test-vectors/v1/README.md`
- `docs/REQUIREMENTS-TRACEABILITY.md`, in its "Review fixes" table

## 1. A JWS could carry an embedded payload that differed from the one expected

**Change.** `verifyJws` now always receives the expected payload. That is the canonical JSON the caller recomputed. If a compact JWS carries an embedded payload that is not the same bytes, the check fails with `payload_mismatch`. Every caller now passes the expected payload: proofs, first publication, commerce and revocation.

**Files.**
- `src/core/jws.ts`
- `src/serve/proof.ts`
- `src/basic/first-publication.ts`
- `src/commerce/*.ts`
- `src/ledger/revocation.ts`
- the kits: `verifier/js/verify.mjs`, `verifier/python/trooth_semanto_verify/jws.py` and `verify.py`, `verifier/go/semanto/jws.go` and `verify.go`

**Tests.** In `test/review-fixes.test.ts`, "finding 1: an embedded JWS payload must be the payload the caller expected". This has three cases. Vectors: `negative/forged-compact-payload.json` and `negative/page-proof-forged-compact.json`.

**Founder step.** None.

## 2. Company keys were merged with Trooth's witness keys

**Change.** The key port is now split into `resolveCompany(trooth_id, kid)` and `resolveTrooth(kid)`. Each kind of statement checks only the key set for its role:

| Statement | Key set |
| --- | --- |
| Version, offer, catalog | company |
| Witness statement, tree head, checkpoint, revocation list | Trooth |

`verifyResponse` decides which key set to use from `Trooth-Signed-By`. A checkpoint must also name the signer `trooth.co` (reason `wrong_signer`) and the origin `trooth.co/semanto/log/v1` (reason `wrong_origin`).

**Files.**
- `src/serve/ports.ts`
- `src/serve/memory-ports.ts`
- `src/db/d1.ts` (`D1Keys`)
- `src/serve/proof.ts`
- the three kits (`KeySet` roles in Go; `roleKeys` and `roleResolver` in JS and Python)

**Tests.** "finding 2: a company key never passes as Trooth's witness". This has three cases. Vectors: `negative/witness-company-key.json` and `negative/tree-head-company-key.json`.

**Founder step.** None.

## 3. A key was judged at "now" instead of when it signed

**Change.** A new function, `keyValidAtSigning`, judges a key at the time it signed:

- JWS signatures: the `iat` value, or the instant being asked about when there is no `iat`.
- HTTP signatures: the `created` value.

If the key was revoked after it signed, the signature still verifies and the result carries a note, for example "key revoked after signing on <date>". The specs say how to handle a compromised key: set `revoked_at` to the earliest moment the compromise could have begun.

**Files.**
- `src/core/jws.ts`
- `src/core/httpsig.ts`
- the three kits

**Tests.** "finding 3: a key is judged at the signature's iat, not at now". This has two cases. Vectors: `key-rotated-after-signing.json`, `key-revoked-after-signing.json` and `negative/key-revoked-before-signing.json`. Vector runners now accept per-vector `keys` and `expect.note`.

**Founder step.** None.

## 4. Trooth-Page-Hash did not always match the body

**Change.** `Trooth-Page-Hash` is now always the digest of the exact body sent. Some answers are derived from a signed page: the page's JSON-LD, a behind page, or a proof. Those answers also carry `Trooth-Signed-Page-Hash`, which is the page's manifest hash, and the signature covers it. The semanto object and versions routes no longer send a page hash.

**Files.**
- `src/serve/headers.ts`
- `src/serve/routes.ts`
- `src/serve/errors.ts`

**Tests.** "findings 4, 11 and 12: the response signature", in the two "finding 4" cases. Vectors: `response-page-jsonld.json` and `response-semanto-object.json`.

**Founder step.** None.

## 5. SSRF in the Web Bot Auth key directory fetch

**Change.**
- The directory is always fetched at the Signature-Agent's origin plus `/.well-known/http-message-signatures-directory`.
- The fetch must use https. A host name is required: IP literals are refused, and so are private, reserved and local names. Resolved addresses are checked through DNS over HTTPS, and the check fails closed.
- Redirects are refused. The response is capped at 64 KB and the fetch at 3 seconds.
- A directory is cached for between 300 and 86,400 seconds. A failed fetch is cached for 300 seconds for each origin.
- The guard lives in the shared `src/core/ssrf.ts`. It covers IPv4 hidden inside IPv6 forms: mapped, translated, compatible, 6to4, Teredo and NAT64. It also covers fec0::/10.

**Files.**
- `src/core/ssrf.ts` (new)
- `src/readers/webbotauth.ts`
- `src/readers/ports.ts` (`platformHttp` with a manual redirect, a timeout and a cap; failure entries in `KeyCache`)
- `src/index.ts`

**Tests.** "finding 5: the key directory fetch cannot be pointed anywhere". This has four cases.

**Founder step.** Confirm that the Worker can reach `cloudflare-dns.com` over DNS over HTTPS. Without that egress, every directory fetch is refused, because the check fails closed. The guard's header comment covers DNS rebinding, which the guard cannot fully close. Fetching through Cloudflare's egress, or through a tunnel that refuses private ranges, is the second layer.

## 6. Nonce replay with a decoy label; nonces were not atomic

**Change.** A request with more than one `web-bot-auth` label is refused with `more_than_one_label`. Checks run in this order:

1. Choose the one label.
2. Check its parameters.
3. Check that its nonce has not been seen.
4. Fetch the directory.
5. Verify that label's signature only (`verifyMessage` takes a `label` option).
6. Claim the nonce.

Nonces are claimed atomically in a new Durable Object, `NonceDO`. KV is still used as a fallback and is documented as not atomic.

**Files.**
- `src/readers/webbotauth.ts`
- `src/readers/nonce-do.ts` (new)
- `src/readers/ports.ts`
- `src/core/httpsig.ts`
- `src/index.ts`
- `src/env.ts`
- `wrangler.toml` (the `NONCES` binding, migration `v1-nonce-and-log-durable-objects`)

**Tests.** "finding 6: one label is chosen, checked and its nonce claimed". This has three cases, including one with many simultaneous claims of the same nonce. Vector: `negative/web-bot-auth-two-labels.json`.

**Founder step.** Deploy with the `NONCES` Durable Object binding. `wrangler deploy --dry-run` succeeds for both environments.

## 7. A reader's address and identity forwarded by an adapter were trusted unsigned

**Change.** When an adapter forwards a request, it passes the agent's `Signature`, `Signature-Input` and `Signature-Agent` through unchanged and adds `Trooth-Forwarded-Authority` and `Trooth-Forwarded-For`. It then signs the forwarding with its connector key, writing `Trooth-Connector-Signature-Input` and `Trooth-Connector-Signature`. That signature covers the agent's signature fields and includes a nonce.

The API checks in this order:

1. The connector signature, against the company's connector keys.
2. If that passes, the agent's signature, with the forwarded authority as `@authority`.
3. Only then does the API use the forwarded address.

An unsigned forwarded header is ignored. Adapters remove any `Trooth-Forwarded-*` or `Trooth-Connector-*` header sent by the client. nginx and Apache clear these headers and do not forward identity, so a read through them counts as an "unproven reader".

**Files.**
- `src/readers/forwarded.ts` (new)
- `src/pipeline.ts` (`webBotAuthReaders`, `forwardingFromStore`)
- `src/serve/routes.ts`
- `adapters/shared/sign-request.mjs` and `semanto-adapter.mjs` (and their `.d.mts` type files)
- every adapter: Cloudflare, Fastly, Gcore, Netlify, Vercel, Akamai, nginx, Apache, WordPress

**Tests.** "finding 7: a reader is proven through an adapter only when the adapter signed the forwarding". This has two cases.

**Founder step.** Generate a connector key for each company that uses a code adapter, register its public half under connectors, and set `TROOTH_CONNECTOR_KEY` in that adapter's secret store. Also confirm that Akamai EdgeWorkers supports Ed25519 in its WebCrypto. If it does not, the Akamai adapter serves pages but cannot prove readers.

## 8. Workspace roles were not read honestly or enforced

**Change.** `troothOsAuthorize` handles roles like this:

- If worker-f sends `workspaceRole`, that role is used.
- Otherwise, the user is owner only when their user id matches the company's registered owner (`os_owner_user_id`). Everyone else is a member.

Every action checks the role:

- A viewer can start nothing.
- A member can build, run the gap report and run the monitor.
- Signing, key rotation, LEI binding and connectors need an owner or admin.

A member may claim a Basic company that has no owner, and becomes its registered owner. The sign_waiting answer and the key panel now explain the two-officer rule.

**Files.**
- `src/pipeline.ts`
- `src/pipeline-store.ts`
- `src/db/d1.ts` (`ownerUserId`, `registerOwner`)
- `migrations/0004_review_fixes.sql`
- `web/semanto/key-binding-panel.tsx`
- `web/semanto/index.ts`

**Tests.** "finding 8: workspace roles are read honestly and enforced". This has two cases. `test/integration.test.ts` also has the authorize test, the test that a member's sign returns 403, and the two-officer note test.

**Founder step.**
- worker-f should send `workspaceRole` and the team seats with the service binding answer.
- Fill in `semanto_companies.os_owner_user_id` for existing companies. Until then, nobody is owner without `workspaceRole`.

## 9. SSRF in the compiler

**Change.** The compiler uses the shared guard in `src/core/ssrf.ts` with the DNS over HTTPS resolver. If the resolver fails, the fetch is refused with reason `unresolvable`; it no longer fails open.

**Files.**
- `src/core/ssrf.ts`
- `src/compiler/fetch.ts`
- `src/index.ts`

**Tests.** "finding 9: the shared SSRF guard". This has two cases.

**Founder step.** The DNS over HTTPS egress, the same as in finding 5.

## 10. verifyPageProof failed open

**Change.** A page proof passes only when all of these are present and good:

| Missing part | Reason |
| --- | --- |
| Header | `header_absent` |
| Company signature | `signature_absent` |
| Witness | `witness_absent` |
| Log section | `log_absent` |

Callers who accept less must say so with `allowUnwitnessed` or `allowUnlogged`. The command lines take `--allow-unwitnessed` and `--allow-unlogged`. A header that cannot be fetched now counts as a failure.

**Files.**
- `src/serve/proof.ts`
- `verifier/js/verify.mjs` and `cli.mjs`
- `verifier/python/trooth_semanto_verify/verify.py` and `cli.py`
- `verifier/go/semanto/verify.go` (`VerifyPageProofWith`) and `cmd/semanto-verify/main.go`

**Tests.** "finding 10: a page proof is strict". Vectors: `negative/page-proof-no-header.json` and `negative/page-proof-unwitnessed.json`.

**Founder step.** None.

## 11. Some response headers were not in the signature

**Change.** The signature now always covers the five fixed components. After those, it covers each of these when present: `trooth-signed-page-hash`, `trooth-signed-by`, `trooth-semanto-state`, `location`, `content-signal` and `link`. A verifier refuses a response with `header_not_covered` when any of the first four, or `Location`, is present but not covered.

**Files.**
- `src/core/httpsig.ts` (`semantoResponseComponents`)
- `src/serve/headers.ts`
- `verifier/test-vectors/generate.ts`
- the three kits

**Tests.** "findings 4, 11 and 12: the response signature", in the "finding 11" case. Vector: `negative/response-uncovered-header.json`.

**Founder step.** None.

## 12. The signature expired before the cache did

**Change.** `SIGNATURE_TTL_SECONDS` is now 3,900. That is `max-age` (300) plus `stale-while-revalidate` (3,600). Statement freshness still comes from the version's own validity and from the revocation list.

**Files.**
- `src/serve/headers.ts`
- `verifier/test-vectors/generate.ts`

**Tests.** The "finding 12" case. Vector: `negative/signature-expired.json`, now 4,500 seconds old against a 3,900 second window.

**Founder step.** None.

## 13. Adapter answers lacked Vary: Accept

**Change.** Every adapter answer carries `Vary: Accept`, merged into any `Vary` already present. This covers errors and HTML passed through to a browser.

**Files.**
- `adapters/shared/semanto-adapter.mjs` (`mergeVary`, `withProofHeaders`)
- Vercel middleware
- Akamai
- nginx and Apache configs
- WordPress `negotiate.php`

**Tests.** "findings 13 and 14: the adapter's answers", in the "finding 13" case. `test/adapters.test.ts` was updated.

**Founder step.** None.

## 14. The adapter and the API answered JSON-LD differently

**Change.** `/facts.jsonld` at the site root returns the facts. Any other path asked for as JSON-LD returns that page's JSON-LD through `by-path`.

The cross-check found one more bug, now fixed: the adapter's page URL had lost its `.md` suffix. As a result, an `ld+json` Accept header returned JSON-LD where markdown was expected. The adapter now adds `.md` in JavaScript and in PHP.

**Files.**
- `adapters/shared/semanto-adapter.mjs`
- `adapters/nginx/*.conf`
- `adapters/apache/semanto.conf`
- `adapters/wordpress-plugin/*` (PHP lint passes)
- `src/serve/routes.ts` (by-path `/facts.jsonld`)

**Tests.** The "finding 14" case. It runs every Accept header and path through the adapter and through the API, and compares the bytes.

**Founder step.** None.

## 15. Semanto Basic records were not marked witnessed-only

**Change.** Basic builds are witnessed by Trooth and never signed with the company's key (`witnessOnly`). They are served with `Trooth-Semanto-State: witnessed-not-signed`. Every markdown body begins with a front matter notice.

`llms.txt` is rewritten to match the version's state. The fallback header no longer claims "Signed". The basic/prove answer includes `record_state`, `witnessed` and `witness`. A company's `basic_version` is stored and served when no signed version exists.

**Files.**
- `src/pipeline.ts`
- `src/serve/routes.ts`
- `src/serve/represent.ts`
- `src/serve/errors.ts` (`basicNotice`)
- `src/compiler/llms.ts` (`trustLine`, `withTrustState`)
- `src/serve/memory-ports.ts`
- `src/db/d1.ts` (`selectServedVersion`, `markWitnessed`)
- `src/basic/ports.ts`
- `migrations/0004_review_fixes.sql`

**Tests.** "finding 15: llms.txt says what is true of the version". In `test/integration.test.ts`, "Semanto Basic: claims, proves by DNS, builds the witnessed record and measures the setup".

**Founder step.** None.

## 16. The log read every leaf to append or prove

**Change.** The right edge of the tree is now stored as a compact range. Each append costs O(log n) hashes, and the edge is kept in `semanto_log_frontier`; an existing log is backfilled once. Hashes are written to R2 as tiles in the tlog layout, 256 hashes per tile, with a partial tile stored as `.p/<width>`. Inclusion and consistency proofs are computed from the tiles.

Appends and tree head signing run one at a time in a new Durable Object, `LogDO`. Each append is written as one D1 batch. The in-memory store throws if appends are not serialized.

**Files.**
- `src/ledger/tiles.ts` (new)
- `src/ledger/log.ts`
- `src/ledger/ports.ts`
- `src/ledger/store-d1.ts`
- `src/ledger/log-do.ts` (new)
- `src/serve/ledger-port.ts`
- `src/index.ts`
- `wrangler.toml`
- `migrations/0004_review_fixes.sql`

**Tests.** "finding 16: the log appends in O(log n) from its frontier and proves from its tiles". This has three cases: the root at every size from 1 to 600; proofs at sizes 255, 256, 257 and 513; and concurrent appends through `LogDO`.

**Founder step.** Deploy with the `LOG` Durable Object binding and apply migration 0004 (`wrangler d1 migrations apply`) before the first append.

## 17. The first-publication statement pointed at routes that did not exist

**Change.** Two new public routes:

- `GET /public/semanto/first-publication/{smb_id}` returns the record, its JWS, its leaf and its inclusion proof.
- `POST /public/semanto/first-publication/check` returns `matches` or `differs`.

Both answers are signed with Trooth's witness key. The record now keeps what the requester said in a separate block, `declared: { stated_by: "requester", title, author }`. Trooth witnesses only `url`, `content_hash` and `witnessed_at`. The dispute export links both routes.

**Files.**
- `src/basic/first-publication.ts`
- `src/serve/routes.ts`
- `src/pipeline-store.ts`
- `src/db/d1.ts` (`getFirstPublication`, `record_json`)
- `migrations/0004_review_fixes.sql`
- `src/index.ts`

**Tests.** "finding 17: the first-publication record is checkable where the statement points". In `test/integration.test.ts`, "witnesses a first publication, logs it, and the record verifies against the text".

**Founder step.** None.

## 18. The Go command line ignored flags after the file path

**Change.** `ParseInterspersed` reads flags placed before or after positional arguments. Every subcommand uses it.

**Files.**
- `verifier/go/semanto/cli.go` (new)
- `verifier/go/cmd/semanto-verify/main.go`

**Tests.** In `verifier/go/semanto/cli_test.go`: `TestParseInterspersedReadsFlagsAfterThePath` and `TestCLIReadsFlagsAfterTheFilePath`.

**Founder step.** None.

## 19. Small items

| Item | Change | Test |
| --- | --- | --- |
| Signed 303 | The redirect to the company's HTML page is signed, with `Location` covered (`sendRedirect` in `src/serve/routes.ts`) | "finding 19: the 303 to the company's page is signed, with Location covered" |
| Malformed `created` / `expires` | A non-Integer value is `malformed`, never treated as absent (`src/core/httpsig.ts` and the kits) | "created=abc and expires=abc are malformed, never treated as absent"; vector `negative/response-created-not-integer.json` |
| Malformed `nbf` / `exp` / `iat`; null JWS header | A time that does not parse, or a header that is not an object, is `malformed` (`src/core/jws.ts` and the kits) | "a JWS whose nbf, exp or iat does not parse, or whose header is not an object, is malformed"; vectors `negative/jws-bad-nbf.json`, `negative/jws-header-null.json` |
| Catalog nonce and size | The catalog route requires a nonce and claims it once. A body over 5 MB gets a `payload_too_large` problem (413) (`src/pipeline.ts`, `src/serve/routes.ts`, `src/serve/errors.ts`; the adapters' `signPost` sends a nonce) | `test/integration.test.ts` "review finding 19: a catalog request is accepted once (its nonce is claimed), and a body over 5 MB is a 413 problem" |
| Ellipses and the house-rules scan | Ellipses removed from Python docstrings, Go variadics and docs. X-prefix mentions reworded in the docs. Banned words no longer spelled out in `docs/ARCHITECTURE.md` and `docs/AGENT-BRIEF.md`. The scan now covers every folder | `test/integration.test.ts` "no banned word, no ellipsis and no X-prefixed Semanto header in src, migrations, adapters, verifier, web or docs" |
| `marketplaceCatalog` in the kits | The JS, Python and Go kits now list the type, in step with `src/core/jws.ts` | "the JS kit's JWS_TYPES is the core registry, marketplaceCatalog included" |
| Exception messages | Pipeline handlers log the exception through `logError` and answer with a request id in the detail and in `Trooth-Request-Id`, never with the message. The catalog's `skipped` list no longer carries exception text | "a pipeline handler never returns an exception message: it logs it and answers with a request id" |

**Founder step.** None.

## Founder steps, in one list

1. Apply migration `0004_review_fixes.sql` to the production D1 database. It adds:
   - the `semanto_log_frontier` table
   - `semanto_companies.os_owner_user_id`
   - `semanto_companies.basic_version`
   - `semanto_first_publications.record_json`
2. Deploy with the `NONCES` (NonceDO) and `LOG` (LogDO) Durable Object bindings. The migration tag is `v1-nonce-and-log-durable-objects`, and the config is already in `wrangler.toml` for both environments.
3. Confirm that the Worker can reach `https://cloudflare-dns.com/dns-query` over DNS over HTTPS. Both the compiler and the key directory fetch fail closed without it.
4. For each company with a code adapter, generate a connector key, register its public half, and set `TROOTH_CONNECTOR_KEY` in the adapter's secret store.
5. Confirm that Akamai EdgeWorkers supports Ed25519 in WebCrypto.
6. worker-f should send `workspaceRole` and the team seats. Fill in `os_owner_user_id` for existing companies.
