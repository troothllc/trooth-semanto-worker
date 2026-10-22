<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The Semanto setup wizard for trooth-web: what is here, how to drop it in, and the one command that walks every click in a browser. -->

# Semanto setup wizard

The six screens of `docs/audit/workflow-research.md` section 5 (Sign in, Your company, Prove your domain, What Semanto read, Review and sign, Put it on your site), built against `docs/spec/setup-api.md`. React 19, TypeScript, `"use client"`, lucide-react icons and trooth-web's Tailwind token classes (`text-text-primary`, `border-hairline`, `btn-primary`, `btn-secondary`, `btn-ghost`).

| File | What it is |
| --- | --- |
| `SetupWizard.tsx` | The container. Polls `GET /os/semanto/{id}/setup` every 4 seconds backing off to 60, restarts at 4 when something visible changes, pauses while the tab is hidden, reads again when the tab or window comes back. Renders the screen for `state.step`, the six-step tracker, Save for later, Help and the time spent. |
| `ScreenSignIn.tsx` | A: Continue with Google (a link into trooth.co sign-in), Continue with email (Work email), and after the email link the once-only passkey offer (Save a passkey, Not now). |
| `ScreenCompany.tsx` | B: Company name and Website with live cleaning ("We will use acme.com"); Continue claims the domain and starts the held read (`setup/start`). |
| `ScreenProveDomain.tsx` | C: the record with Copy buttons, the DNS host's steps, Not your host?, the file tab, Domain Connect only when `domain_connect_url` is present, a status line the poll changes, I've added it, Check now, I will do this later. |
| `ScreenWhatWasRead.tsx` | D: the coverage receipt (Found, Read, Left out; reasons grouped, See pages, Open page, Copy address), the progress bar from `pages_done` of `found`, Finish setup for Basic and the outlined Sign it as your company card. |
| `ScreenReviewAndSign.tsx` | E: facts by section ticked Looks right, Fix, Confirm these facts; then the signing sentence, the key choice, Add a passkey (the first time) then Sign with my passkey (hosted: Trooth's options, the device, Trooth checks the assertion before it releases the key) or the signing input and signature field (customer key), and the two-officer approvals. |
| `ScreenInstall.tsx` | F: the detected host with Change, the guide for `guide_id`, every value with Copy, Check my site and its three checks, then questions and companies and Start monitoring, then the done state linking to monitoring. |
| `api.ts` | `createSetupClient({ base, token, timeoutMs })`: one function per route, bearer auth, a 15 second deadline, RFC 9457 problems as `SetupApiError` with the detail, the fix and the request id. |
| `ui.tsx`, `browser.ts`, `domain.ts`, `poll.ts`, `guides.ts`, `dns-guides.ts`, `types.ts` | Shared parts, browser seams (visibility, clipboard, WebAuthn), the Website rule, the poll schedule, the install guides, the DNS host steps, the API shapes. |

## Dropping in

Copy this folder to `src/components/semanto/setup/` in trooth-web and render:

```tsx
<SetupWizard
  client={createSetupClient({ base: "https://api.trooth.co", token: () => workspaceToken() })}
  apiBase="https://api.trooth.co"
  signedIn={!!session}
  signIn={{ googleHref, sendEmailLink, linkExpiredFor }}
  passkeyOffer={justSignedInByEmail ? { save: registerPasskey, dismiss } : null}
  links={{ help, monitoring, handoff, keys, install }}
  domainConnectDeclined={searchParams.get("error") === "access_denied"}
/>
```

Hosted signing needs no extra prop: the wizard asks this Worker for the passkey options (`passkeys/options`, `sign/options`), runs `navigator.credentials.create` and `get` on trooth.co, and sends the results to `passkeys` and `sign`, where the Worker checks them (`docs/reports/passkey-signing.md`). The page must run on `https://trooth.co` or `https://www.trooth.co` (the relying party is `trooth.co`).

`docs/reports/setup-wizard.md` lists what trooth-web still has to wire. `harness/` is not copied.

## Tests

Unit tests (in `npx vitest run` at the repository root): `test/setup-wizard.test.ts` covers the Website rule, the poll schedule, every guide by `guide_id`, the client's routes, auth, deadline and problem handling, and the house rules on every file here.

The browser walk, one command (headless Chromium through playwright-core, about 70 seconds, so it is a separate script and not part of vitest):

```
cd web/semanto/setup/harness && npm install && npm test
```

It builds the page into the system temp folder, starts the mock setup API (`harness/mock-server.mjs`), and walks the full signed path and the Basic path click by click, then the error paths (claimed domain, a server error with its request id, Save for later, a partial read, a version that changed, a cancelled passkey, a failed install check, customer custody, two officers, Domain Connect, 72 hours, no host detected, sign-in errors) and the polling rules. Screenshots at 1440 and 390 pixels go to `SETUP_SHOTS_DIR` (default: `semanto-setup-shots` in the system temp folder). `PLAYWRIGHT_CHROMIUM` overrides the browser path (default `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`).

To click through it yourself: `npm run serve`, then open the printed address (`?token=full-demo`, `basic-demo`, `customer-demo`, `officer-demo`, `dc-demo`, `errors-demo`, `timeout-demo`, `unknownhost-demo`, or no token for sign-in). DNS changes come from `POST /__control/{token}` with `{"dns":"wrong"}` or `{"dns":"right"}`, the way a real record changes at the DNS host.

Typecheck: `npx tsc -p web/tsconfig.json --noEmit` (against the shim in `web/types`) and, with the harness installed, `cd web/semanto/setup/harness && npm run typecheck` (against the real React 19 types and the DOM library).
