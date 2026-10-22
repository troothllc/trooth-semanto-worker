<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- What Semanto signs on every HTTP response, how a reader verifies it, and every header it sends. Follows RFC 9421 (HTTP Message Signatures), RFC 9530 (Digest Fields), RFC 8288 (Web Linking), RFC 6648 (no X- prefix on any Trooth header; the only X- names are the two token headers, kept under the names Cloudflare's Markdown for Agents uses, for compatibility). -->

# Response signatures

Web Bot Auth lets an agent sign its request. Semanto signs the answer. Every response Semanto serves, on api.trooth.co or through an adapter on the company's own domain, carries an RFC 9421 signature with tag `trooth-semanto` and an RFC 9530 Content-Digest (two exceptions, both without a body that says anything: a CORS preflight `OPTIONS` answer, and the `witness_key_missing` 503 of a deployment that has no witness key, which cannot be signed because the signing key is the missing one), so a reader can hold the bytes and show later that this is what the company published, unchanged. The reference implementation is `src/core/httpsig.ts` and `src/serve/headers.ts`; the standalone verifiers in `verifier/` re-implement the check, and `verifier/test-vectors/v1/response.json` is a complete signed response.

## What is signed

The signature always covers these components, in this order (`SEMANTO_RESPONSE_COMPONENTS` in `src/core/httpsig.ts`):

| Component | Why it is covered |
| --- | --- |
| `@status` | A 200 cannot be replayed as a 404 or the other way around. |
| `content-type` | The representation (markdown, JSON-LD, JSON) is part of what was said. |
| `content-digest` | The body, through its RFC 9530 digest. Changing one byte of the body breaks the signature. |
| `trooth-semanto-version` | Which signed version the bytes belong to. |
| `trooth-page-hash` | The digest of the exact body bytes of this response, which a reader can always check against the body and Content-Digest. |

Then every one of these the response carries, in this order (`SEMANTO_RESPONSE_OPTIONAL_COMPONENTS`):

| Component | When it is present |
| --- | --- |
| `trooth-signed-page-hash` | The body is derived from a signed page: the page's JSON-LD, the page served with the behind notice, the page's proof object. It is the manifest hash of that page. |
| `trooth-signed-by` | Trooth's witness key made the signature. |
| `trooth-semanto-state` | `behind`, or `witnessed-not-signed` for a Semanto Basic record. |
| `location` | A 303 to the company's HTML page. Redirects are signed like every other response; they are navigation and never content. |
| `content-signal` | The company's content signals. |
| `link` | The relations a reader follows. |

A verifier reads the covered list from `Signature-Input`. It refuses a response that carries `Trooth-Signed-Page-Hash`, `Trooth-Signed-By`, `Trooth-Semanto-State` or `Location` without covering it (`header_not_covered`); an uncovered `Content-Signal` or `Link` is reported and not relied on.

Nothing request-derived is covered: not `@method`, `@target-uri` or `@authority`. A signed response is the same for every reader of the same bytes, which is what lets it be cached by a CDN, stored, forwarded and checked by someone who did not fetch it.

Signature parameters: `created` (unix seconds), `expires`, `keyid` (the RFC 7638 thumbprint of the key), `alg="ed25519"`, `tag="trooth-semanto"`. No `nonce`. The signature label is `sig1`. `expires` is `created` plus `max-age` plus `stale-while-revalidate`, 3,900 seconds (`SIGNATURE_TTL_SECONDS`), so a response a cache serves at the very end of its life still verifies. The freshness of the statement is carried by the signed version's own validity (`not_before`, `not_after`, the revocation list), not by the transport signature: a transport signature only says these bytes left Semanto unchanged.

Which key signs: the company's hosted key when Trooth holds it, the company's own key when the company signs through its adapter, or Trooth's witness key when neither is available for this response (then `Trooth-Signed-By: witness` says so, and the response proves Trooth served these bytes, not that the company signed them).

## The headers

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `text/markdown; charset=utf-8`, `application/ld+json`, `application/json`, or `text/html` | Chosen by Accept or path suffix (`docs/spec/delivery.md`). |
| `Content-Digest` | `sha-256=:<base64>:` over the body | RFC 9530. |
| `Content-Length` | | |
| `Trooth-Contract` | `1` | The schema contract. A reader pins it on requests the same way. |
| `Trooth-Semanto-Version` | the `smv_` id, or `none` | |
| `Trooth-Page-Hash` | `sha256:` plus 64 hex | ALWAYS the digest of the exact body bytes of this response. For a page's markdown that is also the manifest hash. |
| `Trooth-Signed-Page-Hash` | `sha256:` plus 64 hex, when set | The manifest hash of the signed page when the body is derived from it (the page's JSON-LD, the page with the behind notice, its proof). Covered. |
| `Trooth-Semanto-State` | `behind` or `witnessed-not-signed`, when set | `behind`: the live page moved on after signing and the last signed bytes are served with a notice in front. `witnessed-not-signed`: a Semanto Basic record, witnessed by Trooth and not signed by the company; every body carries the same notice. Covered. |
| `Trooth-Signed-By` | `witness`, when set | Present only when Trooth's witness key made the signature instead of the company's. Covered. |
| `Location` | the page on the company's domain | On a 303. Covered. |
| `Signature-Input`, `Signature` | RFC 9421 | As above. |
| `Link` | `rel="canonical"`, `rel="alternate"; type="text/markdown"`, `rel="alternate"; type="application/ld+json"`, `rel="https://trooth.co/rel/semanto"`, `rel="https://trooth.co/rel/trust-profile"`, `rel="https://trooth.co/rel/proof"`, `rel="https://trooth.co/rel/keys"` | The relations a reader follows: the other representations, the whole file, the Trust Profile, the page's proof, the JWK Set. |
| `Content-Signal` | `ai-train=no, search=yes, ai-input=yes` form | The company's content signals from the signed controls (contentsignals.org). |
| `ETag` | `"<page hash hex>"` strong | Kept across hosts; `If-None-Match` answers 304 with the same headers and a new signature made over status 304, which a reader checks against the body it already holds. |
| `Vary` | `Accept` | Every cache keeps the representations apart. |
| `Cache-Control` | `public, max-age=300, stale-while-revalidate=3600` | The signature lasts the whole 3,900 seconds. |
| `x-markdown-tokens`, `x-original-tokens` | integers | Estimates, under the names Cloudflare's Markdown for Agents uses, so an agent reading both gets the same header. The method is in `src/core/tokens.ts`; the number is never presented as a measurement from a specific model. |

No header carries an `X-` prefix (RFC 6648). The names are the same on api.trooth.co and on every adapter.

## How to verify a response

Given the status, the headers and the body at an instant `now`:

1. Verify `Content-Digest` against the body. If it does not match, stop: the body is not the one that was signed. Reason `content_digest_mismatch`.
2. Parse `Signature-Input` and `Signature`. Pick the signature whose `tag` is `trooth-semanto`. If there is none, the response is unsigned (`no_signature`).
3. Refuse `created` or `expires` that is not an Integer (`malformed`), `alg` other than `ed25519` (`unsupported_alg`), a signature that does not cover the five fixed components (`missing_component`), `now` at or after `expires` (`expired`), or `created` more than 60 seconds in the future (`not_yet_valid`).
4. Resolve `keyid` in one key set, chosen by who signed: when the response says `Trooth-Signed-By: witness`, Trooth's set at `https://api.trooth.co/.well-known/trooth-keys.json`; otherwise the company's set at `/.well-known/trooth-keys.json` on the domain (also linked with `rel="https://trooth.co/rel/keys"`). The two sets are never merged. Unknown kid: `unknown_key`. The key is judged at `created`, when it signed: outside its `nbf`/`exp` window then, or with `revoked_at` at or before `created`: `key_not_yet_valid`, `key_expired`, `key_revoked`. A key revoked after `created` still verifies, and the result carries the note "key revoked after signing on <date>".
5. Build the RFC 9421 signature base from the covered components and the raw signature parameters, and verify the Ed25519 signature. Failure: `bad_signature`.
6. Check that every optional Trooth header present, and `Location`, is covered (`header_not_covered`).
7. Check that SHA-256 of the body equals `Trooth-Page-Hash`, always. Failure: `page_hash_mismatch`. When `Trooth-Signed-Page-Hash` is present, it names the signed page the body is derived from; check it against the page proof (step 9).
8. Optionally, check the key's domain binding: the `kid` appears in the `_trooth-keys.<domain>` TXT record (`v=trooth1; kid=<thumbprint>`). Report `bound to the domain` or `bound to the web host`; do not fail on it, because many companies cannot edit DNS quickly.
9. Optionally, follow `rel="https://trooth.co/rel/proof"` and verify the page proof (`docs/spec/log.md`).

A verifier reports the first failing step and never shows later steps as passed. The command `semanto-verify response <url>` in any of the three kits prints each step in plain words.

## An example

From the vectors, `GET https://acme.com/security` with `Accept: text/markdown`:

```
HTTP/1.1 200 OK
Content-Type: text/markdown; charset=utf-8
Content-Digest: sha-256=:YfSIot2m45x3ctsg60TBP+ccy1YRMZn5VNiAQtXSxBA=:
Trooth-Contract: 1
Trooth-Semanto-Version: smv_sf26uv6f5niw6xllfj2i6ru6ym
Trooth-Page-Hash: sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410
Link: <https://acme.com/security>; rel="canonical", <https://api.trooth.co/public/semanto/acme/pages/smp_mh2iriw5u3rzy53s3mqowrgbh7/proof>; rel="https://trooth.co/rel/proof", <https://acme.com/.well-known/trooth-keys.json>; rel="https://trooth.co/rel/keys", <https://acme.com/.well-known/trooth.semanto>; rel="https://trooth.co/rel/semanto"
Content-Signal: ai-train=no, search=yes, ai-input=yes
Signature-Input: sig1=("@status" "content-type" "content-digest" "trooth-semanto-version" "trooth-page-hash" "content-signal" "link");created=1792670400;expires=1792674300;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";alg="ed25519";tag="trooth-semanto"
Signature: sig1=:pVEDmb8ECtZ+MSwgC16h8UWYngTXhZDrJQmtzU3215cSLtQkFAuNp+JB6jX6wWr2YnXhTFT1xiAm2AFyrdqxDg==:
```

`verifier/test-vectors/v1/response-page-jsonld.json` is the page's JSON-LD (its own Trooth-Page-Hash, and Trooth-Signed-Page-Hash naming the markdown page) and `response-semanto-object.json` is the semanto object; `negative/response-uncovered-header.json` carries Trooth-Signed-Page-Hash outside the signature and must fail.

The signature base, line by line:

```
"@status": 200
"content-type": text/markdown; charset=utf-8
"content-digest": sha-256=:YfSIot2m45x3ctsg60TBP+ccy1YRMZn5VNiAQtXSxBA=:
"trooth-semanto-version": smv_sf26uv6f5niw6xllfj2i6ru6ym
"trooth-page-hash": sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410
"content-signal": ai-train=no, search=yes, ai-input=yes
"link": <https://acme.com/security>; rel="canonical", <https://api.trooth.co/public/semanto/acme/pages/smp_mh2iriw5u3rzy53s3mqowrgbh7/proof>; rel="https://trooth.co/rel/proof", <https://acme.com/.well-known/trooth-keys.json>; rel="https://trooth.co/rel/keys", <https://acme.com/.well-known/trooth.semanto>; rel="https://trooth.co/rel/semanto"
"@signature-params": ("@status" "content-type" "content-digest" "trooth-semanto-version" "trooth-page-hash" "content-signal" "link");created=1792670400;expires=1792674300;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";alg="ed25519";tag="trooth-semanto"
```

## Web Bot Auth, the other direction

Semanto also verifies the agent's request signature per draft-ietf-webbotauth-httpsig-protocol (`src/readers/webbotauth.ts`, `verifier/test-vectors/v1/web-bot-auth-request.json`). The order matters, because the key directory is a URL a stranger chose:

1. Exactly one signature labelled `tag="web-bot-auth"`; a second one is refused (`more_than_one_label`), so a decoy label with a fresh nonce cannot carry a replayed signature.
2. That label covers `@authority` and `signature-agent`; `created` and `expires` are Integers no more than 360 seconds apart; a `nonce` is present and has not been seen.
3. Only then is the directory fetched, always at `<origin of Signature-Agent>/.well-known/http-message-signatures-directory` (a path or query in Signature-Agent is dropped), and only when the origin passes `src/core/ssrf.ts`: https, a host name and never an IP literal, no private, reserved or local name, and resolved addresses checked over DNS over HTTPS, failing closed. Redirects are refused; the body is capped at 64 KB and the fetch at 3 seconds; a good directory is cached between 5 minutes and 24 hours; a failure is remembered per origin for 5 minutes.
4. That one label's signature is checked, with the key judged at `created`.
5. Only then is that label's nonce claimed, atomically, in the NonceDO Durable Object (`src/readers/nonce-do.ts`; KV is a fallback that is not atomic).

A request that checks out names a key directory, and only that: a read receipt records the directory, never a guess from the User-Agent string.

### Through an adapter

On the company's domain an agent signs `@authority` as the company's host, and the adapter forwards to api.trooth.co, where the authority is different. The adapter forwards the agent's `Signature`, `Signature-Input` and `Signature-Agent` unchanged, adds `Trooth-Forwarded-Authority` (the host the agent addressed) and `Trooth-Forwarded-For` (the client address), and signs its forwarding request with its connector key in `Trooth-Connector-Signature-Input` and `Trooth-Connector-Signature`: RFC 9421, tag `trooth-connector`, over `@method`, `@target-uri`, `trooth-forwarded-authority`, `trooth-forwarded-for`, `signature`, `signature-input` and `signature-agent`, with a nonce. The connector signature has its own fields because the Signature fields hold the agent's, which it covers whole (the same job RFC 9421 section 4.3 does for a proxy). The API checks the connector signature against that company's connector keys first; only when it passes is the agent's signature checked with the forwarded authority as `@authority`, and only then is the forwarded address used (hashed with a daily salt, never kept). An unsigned forwarded header is ignored. nginx and Apache cannot sign, so a read through them is an "unproven reader" unless the agent's request reaches the API directly (`adapters/README.md`).

## Errors

Every error is an RFC 9457 problem (`application/problem+json`) with `code`, `retryable`, `next_action`, `terminal`, and a markdown form for `Accept: text/markdown`. Error responses are signed the same way as successful ones, with `@status` covered, so a reader can tell a signed not-found from a dropped connection.

## In the Internet-Draft

`docs/draft-trooth-signed-web-content-00.md` specifies the same mechanism with generic names: tag `signed-web-content`, header fields `Content-Version` and `Content-Hash`, the JWK Set at `/.well-known/signed-web-content-keys.json`, the TXT record at `_swc.<domain>`. The Trooth names above are the deployed implementation and are given in the draft as implementation notes.
