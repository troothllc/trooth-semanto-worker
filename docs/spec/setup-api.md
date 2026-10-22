<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The workspace API behind the Semanto setup wizard (six screens, nine steps, docs/audit/workflow-research.md sections 5 and 6), plus the workspace and public routes added with the pre-deploy audit fixes. Every shape here is what src/setup/state.ts, src/pipeline.ts and src/serve/routes.ts answer. Errors are RFC 9457 problems (src/serve/errors.ts). -->

# Setup API

This is the contract the dashboard wizard is built against. Every route below is served by this Worker (`src/serve/routes.ts`), every answer is signed like every other Semanto answer (RFC 9421, tag `trooth-semanto`, with `Content-Digest`), every `/os` answer carries `Cache-Control: private, no-store` and `Vary: Origin` with `Access-Control-Allow-Origin` set to the caller's origin when it is `https://trooth.co` or `https://www.trooth.co` (or `http://localhost` on any port in development), else `https://trooth.co`, and every answer carries `Trooth-Request-Id` (exposed to browsers), the id a person quotes to support. Field names are exact. A field marked optional with `?` is absent, not null, when it does not apply.

Base: `https://api.trooth.co`. `{id}` is the company's Trooth ID (the `trooth_id` a claim answers).

## Authorization

Every `/os` route needs `Authorization: Bearer <workspace token>`. The Worker asks worker-f's session check (`GET /auth/session` through the `TROOTH_OS` service binding). worker-f answers `{ authenticated, companyId, userId, email, role, workspaceRole?, companySlug?, signedInAt? }`.

- `role` is the account type. Only `vendor` accounts reach Semanto; a `buyer` session is refused like no session (a 401 problem): it has no company to act for.
- Three routes need only a valid vendor session, with no Semanto company yet: `GET /os/semanto/setup`, `POST /os/semanto/setup/start` and `POST /os/semanto/claim`. This is the claim variant of authorization (`troothOsSession` in `src/pipeline.ts`).
- Every other `/os` route maps worker-f's `companyId` to the company through `semanto_companies.os_company_id`, which the claim writes. No mapping is a 401 problem. A session whose company is not `{id}` is a 403 problem.
- Roles: `workspaceRole` when worker-f sends it; otherwise the user who claimed the company (`os_owner_user_id`) is `owner` and every other vendor session of that company is `member`.

| Role | May |
| --- | --- |
| owner, admin | everything below, including sign, withdraw, key changes, settings |
| member | start and drive setup, read again, build, reports, install check |
| viewer | read only (`GET` routes) |

## The nine steps and their timing targets

`SETUP_STEPS` in `src/basic/tier.ts`. Targets are targets; `timings` reports what the server measured from its own timestamps (`measureSetup`). A step's time runs from the previous step's completion, so a read that overlaps the domain proof costs nothing extra.

| # | id | Words | Who | Basic | Full | Completed when (server timestamp) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `sign_in` | Sign in | owner | 30 | 30 | the session's `signedInAt` when worker-f sends it, else the first authorized setup call |
| 2 | `company` | Name your company and website | owner | 30 | 30 | the claim (`setup/start` or `claim`) |
| 3 | `prove_domain` | Prove you control the domain | owner, then Trooth | 270 | 270 | the poll that finds the proof record |
| 4 | `read_site` | Trooth reads your site; you look at what it read | Trooth, then owner | 240 | 240 | `setup/choose` (the receipt was seen and a path chosen) |
| 5 | `review` | Review and confirm the facts | owner | not in Basic | 60 | `setup/confirm` |
| 6 | `sign` | Sign the version | owner | not in Basic | 45 | the signature is witnessed and logged |
| 7 | `install` | Put it on your site | owner | not in Basic | 120 | the first `setup/install-check` |
| 8 | `check` | Trooth checks it works | Trooth | not in Basic | 30 | an install check where all three checks pass |
| 9 | `monitoring` | Start monitoring | Trooth, then owner | not in Basic | 30 | `setup/monitoring` |

Basic is steps 1 to 4, target 600 seconds (the targets sum to 570). Full is steps 1 to 9, target 900 seconds (the targets sum to 855).

## The setup state

`GET /os/semanto/setup` (session only) and `GET /os/semanto/{id}/setup` answer this object. Every `POST /os/semanto/{id}/setup/*` route answers it too, after its change. The wizard polls it (4 s, then backing off to 60 s); it never needs a "check" button.

```json
{
  "object": "semanto.setup",
  "trooth_id": "acme",
  "org": "Acme Inc",
  "domain": "acme.com",
  "step": "prove",
  "basic": true,
  "saved_for_later": false,
  "proof": { },
  "read": { },
  "review": { },
  "sign": { },
  "install": { },
  "monitoring": { },
  "timings": { },
  "next_action": { "label": "Add the record, then wait here", "method": "GET", "url": "https://api.trooth.co/os/semanto/acme/setup" },
  "checked_at": "2026-10-22T12:00:00.000Z"
}
```

With no company yet (`GET /os/semanto/setup` before a claim) the answer is `{ "object": "semanto.setup", "trooth_id": null, "org": null, "domain": null, "step": "company", "basic": true, "saved_for_later": false, "proof": null, "read": null, "review": null, "sign": null, "install": null, "monitoring": null, "timings": <measureSetup with nothing completed>, "next_action": { "label": "Continue", "method": "POST", "url": "https://api.trooth.co/os/semanto/setup/start" }, "checked_at": "2026-10-22T12:00:00.000Z" }`. Once a company exists, every member object is present.

### step

Decided by the server, in this order:

| step | When |
| --- | --- |
| `company` | no company for this session |
| `prove` | the domain is not proven |
| `read` | the read is not done, or the owner has not chosen a path on the receipt screen (`setup/choose`) |
| `review` | full path: the newest built version is not confirmed, or not signed |
| `install` | full path: signed, and the install check has not passed all three checks, or monitoring has not started |
| `done` | Basic path chosen after the receipt, or full path with all three checks passed and monitoring started |

`basic` is true while the company is on Semanto Basic (tier `basic`). `setup/choose` with `path: "full"` makes it false.

### proof

```json
{
  "record_type": "TXT",
  "record_name": "_trooth-challenge.acme.com",
  "name_to_type": "_trooth-challenge",
  "record_value": "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef",
  "status": "waiting",
  "checked_at": "2026-10-22T12:00:00.000Z",
  "next_check_at": "2026-10-22T12:00:10.000Z",
  "proven_at": null,
  "method": null,
  "provider": { "id": "cloudflare", "name": "Cloudflare", "manual_steps": ["Open your domain in Cloudflare, then DNS, then Records.", "Add a new record and choose the type TXT.", "In Name (some hosts call it Host), type _trooth-challenge. If your host does not add acme.com on its own, type _trooth-challenge.acme.com.", "In Value (some hosts call it Content), paste the value with the Copy button.", "Save it. Trooth keeps looking on its own and moves on when it finds the record."] },
  "diagnosis": { "state": "looking", "tone": "working", "title": "Looking for your record", "detail": "Most hosts publish a new record within minutes. Some take a few hours. Trooth asked cloudflare-dns.com and dns.google and keeps looking. You can leave this page: Trooth emails you when it is found.", "keep_looking": true, "resolvers": [{ "resolver": "cloudflare-dns.com", "found": [] }, { "resolver": "dns.google", "found": [] }] },
  "well_known": { "url": "https://acme.com/.well-known/trooth-claim.txt", "body": "trooth-domain-challenge=0123456789abcdef0123456789abcdef0123456789abcdef" },
  "pointer": { "record_name": "_trooth.acme.com", "record_value": null }
}
```

- One proof record format (`src/basic/tier.ts`): the proof is the TXT record `_trooth-challenge.<domain>` with the value `trooth-domain-challenge=` followed by 48 lowercase hex characters. `_trooth.<domain>` is reserved for the pointer `v=trooth1; id=<trooth_id>; key=<kid>`; it is never read as proof. The file `https://<domain>/.well-known/trooth-claim.txt` holding the same value is the other way to prove.
- `status`: `waiting` (nothing at the name yet), `found_wrong_value` (a Trooth-looking value at the name, or the record at the doubled name, that is not this value), `found` (the exact value was found on this poll and the proof was recorded by this request), `proved` (recorded on an earlier poll).
- Live checking: while the domain is not proven, each `GET /os/semanto/{id}/setup` looks the record up again (two DNS over HTTPS resolvers, `cloudflare-dns.com` and `dns.google`, plus the well-known file), at most once every 10 seconds per company; a poll inside the 10 seconds answers the last result and `next_check_at` says when the next lookup happens. The value proves the domain when every resolver that answered (at least one) returns it, or when the well-known file holds it; a value one resolver returns and the other does not yet is `propagating`, not proof.
- `method`: `dns_txt` or `well_known` once proven.
- `provider`: read from the domain's NS records (`src/setup/dns-hosts.ts`). `id` is one of `cloudflare`, `godaddy`, `route53`, `namecheap`, `gcloud`, `vercel`, `azure`, `digitalocean`, `wix`, `porkbun`, `ionos`, `squarespace`, or `unknown` (name "your DNS host"). `manual_steps` are plain sentences for that host. `domain_connect_url?` is present only when Domain Connect discovery finds a provider on `ONBOARDED` (`src/setup/domain-connect.ts`) and the company has a key whose id fills the template's pointer record. `ONBOARDED` is empty until providers confirm, so today the field is never present and the wizard shows the manual table.
- `diagnosis`: from `src/setup/dns-diagnosis.ts`. `state` is one of `not_started`, `looking`, `propagating` (one resolver sees the record and the other does not yet), `doubled_name`, `wrong_value`, `old_value`, `proven`, `timed_out` (72 hours of looking), `claimed_elsewhere`. `fix?` is the one next thing to do. `resolvers` lists what each resolver answered at the proof name.
- `pointer.record_value` is the `_trooth` pointer once the company has a signing key, else null.

### read

```json
{
  "status": "reading",
  "held": true,
  "found": 212,
  "read": 0,
  "pages_done": 47,
  "left_out": [{ "url": "https://acme.com/login", "reason": "Needs a login", "code": "login" }],
  "eta_seconds": 83,
  "started_at": "2026-10-22T12:00:31.000Z",
  "version": null
}
```

- `status`: `queued`, `reading`, `done`, `failed`. `finished_at?` once done or failed; `error?` (plain words) when failed.
- `held`: the read started before the domain was proven. A held read is stored and not published, served or witnessed. When the proof is recorded the held version is promoted: on Semanto Basic it is witnessed and served marked witnessed-not-signed; on the full path it becomes the version to review and sign.
- `found`: addresses found so far. `pages_done`: pages fetched and stored so far. `read`: pages in the built version (0 until done). `eta_seconds?`: from the measured rate, present once at least one page is done and the read is not finished.
- `left_out[].reason` is one of these plain sentences, `code` the stable key: `noindex` "Asked search engines not to show it (noindex)", `robots` "Blocked by your robots.txt", `not_found` "Page not found (404)", `server_error` "Server error (5xx)", `login` "Needs a login", `personal` "A cart, account or personal page", `duplicate` "Same page as another one", `too_large` "Too large to read", `not_reached` "Not reached: no link to it from your site or sitemap", `not_html` "Not a web page", `other` "Could not be read".
- `version`: the built version number once done.
- An email goes to the address on the session that started setup when a read that took longer than 60 seconds finishes: subject "Semanto read 198 of 212 pages on acme.com".

### review

```json
{ "version": 1, "root_hash": "sha256:<64 hex>", "changed_since_read": false, "changed_urls": [], "facts_count": 64, "pages_count": 198, "saved_for_later": false, "confirmed_at": null }
```

`changed_since_read` is true when a change check after the build found a page whose live bytes differ from the bytes read. `version` and `root_hash` are null before a version is built.

### sign

```json
{ "custody": "hosted", "passkey_required": true, "has_passkey": true, "two_officer": false, "approvals": [{ "name": "ada@acme.com", "role": "owner", "at": "2026-10-22T12:09:00.000Z", "passkey": true }], "signed_version": null, "signed_at": null }
```

`passkey_required` is true for hosted custody: Trooth keeps the company key and releases it only after the signer completes a fresh passkey assertion for the exact version and root hash (W3C WebAuthn Level 3, section 7.2; see Passkey routes below and `docs/reports/passkey-signing.md`). `has_passkey` is true when the signed-in person has at least one passkey on file; it is per person, so two people on the same company can see different values. `approvals` are the approvals recorded for the newest built version's root hash; with hosted custody only approvals made with a passkey assertion are listed and counted (the two-officer rule counts distinct people who each completed an assertion for that root hash).

### install

```json
{ "host": "shopify", "guide_id": "shopify-app", "detected_at": "2026-10-22T12:10:00.000Z", "checks": { "markdown": "pending", "signature": "pending", "well_known": "pending" }, "message": "Put Semanto on your site, then Trooth checks it.", "checked_at": null }
```

- `host`: the owner's choice (`setup/host`) when made, else the detected host (`src/serve/detect.ts`), else `unknown`. Host detection runs on the first poll in the install step and again at most once an hour, or on `POST /os/semanto/{id}/detect`.
- `guide_id` per host: `cloudflare` `cloudflare-worker`, `vercel` `vercel-middleware`, `netlify` `netlify-edge`, `fastly` `fastly-compute`, `akamai` `akamai-edgeworkers`, `gcore` `gcore-fastedge`, `nginx` `nginx-config`, `apache` `apache-config`, `wordpress` `wordpress-plugin`, `shopify` `shopify-app`, `webflow` `webflow-head-code`, `squarespace` `squarespace-code-injection`, `wix` `wix-custom-code`, `head_tag` `head-tag`, `unknown` `pick-host`.
- Shopify, Webflow, Squarespace and Wix are detected from these signals, which have not yet been confirmed on live sites: Shopify `powered-by: Shopify` or an `x-shopid` header or `cdn.shopify.com` in the page; Squarespace `server: Squarespace`; Wix an `x-wix-request-id` header; Webflow `<meta name="generator" content="Webflow">`.
- With no host detected or chosen, `message` is "We could not tell where your site runs. Pick it from the list."
- `checks.*`: `pass`, `fail` or `pending`. `message` is one plain sentence: the success line, or the first failure and its fix.

### monitoring

```json
{ "started_at": null, "questions": [], "competitors": [], "suggested_questions": ["What does Acme Inc do?"] }
```

### timings

`measureSetup` output:

```json
{
  "steps": [{ "id": "sign_in", "target_seconds": 30, "spent_seconds": 0, "within_target": true }],
  "basic": { "target_seconds": 600, "spent_seconds": null, "within_target": null },
  "full": { "target_seconds": 900, "spent_seconds": null, "within_target": null },
  "not_started": ["company", "prove_domain"]
}
```

`basic.spent_seconds` is the sum of steps 1 to 4 once all four are done, else null; `full` likewise for steps 1 to 9.

### next_action

The one primary action for the current step, `{ label, method, url }`, or null when the step is `done`. Labels: `company` "Continue" (POST `setup/start`); `prove` "Add the record, then wait here" (GET `setup`), or "Add it at <provider>" (GET `domain_connect_url`) when that URL is present; `read` "Finish setup" (POST `setup/choose`) once the read is done, else "Wait for the read" (GET `setup`); `review` "Confirm these facts" (POST `setup/confirm`) until confirmed; then, with hosted custody, "Add a passkey" (POST `passkeys/options`) while the signed-in person has none and "Sign with my passkey" (POST `sign/options`) once they have one; with customer custody, "Sign with our own key" (POST `sign`); `install` "Check my site" (POST `setup/install-check`) until it passes, then "Start monitoring" (POST `setup/monitoring`).

## Setup routes

| Route | Body | Who | Answer |
| --- | --- | --- | --- |
| `GET /os/semanto/setup` | | any vendor session | the setup state for the session's company, or the `company` step |
| `POST /os/semanto/setup/start` | `{ "org": "Acme Inc", "domain": "https://www.acme.com/about" }` | any vendor session | 201 with the setup state (company created) or 200 (already linked to this session's company with the same domain). Claims the company and queues a held read of the public site at once. |
| `POST /os/semanto/claim` | `{ "domain": "acme.com", "org": "Acme Inc" }` | any vendor session | 201 or 200 `{ "object": "semanto.claim", "trooth_id", "domain", "org", "created": boolean, "owner": boolean }`. Claims without starting a read. |
| `GET /os/semanto/{id}/setup` | | viewer and up | the setup state, with the live DNS check when proving |
| `GET /os/semanto/{id}/setup/review` | | viewer and up | the facts to review (below) |
| `POST /os/semanto/{id}/setup/look-again` | `{}` | member and up | restarts the 72-hour proof window |
| `POST /os/semanto/{id}/setup/read-again` | `{}` | member and up | queues a new read (held until the domain is proven) |
| `POST /os/semanto/{id}/setup/choose` | `{ "path": "basic" }` or `{ "path": "full" }` | member and up for basic, owner or admin for full | completes step 4; `full` moves the company to the full tier |
| `POST /os/semanto/{id}/setup/confirm` | `{ "version": 1, "root_hash": "sha256:<64 hex>" }` | owner or admin | completes step 5. A root hash that is not the newest build is a 409 problem: "This version changed while you were reviewing. Review the changes, then confirm." |
| `POST /os/semanto/{id}/setup/host` | `{ "host": "webflow" }` | owner or admin | the owner's host choice (the "Change" link) |
| `POST /os/semanto/{id}/setup/install-check` | `{}` | member and up | `{ "object": "semanto.install_check", "url", "checks", "messages": { "markdown", "signature", "well_known" }, "message", "checked_at", "setup": <setup state> }` |
| `POST /os/semanto/{id}/setup/monitoring` | `{ "questions"?: string[], "competitors"?: [{ "name", "domain" }] }` (at most 10 questions, 3 competitors) | owner or admin | saves the questions and competitors, starts the first report (queued when the queue is bound) and completes step 9 |
| `POST /os/semanto/{id}/setup/save-for-later` | `{ "screen"?: "A" to "F" }` | member and up | `saved_for_later: true`; the state is kept on the server |
| `POST /os/semanto/{id}/setup/resume` | `{}` | member and up | `saved_for_later: false` |

The domain is fixed at the claim. Later requests never change it: a start or claim for a different domain by a session whose company already has one is a 409 problem with code `domain_fixed`. A domain already linked to another worker-f company is a 409 problem with code `domain_claimed_elsewhere` and the words "acme.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim."

The website field accepts a pasted address: the scheme, a leading `www.`, any path, query and port are removed, and the host is lowercased. The Trooth ID is worker-f's `companySlug` when the session carries one and it is free, else the first label of the registrable domain (`acme.com` is `acme`), else the whole host with dots as hyphens (`acme-io`), else that with `-2`, `-3` and so on. The names `setup`, `claim`, `log`, `verify`, `first-publication`, `keys`, `revocations` and `well-known` are never given.

## Passkey routes (hosted signing)

Trooth keeps a hosted company key and releases it only after a passkey assertion. These routes follow W3C Web Authentication Level 3: section 7.1 to add a passkey, section 7.2 for the assertion. Options are answered in the JSON form of `PublicKeyCredentialCreationOptions` and `PublicKeyCredentialRequestOptions`: every buffer is base64url. The relying party id is `trooth.co` (the Worker's `WEBAUTHN_RP_ID` when set); accepted origins are `https://trooth.co` and `https://www.trooth.co`, and `http://localhost` on any port only when `ENVIRONMENT` is `development`. Every challenge is 32 random bytes, kept five minutes, and used once.

| Route | Body | Who | Answer |
| --- | --- | --- | --- |
| `POST /os/semanto/{id}/passkeys/options` | `{}` | any workspace user | `{ "object": "semanto.passkey_options", "trooth_id", "expires_at", "has_passkey", "publicKey": { "rp": { "id": "trooth.co", "name": "Trooth" }, "user": { "id": "<base64url of 32 random bytes, kept per user>", "name", "displayName" }, "challenge", "pubKeyCredParams": [ES256 -7, EdDSA -8, RS256 -257], "timeout": 300000, "excludeCredentials", "authenticatorSelection": { "residentKey": "preferred", "requireResidentKey": false, "userVerification": "required" }, "attestation": "none" }, "next" }` |
| `POST /os/semanto/{id}/passkeys` | `{ "credential": <PublicKeyCredential JSON from navigator.credentials.create> }` | the same user | 201 `{ "object": "semanto.passkey", "trooth_id", "credential_id", "alg", "transports", "backed_up", "created_at" }`. Checked: type `webauthn.create`, the challenge (consumed), an allowed origin, attestation format `none` (or `packed` self attestation; any other format is refused in plain words), the rp id hash, the UP (user present) and UV (user verification) flags, the attested credential data and its algorithm. The public key is stored as a JWK with its sign count and transports. |
| `POST /os/semanto/{id}/sign/options` | `{ "version"?: n }` | owner or admin, hosted custody | `{ "object": "semanto.sign_options", "trooth_id", "version", "root_hash", "expires_at", "publicKey": { "challenge", "rpId", "allowCredentials", "userVerification": "required", "timeout": 300000 }, "next" }`. The challenge is bound to this person, this version and this root hash. 409 `passkey_missing` when the person has no passkey yet. |
| `POST /os/semanto/{id}/sign` | hosted: `{ "version": n, "assertion": { "id", "clientDataJSON", "authenticatorData", "signature", "userHandle" } }` | owner or admin | Checked before the key is released: the challenge is the one issued for this version and root hash (consumed), type `webauthn.get`, an allowed origin, the rp id hash, the UP (user present) and UV (user verification) flags, the signature over authenticatorData and the SHA-256 of clientDataJSON with the stored key (ES256, EdDSA or RS256), and a sign count that grows when either count is not zero, written with one conditional update (`WHERE sign_count < new` or both zero): when no row changes, another assertion at that count was used first and the answer is `passkey_counter`. Then the approval is recorded with `{ credential_id, user_id, user_handle, checked_at }` (the internal `user_id` stays in the approval record for the two-officer count), and the version's `identity.authorized_by` entry gets `{ credential_id, user_handle, checked_at }`: the random base64url WebAuthn user handle is the only person reference in the signed public header. Customer custody is unchanged: the company signs the signing input with its own key. |

### Review document

`GET /os/semanto/{id}/setup/review`:

```json
{
  "object": "semanto.setup_review",
  "trooth_id": "acme",
  "version": 1,
  "root_hash": "sha256:<64 hex>",
  "changed_since_read": false,
  "changed_urls": [],
  "sections": [
    { "id": "company", "title": "Company", "facts": [{ "id": "smf_<26>", "key": "company.name", "statement": "Acme Inc", "value": "Acme Inc", "provenance": "declared", "source_url": "https://acme.com/about", "source_title": "About Acme" }] },
    { "id": "products", "title": "Products", "facts": [] },
    { "id": "contact", "title": "Contact and hours", "facts": [] },
    { "id": "policies", "title": "Policies", "facts": [] }
  ],
  "pages": [{ "id": "smp_<26>", "url": "https://acme.com/about", "title": "About Acme" }]
}
```

Facts whose key fits none of the first three sections go under `policies`. A fact is the site's own words, so a wrong fact is fixed on the site: change the page, then `setup/read-again`. Semanto never signs words the site does not say.

## Workspace routes added by the audit fixes

| Route | Body | Who | Answer |
| --- | --- | --- | --- |
| `POST /os/semanto/{id}/withdraw` | `{ "version": 2, "reason": "plain words, required" }` | owner or admin | `{ "object": "semanto.withdrawn", "trooth_id", "version", "version_id", "revoked_at", "log_index", "revocations_url" }`. The version answers `semanto_withdrawn` (410) from then on; when it was the current signed version, the newest earlier signed version that is not withdrawn becomes current, or none. |
| `POST /os/semanto/{id}/keys/{kid}/revoke` | `{ "reason": "plain words, required", "compromised_at"?: "<ISO time>" }` | owner or admin | `{ "object": "semanto.key_revoked", "trooth_id", "kid", "revoked_at", "log_index", "revocations_url" }`. `compromised_at` backdates `revoked_at`: signatures made after it no longer check out. It cannot be in the future. |
| `GET /os/semanto/{id}/keys` | | viewer and up | `{ "object": "semanto.keys", "trooth_id", "keys": [{ "kid", "custody", "state", "sentence", "created_at", "nbf"?, "exp"?, "revoked_at"? }], "binding": <BindingStatus from src/identity/keys.ts for the current key, or null> }` |
| `POST /os/semanto/{id}/detect` | `{}` | member and up | the `DetectionResult` of `src/serve/detect.ts`, stored for the install step |
| `GET /os/semanto/{id}/writeback` | | viewer and up | `{ "object": "semanto.writeback_preview", "trooth_id", "payloads": [WritebackPayload], "skipped": [{ "connector", "why" }] }`, previews only; nothing is sent |
| `POST /os/semanto/{id}/competitor-report` | `{ "kind": "local" or "shopping", "competitors": [{ "name", "domain" }] }` (1 to 3) | member and up | `{ "object": "semanto.competitor_report", "view": <CompetitorView>, "markdown" }` |
| `GET /os/semanto/{id}/receipts?day=YYYY-MM-DD` | | viewer and up | `{ "object": "semanto.receipts_digest", "trooth_id", "day", "digest", "jws", "rows" }`, the day's digest signed by Trooth's witness key (yesterday when `day` is absent) |
| `GET /os/semanto/{id}/receipts.csv?from=&to=` | | viewer and up | `text/csv` with the columns of `CSV_COLUMNS` in `src/readers/receipts.ts` plus `count` |
| `POST /os/semanto/{id}/monitor/run` | as before | member and up | as before, plus `content_signals`: the drift between the signed Content Signals and the site's robots.txt and home page headers (`checkContentSignalsDrift`) |
| `POST /os/semanto/{id}/build` | `{}` | member and up | 409 `domain_not_proven` until the domain is proven; otherwise as before (202 queued) |
| `POST /os/semanto/{id}/sign`, `first-publication` | as before | as before | 409 `domain_not_proven` until the domain is proven |
| `POST /os/semanto/{id}/basic/claim` | `{ "domain"?: "acme.com" }` | as before | answers the proof record above. A `domain` that differs from the company's is a 409 `domain_fixed` problem. |
| `POST /os/semanto/{id}/basic/prove` | `{}` | as before | checks the record; when found, records the proof and queues the read (or promotes a finished held read). Never compiles inside the request. |

## Public routes added by the audit fixes

| Route | Answer |
| --- | --- |
| `GET /public/semanto/.well-known/trooth-keys.json` and `GET /public/semanto/keys/trooth.json` | Trooth's witness JWK Set: the current witness key and any earlier ones from `TROOTH_WITNESS_PREVIOUS_KEYS`, each with its `exp` or `revoked_at` when set, so a verifier judges a key at the signature's `iat`. The three verifier CLIs read this URL by default. worker-f may also serve it at `https://api.trooth.co/.well-known/trooth-keys.json` (a founder step: add that route). |
| `GET /public/semanto/{id}/revocations` | `{ "object": "semanto.revocation_list", "trooth_id", "jws", "list" }`: the company's revocation list (typ `https://trooth.co/types/revocation-list`), signed by Trooth's witness key, valid 24 hours, re-signed on every withdrawal and key revocation and nightly. Before the first withdrawal or key revocation there is no list: a 404 `semanto_not_found` problem, "No revocation list has been signed yet." |
| `GET /public/semanto/revocations` | the same for every company (`trooth_id` null) |
| `GET /public/semanto/{id}/sellers?domain=&sku=` | `{ "object": "semanto.seller_authorization" }` plus the fields of `AuthorizationAnswer`, from the brand's seller attestations (`src/commerce/sellers.ts`) |
| `POST /public/semanto/catalogs/check` | body `{ "jws": "<compact JWS of a marketplace catalog>" }`, at most 5 MB; answers `verifyCatalog` (`src/commerce/nested.ts`), each layer resolved against the Trooth keys of the companies it names |
| `GET /public/semanto/{id}/synonyms?name=` | `{ "object": "semanto.synonyms", "name", "group", "synonyms" }` from `src/commerce/synonyms.ts` |

## Rate limits and body caps

- Public routes: a token bucket per client address and route group, held in the `RateLimitDO` Durable Object bound as `RATE` (`RATE_LIMITS` in `src/readers/rate-limit.ts`): `read` (pages, files, keys, commerce) 120 requests at once and 2 a second after that; `log` (the log routes) 60 at once and 2 a second; `check` (`verify`, `first-publication/check`, `catalogs/check`) 10 at once and one every 5 seconds. Over the limit is a 429 `rate_limited` problem with `Retry-After` in whole seconds. The client address is Cloudflare's own `CF-Connecting-IP`. `/os` routes are not limited here; worker-f's session check gates them.
- Read receipts are counted per minute inside the same Durable Object class (one object per company) and written to D1 in one batch a minute: one row per company, version, page, representation, proof, agent and address hash per minute, with a `count`, never one row per request.
- The Web Bot Auth key directory fetch is limited per directory origin and per client address.
- Every POST body is capped at 5 MB; a larger body is a 413 `payload_too_large` problem, refused before it is read when `Content-Length` says so, and cut off at the cap otherwise.

## Problem codes used here

| code | status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | no session, an ended session, a buyer account, or no company mapped to it |
| `forbidden` | 403 | another company's session, or a role that cannot do this (a buyer account is a 401: it has no company) |
| `invalid_request` | 400 | a missing or wrong field; the detail names it |
| `domain_fixed` | 409 | the domain was fixed at the claim and cannot change |
| `domain_claimed_elsewhere` | 409 | another Trooth workspace holds the domain |
| `domain_not_proven` | 409 | prove the domain first |
| `conflict` | 409 | the record is not in the state this step needs |
| `semanto_withdrawn` | 410 | the version was withdrawn |
| `representation_not_offered` | 404 | the company turned this format off in its delivery settings |
| `payload_too_large` | 413 | the body is over 5 MB |
| `rate_limited` | 429 | over the limit; wait `Retry-After` seconds |
| `internal_error` | 500 | a fault inside Trooth; quote the request id |
| `passkey_missing` | 409 | "Add a passkey first": hosted signing needs a passkey; the detail names `passkeys/options` |
| `passkey_challenge_expired` | 409 | the passkey request is older than five minutes or was already used; start the passkey step again |
| `passkey_origin_mismatch` | 403 | the passkey answer came from a page that is not trooth.co |
| `passkey_cancelled` | 400 | no assertion was sent (the device step did not finish); nothing was signed |
| `passkey_invalid` | 422 | the passkey answer does not check out (another site's passkey, no user verification, a bad signature, another version's challenge, someone else's passkey) |
| `passkey_counter` | 422 | the passkey's sign count did not go up, which can mean it was copied; the key is not released |
| `witness_key_missing` | 503 | this deployment has no witness key yet; routes that sign or witness answer this, the rest keep working. This answer cannot carry a signature, because the key that signs answers is the missing one. |
