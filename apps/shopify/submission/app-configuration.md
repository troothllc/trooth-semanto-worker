# Semanto by Trooth for Shopify: app configuration

Every value the Partner Dashboard (now the Dev Dashboard, dev.shopify.com), `shopify.app.toml` and the Cloudflare Worker need. Secrets are named, never written down.

## App identity

| Field | Value | Where |
| --- | --- | --- |
| App name | Semanto by Trooth | Dev Dashboard, `shopify.app.toml` `name` (must match the listing name, requirement 4.1.1) |
| Handle | `semanto-by-trooth` | `shopify.app.toml` `handle`, Worker var `SHOPIFY_APP_HANDLE` |
| Distribution | Public, Shopify App Store | Dev Dashboard, Distribution |
| Client id (API key) | from the Dev Dashboard | `shopify.app.toml` `client_id` (written by `shopify app config link`), Worker var `SHOPIFY_API_KEY` |
| Client secret | from the Dev Dashboard | Worker secret `SHOPIFY_API_SECRET` (`wrangler secret put SHOPIFY_API_SECRET`) |
| App URL | `https://shopify.trooth.co/app` | `shopify.app.toml` `application_url` |
| Allowed redirection URL | `https://shopify.trooth.co/auth/callback` | `shopify.app.toml` `[auth] redirect_urls` (kept for the library; managed installation does not redirect) |
| Embedded | yes | `shopify.app.toml` `embedded = true` |
| App icon | 1200 x 1200 px, the Trooth mark on its own; no text, no pricing | Dev Dashboard, App icon |
| Emergency developer contact | an on-call Trooth engineer's email and phone | Partner Dashboard, Settings (requirement 4.5.6) |
| Privacy policy | `https://trooth.co/privacy` | Listing, Privacy policy URL |
| Terms | `https://trooth.co/terms` | Listing |
| Support | `support@trooth.co`, `https://trooth.co/contact` | Listing, Support |
| Data processing addendum | `https://trooth.co/dpa` | Listing, Data protection details |

## Installation and auth

- Managed installation: `[access_scopes] scopes = "read_products"`, `use_legacy_install_flow = false`. Shopify shows the scope and installs the app before it loads; there is no OAuth redirect.
- Token exchange: the embedded app sends the App Bridge session token; `@shopify/shopify-app-react-router` trades it for an offline access token. Expiring offline tokens are on (`future.expiringOfflineAccessTokens`), refreshed by the library.
- Sessions: Cloudflare D1, table `shopify_sessions`, sealed with AES-256-GCM (`app/lib/session-storage.server.ts`).

## Access scopes, each justified

| Scope | Asked | Why |
| --- | --- | --- |
| `read_products` | yes | Reads products, variants, prices and availability for the catalog the app sends to Trooth; needed for the `products/*` webhooks and the bulk operation that reads the catalog once at connect. |
| `read_themes` | no | The app embed's state is read with App Bridge `shopify.app.extensions()`, which needs no scope. The app never reads or writes theme files. |
| `read_inventory` | no | Stock is sent as in stock or out of stock from `availableForSale`; no inventory count is sent. |
| `write_products`, `write_themes` | no | The app changes nothing in the store. The embed's Trooth ID is written to app-owned metafields on the app installation, which needs no scope. |
| customers, orders | no | The app never reads customers, orders or addresses. |

## Webhooks (all declared in `shopify.app.toml`, API version 2026-10, URI `/webhooks`)

| Topic | What the app does |
| --- | --- |
| `app/uninstalled` | Queues removal: revokes the shop's connector key at Trooth (`POST /public/semanto/connect/uninstall`, signed with that key) and deletes every row for the shop. |
| `products/create`, `products/update` | Queues the product: reads it with GraphQL, sends it signed when what Trooth would receive changed. |
| `products/delete` | Queues the product: sends it once as discontinued, then forgets it. |
| `bulk_operations/finish` | Queues the first sync's or Sync now's result: downloads the JSONL, sends the catalog in parts under 4 MB. |
| `customers/data_request`, `customers/redact` | Compliance: HMAC checked, 200, nothing to return or delete (see privacy-and-data.md). |
| `shop/redact` | Compliance: HMAC checked, 200, every row for the shop deleted (and the key revoked if still held). |

Every request is checked with `X-Shopify-Hmac-Sha256` (HMAC-SHA256 of the raw body, client secret, constant-time comparison) before anything else; a mismatch answers 401.

## Theme app extension

| Field | Value |
| --- | --- |
| Folder | `extensions/trooth-head-tag` |
| Extension handle | `trooth-head-tag` |
| Block | `blocks/trooth-head.liquid`, an app embed, `target: head`, no settings |
| Activation deep link | `https://{shop}/admin/themes/current/editor?context=apps&activateAppId={SHOPIFY_API_KEY}/trooth-head` |
| Values it reads | `app.metafields.trooth.trooth_id`, `app.metafields.trooth.api_base` (app-owned metafields on the app installation, written at connect, removed at Disconnect) |

## Cloudflare Worker (`wrangler.toml`)

| Name | Kind | Value |
| --- | --- | --- |
| `DB` | D1 binding | database `trooth-shopify-app`; set `database_id` after `wrangler d1 create trooth-shopify-app`; migrations in `migrations/`, down files in `migrations-down/` |
| `SYNC_QUEUE` | Queue producer and consumer | queue `trooth-shopify-sync`, dead letter queue `trooth-shopify-sync-dlq`, `max_retries = 3` (retries after 30, 120, 600 seconds) |
| `SHOPIFY_API_KEY` | var | the client id |
| `SHOPIFY_API_SECRET` | secret | the client secret |
| `SHOPIFY_APP_URL` | var | `https://shopify.trooth.co` |
| `SHOPIFY_APP_HANDLE` | var | `semanto-by-trooth` |
| `SCOPES` | var | `read_products` |
| `TROOTH_API_BASE` | var | `https://api.trooth.co` |
| `TROOTH_DASHBOARD_URL` | var | `https://trooth.co/dashboard/semanto` (approve addresses must be on this origin) |
| `APP_SEAL_KEY` | secret | 32 random bytes, base64 (`openssl rand -base64 32`); seals sessions, the shop keys and poll tokens |

No cron trigger, no Postgres, no Hyperdrive.

## Commands

```
cd apps/shopify
npm install
wrangler d1 create trooth-shopify-app            # put the id in wrangler.toml
wrangler queues create trooth-shopify-sync
wrangler queues create trooth-shopify-sync-dlq
npm run db:migrate
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put APP_SEAL_KEY
npm run deploy:worker                             # builds and deploys the Worker
shopify app config link                           # writes client_id
npm run deploy:app                                # pushes shopify.app.toml and the theme app extension
```

For local development, `shopify app dev` runs the Vite dev server with the Cloudflare plugin (the Worker runtime) behind the CLI tunnel; put the secrets in `.dev.vars`.
