<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The workspace API of the program contract of 23 October 2026 (docs/program/CONTRACT-2026-10-23.md): every route src/serve/os-routes.ts serves, with its auth, rate group, audit row and an example. Shapes are what src/os/*.ts answer. Errors are RFC 9457 problems (src/serve/errors.ts). -->

# Workspace API (23 October 2026)

This is every route the Semanto Worker added for the program contract of 23 October 2026. It sits beside the setup API (docs/spec/setup-api.md) and follows its conventions: base `https://api.trooth.co`, `{id}` is the company's Trooth ID, every answer is signed (RFC 9421, tag `trooth-semanto`, with `Content-Digest`) and carries `Trooth-Request-Id`, every `/os` answer carries `Cache-Control: private, no-store`, a body is JSON of at most 5 MB, and a field marked `?` is absent, not null, when it does not apply. The bodies below marked **Example** are examples: the ids, keys, times and figures in them are made up.

## Rules every route here follows

- **Auth.** Every `/os/semanto/{id}/<route>` passes `workspaceFor`: the worker-f session through the TROOTH_OS binding, mapped to the caller's own company; no session is a 401 problem; a signed-in person whose workspace has no Semanto company here, or another company's session, a 403; the session service not answering a 503 `session_unavailable` (retryable, never read as signed out). `GET /os/semanto/connect/{session_id}` takes the worker-f session alone (no company needed). The `/public` routes are named with their own check.
- **Roles.** Every write needs an owner or admin (`mayAdminister`), unless the route says otherwise. Actions that read and cost work (the DNS binding check, the connector test) need an owner, admin or member (`mayOperate`). A viewer reads.
- **Rate groups** (src/readers/rate-limit.ts, the RateLimitDO bound as RATE): every `/os` write passes `os_write`, 30 a minute per company and session subject (the worker-f user); `POST /public/semanto/connect/sessions` passes `public_connect`, 10 a minute per client address; the session poll passes `connect_poll`, 40 a minute per session id, and the uninstall `connect_uninstall`, 10 a minute per key id (app servers poll from shared egress addresses, so these two are not counted per address). Over the limit is a 429 problem with `Retry-After`.
- **Audit.** Every write appends one row to `semanto_audit`: the user id, who (the person's name or address, or `connector:<kid>`), role, action, target, the sha256 digest of the canonical JSON before and after, the request id and the time. Secrets never enter a row; only digests do. `GET company` answers the newest 20 as `recent_changes`.
- **No schedule.** Nothing here runs on a cron or polls. The queue (`trooth-semanto-compile`) carries the jobs: `writeback`, `recall_event` and `credential`; a job that should run again is retried with `retry({ delaySeconds })` after 30, 120 and 600 seconds, up to the queue's four attempts.

## 1a. Delivery settings

`GET /os/semanto/{id}/settings` (any role)

**Example**
```json
{ "object": "semanto.settings", "trooth_id": "acme", "domain": "acme.com", "settings": { "where": { "trooth_hosted": true, "own_domain": false }, "host": "unknown", "formats": { "markdown": true, "jsonld": true, "llms": true, "sitemap_md": true, "whole_file": true }, "markdown_source": "semanto_only", "when_page_changed": "serve_last_signed_marked_behind", "content_signals": { "ai-train": false, "search": true, "ai-input": true } }, "detection": { "host": "cloudflare", "at": "2026-10-23T11:58:00.000Z" }, "updated_at": "2026-10-23T12:00:00.000Z" }
```

`POST /os/semanto/{id}/settings/preview` (owner or admin, os_write, no audit: nothing is saved) takes the DeliverySettings object, as Save does, and answers what changes for readers.

**Example**
```json
{ "object": "semanto.settings_preview", "issues": [], "effects": [
  { "route": "/public/semanto/acme/facts.jsonld", "before": "served (JSON-LD)", "after": "404 representation_not_offered (turned off)" },
  { "route": "/public/semanto/acme/* Content-Signal header", "before": "ai-train=no, search=yes, ai-input=yes", "after": "ai-train=yes, search=yes, ai-input=yes" } ] }
```

`POST /os/semanto/{id}/settings` (owner or admin, os_write, audit `settings.save`) saves and answers the `semanto.settings` object. A refused save is the 422 problem `settings_invalid` with `issues: [{ path, message }]`.

## 1b. Signing keys, domain binding, staged rotation

`GET /os/semanto/{id}/keys` (any role). Each key's `state` is computed when read: `next` (published, not signing), `active`, `retiring` (still checks out until `overlap_until`), `expired` (a retiring key whose overlap has passed; no cron moves it) or `revoked`. `binding` is the last DNS check of the active key; `rotation` the newest rotation (`completed` once a confirmed rotation's overlap has passed); while a rotation is `started` it also carries `dns_record` (`{ name, value }` for the new key), so the screen shows it again after a reload.

**Example**
```json
{ "object": "semanto.keys", "trooth_id": "acme",
  "keys": [
    { "kid": "Xq2fixtureOldKid0000000000000000000000000000", "custody": "hosted", "state": "retiring", "sentence": "This key still checks out until 2026-11-22T12:00:00.000Z. The new key signs from now on.", "overlap_until": "2026-11-22T12:00:00.000Z", "created_at": "2026-10-01T09:00:00.000Z", "nbf": "2026-10-01T09:00:00.000Z", "exp": "2026-11-22T12:00:00.000Z" },
    { "kid": "Yr3fixtureNewKid0000000000000000000000000000", "custody": "hosted", "state": "active", "sentence": "This key is valid now.", "overlap_until": null, "created_at": "2026-10-23T11:55:00.000Z", "nbf": "2026-10-23T11:55:00.000Z" } ],
  "binding": { "dns_name": "_trooth-keys.acme.com", "dns_value": "v=trooth1; kid=Yr3fixtureNewKid0000000000000000000000000000", "found": false, "checked_at": null },
  "rotation": { "rotation_id": "rot_fixture", "next_kid": "Yr3fixtureNewKid0000000000000000000000000000", "current_kid": "Xq2fixtureOldKid0000000000000000000000000000", "overlap_until": "2026-11-22T12:00:00.000Z", "state": "confirmed" } }
```

`POST /os/semanto/{id}/keys/rotation/start` (owner or admin, os_write, audit `keys.rotation.start`) takes `{ "custody": "hosted" }` or `{ "custody": "customer", "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<32 bytes base64url>" } }`. The new key is published in the JWK Set at once and logged; it does not sign. A second start while one is started is a 409, two starts at the same moment included (one conditional write, migration 0008's index keeps one started rotation per company).

**Example**
```json
{ "object": "semanto.key_rotation", "trooth_id": "acme", "rotation_id": "rot_fixture", "state": "started", "custody": "hosted", "next_kid": "Yr3fixtureNewKid0000000000000000000000000000", "current_kid": "Xq2fixtureOldKid0000000000000000000000000000", "jwks_url": "https://acme.com/.well-known/trooth-keys.json", "dns_record": { "name": "_trooth-keys.acme.com", "value": "v=trooth1; kid=Yr3fixtureNewKid0000000000000000000000000000" }, "overlap_until": "2026-11-22T12:00:00.000Z", "next": "The new key is published now and does not sign yet. Add the DNS record if you use one, then confirm at POST https://api.trooth.co/os/semanto/acme/keys/rotation/confirm." }
```

`POST /os/semanto/{id}/keys/rotation/options` (owner or admin, os_write) takes `{ rotation_id }` for a started rotation and answers the sign-options shape (`object: "semanto.sign_options"`, `purpose: "key_rotation"`, `binding: "rotation:<rotation_id>"`, `publicKey`), a single-use five-minute challenge bound to this person and this rotation. `POST sign/options` with `{ "purpose": "key_rotation", "rotation_id" }` answers the same.

`POST /os/semanto/{id}/keys/rotation/confirm` (owner or admin, os_write, audit `keys.rotation.confirm`) takes `{ rotation_id, assertion }`, the assertion as `POST sign` takes it. The assertion is needed when the company's key or the new key is hosted; between two customer-held keys it is not, as for sign. `next` becomes active, every other active key becomes retiring with `overlap_until` = now + 30 days.

**Example**
```json
{ "object": "semanto.key_rotation", "trooth_id": "acme", "rotation_id": "rot_fixture", "state": "confirmed", "active_kid": "Yr3fixtureNewKid0000000000000000000000000000", "retiring_kids": ["Xq2fixtureOldKid0000000000000000000000000000"], "overlap_until": "2026-11-22T12:00:00.000Z", "custody": "hosted" }
```

`POST /os/semanto/{id}/keys/rotation/cancel` (owner or admin, os_write, audit `keys.rotation.cancel`) takes `{ rotation_id }`, only before confirm. The next key is revoked, logged and on the signed revocation list at once: `{ "object": "semanto.key_rotation", "state": "cancelled", "revoked_kid", "revocations_url" }`.

`POST /os/semanto/{id}/keys/{kid}/revoke` (owner or admin, os_write, audit `keys.revoke`) takes `{ "confirm": "<kid>", "reason"?, "compromised_at"? }`. Without the typed kid it is a 400; the only active key is refused (409: rotate first); the next key of a started rotation is refused (cancel instead). Without `reason` the published reason is "Revoked by the company." The answer is `semanto.key_revoked` with the log index and the revocations address.

`POST /os/semanto/{id}/keys/binding/check` (owner, admin or member, os_write, no audit: it changes nothing a person set) reads `_trooth-keys.<domain>` now over the two DNS over HTTPS resolvers of src/setup/ports.ts and answers the binding object alone: `{ "dns_name", "dns_value", "found", "checked_at" }`.

`POST /os/semanto/{id}/keys/rotate` (owner or admin, os_write, audit `keys.rotate`) stays the one-call rotation for API users (start and confirm together), refused with 409 while a staged rotation is started. It needs no passkey for a move between two customer keys and for rolling the hosted key Trooth keeps; moving a hosted company to a customer key is a 409 that names the staged rotation, whose confirm asks for the passkey.

## 1c. Read receipts

`GET /os/semanto/{id}/receipts?from=&to=&agent=&path=&status=&cursor=&limit=` (any role). `from` and `to` are days (YYYY-MM-DD), at most 92 days apart, the last seven days when left out; `agent` is an operator name (the display name or the host of its key directory); `path` a prefix; `status` `signed_agent` or `unsigned`; `limit` 1 to 200 (50 by default). An agent is named only behind a proven Web Bot Auth key; the rest is one "unproven reader". Whole-file reads have the path `(whole file)`.

**Example**
```json
{ "object": "semanto.receipts", "trooth_id": "acme", "from": "2026-10-20", "to": "2026-10-23",
  "rows": [ { "day": "2026-10-22", "agent": "agent.example", "operator": "agent.example", "path": "/about", "reads": 4, "signed": true, "last_at": "2026-10-22T10:30:00.000Z" } ],
  "totals": { "reads": 4, "agents": 1, "paths": 1 }, "agents": ["agent.example", "unproven reader"], "next_cursor": null }
```

`totals.agents` counts the agents of signed rows only: every unsigned read is one "unproven reader" in the `agents` list for the filter, never an agent in the count.

`GET /os/semanto/{id}/receipts.csv` takes the same filters (no cursor or limit) and answers every row as RFC 4180 CSV with the fixed header `day,agent,operator,path,reads,signed,last_at`. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a single quote.

## 1d. Connector keys and the connect flow

`GET /os/semanto/{id}/connectors` (any role) answers `{ "object": "semanto.connectors", "trooth_id", "keys": [{ "kid", "source", "label", "created_at", "last_used_at", "revoked_at" }] }`; `last_used_at` is the last catalog request whose signature checked out.

`POST /os/semanto/{id}/connectors` (owner or admin, os_write, audit `connectors.add`) takes `{ public_jwk, label?, source? }`, `source` one of `edge`, `api`, `app` (`api` when left out). The answers that name the problem, exactly:

| Problem | Status | detail |
| --- | --- | --- |
| no key | 400 | Send the connector's public key as public_jwk. |
| not JSON | 400 | The key is not JSON. Paste the public key exactly as the connector printed it: a JSON object that starts with {. |
| private parts | 400 | This key has private parts (the "d" member). Paste only the public key and keep the private key on the connector's server. |
| not Ed25519 | 400 | This is not an Ed25519 key (kty must be OKP and crv Ed25519). Make an Ed25519 key in the connector and paste its public key. |
| duplicate kid | 409 | This key is already on file (kid `<kid>`). Each connector needs its own key. |

`POST /os/semanto/{id}/connectors/create` (owner or admin, os_write, audit `connectors.create`) takes `{ source, label? }`. The Worker makes an Ed25519 pair, stores the public half and answers the private half once; it is never stored or logged.

**Example**
```json
{ "object": "semanto.connector_key_created", "trooth_id": "acme", "kid": "Zt4fixtureConnectorKid000000000000000000000", "source": "edge", "label": "Cloudflare Worker", "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>", "kid": "Zt4fixtureConnectorKid000000000000000000000", "alg": "EdDSA", "use": "sig", "nbf": "2026-10-23T12:00:00.000Z" }, "private_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>", "d": "<base64url, shown once>", "kid": "Zt4fixtureConnectorKid000000000000000000000", "alg": "EdDSA", "use": "sig" }, "secret_shown_once": true, "next": "Copy or download the private key now and put it in the connector's settings. Trooth does not keep it and cannot show it again." }
```

`POST /os/semanto/{id}/connectors/{kid}/test` (owner, admin or member, os_write) answers from the last signed request the catalog route saw for the kid (its time and result, kept on every `commerce/catalog` call), and for an `edge` key also reads `https://{domain}/.well-known/trooth-semanto-connector` through the SSRF guard, where the adapter answers `{ "kid" }` (adapters/shared/semanto-adapter.mjs serves it when it holds a connector key).

**Example**
```json
{ "object": "semanto.connector_test", "trooth_id": "acme", "kid": "Zt4fixtureConnectorKid000000000000000000000", "last_signed_request_at": "2026-10-23T12:00:00.000Z", "last_result": "ok", "verdict": "connected", "checked_url": "https://acme.com/.well-known/trooth-semanto-connector", "adapter_kid": "Zt4fixtureConnectorKid000000000000000000000" }
```

`verdict` is `connected`, `never_seen`, `signature_failed` (the kid's last request did not check out) or `revoked`.

`POST /os/semanto/{id}/connectors/{kid}/revoke` (owner or admin, os_write, audit `connectors.revoke`) takes `{ "confirm": "<kid>" }`; the key stops signing catalogs at once.

The connect flow for app installs (Shopify first):

- `POST /public/semanto/connect/sessions` (public, public_connect) takes `{ "app": "shopify", "account": "<shop>.myshopify.com", "public_jwk", "return_url"? }` (`return_url` https, on the account's own host or `admin.shopify.com`) and answers 201 `{ "object": "semanto.connect_session", "session_id", "poll_token", "approve_url": "https://trooth.co/dashboard/semanto/connect/<session_id>", "expires_at", "kid" }`. The session lasts 15 minutes; the poll token is kept only as its SHA-256.
- `GET /public/semanto/connect/sessions/{session_id}` (public, connect_poll per session, `Authorization: Bearer <poll_token>`) answers `{ "object": "semanto.connect_session", "session_id", "state": "pending" | "approved" | "denied" | "withdrawn" | "expired", "trooth_id"?, "kid"?, "expires_at" }`; a wrong token is a 401. `withdrawn` is a request the app took back before anyone decided: the app's uninstall, signed with the key the request offered, arrived first.
- `GET /os/semanto/connect/{session_id}` (the worker-f session, no company needed) answers what the approve page shows: `{ "object": "semanto.connect_request", "session_id", "app", "account", "kid", "requested_at", "expires_at", "state", "return_url", "companies": [{ "trooth_id", "domain", "org" }] }` (`return_url` is the app's own address, checked when the request was opened, or null); 404 `connect_session_not_found`, 410 `connect_session_expired`.
- `POST /os/semanto/{id}/connect/{session_id}/approve` and `/deny` (owner or admin, os_write, audit `connect.approve` or `connect.deny`) take `{}`. Approve registers the key with `source = "shopify:<shop>"` and label `Shopify: <shop>`, and answers `{ "state": "approved", "trooth_id", "kid", "source", "return_url" }`. Each session is decided once; on a withdrawn session both answer 409 `connect_session_withdrawn`, "The store withdrew this request (the app was removed or disconnected before it was approved). Nothing was connected."
- `POST /public/semanto/connect/uninstall` (public, connect_uninstall per key id) serves `app/uninstalled`, the app's Disconnect and `shop/redact`. It takes `{ "account"?, "reason"?: "uninstalled" | "disconnected" | "shop_redact" }` (the app may add `app`, `kid`, `trooth_id`), signed with the app's connector key: RFC 9421, components `@method`, `@target-uri`, `content-digest`, `content-type`, tag `trooth-connector`, a fresh nonce (a replay is a 401). It revokes that key and answers `{ "object": "semanto.connector_revoked", "trooth_id", "kid", "revoked_at", "reason" }` (audit `connectors.uninstall.<reason>`, who `connector:<kid>`). A well-formed signature by a key never registered is 404 `not_registered`; a bad signature on a registered key is 401; a registered key no app install made is 403.
- `POST /os/semanto/{id}/commerce/catalog` (unchanged, connector-signed): a product or variant sent with `stock_status: "discontinued"` takes every offer for its sku out, signs nothing for it, and is listed in the receipt's `removed`; its product record stays. A connector has no delete call, so this is how a deleted or unpublished product leaves the offers.

## 1e. Connect Google

`GET /os/semanto/{id}/google` (any role)

**Example**
```json
{ "object": "semanto.google", "trooth_id": "acme", "state": "connected", "account_email": "owner@acme.example",
  "scopes": [
    { "scope": "https://www.googleapis.com/auth/content", "purpose": "Send your signed product details to Merchant Center.", "granted": true },
    { "scope": "https://www.googleapis.com/auth/business.manage", "purpose": "Send your signed name, phone, address, hours and website to Business Profile.", "granted": true },
    { "scope": "openid", "purpose": "Know which Google account you connected.", "granted": true },
    { "scope": "email", "purpose": "Show the Google account's email address on this screen.", "granted": true } ],
  "merchant_accounts": [{ "id": "123456", "name": "Acme Store" }], "business_locations": [{ "name": "locations/987", "title": "Acme Inc" }],
  "connected_at": "2026-10-23T12:00:00.000Z", "last_refresh_at": "2026-10-23T12:00:00.000Z", "last_error": null }
```

`POST /os/semanto/{id}/google/connect` (owner or admin, os_write, audit `google.connect.start`) takes `{ "products": ["merchant", "business"] }` and answers `{ "object": "semanto.google_authorization", "authorization_url", "expires_at" }`: the authorization code flow with PKCE (S256), `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, and a state bound to the company, the person and ten minutes, kept as its SHA-256 for one use. Without the OAuth client or the seal secret it is a 409.

`GET /public/semanto/google/callback` (public; Google redirects here) checks the state once, exchanges the code with the PKCE verifier, seals the refresh token (AES-256-GCM, src/db/key-seal.ts sealText, context `google-refresh`, bound to the company), records the granted scopes and the accounts and locations the token sees, and redirects (302) to `https://trooth.co/dashboard/semanto/connections?google=connected`, or `?google=error&reason=<code>` with one of `not_configured`, `access_denied` (or Google's own error code), `state_invalid`, `state_expired`, `no_code`, `exchange_failed`, `no_refresh_token`, `scopes_declined`. Audit `google.connect` or `google.reconnect`.

`POST /os/semanto/{id}/google/disconnect` (owner or admin, os_write, audit `google.disconnect`) takes `{ "confirm": true }`, revokes the token at `https://oauth2.googleapis.com/revoke`, deletes the sealed token and answers the `semanto.google` object with `revoked_at_google`.

The token is refreshed on use only. A refresh answering `invalid_grant` sets `needs_reconnect` with `last_error`, and one email goes to the confirmed alert addresses (the first time only).

## 2. Company settings

`GET /os/semanto/{id}/company` (any role)

**Example**
```json
{ "object": "semanto.company_settings", "trooth_id": "acme", "signing_policy": { "officers_required": 1 },
  "surfaces": [
    { "kind": "website", "id": "website", "label": "acme.com", "url": "https://acme.com/", "connected": true },
    { "kind": "merchant_center", "id": "accounts/123456", "label": "Acme Store", "data_source": "accounts/123456/dataSources/42", "connected": true } ],
  "alert_addresses": [{ "address": "ops@acme.example", "state": "confirmed", "added_at": "2026-10-23T12:00:00.000Z", "confirmed_at": "2026-10-23T12:05:00.000Z" }],
  "recent_changes": [{ "who": "Ada Owner", "role": "owner", "action": "company.surfaces.add", "target": "accounts/123456", "at": "2026-10-23T12:01:00.000Z", "request_id": "0f1e2d3c4b5a6978", "before_hash": "sha256:<64 hex>", "after_hash": "sha256:<64 hex>" }] }
```

Every `POST company/*` answers this object.

- `POST /os/semanto/{id}/company/signing-policy` (owner or admin, os_write, audit `company.signing_policy`) takes `{ "officers_required": 1 | 2, "confirm"? }`. From two to one needs the owner and `"confirm": "one officer"`, and is refused (409) while the newest version has an approval waiting for a second officer.
- `POST /os/semanto/{id}/company/surfaces` (owner or admin, os_write, audit `company.surfaces.add` or `.remove`) takes `{ "add": { "kind", "label", "id"?, "url"?, "data_source"?, "content_language"?, "feed_label"? } }` or `{ "remove": "<id>", "confirm"? }`. Removing a connected surface needs `"confirm": "<id>"`; the website cannot be removed. The first Merchant Center surface and the first Business Profile surface are the write-back targets.
- `POST /os/semanto/{id}/company/alerts` (owner or admin, os_write, audits `company.alerts.add`, `.resend`, `.remove`) takes one of `{ "add": "<address>" }`, `{ "resend": "<address>" }` (at most once a minute; sooner is a 429 with Retry-After) or `{ "remove": "<address>", "confirm": "<address>" }`. Add and resend email a single-use 24-hour link; without Resend (RESEND_API_KEY and ALERT_FROM) they are a 409. Alerts go to confirmed addresses only.
- `GET /public/semanto/alerts/confirm?token=<token>` (public, the link in the email) confirms the address once and redirects (302) to `https://trooth.co/dashboard/semanto/settings?alerts=confirmed` or `?alerts=error&reason=link_invalid|link_expired` (audit `company.alerts.confirm`, who the address).

## 3. Write-back that sends

`GET /os/semanto/{id}/writeback` (any role) is the preview of src/monitor/writeback.ts, with every payload carrying `item_id` (a content address of the change), `sendable` and, when it cannot be sent, `blocked_by`. The Merchant Center http payload is the Merchant API form that is sent.

**Example** (one payload)
```json
{ "item_id": "wbi_0123456789abcdef0123456789abcdef", "connector": "merchant_center", "target": "accounts/123456", "transport": "http", "method": "POST", "url": "https://merchantapi.googleapis.com/products/v1/accounts/123456/productInputs:insert?dataSource=accounts%2F123456%2FdataSources%2F42", "content_type": "application/json", "body": "{ \"productInputs\": [ { \"offerId\": \"ANV-100\", \"contentLanguage\": \"en\", \"feedLabel\": \"US\", \"productAttributes\": { \"title\": \"Acme Anvil\", \"availability\": \"IN_STOCK\", \"price\": { \"amountMicros\": \"49000000\", \"currencyCode\": \"USD\" } } } ] }", "dry_run": "Would insert 1 product into Merchant Center account 123456 through the Merchant API (productInputs.insert, data source accounts/123456/dataSources/42), each with the signed title, link, price, stock and GTIN. Needs your Google connection with Merchant Center access.", "needs": "oauth_token", "carries": {}, "sendable": true }
```

`POST /os/semanto/{id}/writeback/send` (owner or admin, os_write, audit `writeback.send`) takes `{ "item_ids": ["<item_id>"], "confirm": true, "idempotency_key": "<8 to 200 characters>" }`, creates a run and one queue message `{ "kind": "writeback", "trooth_id", "run_id", "item_id" }` per item, and answers 202 `{ "object": "semanto.writeback_run", "trooth_id", "run_id", "items": [{ "item_id", "state": "queued" }] }`. Leave `item_ids` out to send every change the preview can send now (at most 500). The same key with the same items answers the same run (200); the same key with other items is a 409 (as Stripe refuses an idempotency key reused with other parameters). A stale or unknown item, a file payload, a Merchant Center account without a data source, or Google not connected is a 409. A run, once it can be read, always has every item.

The consumer sends only to `merchantapi.googleapis.com` and `mybusinessbusinessinformation.googleapis.com` (any other address in a stored item fails it without a request), with an access token refreshed on use and reused in the isolate until a minute before it expires (a 401 drops it and the item is retried): each `productInputs.insert` to `https://merchantapi.googleapis.com/products/v1/accounts/{account}/productInputs:insert?dataSource={data source}` (an insert with the same offerId replaces the earlier input), or `PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/{id}?updateMask={fields}`. A 429 or 5xx sets `retrying` and asks the queue to wait 30, then 120, then 600 seconds; the fourth failure, and any other 4xx, sets `failed` with Google's own message ("Google refused this change (400): <message>"); `invalid_grant` fails the item with `needs_reconnect: <sentence>`. Each image link sent gets a credential job.

`GET /os/semanto/{id}/writeback/runs?cursor=` (any role) answers 20 runs a page, newest first (`created_by` names who sent the run, the workspace email or name as Recent changes shows it, never an internal user id): `{ "object": "semanto.writeback_runs", "runs": [{ "run_id", "created_at", "created_by", "counts": { "queued", "sending", "retrying", "sent", "failed" }, "items": [{ "item_id", "connector", "state" }] }], "next_cursor" }`.

`GET /os/semanto/{id}/writeback/runs/{run_id}` (any role) answers `{ "object": "semanto.writeback_run", "run_id", "created_at", "created_by", "counts", "items": [{ "item_id", "connector", "target", "dry_run", "state": "queued" | "sending" | "sent" | "failed" | "retrying", "attempts", "last_error", "sent_at" }] }`.

`POST /os/semanto/{id}/writeback/runs/{run_id}/retry` (owner or admin, os_write, audit `writeback.retry`) takes `{ "item_ids" }`, failed items only, or no `item_ids` for every failed item of the run; each is taken back to queued in one conditional write (two retries at once queue it once), queued again, and the run is answered (202). A run with no failed item is a 409.

## 4. Seller lists

The payload: `{ "trooth_id", "version", "issued_at", "sellers": [{ "seller_id", "name", "domain"?, "marketplace"?, "authorized_from", "authorized_until"? }] }`, 1 to 5,000 sellers, each with a domain or a marketplace.

`POST /os/semanto/{id}/sellers/lists/options` (owner or admin, os_write; custody hosted) takes `{ "draft" }` and answers the sign-options shape with `purpose: "seller_list"`, the challenge bound to this person and this exact draft.

`POST /os/semanto/{id}/sellers/lists` (owner or admin, os_write, audit `sellers.list`) takes `{ "jws" }` (custody customer: a compact JWS, typ `https://trooth.co/types/seller-list`, the payload above) or `{ "draft", "assertion" }` (custody hosted: the server signs with the hosted key after the passkey check). The key must be the company's, valid at the JWS iat and at `issued_at`; a bad signature, type or key is the 422 problem `seller_list_signature` and nothing is stored. A version that is not higher than the newest on file is a 409, also when another submission landed between the check and the insert (one conditional insert).

**Example**
```json
{ "object": "semanto.seller_list", "trooth_id": "acme", "version": 2, "state": "valid", "kid": "Yr3fixtureNewKid0000000000000000000000000000", "issued_at": "2026-10-23T12:00:00.000Z", "sellers": 1, "custody": "customer", "jws": "<header>.<payload>.<signature>" }
```

`GET /os/semanto/{id}/sellers/lists` (any role) answers `{ "object": "semanto.seller_lists", "next_version", "lists": [{ "version", "issued_at", "state": "valid" | "superseded" | "invalid", "sellers_count", "received_at", "kid", "reason", "custody" }] }`, the state computed now (a key revoked back to before `issued_at` makes a list invalid).

`GET /public/semanto/{id}/sellers` (public, read group) reads the newest valid list only: without a query it answers `{ "object": "semanto.seller_list", "version", "issued_at", "kid", "jws", "sellers" }`; with `domain` (the sku is optional) `{ "object": "semanto.seller_authorization", "state": "authorized" | "not_listed" | "expired", "seller_id"?, "list_version", "brand_trooth_id", "seller_domain", "checked_at" }`. A company that never published a list keeps the attestation answer of src/commerce/sellers.ts.

## 5. Recalls and recall events to worker-f

A company stores a recall notice here (added by the backend review: before it, no route stored a recall, so none reached the feed):

`POST /os/semanto/{id}/recalls/options` (owner or admin, os_write; custody hosted) takes `{ "notice" }` (src/commerce/recalls.ts: `skus` or `gtins`, `issued_at`, `action`, `statement`, `url`, `authority`?, `lots`?, `closed_at`?) and answers the sign-options shape with `purpose: "recall"`, the challenge bound to this person and this exact notice. A notice that does not pass the checks is a 400 with `issues`.

`POST /os/semanto/{id}/recalls` (owner or admin, os_write, audit `recalls.publish`; domain proven) takes `{ "jws" }` (custody customer: the notice signed with the company's key, typ `https://trooth.co/types/recall-notice`; sign with iat set to the time you sign) or `{ "notice", "assertion" }` (custody hosted: the hosted key signs after the passkey check). A JWS that does not check out is the 422 problem `signature_invalid` and nothing is stored. It answers 201 (200 for a notice already stored) `{ "object": "semanto.recall", "recall_id", "issued_at", "action", "statement", "url", "skus"?, "gtins"?, "lots"?, "authority"?, "closed_at"?, "kid", "jws", "event": { "event_id", "state": "queued" | "sent" | "failed", "attempts", "last_error", "sent_at" } | null }`; `event` says whether it reached worker-f's changes feed and why not.

`GET /os/semanto/{id}/recalls` (any role) answers `{ "object": "semanto.recalls", "recalls": [ the same rows, newest first ] }`.

When a recall is stored or changed through the commerce store (src/os/recalls.ts withRecallEvents), the Worker posts `https://os/internal/semanto/recall-events` through the TROOTH_OS binding with `Trooth-Event-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` (secret SEMANTO_EVENTS_SECRET, five-minute tolerance at worker-f).

**Example** (the body)
```json
{ "event_id": "<64 lowercase hex: sha256 of trooth_id, recall_id and the notice's content hash>", "trooth_id": "acme", "os_company_id": "co-acme", "domain": "acme.com",
  "recall": { "recall_id": "smn_fixture", "product_record_id": "smk_fixture", "gtin": "00012345678905", "title": "Stop using the Acme Anvil.", "remedy": "Stop using it.", "published_at": "2026-10-23T10:00:00.000Z", "source_url": "https://www.cpsc.gov/Recalls/fixture", "provenance": "public_record" },
  "emitted_at": "2026-10-23T12:00:00.000Z" }
```

The event is stored once by its id (a repeat is a no-op). A 2xx is delivered; a 429, a 5xx or no answer queues `{ "kind": "recall_event", "trooth_id", "event_id" }` and retries the same body after 30, 120 and 600 seconds; another 4xx is final. A recall worker-f could not file (no matching product record, no workspace, no proven domain) is kept as a failed event with the reason and not sent; when the same recall is stored again (after the record arrives, or after a failed send), the failed event takes the body and is sent.

## 6. C2PA credentials

A build queues `{ "kind": "credential", "trooth_id", "asset_url", "source": "compile", "version" }` for each image and PDF in its documents tier and each image and PDF its signed pages link on the company's own site (at most 200 a version); a write-back send queues one with `"source": "writeback"` for each image link Google received. The job builds the c2pa-rs manifest definition (src/c2pa/bridge.ts), stores `{ "object": "semanto.c2pa_manifest", "sha256", "asset_url", "manifest", "signing_note" }` in R2 under `credentials/{trooth_id}/{sha256}.c2pa`, and records the row: `made`, `failed` (the asset could not be read) or `skipped` (not an image or PDF).

`GET /os/semanto/{id}/credentials?state=&cursor=` (any role) answers 50 rows a page: `{ "object": "semanto.credentials", "rows": [{ "asset_url", "sha256", "kind", "source", "state", "reason", "made_at", "manifest_url"? }], "totals": { "made", "failed", "skipped" }, "next_cursor" }`.

`GET /public/semanto/{id}/credentials/{sha256}` (public, read group; 64 lowercase hex) serves the stored manifest, signed, for a company whose domain is proven; anything else is a 404 problem.

## Additions from the backend review (23 October 2026)

Additive members, no shape removed: `interval` (seconds between polls, RFC 8628 section 3.2) on the connect session's create answer and on a pending poll; `advice` (what to do next) on the connector test; `resend_available_at` on each pending alert address; `next_version` on the seller lists; `counts` on write-back runs; `dns_record` on a started rotation. Approve or deny of a connect session already decided the same way for the same company answers the same decision (200). A connector revoke sent twice answers the same revocation and audits once. Adding a signing passkey (`passkeys.add`), signing a version (`versions.sign`, or `versions.approve` while a second officer is awaited) and withdrawing one (`versions.withdraw`) append audit rows and pass os_write. The alert confirmation link answers `reason=link_invalid` for a link that never was or was used or replaced, and `reason=link_expired` only for one past its 24 hours. `POST /public/semanto/connect/uninstall` is limited per key id and client address.

## Problem codes added

| code | status | when |
| --- | --- | --- |
| `settings_invalid` | 422 | a settings save whose settings do not work together; `issues` beside the problem |
| `seller_list_signature` | 422 | a seller list whose signature, type or key does not check out |
| `connect_session_not_found` | 404 | an unknown connect session on the approve page or approve and deny |
| `connect_session_expired` | 410 | a connect session past its 15 minutes |
| `connect_session_withdrawn` | 409 | approve or deny on a connect session the app withdrew |
| `not_registered` | 404 | an uninstall signed by a connector key Trooth never registered; when a pending connect request offered that key and the signature checks out against it, the request becomes `withdrawn` |
