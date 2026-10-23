# trooth-web: the Semanto dashboard screens (2026-10-23)

Area: the Semanto settings screens in trooth.co's dashboard. Repository `/home/claude/trooth-web`, branch `semanto-dashboard` (one commit, 40c92ae8, on origin/main a87b85f8). Nothing was committed or pushed; all work is in the working tree. `SEMANTO_DASHBOARD` in `lib/launch-config.ts` stays `false`. No environment variables, migrations, or Neon, Vercel, GitHub, UptimeRobot or Sentry settings were added or changed.

## Routes

All under the existing Semanto layout, behind `SEMANTO_DASHBOARD`. Each has a `page.tsx` and a `loading.tsx`.

| Route | Screen | Component |
| --- | --- | --- |
| /dashboard/semanto/delivery | 1a Delivery settings | components/dashboard/semanto/delivery-settings.tsx |
| /dashboard/semanto/keys | 1b Signing key, staged rotation | signing-keys.tsx |
| /dashboard/semanto/receipts | 1c Read receipts | reader-receipts.tsx |
| /dashboard/semanto/connectors | 1d Connector keys | connector-keys.tsx |
| /dashboard/semanto/connect/[session] | 1d App connect approve page | connect-approve.tsx |
| /dashboard/semanto/connections | 1e Connect Google | google-connection.tsx |
| /dashboard/semanto/company | 2 Company settings | company-settings.tsx |
| /dashboard/semanto/writeback | 3 Write-back | writeback.tsx |
| /dashboard/semanto/sellers | 4 Seller lists | seller-lists.tsx |
| /dashboard/semanto/credentials | 6 Content credentials status | credentials.tsx |
| /dashboard/semanto (existing) | Settings list and the Semanto Basic card | semanto-manage.tsx, rendered by semanto-guide.tsx |
| /dashboard/semanto/monitor (existing) | Consistency monitor (port), once a version is signed | consistency-monitor.tsx, rendered by watch-report.tsx |

Every screen has loading, empty, error (with Try again and the request id), off (Semanto not switched on) and success states; keyboard paths; dialogs that take focus and return it to their opener on close; aria labels and live regions; and all strings in `lib/i18n/messages/en-workspace.ts`.

## Files

New:

- `lib/semanto-settings-types.ts`: the response shapes from CONTRACT-2026-10-23 (with the Worker area's settled shapes).
- `lib/semanto-forms.ts`: pure validators and helpers (public JWK check, email shape, 92-day range, receipt query and filters, typed-confirm match, Google consent URL check, Shopify return address check, compact JWS check, seller rows, run-is-moving, CSV file name). Tested in `tests/semanto-forms.test.mjs` (10 tests).
- `lib/semanto-ed25519.ts`: Ed25519 key generation in the browser (WebCrypto) for customer-held rotation; the private key is shown once and dropped.
- `components/dashboard/semanto/semanto-settings-frame.tsx` (GitHub-style settings header and sidebar) and `semanto-settings-ui.tsx` (SecretOnce, TypedConfirmDialog, ConfirmDialog, SaveBar, useLeaveGuard, Pager, StatePill, useDialogOpener, formatters).
- The ten screen components above, plus `consistency-monitor.tsx` and `semanto-manage.tsx`.
- `app/dashboard/semanto/{delivery,keys,receipts,connectors,connections,company,writeback,sellers,credentials}/{page,loading}.tsx` and `app/dashboard/semanto/connect/[session]/{page,loading}.tsx`.
- 23 i18n slices in `i18n/slices/ws.semanto*.generated.ts`.
- `scripts/qa-semanto-screens.mjs` (`npm run qa:semanto-screens`): the Playwright fixture walk.
- `tests/semanto-forms.test.mjs`.
- `docs/writing/W3-81-RENDER-SEMANTO-SCREENS.md`: the render record.

Changed:

- `app/api/semanto/[...path]/route.ts`: per-path query validation (400 "The query is not one this address takes.") and CSV passthrough as a file with Content-Disposition.
- `lib/semanto-api-core.ts`: the new allowlist entries with their query rules; `semantoQuery`, `semantoFileType`, answer kind `file`.
- `lib/semanto-api.ts`, `lib/use-semanto.ts` (problem `issues`, `useSemantoGet` with opt-in polling), `lib/semanto-types.ts`.
- `components/settings/settings-chrome.tsx` (exports NavList, NavGroup, NavItem), `components/settings/gh.module.css` (date field focus ring on `:focus-within`, same ring as every field).
- `components/dashboard/semanto/semanto-guide.tsx`, `watch-report.tsx`.
- `lib/i18n/messages/en-workspace.ts` (about 600 keys), `lib/i18n/surfaces-workspace.ts`.
- `package.json`: `test:semanto-api` covers both Semanto test files; `qa:semanto-screens`; the two tests appended to `test:units`.
- `scripts/run-gates.mjs` (`test:semanto-api` in NOT_GATES, since `test:units` runs it), `scripts/check-client-weight.mjs` (evidence 350 to 360 and questionnaires edit 270 to 280 from workspace-nav importing launch-config; semanto/page and semanto/company at 260; dated notes), `scripts/gen-route-elements.mjs` (budget 6 to 7 MiB, note), `scripts/browser-audit/route-crawl.mjs` and `tests/browser-route-crawl.test.mjs` (the `/dashboard/semanto/connect/t3-unknown` sample).
- `tests/semanto-api.test.mjs` (allowlist, query and CSV), `tests/csv-cell.test.mjs`, `tests/sentence-case.test.mjs` ("Semanto", "Semanto Basic").
- Regenerated with the repo's generators: `docs/writing/*` (W3-DISPOSITIONS sets `W3-81-SEMANTO-SCREENS-2026-10-23`, 520 changed, and `W3-81-SEMANTO-SCREENS-ARTEFACT-2026-10-23`, 57 retained, with the 217 W3-80 rows restored; ledger 33784 discovered, 15337 changed, 17962 retained, 485 protected, 0 open; content rows, route coverage, route elements, delivery report, browser record), `docs/rebuild-package/*` (manifests, inventories, sbom, seal), `docs/launch/*` (requirements, test evidence, release report, scope matrix, route crawl with 10 routes added), `docs/profile-lifecycle/FINAL_HANDOFF.md`, `docs/i18n-unconverted.json`, `lib/otel/vocabulary.generated.json`, `public/openapi.json`.

## Allowlisted paths added (lib/semanto-api-core.ts ALLOWED)

Paths are relative to the Worker's `/os/semanto/`. `{id}` is the Trooth ID; `{kid}`, `{session}` and `{run}` match `[A-Za-z0-9_-]{8,128}`. Any query not listed is refused with 400.

- GET `{id}/settings`
- POST `{id}/settings`
- POST `{id}/settings/preview`
- GET `{id}/keys`
- POST `{id}/keys/rotation/start`
- POST `{id}/keys/rotation/options`
- POST `{id}/keys/rotation/confirm`
- POST `{id}/keys/rotation/cancel`
- POST `{id}/keys/binding/check`
- POST `{id}/keys/{kid}/revoke`
- GET `{id}/receipts` (query: from, to, agent, path, status, cursor, limit)
- GET `{id}/receipts.csv` (query: from, to, agent, path, status; answered as text/csv)
- GET `{id}/connectors`
- POST `{id}/connectors`
- POST `{id}/connectors/create`
- POST `{id}/connectors/{kid}/test`
- POST `{id}/connectors/{kid}/revoke`
- GET `connect/{session}`
- POST `{id}/connect/{session}/approve`
- POST `{id}/connect/{session}/deny`
- GET `{id}/google`
- POST `{id}/google/connect`
- POST `{id}/google/disconnect`
- GET `{id}/company`
- POST `{id}/company/signing-policy`
- POST `{id}/company/surfaces`
- POST `{id}/company/alerts`
- GET `{id}/writeback`
- POST `{id}/writeback/send`
- GET `{id}/writeback/runs` (query: cursor)
- GET `{id}/writeback/runs/{run}`
- POST `{id}/writeback/runs/{run}/retry`
- GET `{id}/sellers/lists`
- POST `{id}/sellers/lists`
- POST `{id}/sellers/lists/options`
- GET `{id}/credentials` (query: state, cursor)
- POST `{id}/monitor/run`

The Worker area also lists POST `keys/rotate` and POST `sign/options`. They are not allowlisted because the dashboard does not call them.

## Contract

I appended "Shapes the dashboard reads (added by the trooth-web screens area)" to `docs/program/CONTRACT-2026-10-23.md`. It adds `keys/rotation/options` and `sellers/lists/options` (the passkey options for those two signed acts) and clarifies several shapes. The Worker area implemented them. After reading its "Settled by the Worker backend area" section, I updated the screens to match three points:
- **Host detection:** they read the short `{ host, at }` form as well as the long form.
- **Write-back:** a change the Worker marks `sendable: false` shows under "Ready, but not sendable yet" with its `blocked_by` reason, and Send skips it.
- **Google connection errors:** the return codes `state_invalid`, `scopes_declined`, `not_configured` and `no_refresh_token` each have their own sentence.

## Reference products per screen

- **Delivery:** Vercel project settings (per-setting save, and a preview before the change applies), the Stripe dashboard save bar, and the Linear and GitHub settings forms.
- **Signing key:** Stripe "Roll key" (an overlap window before the old key expires), GitHub deploy keys and fine-grained tokens (the secret is shown once), AWS KMS rotation and scheduled deletion, and GitHub's typed repository delete for revoke.
- **Read receipts:** Cloudflare AI Crawl Control (filters for date, crawler, operator and path, with Download CSV of the same filters), Plausible and Vercel Analytics (totals as filters).
- **Connector keys:** Stripe API keys (create, then reveal once), Segment sources, and the Zapier connection test.
- **App connect approve page:** the GitHub OAuth device flow (15-minute expiry, cancel returns access_denied) and the Stripe CLI login "Allow access" page.
- **Connect Google:** the Shopify Google & YouTube app, Zapier connections and Reconnect, and HubSpot connected apps with their scopes in plain words.
- **Company settings:** GitHub emails (Unverified badge, Resend, Remove), Stripe email verification, and GitHub typed confirms for the downgrade to one officer.
- **Write-back:** the Shopify bulk editor (pick, then review), Merchant Center diagnostics (per-item states), and Stripe idempotency keys for retry.
- **Seller lists:** ads.txt managers (adstxtmanager.com, and Google Ad Manager's "Declare authorized sellers").
- **Content credentials:** GitHub's Open and Closed counts used as filters, and Merchant Center item states.

Sources read: support.stripe.com (roll API keys); developers.cloudflare.com/ai-crawl-control (analyze AI traffic); docs.github.com (authorizing OAuth apps, the device flow, verifying your email address); help.shopify.com (Google & YouTube connect); help.zapier.com (connections and reconnect); support.google.com/admanager/answer/9422220; vercel.com/docs (project settings).

## Checks and results

- **Typecheck:** `tsc --noEmit` is clean.
- **Lint:** `eslint --max-warnings 0` is clean.
- **Unit tests:**
  - `tests/semanto-api.test.mjs` and `tests/semanto-forms.test.mjs` pass (forms: 10 of 10).
  - `test:units` stops at the first failing link, so I ran every link: 665 of 666 pass.
  - The one failure is `tests/worker-sboms.test.mjs`. It fails because the sibling checkout `/home/claude/trooth-os-worker-f` (another area's branch, lockfile fb004787) is stale against its SBOM. main fails the same way when that sibling is present.
- **Production build:** `next build` exits 0, and every Semanto route is listed.
- **Gates:** `node scripts/run-gates.mjs` passes 180 of 182. The same two fail on origin/main in this clone:
  - **`test:units`:** fails at the worker-sboms link described above.
  - **`check:doc-claims`:** reports 96 claims, the same set as on main. The cause is commit hashes that are absent from this clone.

  On main, `check:db-apply-order` also failed, because of a scratchpad path permission. It passes on this branch.
- **`check:docs`:** 0 of 54 stale. Each of the 27 stale documents in `docs/rebuild-package/` was re-read against the code, corrected where the Semanto work changed what it says (see Follow-ups), and then stamped with `node scripts/check-docs-stale.mjs --stamp`.
- **Derived docs:** regenerated as listed above. `check:content-coverage` shows 33784 rows and 0 open.
- **Browser QA:** `npm run qa:semanto-screens`, dark and light:
  - **States:** 56 per theme, on 17 addresses.
  - **axe-core 4.12.1:** clean on all 56 (WCAG 2.0, 2.1 and 2.2 A and AA).
  - **Keyboard and dialogs:** 12 keyboard walks complete. Every dialog takes focus and returns it on close.
  - **Errors:** no console errors, no page errors and no failed requests.
  - **Polling:** write-back stops after the run settles.
  - **Width:** no sideways scroll at 390 wide.

  `scripts/qa-semanto-parity.mjs` passes: 236 properties are equal.

## Follow-ups (same day)

1. **Return to Shopify.** The answer from `POST {id}/connect/{session}/approve` (and from `deny`) carries `return_url`. `components/dashboard/semanto/connect-approve.tsx` now:
   - checks it again with the Worker's rule (`isShopifyReturnUrl` in `lib/semanto-forms.ts`: https, at most 2000 characters, the session's own `<shop>.myshopify.com` host or `admin.shopify.com`, no user name, password or port);
   - after approval, keeps the success state and makes "Return to Shopify" the primary action linking to `return_url`, with Open connector keys beside it; it never redirects without the click;
   - after denial, shows the denied state with the same "Return to Shopify" link beside Back to Semanto;
   - with no `return_url`, or one that fails the check, keeps the earlier success and denied states and links nowhere outside trooth.co.
   `tests/semanto-forms.test.mjs` has a new test for the rule (both good forms; http, another store, lookalike hosts, credentials, a port, `javascript:`, over-long and non-string values refused). No allowlist entry changed.
2. **The three late updates, rendered.** `scripts/qa-semanto-screens.mjs` gained nine states:
   - the delivery host read in its short `{ host, at }` form. Looking at it found one defect, now fixed: the short form was read as "not serving the well-known file yet", which the short form does not say. The line now says nothing about the file when the answer does not.
   - a write-back change with `sendable: false` and its `blocked_by`, listed under "Ready, but not sendable yet" and checked to be left out of the send body;
   - the four Google return codes (`state_invalid`, `scopes_declined`, `not_configured`, `no_refresh_token`);
   - Return to Shopify after approve (keyboard walk) and after deny, and an approve whose `return_url` is off the store, which is not linked.
   Both themes ran clean: 56 states each on 17 addresses, axe-core clean on all 56, 12 keyboard walks, no console or page errors, no failed requests. They are recorded in the same runs (`W3-81-semanto-screens`, `W3-81-semanto-screens-light`) in `docs/writing/W3-BROWSER-RECORD.json` and in `docs/writing/W3-81-RENDER-SEMANTO-SCREENS.md`.
3. **Stale docs.** I re-read all 27 documents `check:docs` named against the code and corrected these 15:
   - `API_REFERENCE` (the `/api/semanto` row)
   - `AGENT_SAFETY_POLICY` (the Trooth ID in a path is an address, not a grant)
   - `COMPONENT_STATE_AUDIT` (the first product surfaces that page by cursor)
   - `DEFENSIVE_ASSESSMENT` (the third catch-all proxy and its exact allowlist)
   - `DEPLOYMENT_RUNBOOK` (the Semanto Worker as a sibling; the three Semanto commands are not gates)
   - `DESIGN_SYSTEMS` (Semanto route map; built from the existing settings primitives, plus the one date-field focus rule)
   - `DIAGRAMS` (the undrawn Semanto edge; write-back is not a read-only connector)
   - `KNOWN_LIMITATIONS` (item 28: fixtures only, flag off)
   - `PENTEST_RFP` (scope)
   - `QA_TEST_PLAN` (the hand-run Semanto browser layer)
   - `REPOSITORY_INVENTORY` (`trooth-semanto-worker`)
   - `SECURITY_ASSESSMENT_REPORT` (F19, design note on the proxy)
   - `THREAT_MODEL` (the Semanto section)
   - `USER_JOURNEYS` (journey 33)
   - `WORKOS_AUTHENTICATION_GUIDE` (same session; the signing passkey is not a sign-in)

   The other 11 hand-written documents needed no change and say so in their header. `COMPONENT_STATE_INVENTORY` is generated and was regenerated; I read its header and Semanto rows against source. Each header records the re-read, and the set was then stamped, so `check:docs` reports 0 of 54 stale.
4. **Re-run.** The derived-doc chain was regenerated again: content rows 33784 with 0 open, dispositions, ledger, route coverage, route elements, delivery report, i18n, otel, openapi, launch inventory, handoff, scope matrix, package manifests and seal, release report, and test evidence for the changed tests. The gates pass 180 of 182; the same two fail as on main (`test:units` at the stale worker-f SBOM link, with all other 665 links passing, and `check:doc-claims` on 96 missing commits in this shallow clone plus the same table count as main). Lint, typecheck and the production `next build` (exit 0) pass. `SEMANTO_DASHBOARD` is back to false and `AGENTS.md` and `next-env.d.ts` are restored.

## Browser run ids

- `W3-81-semanto-screens` (dark) and `W3-81-semanto-screens-light` (light), recorded per route in `docs/writing/W3-BROWSER-RECORD.json` and described in `docs/writing/W3-81-RENDER-SEMANTO-SCREENS.md`.
- Route-crawl supplements: `CRAWL_ADD_ROUTES` runs against a production server for the ten new routes, including the `/dashboard/semanto/connect/t3-unknown` sample, recorded in `docs/launch/route-crawl.json`.

## Not run

- Safari, Firefox and screen readers.
- A real passkey ceremony: the headless browser has no authenticator, so each passkey step was walked up to the ceremony.
- Google's consent page.
- The live Semanto Worker. Every request was answered by fixtures shaped to the contract.
