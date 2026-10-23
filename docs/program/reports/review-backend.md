<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# Item 8: independent backend review (Semanto Worker, Shopify app, worker-f item 5)

Reviewer: independent of every area that built this. Scope: `/home/claude/trooth-semanto-worker` (src, adapters, verifier, `apps/shopify`, docs) and the item 5 change in `/home/claude/trooth-os-worker-f` (`src/semanto-recall-events.ts`, its edits to `src/facts.ts` and `src/mcp.ts`, migration 008). trooth-web was not edited. Nothing was committed or pushed.

## trooth-web must follow

1. Proxy allowlist, only if the dashboard adds a recall screen (no existing screen needs it): `GET /os/semanto/{id}/recalls`, `POST /os/semanto/{id}/recalls`, `POST /os/semanto/{id}/recalls/options`. They are in the contract's allowlist block.
2. `POST writeback/send`: send a new `idempotency_key` for every new send. Reusing a key with other items is now a 409 (before, it silently answered the earlier run). The same key with the same items still answers the same run, so a retried click is safe.
3. The alert confirmation redirect now uses both reasons the contract already listed: `reason=link_invalid` (used, replaced by a resend, or unknown) and `reason=link_expired` (only past 24 hours). The settings page must word both.
4. `POST keys/rotate` (one call) answers 409 for a hosted company moving to a customer key; the dashboard already uses the staged routes, so nothing changes on screen.
5. `POST passkeys`, `POST sign` and `POST withdraw` now pass the `os_write` group (30 a minute per person) and show in "Recent changes" as `passkeys.add`, `versions.sign`, `versions.approve`, `versions.withdraw`. The recent changes list should have words for these actions.
6. Optional additive members the screens may use: `interval` (connect session), `advice` (connector test), `resend_available_at` (pending alert address), `next_version` (seller lists, to prefill the version), `counts` (write-back runs), `rotation.dns_record` (started rotation), and `event` on recalls. Approving a connect session twice now answers 200 with the same approval.

## Counts

26 findings, all fixed, each with a regression test: 1 high, 8 medium, 17 low. 19 in the Semanto Worker, 7 in the Shopify app, none in worker-f's item 5 change. 13 enhancements implemented.

## Findings

Each: severity, place, the repro (what happened before the fix), the fix, and the test that guards it. Root tests are in `test/review-backend.test.ts` unless named otherwise; Shopify tests are in `apps/shopify/test/review-fixes.test.ts`.

### Semanto Worker

**1. High. Recalls had no write path, so requirement 24 and contract item 5 were not met end to end.** `src/commerce/ports.ts:28` `putRecall` was called by no route, connector or job in `src` (the only callers were tests). Repro: as an owner, try to publish a recall through any `/os` or `/public` route; there is none, so `withRecallEvents` (`src/os/recalls.ts`) never runs and worker-f's changes feed never receives a recall. Fixed: `POST /os/semanto/{id}/recalls` (custody customer: a JWS checked with `verifyRecall` against the company's non-staged keys; custody hosted: a passkey assertion bound to the exact notice through the new purpose `recall` in `src/pipeline-passkeys.ts`, then the hosted key signs), `POST recalls/options`, `GET recalls` with each recall's feed state (`event`), `mayAdminister`, `os_write`, domain proven, audit `recalls.publish` (`src/os/recalls.ts` `submitRecall`, `recallOptions`, `listRecalls`; routes in `src/serve/os-routes.ts`). A JWS signed at the notice's issued_at before the key was on file names the fix in the problem. Test: "finding 1".

**2. Medium. The one-call `keys/rotate` skipped the passkey the staged confirm asks for.** `src/os/keys.ts:240` (before). Repro: hosted company, admin session, `POST /os/semanto/acme/keys/rotate { public_jwk: <a key the caller holds> }` answered 200 and the company became customer custody with the caller's key, which signs versions with no passkey step; the staged `rotation/confirm` refuses the same move without an assertion. Fixed: that move is a 409 naming the staged rotation; rolling the hosted key Trooth keeps and moves between customer keys stay one call (they match what confirm allows); an explicit role check added. Test: "finding 2".

**3. Medium. Connector keys were written with `INSERT OR REPLACE`.** `src/db/d1.ts:871` (before). Repro: two approvals of connect sessions carrying the same public key into two companies at once both pass the `connectorByKid` check, and the second `INSERT OR REPLACE` moves the kid to the other company and resets `revoked_at` to NULL (a revoked key comes back). Fixed: `putConnectorKey` is insert only (`ON CONFLICT(kid) DO NOTHING RETURNING kid`) and answers whether it inserted, in D1 and in memory; paste, create, approve and the old pipeline action answer 409 when it did not; approve registers the key before settling the session and revokes it at once if another request settled the session first. Test: "finding 3" (D1 and routes).

**4. Medium. A recall kept as failed stayed failed forever.** `src/os/recalls.ts:138` (before). Repro: store a recall before the product record it names exists (or before the domain is proven, or while the events secret is missing); the event is kept `failed` under its deterministic `event_id`; store the same recall again after the record arrives: `putRecallEvent` answers "duplicate" and nothing is ever sent. Fixed: `reviveRecallEvent` takes a failed event back to queued with the body (one conditional update), so the same recall stored again is sent; worker-f dedupes by `event_id`. Test: "finding 4".

**5. Medium. Adding a signing passkey, signing and withdrawing were not audited.** `src/serve/routes.ts` actionRoute (no `semanto_audit` row). Repro: add a passkey and sign a version; `GET company` shows nothing under recent changes, although these release the hosted key and change what is published (brief rule 4: audit where sensitive routes log). Fixed: `src/serve/os-routes.ts` registers `passkeys`, `sign` and `withdraw` before the older routes, keeps the pipeline's handlers and shapes, adds `os_write` and the audit rows `passkeys.add`, `versions.sign`, `versions.approve`, `versions.withdraw`. Test: "finding 5"; `test/os-contract.test.ts` 1b now filters `keys.` actions.

**6. Medium. Two rotation starts at once published two next keys.** `src/os/keys.ts:123` (before: check, then put key, then put rotation). Repro: `Promise.all` of two `keys/rotation/start` answered 200 twice; two keys stayed `next` and one started rotation could never be confirmed or cancelled from the screen. Fixed: the rotation row is claimed first with `beginRotation` (an insert with `ON CONFLICT DO NOTHING`, backed by the partial unique index `semanto_key_rotations_started`, migration 0008), and the key is published only after the claim. Test: "finding 6".

**7. Low. An idempotency key reused with other items answered the earlier run.** `src/os/writeback.ts:141` (before). Repro: send item A with key K, then send A and B with key K: 200 with the first run, B never sent and nothing said so. Fixed: 409 naming the reuse, as Stripe refuses a key reused with other parameters; same key with same items still answers the same run. Test: "finding 7".

**8. Low. A write-back run could be read before its items existed.** `src/db/os-d1.ts` `createWritebackRun` (before: run row first, items in later batches). Repro: two sends with the same key at once: the loser reads the run between the run insert and the item batches and answers a run with no items; a failure between the two leaves a run that holds the key forever with no items. Fixed: items first under the new run id, then the run row in one conditional insert; the loser removes its items. Test: "finding 8".

**9. Low. Two retries of a failed item at once sent it twice.** `src/os/writeback.ts:290` (before). Repro: `Promise.all` of two `runs/{id}/retry`: two queue messages and two audit rows for one item. Fixed: `requeueWritebackItem`, one conditional update from failed to queued; only items taken are audited and dispatched. Test: "finding 9".

**10. Low. The Google bearer token went to whatever URL a stored item held.** `src/os/writeback.ts:217`. Repro: a stored item whose URL is not Google's (an old row, a target built by a future preview change) is sent with `Authorization: Bearer <Google token>`. Fixed: only `merchantapi.googleapis.com` and `mybusinessbusinessinformation.googleapis.com` over https; anything else fails the item without a request. Test: "finding 10".

**11. Low. The connector test recorded an unsigned GET as the last signed request.** `src/os/connectors.ts:160` (before). Repro: any site that serves `{"kid":"<kid>"}` at `/.well-known/trooth-semanto-connector` made the test write `last_request_at`, `last_result: "ok"` and `last_used_at`, a claim of a signed request that never happened. Fixed: the verdict is still `connected` from the adapter's answer (the contract's rule) but the signed-request fields keep what the catalog route saw. Test: `test/os-contract.test.ts` "an edge adapter answers its kid".

**12. Low. Used, replaced or unknown confirmation links reported `link_expired`.** `src/os/company.ts:240` (before). Repro: open a link twice, or open a link replaced by a resend: `reason=link_expired`. Fixed: `alertByToken` tells an expired pending link from one that is not held; `link_invalid` otherwise. Test: `test/os-contract.test.ts` "alert addresses".

**13. Low. Adding the same alert address twice at once sent two emails and killed the first link.** `src/os/company.ts:225` (before: `INSERT OR REPLACE`). Repro: double click Add: two confirmation emails, the first link no longer works. Fixed: `insertAlertAddress`, one conditional insert; the second request is a 409. Test: "finding 13".

**14. Low. The settings answer lost `updated_at` after 200 other writes.** `src/os/settings.ts:62` (before: searched the newest 200 audit rows). Repro: save settings, then make 200 other audited changes: `updated_at` is null. Fixed: `lastAudit(trooth_id, "settings.save")`, one indexed query (index `semanto_audit_action`, migration 0008). Test: "finding 14".

**15. Low. A lower seller list version could land after a higher one.** `src/os/sellers.ts:165` and `src/db/os-d1.ts` `putSellerList`. Repro: versions 6 and 5 submitted at once both pass the "newer than the newest" check; 5 is stored after 6. Fixed: one conditional insert that refuses any version not above every stored one. Test: "finding 15".

**16. Low. A connector revoked twice at once was audited twice.** `src/os/connectors.ts:183` (before: the store's boolean was ignored). Fixed: the second answers the same revocation without a row; the uninstall route does the same. Test: "finding 16".

**17. Low. Anyone who knew an app's kid could use up its uninstall bucket.** `src/serve/os-routes.ts:392` (before: bucket per kid read from the unchecked Signature-Input). Repro: ten junk requests naming the kid from one address made the app's real uninstall a 429. Fixed: bucket per kid and client address. Test: "finding 17".

**18. Low. Dead code that would delete a started rotation.** `OsStore.putRotation` (`INSERT OR REPLACE`) had no production caller after the fix for 6, and with the new unique index a replace would delete the other started row. Removed from the interface, memory and D1 stores; `test/os-d1.test.ts` uses `beginRotation`.

**19. Low. Approving a connect request twice answered 409.** `src/os/connectors.ts:258` (before). Repro: double click Approve: the second answer is "already approved" and the dashboard shows an error for a request that worked. Fixed: the same decision for the same company answers the same approval (200) and audits once; a race that loses the key insert reads the settled session first. Test: "finding 19".

### Shopify app (`apps/shopify`)

**S1. Medium. A webhook was marked handled before its work was queued.** `app/lib/webhooks.server.ts:128` (before). Repro: the queue send fails on `app/uninstalled` or `shop/redact`: the request throws (Shopify retries), and every retry answers "Already handled.", so the shop's data is never deleted (a privacy compliance failure). Fixed: the delivery id is given back (`releaseWebhook`) and the answer is 503, so Shopify's retry is handled. Test: "S1".

**S2. Low. Two deliveries of one webhook at once were both handled.** `app/lib/store.server.ts:206` (before: SELECT, then INSERT OR IGNORE). Fixed: one insert with `ON CONFLICT (id) DO NOTHING RETURNING id`; only the request that inserted handles the delivery. Test: "S2".

**S3. Medium. Two Connect presses at once made two sessions and lost the approval.** `app/lib/service.server.ts:143` (before). Repro: double click Connect: each request makes a key and a session; the store keeps the second; the merchant approves the window the first opened, Trooth registers a key the store does not hold, and the store waits until expiry. Fixed: `beginPending` moves the shop to pending only from none; the loser hands back the winner's approval address. Test: "S3".

**S4. Medium. Two checks that both saw the approval finalized twice.** `app/lib/service.server.ts:244` (before). Repro: a slow poll overlapping the next two-second poll: two "connected" events and two first syncs; Shopify allows one bulk operation at a time, so the second run fails and the screen shows "The sync stopped" while the first runs. Fixed: `finalizePending`, one conditional update from pending with the same kid. Test: "S4".

**S5. Low. Two presses of Sync now at once started two runs.** `app/lib/service.server.ts:363` (before: check, then create). Fixed: partial unique index `sync_runs_one_running` (migration `apps/shopify/migrations/0002_review_fixes.sql`, down file beside it) and `createRun` answers the running run. Test: "S5", "migration 0002".

**S6. Low. The activity log grew without bound.** `app/lib/store.server.ts:216`. Fixed: the newest 200 events per shop are kept as new ones arrive (no cron). Test: "S6".

**S7. Low. Disconnect's success banner claimed the key was revoked when Trooth had never registered it.** `app/routes/app.settings.tsx:139` (before). Fixed: `disconnect` answers the outcome and the banner says what happened. Test: "S7".

### worker-f item 5

No defect found. Checked: the `/internal` host gate in front of `POST /internal/semanto/recall-events`; the HMAC over `t.body` with a constant-time compare over every `v1`, five-minute tolerance both ways, header length cap; 503 without the secret; content type, 64 KiB cap read from the stream, zod limits matching the contract; rate limit after the signature (an unsigned caller cannot spend a workspace's quota); `ON CONFLICT(event_id) DO NOTHING RETURNING seq` and the duplicate answer; AUTOINCREMENT cursor, forged cursor refusal, `next_cursor` never null; the global middlewares (DPoP gate, write audit, idempotency) do nothing for a request with no credential; the MCP feed matches recalls on the published record's own domain and prints company text through `JSON.stringify`; migration 008 and its down file; no cron added. The Semanto side's sender matches every field limit (titles from a non-empty statement, https URLs enforced by `validateRecall`, ids of `smn_` and `smk_` form).

## Enhancements (ranked by user impact)

| # | Enhancement | Source product | Where |
| --- | --- | --- | --- |
| 1 | Recalls can be published and each shows whether it reached the agents' changes feed, with the reason when not | CPSC and Shopify's own product status pages (state per item with the reason) | `src/os/recalls.ts` `submitRecall`, `listRecalls` |
| 2 | Google access token reused until a minute before expiry instead of a refresh per item; a 401 drops it and retries | Google's OAuth 2.0 guide (reuse an access token until it expires; refresh tokens have limits) | `src/os/service.ts` `googleTokens`, `src/os/google.ts`, `src/os/writeback.ts` |
| 3 | Send every sendable change when `item_ids` is left out ("select all"), with confirm still required | Mailchimp and Klaviyo bulk send; Stripe dashboard bulk actions | `src/os/writeback.ts` `sendWriteback` |
| 4 | Retry every failed item of a run in one call | Stripe's webhook dashboard (resend failed events), Zapier task history "replay" | `src/os/writeback.ts` `retryRun` |
| 5 | Runs carry `counts` by state, so history reads "3 sent, 1 failed" | Stripe and Mailchimp send summaries | `src/os/writeback.ts` `countsOf` |
| 6 | Idempotency key mismatch answered with a clear 409 | Stripe ("reusing an idempotency key with different parameters returns an error", changelog 2015-09-03) | `src/os/writeback.ts` `sameRunOrMismatch` |
| 7 | Approve and revoke are idempotent: a double click answers the same result | Stripe idempotent requests; GitHub device flow (an approved code stays approved) | `src/os/connectors.ts` |
| 8 | Connect session answers `interval` for the poll | RFC 8628 section 3.2 (device authorization response `interval`); GitHub's device flow | `src/os/connectors.ts` `CONNECT_POLL_INTERVAL_SECONDS` |
| 9 | Connector test says what to do next for each verdict | Stripe's webhook endpoint test (result with guidance) | `src/os/connectors.ts` `CONNECTOR_ADVICE` |
| 10 | A started rotation shows the new key's DNS record on every read, so a reload keeps it | GitHub and Stripe key screens (the pending key stays visible until confirmed) | `src/os/keys.ts` `rotationView` |
| 11 | Seller lists answer `next_version` for the form's default | ads.txt managers and Merchant Center (the next revision prefilled) | `src/os/sellers.ts` `listSellerLists` |
| 12 | Pending alert addresses say when resend opens (`resend_available_at`) | Mailchimp and Substack confirmation resend (the wait shown, not an error) | `src/os/company.ts` `companySettings` |
| 13 | Shopify Settings: Polaris empty states for no sync and no activity, and the last sync's product and signed record counts | Shopify App Home patterns, Empty state (shopify.dev); Klaviyo's sync summary | `apps/shopify/app/routes/app.settings.tsx` |

Sources: https://docs.stripe.com/changelog/2015-09-03/reuse-idempotency-tokens-alter-error, https://docs.stripe.com/error-low-level, https://shopify.dev/docs/api/app-home/patterns/compositions/empty-state, https://www.ietf.org/archive/id/draft-ietf-oauth-refresh-token-expiration-03.html, https://docs.cloud.google.com/apigee/docs/api-platform/antipatterns/oauth-long-expiration, https://hookdeck.com/webhooks/platforms/guide-to-stripe-webhooks-features-and-best-practices.md, https://docs.kinde.com/authenticate/device-authorization-flow/overview/.

Considered and left as they are, with the reason: the alert confirmation stays a GET link (the contract fixes it; Mailchimp's confirmation links are GET too); `POST settings` keeps replace semantics (the contract says the body is the DeliverySettings object, and the preview shows every reset before Save).

## Migrations

- Worker: `migrations/0008_review_backend.sql` (two indexes: `semanto_key_rotations_started`, partial unique on started rotations per company; `semanto_audit_action`), down `migrations-down/0008_review_backend.down.sql`. Tested up, down, up.
- Shopify app: `apps/shopify/migrations/0002_review_fixes.sql` (partial unique index `sync_runs_one_running`), down `apps/shopify/migrations-down/0002_review_fixes.down.sql`. Tested up, down, up.
- No trigger, no cron, no polling added anywhere. No env var added.

## Files changed

Semanto Worker: `src/os/keys.ts`, `src/os/connectors.ts`, `src/os/recalls.ts`, `src/os/writeback.ts`, `src/os/company.ts`, `src/os/settings.ts`, `src/os/sellers.ts`, `src/os/store.ts`, `src/os/service.ts`, `src/os/google.ts`, `src/db/os-d1.ts`, `src/db/d1.ts`, `src/pipeline-store.ts`, `src/pipeline.ts`, `src/pipeline-passkeys.ts`, `src/serve/os-routes.ts`; `migrations/0008_review_backend.sql`, `migrations-down/0008_review_backend.down.sql`; tests `test/review-backend.test.ts` (new), `test/os-contract.test.ts`, `test/os-d1.test.ts`; docs `docs/spec/os-api.md`, `docs/program/CONTRACT-2026-10-23.md` (section "Settled by the backend review" and three allowlist lines), `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS-TRACEABILITY.md`, this report.

Shopify app: `app/lib/store.server.ts`, `app/lib/webhooks.server.ts`, `app/lib/service.server.ts`, `app/routes/app.settings.tsx`; `migrations/0002_review_fixes.sql`, `migrations-down/0002_review_fixes.down.sql`; `test/review-fixes.test.ts` (new).

worker-f: none.

## Tests and results

- Semanto Worker: `npm test` 22 files, 603 tests passing (582 before; 21 new, and four existing cases updated to the fixed behavior). `npx tsc --noEmit` clean.
- Shopify app: `npm test` 12 files, 126 tests passing (118 before; 8 new). `npm run typecheck` clean. `npm run build` clean.
- worker-f: `npx vitest run` 118 files, 1511 tests passing. `npx tsc --noEmit` clean. `npm run verify` passing (18 of 18 in the last standalone suite). `node scripts/derive-schema.mjs --check`: current, 1190 static statements compile.
