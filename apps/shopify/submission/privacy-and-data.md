# Semanto by Trooth for Shopify: privacy and data

## What the app reads from Shopify

Products only, through the one scope it asks for, `read_products`:

- product id, title, handle, status, description, online store address, last update time;
- each variant's id, title, SKU, barcode (sent as the GTIN), price, compare-at price, whether it is available for sale, and its option names and values;
- the shop's name, primary domain, currency and myshopify domain.

It never reads customers, orders, addresses, checkouts, payment details, staff accounts or inventory counts. It has no scope that would allow it.

## What the app sends to Trooth

The catalog document above (one per sync part or per changed product), signed with the store's own Ed25519 key, to `POST https://api.trooth.co/os/semanto/{trooth_id}/commerce/catalog`. Trooth records each product as declared by the company (provenance word `declared`) and, for a company whose key Trooth holds, signs it. The connect session sends the store's public key and myshopify domain. Uninstall and Disconnect send the store's key id to revoke it.

## What the app stores (Cloudflare D1, database `trooth-shopify-app`)

| Table | Holds | Personal data |
| --- | --- | --- |
| `shopify_sessions` | the offline access session Shopify issues, sealed (AES-256-GCM) | the staff member's details only if an online session were used; the app uses offline sessions only |
| `shops` | connection state, Trooth ID, the store's public key and its private key (sealed), the pending connect session's poll token (sealed), embed state, last sync time | none |
| `sync_runs` | each sync's steps, counts and errors (newest 20 per shop) | none |
| `products` | the last catalog entry sent per product and its hash | none |
| `webhook_events` | Shopify delivery ids for seven days, to handle each delivery once | none |
| `app_events` | the shop's own activity list (connected, synced, disconnected) | none |

No customer personal data is held anywhere, at any time.

## Compliance webhooks (declared in `shopify.app.toml`, handled in `app/lib/webhooks.server.ts`)

Every delivery is checked first: `X-Shopify-Hmac-Sha256` must equal the base64 HMAC-SHA256 of the raw body under the app's client secret, compared in constant time. A missing or wrong HMAC answers `401 Unauthorized` and nothing else happens. After the check:

| Topic | Answer | Action |
| --- | --- | --- |
| `customers/data_request` | 200 | None needed: the app holds no data about any customer, so there is nothing to give the merchant. The payload (which carries the customer's email and phone) is not stored; only the delivery id, shop and topic are kept for seven days to handle repeats. |
| `customers/redact` | 200 | None needed, for the same reason. The payload is not stored. |
| `shop/redact` | 200 | Every row for the shop is deleted from every table, in one transaction, through the queue (the store's connector key is revoked at Trooth first if one is still held). Shopify sends this 48 hours after uninstall; the app has usually deleted everything at `app/uninstalled` already, and the second deletion is harmless. |

Each is completed at once, well inside Shopify's 30-day limit.

## Uninstall

`app/uninstalled` queues the same removal: the connector key is revoked at Trooth (signed with that key, so only this store can revoke it), then every row for the shop is deleted, sessions included. If Trooth cannot be reached, the queue retries after 30, 120 and 600 seconds; on the last attempt the rows are deleted anyway, and with them the only copy of the private key, so nothing can sign for the store again. Shopify removes the app embed with the app; no theme file was ever changed.

## An unfinished connection leaves nothing behind

A pending connection holds a key Trooth has not registered. Before it is removed it is offered to Trooth for revocation (Trooth answers 404 not registered, or revokes it if an approval raced the expiry). It is removed when the request is declined, when it expires (15 minutes) and the Connect screen or any later read of the shop settles it, when the merchant presses Connect again after expiry, and on uninstall. An approval that arrives after the merchant left the screen is kept the next time the app opens, not orphaned. `test/service.test.ts` ("abandoned installs leave nothing behind") proves each case.

## Data subject requests about merchants

A merchant's request about data Trooth holds for their company goes to `privacy@trooth.co` and is handled under `https://trooth.co/privacy`. The data processing addendum is at `https://trooth.co/dpa`; subprocessors (Cloudflare among them) are listed at `https://trooth.co/subprocessors`.
