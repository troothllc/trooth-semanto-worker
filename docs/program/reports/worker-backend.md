<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# Worker backend: the workspace contract of 23 October 2026

Repo: /home/claude/trooth-semanto-worker (branch main, nothing committed or pushed). Every backend part of docs/program/CONTRACT-2026-10-23.md is implemented, wired in src/index.ts, tested, and described route by route in docs/spec/os-api.md.

## Routes

Workspace routes (all through `workspaceFor`, every write in rate group `os_write` and audited; src/serve/os-routes.ts, registered before the older routes so the shared paths answer in the contract's shapes):

| Section | Routes |
| --- | --- |
| 1a | `GET settings`, `POST settings`, `POST settings/preview` |
| 1b | `GET keys`, `POST keys/rotation/start`, `POST keys/rotation/options`, `POST keys/rotation/confirm`, `POST keys/rotation/cancel`, `POST keys/binding/check`, `POST keys/rotate`, `POST keys/{kid}/revoke` |
| 1c | `GET receipts`, `GET receipts.csv` |
| 1d | `GET connectors`, `POST connectors`, `POST connectors/create`, `POST connectors/{kid}/test`, `POST connectors/{kid}/revoke`, `GET /os/semanto/connect/{session_id}` (session only), `POST connect/{session_id}/approve`, `POST connect/{session_id}/deny` |
| 1e | `GET google`, `POST google/connect`, `POST google/disconnect` |
| 2 | `GET company`, `POST company/signing-policy`, `POST company/surfaces`, `POST company/alerts` |
| 3 | `GET writeback`, `POST writeback/send`, `GET writeback/runs`, `GET writeback/runs/{run_id}`, `POST writeback/runs/{run_id}/retry` |
| 4 | `POST sellers/lists`, `POST sellers/lists/options`, `GET sellers/lists` |
| 6 | `GET credentials` |

Public routes: `POST /public/semanto/connect/sessions` and `GET /public/semanto/connect/sessions/{session_id}` (rate group `public_connect`, the poll with the bearer poll token), `POST /public/semanto/connect/uninstall` (the app's RFC 9421 signature, `public_connect`), `GET /public/semanto/google/callback`, `GET /public/semanto/alerts/confirm`, `GET /public/semanto/{id}/credentials/{sha256}`, and `GET /public/semanto/{id}/sellers` now reading the newest valid seller list.

Queue kinds on the existing compile queue (src/os/jobs.ts): `writeback`, `recall_event`, `credential`; a job that should run again throws `RetryLater` and `runQueue` calls `retry({ delaySeconds })` with 30, 120 and 600 seconds. No cron was added and nothing polls.

Sender side of section 5: every recall stored or changed through the commerce store (`withRecallEvents` around `D1CommerceStore`) is posted to `https://os/internal/semanto/recall-events` through `TROOTH_OS` with `Trooth-Event-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` (`SEMANTO_EVENTS_SECRET`), the body worker-f's receiver checks (with `domain`, as item 5 added).

## Deviations from the contract

None in what a section required. Where the contract left a choice open, or another area's addition named a shape, the Worker follows it, and the contract file now says so in "Settled by the Worker backend area" (same change). The points a caller notices:

- The passkey for a staged rotation and for a hosted seller list comes from `POST keys/rotation/options` and `POST sellers/lists/options` (the trooth-web area's additions); `POST sign/options` with a `purpose` answers the same challenge. Confirm needs the assertion when either key is hosted; between two customer-held keys it needs none, as `POST sign` does.
- `keys/{kid}/revoke` keeps `reason` (now optional, default "Revoked by the company.") beside the required typed `confirm`.
- The one-call `keys/rotate` is refused while a staged rotation is started.
- A recall event worker-f could not file (no matching product record, no workspace link, no proven domain: worker-f's schema requires all three) is kept on this side as failed with the reason rather than sent.
- The Merchant Center preview payload is the Merchant API form that is actually sent; the Content API builders in src/monitor/writeback.ts are kept unchanged beside it.

The contract file also had three ellipses (the house rules test reads docs/); they were replaced with `<route>`, `<token>` and `["<item_id>"]`. The worker-f area's report in this repo had one in its answer for a duplicate event, rewritten in words so the root suite passes.

## Migrations

- Up: `migrations/0007_os_contract.sql` (additive): tables `semanto_audit`, `semanto_key_rotations`, `semanto_connect_sessions`, `semanto_google_states`, `semanto_google_connections`, `semanto_alert_addresses`, `semanto_writeback_runs`, `semanto_writeback_items`, `semanto_seller_lists`, `semanto_recall_events`, `semanto_credentials`; columns `semanto_keys.pending` and `semanto_connector_keys.label`, `last_request_at`, `last_result`, `last_ok_at`; their indexes.
- Down: `migrations-down/0007_os_contract.down.sql` drops exactly those (tested: up, down, up again on SQLite).
- No trigger, no cron, no polling. Rows are written and read on demand or by a queue message.

## Env names added

`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (secret), `GOOGLE_OAUTH_REDIRECT_URI` (var, default `https://api.trooth.co/public/semanto/google/callback`), `SEMANTO_EVENTS_SECRET` (secret, the same value on worker-f). In src/env.ts and the wrangler.toml comment block (names only). The Google refresh token is sealed with the existing `HOSTED_KEY_SEAL_SECRET` (context `google-refresh`); alert confirmation emails use the existing `RESEND_API_KEY` and `ALERT_FROM`.

## Files changed

New:
- `src/os/common.ts`, `src/os/service.ts`, `src/os/store.ts`, `src/os/keys.ts`, `src/os/settings.ts`, `src/os/receipts.ts`, `src/os/connectors.ts`, `src/os/google.ts`, `src/os/company.ts`, `src/os/writeback.ts`, `src/os/sellers.ts`, `src/os/recalls.ts`, `src/os/credentials.ts`, `src/os/jobs.ts`
- `src/serve/os-routes.ts`, `src/db/os-d1.ts`
- `migrations/0007_os_contract.sql`, `migrations-down/0007_os_contract.down.sql`
- `test/os-contract.test.ts`, `test/os-d1.test.ts`, `test/helpers/os-world.ts`
- `docs/spec/os-api.md`, `docs/program/reports/worker-backend.md`

Edited:
- `vitest.config.ts`, `tsconfig.json`: apps/** excluded, so the Shopify package never enters the root suite or typecheck.
- `src/serve/routes.ts`: the os routes registered first; `public_connect` chosen in the rate middleware; RFC 9457 extension members (`issues`); `runQueue` passes the queue's attempts and `delaySeconds`; the public sellers route reads the newest valid list.
- `src/serve/errors.ts`: problem codes `settings_invalid` (422), `seller_list_signature` (422), `connect_session_not_found` (404), `connect_session_expired` (410); problems may carry extension members.
- `src/serve/ports.ts`: `JobPort.compile(job, attempts)`, problem extensions.
- `src/pipeline.ts`: the catalog route records each connector kid's last signed request (`connectorSeen`, `namedConnectorKid`); signing paths skip a staged key; hooks `afterAssembled` (credential jobs), `consumeOs` and `consumeOsFailed` (the new queue kinds); `logKey` public; product images carried to the monitor's view (`image_url`).
- `src/pipeline-passkeys.ts`: purpose-bound passkey requests and checks (`key_rotation`, `seller_list`), the version path unchanged.
- `src/pipeline-store.ts`, `src/db/d1.ts`: `CompanyKey.next` (`semanto_keys.pending`): a staged key is published but never signs and never sets the custody; connector key labels; company surfaces in the company config.
- `src/db/key-seal.ts`: `sealText` and `openText` (AES-256-GCM, HKDF per context and company).
- `src/readers/rate-limit.ts`: groups `os_write` (30 a minute) and `public_connect` (10 a minute), `durableKeyedLimit`.
- `src/monitor/writeback.ts`: `merchantProductInputs`, `merchantInsertUrl`, `amountMicros` (Merchant API v1), `MerchantCenterTarget.dataSource`; previews unchanged. `src/monitor/types.ts`: `Product.image_url`.
- `src/core/jws.ts` and the three kits (`verifier/js/verify.mjs`, `verifier/python/trooth_semanto_verify/jws.py`, `verifier/go/semanto/jws.go`) with their registry tests: `JWS_TYPES.sellerList` = `https://trooth.co/types/seller-list`.
- `src/env.ts`, `src/index.ts`, `wrangler.toml` (comments only).
- `adapters/shared/semanto-adapter.mjs`: answers `{ kid }` at `/.well-known/trooth-semanto-connector` when it holds a connector key (the dashboard's connection test); `test/adapters.test.ts`.
- Docs: `docs/ARCHITECTURE.md` (layer `src/os`, routes, queue kinds, migration 0007), `docs/REQUIREMENTS-TRACEABILITY.md` (rows 4, 16, 22, 24 and a table for the contract), `docs/spec/setup-api.md` (pointers to os-api.md), `docs/program/CONTRACT-2026-10-23.md` (the settled points and the full /os allowlist with methods), `docs/program/reports/worker-f-recalls.md` (one ellipsis).

## Reference products per workflow

- Staged key rotation: GitHub deploy keys and SSH keys (the new key is added before the old one is removed), AWS KMS automatic rotation (earlier key material stays for verification while new material signs; https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html), Stripe's "Roll key" (the old key gets an expiry window while the new one goes live; https://docs.stripe.com/keys-best-practices, https://support.stripe.com/questions/how-do-i-roll-change-update-my-stripe-api-key). Typed confirmation for destructive actions: GitHub's "type the repository name to confirm".
- Copy-once secrets: GitHub personal access tokens ("make sure to copy it now, you won't be able to see it again").
- App connect: Stripe CLI `stripe login` (pairing code and browser approval) and the OAuth 2.0 device authorization flow as GitHub implements it (the device polls while the person approves; the session expires).
- Connect Google: Google's "Using OAuth 2.0 for Web Server Applications" (authorization code with PKCE S256, `access_type=offline`, `prompt=consent`, `include_granted_scopes=true` for incremental scopes, a state parameter, revocation at `https://oauth2.googleapis.com/revoke`, `invalid_grant` for a revoked or expired refresh token). Connection state and Reconnect: Zapier's app connections ("Reconnect" on an expired connection), Shopify's and HubSpot's connected-apps screens (connected account, granted access, disconnect with confirmation).
- Merchant writes: Merchant API `accounts.productInputs.insert` (`POST https://merchantapi.googleapis.com/products/v1/{parent=accounts/*}/productInputs:insert?dataSource=`, ProductInput with `offerId`, `contentLanguage`, `feedLabel`, `productAttributes` with `price.amountMicros` and `currencyCode`, `gtins`, `availability` `IN_STOCK`; scope `https://www.googleapis.com/auth/content`; https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.productInputs/insert, https://developers.google.com/merchant/api/guides/products/add-manage). Business Profile: Business Information API v1 `locations.patch` with `updateMask`.
- Sending with an idempotency key and retries: Stripe's Idempotency-Key header (the same key answers the same result), exponential backoff on 429 and 5xx as Google's API guidance recommends.
- Signed events: Stripe webhook signatures (`Stripe-Signature: t=,v1=`, HMAC-SHA256 over `timestamp.payload`, five-minute tolerance; https://docs.stripe.com/webhooks/signature).
- Alert addresses: double opt-in as Mailchimp and Substack confirm a new subscriber (a single-use link in an email, the address unused until it is opened).
- Seller lists: ads.txt and app-ads.txt (IAB Tech Lab: one file the brand publishes naming its authorized sellers), Amazon Brand Registry and Merchant Center's authorized-reseller lists.
- Read receipts filters and export: Google Search Console's performance report (date range, filters, export) and Cloudflare analytics; CSV injection guard from OWASP.
- Settings preview: the review step Cloudflare's dashboard and Vercel's project settings show before a change that affects what is served.

## Follow-ups from the Shopify app area

- Rate groups: `public_connect` now counts only `POST /public/semanto/connect/sessions` (10 a minute per address); the poll is limited per session id (`connect_poll`, 40 a minute) and the uninstall per key id (`connect_uninstall`, 10 a minute), in src/serve/os-routes.ts with the keyed limiter; the address middleware skips those two.
- Uninstall: a well-formed signature by a never-registered kid is 404 `not_registered` (new problem code); a bad signature on a known kid stays 401; `reason` (`uninstalled` default, `disconnected`, `shop_redact`) is recorded as the audit action `connectors.uninstall.<reason>` and answered.
- Approve: `return_url` is checked when the session opens (https, host the session's `*.myshopify.com` account or `admin.shopify.com`) and returned by approve.
- Catalog: a product sent as `discontinued` used to become a signed discontinued offer, and was skipped (leaving the old offer in place) when it came without a price. It now removes every offer for its sku (`CommerceStore.removeOffers`, D1 `DELETE` on `semanto_offers`), signs nothing, and is listed in the receipt's `removed`. The Shopify app's own test `apps/shopify/test/mapping.test.ts` ("reads a discontinued product as discontinued offers") expects the old answer and needs `out.removed` to contain the sku and `out.offers` to be empty; apps/ was not touched here.

## Tests and results

- `npm test` (vitest): 21 files, 582 tests, all passing (523 before; 59 new: `test/os-contract.test.ts` 50, `test/os-d1.test.ts` 8, one in `test/adapters.test.ts`). The house rules test (banned words, ellipses, file headers) passes over every new file and doc.
- `npx tsc --noEmit`: clean. There is no lint script in package.json.
- Verifier kits: Go `go test` over every package in verifier/go passes; Python `python3 -m pytest` 40 passed; the JavaScript kit's registry test runs inside the vitest suite.
- `wrangler deploy --dry-run` bundles the Worker with every binding.

What the new tests prove, by section: the audit row per write with digests and the request id and the newest 20 as recent changes; os_write at 30 a minute per session subject and public_connect at 10 a minute per address; 401 without a session and 403 for a viewer on every new route; the settings preview with no save and the 422 problem with issues; a staged key published but not signing, confirm only with a passkey bound to that rotation, overlap expiry and rotation completion computed on read with no cron, cancel revoking and listing the key, customer custody, typed revoke refusing the only active key, the DNS binding check; receipts filters, cursor, the 92-day limit and the CSV header and injection guard; the exact paste messages, copy-once creation, the connector test verdicts from the catalog route's per-kid record and the edge adapter's well-known answer, revoke; the connect flow end to end with poll-token hashing, 404 and 410, expiry, deny, and the signed uninstall with replay refusal; Google PKCE and state hashing, the single-use callback, the sealed refresh token never answered or audited in the clear, refresh on use, needs_reconnect with exactly one alert to confirmed addresses, disconnect with revoke; the signing policy rules, surfaces and write-back targets, alert addresses with single-use 24-hour links and the resend limit; write-back item ids, confirm and idempotency, the Merchant API and Business Profile calls, backoff 30, 120, 600 and the final failure, Google's message on a 4xx, needs_reconnect, retry of failed items, credential jobs for sent images, `delaySeconds` through `runQueue`; seller lists by JWS (422 on a bad signature, nothing stored, versions only up) and by hosted signing with a draft-bound passkey, and the public route reading the newest valid list; recall events with the exact header and body worker-f checks, a no-op repeat, the failed-and-kept cases, no retry on a 4xx and queue retries on a 5xx; credential jobs from a build and from write-back with made, failed and skipped rows and the public manifest; D1OsStore against SQLite for every single-use value, idempotency, versions, events, credentials and the staged key column; migration 0007 up, down and up again.
