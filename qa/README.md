<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# The Semanto QA stack and walk

Everything the QA pass of 23 October 2026 ran (docs/program/reports/qa.md), so it can be run again. All of it is on loopback; nothing reaches a production system, a real provider or a real account.

## What runs

`qa/stack.mjs` brings up, on ports 47100 to 47123 (move them with `QA_BASE_PORT`):

| Part | What it is |
| --- | --- |
| Semanto Worker | this repository's `src`, bundled by its own wrangler (`wrangler deploy --dry-run`) and run by workerd through Miniflare 5: D1 with `migrations/0001` to `0009` applied in order, R2, KV, the compile queue with its consumer (batch 1, three retries, the dead letter queue), the NonceDO, LogDO and RateLimitDO Durable Objects (SQLite), a witness key made for the run, `HOSTED_KEY_SEAL_SECRET`, `RECEIPT_IP_SALT_SECRET`, `SEMANTO_EVENTS_SECRET`, the Google OAuth client, `RESEND_API_KEY`, `WEBAUTHN_RP_ID=localhost`, `DEV_UPSTREAM_BASE` and `DEV_DASHBOARD_BASE` (src/dev-upstream.ts, development only). State persists under `qa/.run/state` for the life of the run. |
| worker-f | `../trooth-os-worker-f` bundled and run the same way, with its numbered migrations and `migrations/derived-schema.sql`, the same `SEMANTO_EVENTS_SECRET`, and an agent API key bound to a DPoP key the control server holds (for `GET /v1/facts/changes`). |
| TROOTH_OS stand-in | the Worker's binding goes to a function in `qa/stack.mjs`: `GET /auth/session` and `GET /auth/domain-claims` for the people in `qa/personas.mjs` (owner, admin, member, viewer, a teammate without a role, an owner on a two-day-old sign-in, an unconfirmed address, another company's owner), and `POST /internal/semanto/recall-events` forwarded to worker-f at `https://os/internal/semanto/recall-events`. |
| api front | the route table of api.trooth.co on 47100: `/os/semanto/*` and `/public/semanto/*` to the Semanto Worker, everything else to the stand-in. It can be put down or made slow (`POST /mode {"front":"down"|"slow"|"up"}`). |
| trooth-web | its own journeys stack (`scripts/journeys/stack.mjs`): a throwaway PostgreSQL 16 with every file in `db/APPLY_ORDER.txt`, the SQL-over-HTTP server, the Resend capture, `next start` on the production build in `TROOTH_WEB_DIR` (default `../trooth-web`; build it first with `SEMANTO_DASHBOARD` set to true in `lib/launch-config.ts`), and `preload.mjs`, which sends `https://api.trooth.co` to the api front and refuses every other host that is not loopback. The website signs a person in with a `trooth_session` cookie holding a persona token, as its journeys do. The dashboard is at `http://localhost:47120` (a host name, so a passkey's relying party is `localhost`). |
| doubles | `qa/doubles.mjs`: Google (token, revoke, Merchant API accounts and product inputs, Business Profile accounts, locations and patches, and the consent page the walk routes `accounts.google.com` to), Resend (every email captured), DNS over HTTPS, the company sites `acmegoods-qa.com` and `globex-qa.com` (pages, robots, sitemap, an image and a PDF), and trooth.co's profile reads for worker-f's MCP tool. Once the walk "installs" Semanto, the repository's own adapter (`adapters/shared/semanto-adapter.mjs`) answers in front of the site. |
| Shopify app | `qa/shopify-app.mts`: `apps/shopify`'s own `ShopService`, `TroothClient`, store and job runner against the live Worker, Shopify mocked by `apps/shopify/test/fixtures/mock-shopify.ts`, the app's D1 on Node's SQLite. The walk starts it. |

The control server (port 47102) switches modes and reads what the parts hold: `/mode`, `/emails`, `/upstream`, `/outbound`, `/dns`, `/install`, `/directory`, `/d1`, `/pg`, `/feed/rest`, `/feed/mcp`, `/replay-recall`, `/worker/fetch`, `/site-seen`.

## Running it

```
cd ../trooth-web && (set SEMANTO_DASHBOARD = true in lib/launch-config.ts) && npx next build
cd ../trooth-semanto-worker
qa/run.sh start                      # the stack; qa/run.sh stop
qa/walk.sh start W3-83-semanto-qa dark          # a fresh stack, then the full walk
qa/walk.sh start W3-83-semanto-qa-light light
qa/walk.sh status
```

The walk (`qa/walk/walk.mjs`, sections in `qa/walk/*.mjs`) uses Playwright Chromium from `/opt/pw-browsers` and axe-core from trooth-web's own install. It writes a screenshot per state and `walk.json` (states, axe results, keyboard walks, findings, the expected 4xx answers of the unhappy paths) to `qa/.run/walk-<run id>/`, and exits 1 on any finding: a console error, a page error, a failed request, an unexpected HTTP error, an axe violation, a keyboard walk that misses a control or shows no focus ring, or anything a step expected and did not see. `QA_ONLY=<section,section>` runs some sections against the stack as it stands. A fresh stack keeps earlier walks' records; the workers' own console output is in `qa/.stack-out.log`, which the security section searches with the other logs. axe-core runs the WCAG 2.0, 2.1 and 2.2 A and AA rules and Label in Name (2.5.3) on every state. `qa/recall-notice.mts` builds a recall notice the way the Worker does, for the customer-held upload.

To record two clean runs in trooth-web's `docs/writing/W3-BROWSER-RECORD.json`: `node qa/record.mjs W3-83-semanto-qa W3-83-semanto-qa-light` (it refuses a run with any finding), then trooth-web's generators.

Set `SEMANTO_DASHBOARD` back to false in trooth-web when done.
