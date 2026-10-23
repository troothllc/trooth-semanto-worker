# Item 7: the Shopify app (Semanto by Trooth for Shopify)

Area: `trooth-semanto-worker/apps/shopify`, its own package, tests and submission package. Nothing outside `apps/shopify` was edited; nothing was committed or pushed.

## What was built

An embedded Shopify app on Shopify's current stack, running on Cloudflare Workers:

- **Install and auth.** Managed installation (scopes declared in `shopify.app.toml`, `use_legacy_install_flow = false`) and token exchange through `@shopify/shopify-app-react-router` with expiring offline tokens. Sessions in D1, sealed with AES-256-GCM. No Postgres, no cron.
- **Onboarding**, five steps: Welcome (what the app does in plain words), Connect to Trooth, Turn on the app embed, First sync, Done (link to the Semanto dashboard). Each step has loading, empty, error and success states. Polaris web components only.
- **Connect to Trooth** (contract 1d): the app server makes an Ed25519 key per shop, opens a connect session with the public half, the screen opens `approve_url` in a new top-level window from the click, then checks the session every 2 seconds only while the Connect screen is open, and stops at expiry (one last check at expiry settles the session). On approval the app writes the Trooth ID to app-owned installation metafields (read by the embed) and starts the first sync.
- **App embed**: theme app extension `extensions/trooth-head-tag`, block `trooth-head` (target head) adding the two site-wide tags of `adapters/head-tag` with the shop's Trooth ID. The step deep-links to the theme editor with `activateAppId={client_id}/trooth-head` and reads the embed state back with App Bridge `shopify.app.extensions()` (no themes scope), rechecking when the merchant returns to the tab. Skip for now is offered.
- **Catalog sync**: first sync and Sync now run one Admin GraphQL bulk operation; the `bulk_operations/finish` webhook queues the work; the JSONL is streamed, mapped to the catalog shape the Worker's `commerce/catalog` route reads, and posted in parts under 4 MB, each signed with the shop's key. `products/create`, `products/update` and `products/delete` webhooks send incremental updates (unchanged products are skipped by a hash; deleted or drafted products are sent once as discontinued). Retries with exponential backoff and full jitter on 429 and 5xx, a fresh signature and nonce each attempt; the queue retries jobs after 30, 120, 600 seconds and settles them on the last attempt.
- **Settings**: connection state, Trooth ID, key id, last sync with per-step status, Sync now, app embed state, recent activity, Disconnect behind an `s-modal` confirmation.
- **Uninstall and compliance**: every webhook checked with `X-Shopify-Hmac-Sha256` first (401 otherwise), each delivery handled once. `app/uninstalled` and `shop/redact` revoke the key at Trooth (signed with it) and delete every row for the shop. `customers/data_request` and `customers/redact` answer 200: the app holds no customer personal data.
- **Abandoned installs leave nothing**: a pending key is removed on denial, on expiry (settled on the Connect screen or on the next read of the shop, no sweep), on Connect after expiry, on Disconnect and on uninstall; before removal it is offered to Trooth for revocation, so an approval that raced the expiry is never left registered without its private half; an approval that landed after the merchant left is kept on the next open.

## Files (all new, under `apps/shopify`)

- Package and config: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `react-router.config.ts`, `vitest.config.ts`, `wrangler.toml`, `shopify.app.toml`, `.gitignore`
- Worker entry: `workers/app.ts`, `app/worker.server.ts` (fetch: `/webhooks` then React Router; queue consumer)
- React Router app: `app/root.tsx`, `app/entry.server.tsx`, `app/routes.ts`, `app/routes/_index.tsx`, `app/routes/auth.$.tsx`, `app/routes/app.tsx`, `app/routes/app._index.tsx` (onboarding and status home), `app/routes/app.settings.tsx`, `app/routes/app.connect.tsx`, `app/routes/app.sync.tsx`, `app/routes/app.embed.tsx`, `app/components/api.ts`, `app/components/sync-steps.tsx`
- Server modules: `app/shopify.server.ts`, `app/context.server.ts`, `app/lib/env.ts`, `app/lib/seal.ts`, `app/lib/sign.ts` (re-exports the repository's one connector signer, `adapters/shared/sign-request.mjs`), `app/lib/retry.ts`, `app/lib/trooth-client.ts`, `app/lib/mapping.ts`, `app/lib/bulk.ts`, `app/lib/shopify-admin.ts`, `app/lib/store.server.ts`, `app/lib/session-storage.server.ts`, `app/lib/onboarding.ts` (the state machine), `app/lib/service.server.ts`, `app/lib/webhooks.server.ts`, `app/lib/jobs.server.ts`, `app/lib/http.server.ts`
- Theme app extension: `extensions/trooth-head-tag/shopify.extension.toml`, `extensions/trooth-head-tag/blocks/trooth-head.liquid`
- Migrations: `migrations/0001_shopify_app.sql`, down file `migrations-down/0001_shopify_app.down.sql` (the app's own D1 database `trooth-shopify-app`; no Neon change)
- Tests: `test/sign.test.ts`, `test/hmac.test.ts`, `test/mapping.test.ts`, `test/onboarding.test.ts`, `test/webhooks.test.ts`, `test/service.test.ts`, `test/storage.test.ts`, `test/config.test.ts`, `test/house-rules.test.ts`, `test/e2e.test.ts`, `test/worker-contract.test.ts`; fixtures `test/fixtures/d1.ts`, `test/fixtures/mock-shopify.ts`, `test/fixtures/mock-trooth.ts`, `test/fixtures/harness.ts`
- Submission package: `submission/app-configuration.md`, `submission/listing-copy.md`, `submission/screenshots.md`, `submission/submission-checklist.md`, `submission/privacy-and-data.md`
- This report: `docs/program/reports/shopify-app.md`

## Stack and versions (pinned)

Shopify's React Router template stack (github.com/Shopify/shopify-app-template-react-router), moved from Node and Prisma to Workers and D1: `react-router` 7.18.2, `@react-router/dev` 7.18.2, `@shopify/shopify-app-react-router` 3.0.2 (with `@shopify/shopify-api` 15.0.1 and its Cloudflare Worker adapter), `@shopify/shopify-app-session-storage` 7.0.1 (interface implemented on D1), `@shopify/app-bridge-react` 4.2.14, Polaris web components through `AppProvider` (types `@shopify/polaris-types` 1.1.0), React 18.3.1, Vite 7.3.1 with `@cloudflare/vite-plugin` 1.64.0, Wrangler 4.152.0, TypeScript 5.9.3, Vitest 3.2.7, `@cloudflare/workers-types` 5.20261019.1. Admin API and webhooks version 2026-10. Node 22.12 or newer for development (the template's engine).

## Decisions

- **Scopes**: `read_products` only. Embed state comes from App Bridge (no `read_themes`); embed values live in app-owned installation metafields (no write scope); stock comes from `availableForSale` (no `read_inventory`; the catalog's stock count is optional, so none is sent).
- **Billing**: the Billing API is not used because the app charges nothing, in Shopify or elsewhere: no plan, upsell or payment link, no feature gated on payment. Semanto Basic is free (`src/basic/tier.ts`) and the repository states no Semanto price. This complies with requirement 1.2.1; Shopify staff guidance (community.shopify.dev, "Billing requirement 1.2") is that any paid path tied to an App Store app must be Shopify-billed, so a future charge would go through Managed Pricing first (written into `submission/submission-checklist.md`).
- **Design system**: the founder brief's rule 3 (trooth-web's design system) governs trooth-web; this item's brief requires Polaris web components only, which is also what Shopify requires of embedded apps (Built for Shopify 4.1.1). The app has no stylesheet or component library of its own (checked in `test/house-rules.test.ts`).
- **Queue, not cron**: one Cloudflare Queue for slow work; no scheduled handler. Progress is read from Shopify only while a merchant's screen asks.
- **Signing**: the app imports `adapters/shared/sign-request.mjs` rather than copying it; `test/sign.test.ts` proves its Signature-Input and Signature bytes equal the Worker's `signMessage` output for the same inputs and that `verifyMessage` and `verifyContentDigest` from `src/core/httpsig.ts` accept them with the catalog handler's options.
- **No User-Agent switch**: the template's `isbot` streaming choice was replaced by waiting for all content for every reader (house rule 3).

## Reference products, per workflow

| Workflow | Reference apps and sources | What was taken |
| --- | --- | --- |
| Connect an outside account | Klaviyo for Shopify (help.klaviyo.com, "Getting started with Shopify"): approve on the service, return to the integration page, confirm; GitHub device flow and Stripe CLI login (the contract's pattern) | Approval on the service's own site, the app moves on by itself, no credential typed into Shopify |
| Turn on the app embed | Klaviyo (notice that the embed is off, Turn on, theme editor App embeds tab, Save, green banner on return); GP JSON-LD Schema (gropulse.com, "Getting started": Activation Status, Activate opens the customizer); ShopRank AI by Zipify (help.zipify.com: App Embed Status On or Off, link to the theme editor, rechecks automatically) | Status badge, Turn on button with the deep link, automatic recheck on return, Skip for now |
| First sync with progress | Klaviyo's Historical data section; JSON-LD for SEO, Schema Ninja, SEO Schema Pro and JSON-LD Express listings (apps.shopify.com) for the category's dashboard order | A status per step, then a status home page |
| Onboarding order and home page | Shopify's React Router template; Built for Shopify 4.2.2 and 4.2.3 | Setup guide that gives way to a status home page |
| Disconnect | Klaviyo and Shopify's own disconnect flows; Built for Shopify 3.1.5 and 4.1.6 | Disconnect inside the app, confirmed in a modal that says what happens |
| Compliance and HMAC | shopify.dev, "Privacy law compliance" (mandatory webhooks); community.shopify.dev threads on the automated HMAC check | 401 on a bad HMAC, 200 and the documented action for each topic |
| Listing and review | shopify.dev, "App Store requirements" and "Built for Shopify requirements"; shopify.dev changelog "Clearer standards for app listing images" (enforced 26 March 2026); dev.to "Shopify App Store submission: 14 things" (asset sizes, field limits) | The checklist, screenshot list and copy limits |

One page could not be read during research (the permission prompt timed out): the first request for shopify.dev's theme app extension configuration and privacy compliance pages; both were then read through search results.

## Env names (no values)

Worker vars: `SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`, `SHOPIFY_APP_HANDLE`, `SCOPES`, `TROOTH_API_BASE`, `TROOTH_DASHBOARD_URL`. Worker secrets: `SHOPIFY_API_SECRET`, `APP_SEAL_KEY`. Bindings: `DB` (D1 `trooth-shopify-app`), `SYNC_QUEUE` (queue `trooth-shopify-sync`, dead letter queue `trooth-shopify-sync-dlq`). No env var was added to the Semanto Worker, trooth-web or worker-f.

## Worker dependencies (for the Worker engineer and the coordinator)

1. **Routes used, as built in `src/os/connectors.ts` and `src/serve/os-routes.ts`**: `POST /public/semanto/connect/sessions`, `GET /public/semanto/connect/sessions/{id}`, `POST /public/semanto/connect/uninstall`, `POST /os/semanto/{id}/commerce/catalog`. `test/worker-contract.test.ts` runs the app's client against them through the Worker's own test world and passes.
2. **Applied by the Worker engineer after the first report** (docs/program/reports/worker-backend.md): `public_connect` counts only `POST connect/sessions` per address, polls are limited per session id and uninstall per kid; uninstall answers 404 `not_registered`, 401 for a bad signature, 403 for a key no app install created; `reason` takes `uninstalled`, `disconnected` or `shop_redact`; a product sent with `stock_status: "discontinued"` removes every offer for its sku and is listed in the receipt's `removed`. The app now follows each: it sends `shop_redact` on shop/redact, `disconnected` on Disconnect and on clearing an unfinished connection, and `uninstalled` on uninstall; it records 404 as "never registered, nothing to revoke" (activity `key_not_registered`) and treats 401 and 403 as a refusal (`RevokeRefused`): on Disconnect the connection is kept and Settings shows a critical "Trooth still holds this store's key" banner with the answer, the activity list shows "Trooth refused to revoke the store key"; on uninstall and shop/redact the rows are still deleted and the refusal is logged as an error. Removed skus are counted in Trooth's receipt step. A poll answering 429 still keeps the screen waiting.
3. **Approve page**: trooth-web must serve `https://trooth.co/dashboard/semanto/connect/{session_id}` and, after approval, send the merchant to the session's `return_url`, which the app sets to `https://{shop}/admin/apps/semanto-by-trooth`.

## Tests and results

Run in `apps/shopify`:

- `npm test` (vitest): 11 files, 118 tests, all passing. Signing byte for byte against the Worker's checker; HMAC against node:crypto; mapping and the Worker's `catalogToInputs`; bulk JSONL streaming and late variants; the onboarding state machine and polling rule; the webhook endpoint (401, dedupe, compliance, jobs); the service (connect, seven abandoned-install cases, the approval race, rate-limited polls, revocation outcomes told apart (404 versus 401 and 403), first sync, Sync now, discontinued products, retries and queue exhaustion, unsigned receipts, Shopify throttling, incremental updates, Disconnect, uninstall, shop/redact); sealing, D1 session storage and backoff; configuration (scopes, webhooks, no cron, embed schema and limits, listing field limits); house rules across the package; end to end through the Worker's fetch and queue handlers with the real loaders, actions and token exchange; and the real Worker's connect routes (including the 404, 403 and discontinued-removes-offers behaviour).
- `npm run typecheck` (`react-router typegen && tsc --noEmit`): clean.
- `npm run build` (`react-router build`, Vite with the Cloudflare plugin): clean; `wrangler deploy --dry-run` bundles 743 KiB (169 KiB gzip). The built Worker was also run in local workerd (`wrangler dev`): a bad HMAC answered 401, a signed `customers/data_request` answered 200 against a local D1 with the migration applied, and its repeat answered as already handled.

## To publish (for the founder)

```
cd apps/shopify && npm install
wrangler d1 create trooth-shopify-app        # put its id in wrangler.toml
wrangler queues create trooth-shopify-sync && wrangler queues create trooth-shopify-sync-dlq
npm run db:migrate
wrangler secret put SHOPIFY_API_SECRET && wrangler secret put APP_SEAL_KEY
npm run deploy:worker
shopify app config link && npm run deploy:app
```
