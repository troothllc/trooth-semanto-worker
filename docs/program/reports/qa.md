# Semanto QA: the walk in a real browser against the live Worker (2026-10-23)

Item 10 of the Semanto program. Every workflow of items 1 to 8 was walked click by click in Chromium against the real Semanto Worker running locally, with worker-f behind a TROOTH_OS stand-in for the recall feeds, until a full pass in each theme had no defect, no console or page error, no failed request and no axe-core violation. Nothing was committed or pushed.

## The set-up (rerunnable)

Everything is in `qa/` and documented in `qa/README.md`.

- `qa/run.sh start` starts `qa/stack.mjs`: the Semanto Worker bundled with wrangler and run under Miniflare with D1 (migrations 0001 to 0008), R2, KV, the queue consumer and the Durable Objects; a fresh witness key, seal secret and `SEMANTO_EVENTS_SECRET` for every start; trooth-os-worker-f bundled and run the same way, with its numbered migrations and derived schema, an agent API key bound to a DPoP key for `GET /v1/facts/changes`, and the MCP endpoint for `trooth_company_changes`; a TROOTH_OS stand-in with an owner, an admin, a member, a viewer, a teammate with no role, an unconfirmed address, a two-day-old sign-in and a second company, which forwards `/internal/semanto/recall-events` to worker-f; Google and Resend stand-ins (`qa/doubles.mjs`: token, revoke, accounts, locations, product inputs and location writes with a status queue, a consent page, captured email); the company websites with an image, a missing image and a PDF; and trooth-web's production build through its own journeys stack (a throwaway Postgres 16, the neon-http shim, the preload that sends `https://api.trooth.co` to the loopback api front). People sign in with the stand-in's tokens in the `trooth_session` cookie, as trooth-web's journeys do; no production credential is used anywhere.
- The Worker's Google and Resend addresses are overridable in development only: `src/dev-upstream.ts` takes `DEV_UPSTREAM_BASE` and `DEV_DASHBOARD_BASE` only when `ENVIRONMENT` is `development` and the base is a loopback http address; in production both are ignored and the fetch is `fetch` itself (`test/qa-fixes.test.ts`, dev upstream overrides).
- `qa/walk.sh start <run id> <dark|light>` restarts the stack and runs `qa/walk/walk.mjs`: 21 sections, Playwright Chromium from `/opt/pw-browsers`, a virtual WebAuthn authenticator for the signing passkey, axe-core on every state (the WCAG 2.0, 2.1 and 2.2 A and AA rules, plus Label in Name), keyboard walks, and every console error, page error, failed request and unexpected error status recorded as a finding with the answer's body. Each walk writes `qa/.run/walk-<run id>/walk.json` and its screenshots. `node qa/record.mjs <dark> <light>` writes two clean runs into trooth-web's `docs/writing/W3-BROWSER-RECORD.json`.

## Passes

Ten full passes. W3-83-semanto-qa and its light run were first clean before the withdrawn state was added; after it, one dark pass found the same-second failure below, and the two runs were then walked again clean and their records replaced.

| Pass | Theme | States | Findings |
| --- | --- | --- | --- |
| pass1 | dark | 105 | 103 (defects QA-01 to QA-11 and walk mistakes) |
| pass2 | dark | 126 | 47 |
| pass3 | dark | 120 | 20 |
| pass4 | dark | 126 | 114 (most were one Label in Name rule newly turned on) |
| pass5 | dark | 134 | 1 (a walk timing mistake) |
| pass6 (W3-83-semanto-qa, first try with the withdrawn state) | dark | 134 | 6 (the withdrawal failed in the same second, QA-16) |
| W3-83-semanto-qa | dark | 134 | 0 |
| W3-83-semanto-qa-light | light | 134 | 0 |

Findings that were the walk's own mistakes (a locator, a race in reading the newest run, a clock the walk moved, the stand-ins' gaps) were fixed in `qa/` and are not listed as defects. The harness gaps that looked like product failures, and why they were not: the api front first forwarded to the Worker under its own port, which broke every RFC 9421 signature made for the front's address (the Shopify app's catalog, disconnect and uninstall), so the front now passes the address the caller used, as api.trooth.co's route does; the worker-f key was given the wrong permission shape, and the profile stub did not read worker-f's `q` parameter.

## Defects

Each was fixed, has a test that fails without the fix, and was re-walked in the passes after it.

### QA-01: the first hosted signature of a new company failed

- Repro: a company's first Sign with my passkey on Trooth-held custody. Under workerd the clock moves across I/O, so the new hosted key's `nbf` was read later than the signing time it was meant to cover, and the signature was refused.
- Fix: `src/pipeline.ts:579` makes the key at the signing time (`newHostedKey(trooth_id, now)`).
- Test: `test/qa-fixes.test.ts`, QA-01 (a clock that moves on every read).
- Re-walk: signed on the first try in pass2 to the last pass.

### QA-02: every dashboard reload in the same tab was a hydration error (React #418)

- Repro: open any Semanto screen, reload. The kept session answers were written into SWR's cache with `cache.set` before hydration, so the first client render differed from the server's HTML.
- Fix: trooth-web `components/dashboard/session-cache.tsx:93` writes through `mutate(key, data, { revalidate: false })`.
- Test: trooth-web `tests/semanto-qa.test.mjs`, QA-02.
- Re-walk: no page error on any reload from pass2 on.

### QA-03: the install check refused the files the repository's own adapter serves

- Repro: install the Vercel middleware from `adapters/`, press Check my site. The adapter serves the signed file at `/.well-known/trooth.semanto` and the check compared it with a pointer document, so it never passed.
- Fix: `src/pipeline.ts:1002` and `src/serve/routes.ts:760` serve and compare the signed file itself when there is one.
- Test: `test/qa-fixes.test.ts`, QA-03 (byte for byte what the adapter answers), and `test/serve.test.ts`.
- Re-walk: three of three checks passed after the install in every pass.

### QA-04: a passed install check repeated its label underneath

- Fix: trooth-web `components/dashboard/semanto/install-guide.tsx:215`.
- Test: `tests/semanto-qa.test.mjs`, QA-04. Re-walk: clean from pass2.

### QA-05: the company website field did not tell assistive technology about its error

- Fix: trooth-web `components/dashboard/semanto/install-guide.tsx:263` and `:266` (`aria-invalid`, `aria-describedby`, the error with `role="alert"`).
- Test: `tests/semanto-qa.test.mjs`, QA-05. Re-walk: clean from pass2.

### QA-06: the setup launcher covered Save and Discard on the Semanto settings screens

- Fix: trooth-web `components/dashboard/semanto/semanto-settings-ui.tsx:276` (`data-semanto-save-bar`) and `app/globals.css:9053`, the same lift the profile save bar has.
- Test: `tests/semanto-qa.test.mjs`, QA-06. Re-walk: the save bar is clear in the viewport screenshot of every pass.

### QA-07: a Worker that did not answer read as "Semanto is not switched on"

- Repro: stop the Worker (the api front refuses connections), open Signing key, or save Delivery. The read said Semanto was not switched on and the save gave no outage.
- Fix: trooth-web `lib/use-semanto.ts:55` and `:100`, `components/dashboard/semanto/reader-receipts.tsx:168`: unreachable is the offline problem, with Try again.
- Test: `tests/semanto-qa.test.mjs`, QA-07. Re-walk: the outage section in pass3 to the last pass.

### QA-08: the receipts' agent count counted unsigned readers as agents

- Fix: `src/os/receipts.ts:161` counts the agents of signed rows only.
- Test: `test/os-contract.test.ts` (agents 1). Re-walk: the receipts section from pass2.

### QA-09

Not used.

### QA-10: a member or viewer could add a signing passkey

- Fix: `src/pipeline-passkeys.ts:91` and `:109`: only an owner or admin adds one, before any challenge is stored.
- Test: `test/qa-fixes.test.ts`, QA-10; `test/webauthn.test.ts`. Re-walk: the roles section from pass2.

### QA-11: a signed-in person of a workspace with no Semanto company was told to sign in

- Repro: another company's owner opens this company's Semanto addresses. The Worker answered 401, which reads as signed out.
- Fix: `src/serve/routes.ts:817`: 403 forbidden with the reason.
- Test: `test/qa-fixes.test.ts`, QA-11; `test/audit-fixes.test.ts`. Re-walk: the roles section from pass2.

### QA-12: the session service down answered 401, as if the person had signed out

- Repro: stop worker-f's session check, read any Semanto address. `troothOsSession` folded a network error or a 5xx into "no session".
- Fix: `src/pipeline.ts:1531` and `:1533` throw `SessionUnavailable` (`src/serve/errors.ts`); `src/serve/routes.ts:825` and the claim routes answer 503 `session_unavailable`, retryable, "You do not need to sign in again".
- Test: `test/qa-fixes.test.ts`, QA-12 (the routes and the session reader). Re-walk: the outage section of pass3 to the last pass; a direct read during the outage answers 503.

### QA-13: no content credential was ever made for a build's images and PDFs

- Repro: a site whose pages link an image and a PDF; read, sign, open Content credentials: empty. The build never fills the documents tier, so the compile trigger had nothing to queue.
- Fix: `src/os/credentials.ts:69` also queues one job for each image and PDF the signed pages link on the company's own site (at most 200 a version); the job reads each once through the SSRF guard.
- Test: `test/qa-fixes.test.ts`, QA-13; `test/os-contract.test.ts` (the build's own failed row). Re-walk: made for the image and the PDF, failed for the missing image, from pass3.

### QA-14: write-back offered a change the Google connection could not send

- Repro: connect Google with Merchant Center only, open Write-back: the Business Profile change was offered, and Send answered 409.
- Fix: `src/os/writeback.ts:117`: such a change is not sendable and says why, before Send.
- Test: `test/os-contract.test.ts`, QA-14. Re-walk: from pass3.

### QA-15: an empty signed file showed the hint instead of "The file is empty."

- Fix: trooth-web `components/dashboard/semanto/seller-lists.tsx:325` and `components/dashboard/semanto/recalls.tsx:345` check a chosen file even when it is empty.
- Test: `tests/semanto-qa.test.mjs`, QA-15. Re-walk: from pass3.

### QA-16: approving after the app was uninstalled registered a key no app holds

- Repro: Connect in the Shopify app, uninstall the app before approving, then press Approve. The app's signed uninstall found no registered key and the waiting request stayed approvable.
- Fix: `src/os/connectors.ts` `withdrawPending`: a signed uninstall by the key a waiting request offered withdraws that request (the signature is checked against the request's key, the nonce is spent). The request gets its own state, `withdrawn`, never `denied`: migration `0009_connect_withdrawn.sql` (with its down file) lets the table hold it, `withdrawConnectSession` in `src/os/store.ts` and `src/db/os-d1.ts` sets it in one conditional write, the poll and `GET /os/semanto/connect/{id}` answer it (the latter with the app's checked `return_url`), and approve or deny on it answer 409 `connect_session_withdrawn` (`src/serve/errors.ts`), "The store withdrew this request (the app was removed or disconnected before it was approved). Nothing was connected." The uninstall's answer stays 404 `not_registered`, so the app's contract is unchanged. The approve page (trooth-web `components/dashboard/semanto/connect-approve.tsx`) has its own withdrawn state, "The store withdrew this request. Nothing was connected.", with Back to Semanto and Return to Shopify only when the return address passes the page's check; the Shopify app (`apps/shopify/app/lib/trooth-client.ts`) reads withdrawn as expired on its connect screen. The contract (section 1d) and `docs/spec/os-api.md` list the state.
- The first walk of the withdrawn state found the withdrawal still failing in real time: the request's key carries its `nbf` to the millisecond, and an uninstall signed in that same second (RFC 9421 `created` is whole seconds) read as signed before the key began, so nothing was withdrawn. The withdrawal proof now checks the signature against the request's key without its `nbf`.
- Tests: `test/os-contract.test.ts`, QA-16 (opened half a second into a second and withdrawn in it; a forged signature withdraws nothing; poll, approve page, approve and deny); `test/review-backend.test.ts`, migration 0009 and its down file; apps/shopify `test/worker-contract.test.ts`; trooth-web `tests/semanto-qa.test.mjs`, QA-16. Re-walk: the walk's `connect-withdrawn` state in the last two passes.

### QA-17: buttons and links whose accessible name did not hold the visible words (WCAG 2.5.3)

- Repro: speech control saying "Test connection", "Set data source", "View credential", "Send again", "View" or "Open" found nothing; the names began "Test the connection of" and "View the run of", and so on, and Resend while waiting showed "Resend at" with another name.
- Fix: trooth-web `lib/i18n/messages/en-workspace.ts` (`testLabel`, `setDataSourceLabel`, `viewCredentialFor`, `sendAgainLabel`, `openRunLabel`, new `openRunCurrentLabel` and `resendAtLabel`), `components/dashboard/semanto/company-settings.tsx:509`, `components/dashboard/semanto/writeback.tsx:365`; slices regenerated (`scripts/gen-i18n-slices.mjs`), and the locators in `scripts/qa-semanto-screens.mjs` moved with them.
- Test: `tests/semanto-qa.test.mjs`, QA-17; the walk runs axe-core's Label in Name rule on every state. The shared account button is left out of that rule: its name holds the visible name, and axe counts the avatar's decorative initial as visible text.
- Re-walk: pass5 to the last pass.

### QA-18: an uploaded recall notice without its object and id read as ready, then was refused

- Repro: upload a notice signed with the company's key but without `object` and its `smn_` id: the screen said it was ready; Publish answered 422.
- Fix: trooth-web `lib/semanto-recalls.ts:183`: the upload check names the missing id before Publish, with new words `ws.semantoRecalls.jwsNoId`.
- Test: `tests/semanto-qa.test.mjs`, QA-18; `tests/semanto-review-web.test.mjs`. Re-walk: pass4 on (the walk builds the notice as the Worker does, `qa/recall-notice.mts`).

### QA-19: write-back history named the sender by an internal user id

- Repro: send changes, read History: "Sent by u-ada" (a uuid in production).
- Fix: `src/os/writeback.ts:175` records who sent it as Recent changes names them; `docs/spec/os-api.md` says so.
- Test: `test/os-contract.test.ts`, QA-19. Re-walk: the last two passes.

### worker-f: the changes feed failed on a database no native route had touched

- Repro: a fresh database, an agent polls `GET /v1/facts/changes` for recalls: 500, no such table `native_integration_evidence`, and the recalls were lost with the facts.
- Fix: trooth-os-worker-f `src/facts.ts` `projectFacts`: no native tables means no facts, an empty projection; any other error is thrown as before.
- Test: trooth-os-worker-f `test/semanto-recall-events.test.ts`, the last block. Re-walk: both feeds from pass4.

## What the clean passes covered

Both runs, W3-83-semanto-qa (dark) and W3-83-semanto-qa-light, 134 states each on 16 addresses at 1568 by 741 and 390 by 844:

- The setup guide and its four steps: the read, review with a fact marked, Save for later, the signing passkey on a virtual authenticator, Sign, the install guide with Change host, Check my site before and after the adapter, monitoring with an invalid company, the watch report.
- Delivery, signing keys (the DNS binding, a rotation started, cancelled, confirmed, a key revoked through the typed confirmation; a customer-held rotation with the secret shown once; an expired and a revoked key), read receipts from real reads (unsigned and two Web Bot Auth agents), filters, presets, the invalid ranges, paging, Back and the CSV.
- Connector keys (every invalid paste, a duplicate, a created key copied once, the connection test before and after real signed catalog requests and a bad signature, the edge adapter, revoke); the Shopify connect flow driven by `apps/shopify`'s own server code (approve, deny, expired, a closed window, an uninstall before approval, an unknown request, the first sync and its catalog, Disconnect).
- Google: nothing picked, Cancel on the consent page, a partial grant, the full connect, a reused and a stale callback, Disconnect, Reconnect. Company settings: the signing policy both ways, surfaces with every invalid field, alert addresses with the email opened and reused, Recent changes. Write-back: pick, Review, Back, Send double clicked (one run), a 400 with Retry, 429 and 500 retried by the queue, invalid_grant with one alert email and Reconnect, History.
- Seller lists built, pasted, signed and superseded, uploaded with every malformed file, another company's list, an old version, a bad signature, an expired and a revoked key. Recalls built, reviewed, published with the passkey, in both feeds (REST with the DPoP-bound key and MCP), worker-f down and back with the event resent once, an uploaded notice. Content credentials made, failed, filtered, and the public manifest.
- Roles: every write refused for a member, a viewer, a teammate with no role and another company's owner, with no audit row and nothing changed; reads open to the company's own people; an admin cannot go back to one officer; an unconfirmed address and a two-day-old sign-in are asked to confirm.
- Outages: the Worker down for a read and a write, slow past 15 seconds, worker-f's session check down (503, never signed out), each with Try again once it is back.
- Security, proven with requests: the proxy refuses foreign origins, encoded slashes and bodies of the wrong shape; rate limits on connect sessions and binding checks; a replayed uninstall nonce is refused; a created connector's private key is shown once and not stored; the stack's log, the Worker's and worker-f's request logs and console output, trooth-web's log and the workspace reads that hold keys (connectors, Google, keys, company, write-back runs, seller lists) searched for every private JWK the walk made, the witness private key, Google access and refresh tokens, the session tokens, the seal secret, the Google client secret, the receipt salt and `SEMANTO_EVENTS_SECRET`: none found.

## Suites

- trooth-semanto-worker: `npx vitest run` 618 of 618; `npx tsc --noEmit` clean.
- apps/shopify: `npm test` 127 of 127; `npm run typecheck` clean; `npm run build` clean.
- trooth-os-worker-f: `npm test` 1512 of 1512; `npx tsc --noEmit` clean; `npm run verify` 18 of 18.
- trooth-web: `node scripts/run-gates.mjs` 182 of 182; `next build` clean with `SEMANTO_DASHBOARD` back to false; `test:semanto-api` 46 of 46; the generators run (`gen-i18n-slices`, `gen-content-rows`, `gen-route-elements`, `gen-route-coverage`, `gen-w3-delivery-report`, `gen-final-handoff`), the 10 changed content rows recorded under `W3-83-SEMANTO-QA-2026-10-23` and the coverage ledger reconciled (33953 rows, open 0), the six documents the docs check named re-read (the test plan updated for the new test and the QA walk) and stamped, and `npm run refresh:package`.

## Not run locally, and how it was covered

- Google's real consent page, Merchant API and Business Profile API: the stand-in answers in Google's documented shapes, at the network boundary the Worker really calls through, with the status queue for 400, 401, 429 and 500.
- A real Shopify admin and Shopify's bulk export: `apps/shopify`'s own services driven against the live Worker with its mock Shopify, plus that package's suite.
- Resend's delivery: every message captured at the boundary and its links opened in the browser.
- Safari, Firefox and screen readers: not run; axe-core and keyboard walks in Chromium only.
- Cloudflare's own edge (real queues' timing, real D1 replication): Miniflare's local implementations.
