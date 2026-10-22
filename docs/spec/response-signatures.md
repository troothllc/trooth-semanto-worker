<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- What Semanto signs on every HTTP response, how a reader verifies it, and every header it sends. Follows RFC 9421 (HTTP Message Signatures), RFC 9530 (Digest Fields), RFC 8288 (Web Linking), RFC 6648 (no X- prefixes), and the names Cloudflare's Markdown for Agents uses for the token headers. -->

# Response signatures

Web Bot Auth lets an agent sign its request. Semanto signs the answer. Every response Semanto serves, on api.trooth.co or through an adapter on the company's own domain, carries an RFC 9421 signature with tag `trooth-semanto` and an RFC 9530 Content-Digest, so a reader can hold the bytes and show later that this is what the company published, unchanged. The reference implementation is `src/core/httpsig.ts` and `src/serve/headers.ts`; the standalone verifiers in `verifier/` re-implement the check, and `verifier/test-vectors/v1/response.json` is a complete signed response.

## What is signed

The signature covers exactly these components, in this order (`SEMANTO_RESPONSE_COMPONENTS` in `src/core/httpsig.ts`):

| Component | Why it is covered |
| --- | --- |
| `@status` | A 200 cannot be replayed as a 404 or the other way around. |
| `content-type` | The representation (markdown, JSON-LD, JSON) is part of what was said. |
| `content-digest` | The body, through its RFC 9530 digest. Changing one byte of the body breaks the signature. |
| `trooth-semanto-version` | Which signed version the bytes belong to. |
| `trooth-page-hash` | The page's hash in the signed manifest, which ties the response to the file and its proof. |

Nothing request-derived is covered: not `@method`, `@target-uri` or `@authority`. A signed response is the same for every reader of the same bytes, which is what lets it be cached by a CDN, stored, forwarded and checked by someone who did not fetch it.

Signature parameters: `created` (unix seconds), `expires` (`created` plus 300 seconds; `SIGNATURE_TTL_SECONDS`), `keyid` (the RFC 7638 thumbprint of the key), `alg="ed25519"`, `tag="trooth-semanto"`. No `nonce`. The signature label is `sig1`.

Which key signs: the company's hosted key when Trooth holds it, the company's own key when the company signs through its adapter, or Trooth's witness key when neither is available for this response (then `Trooth-Signed-By: witness` says so, and the response proves Trooth served these bytes, not that the company signed them).

## The headers

| Header | Value | Notes |
| --- | --- | --- |
| `Content-Type` | `text/markdown; charset=utf-8`, `application/ld+json`, `application/json`, or `text/html` | Chosen by Accept or path suffix (`docs/spec/delivery.md`). |
| `Content-Digest` | `sha-256=:<base64>:` over the body | RFC 9530. |
| `Content-Length` | | |
| `Trooth-Contract` | `1` | The schema contract. A reader pins it on requests the same way. |
| `Trooth-Semanto-Version` | the `smv_` id, or `none` | |
| `Trooth-Page-Hash` | `sha256:` plus 64 hex | The page hash in the manifest for a page; the digest of the served bytes for other representations. |
| `Trooth-Semanto-State` | `behind` or `unsigned`, when set | Present only when the live page moved on after signing and the delivery setting says to serve the last signed version marked as behind, or the live page marked as unsigned. Absent on a current signed page. |
| `Trooth-Signed-By` | `witness`, when set | Present only when Trooth's witness key made the signature instead of the company's. |
| `Signature-Input`, `Signature` | RFC 9421 | As above. |
| `Link` | `rel="canonical"`, `rel="alternate"; type="text/markdown"`, `rel="alternate"; type="application/ld+json"`, `rel="https://trooth.co/rel/semanto"`, `rel="https://trooth.co/rel/trust-profile"`, `rel="https://trooth.co/rel/proof"`, `rel="https://trooth.co/rel/keys"` | The relations a reader follows: the other representations, the whole file, the Trust Profile, the page's proof, the JWK Set. |
| `Content-Signal` | `ai-train=no, search=yes, ai-input=yes` form | The company's content signals from the signed controls (contentsignals.org). |
| `ETag` | `"<page hash hex>"` strong | Kept across hosts; `If-None-Match` answers 304 with the same signature headers. |
| `Vary` | `Accept` | Every cache keeps the representations apart. |
| `Cache-Control` | `public, max-age=300, stale-while-revalidate=3600` | Matches the signature window. |
| `x-markdown-tokens`, `x-original-tokens` | integers | Estimates, under the names Cloudflare's Markdown for Agents uses, so an agent reading both gets the same header. The method is in `src/core/tokens.ts`; the number is never presented as a measurement from a specific model. |

No `X-Semanto-*` header exists (RFC 6648). The names are the same on api.trooth.co and on every adapter.

## How to verify a response

Given the status, the headers and the body at an instant `now`:

1. Verify `Content-Digest` against the body. If it does not match, stop: the body is not the one that was signed. Reason `content_digest_mismatch`.
2. Parse `Signature-Input` and `Signature`. Pick the signature whose `tag` is `trooth-semanto`. If there is none, the response is unsigned (`no_signature`).
3. Refuse `alg` other than `ed25519` (`unsupported_alg`), a signature that does not cover all five components (`missing_component`), `now` at or after `expires` (`expired`), or `created` more than 60 seconds in the future (`not_yet_valid`).
4. Resolve `keyid` against the company's JWK Set at `/.well-known/trooth-keys.json` on the domain (also linked with `rel="https://trooth.co/rel/keys"`) and Trooth's at `https://api.trooth.co/.well-known/trooth-keys.json`. Unknown kid: `unknown_key`. Key outside its `nbf`/`exp` window or past `revoked_at`: `key_not_yet_valid`, `key_expired`, `key_revoked`.
5. Build the RFC 9421 signature base from the covered components and the raw signature parameters, and verify the Ed25519 signature. Failure: `bad_signature`.
6. Check that SHA-256 of the body equals `Trooth-Page-Hash` (for a page). Failure: `page_hash_mismatch`.
7. Optionally, check the key's domain binding: the `kid` appears in the `_trooth-keys.<domain>` TXT record (`v=trooth1; kid=<thumbprint>`). Report `bound to the domain` or `bound to the web host`; do not fail on it, because many companies cannot edit DNS quickly.
8. Optionally, follow `rel="https://trooth.co/rel/proof"` and verify the page proof (`docs/spec/log.md`).

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
Signature-Input: sig1=("@status" "content-type" "content-digest" "trooth-semanto-version" "trooth-page-hash");created=1792670400;expires=1792670700;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";alg="ed25519";tag="trooth-semanto"
Signature: sig1=:pQposla4OcEMJczN9oimjbTUpMJ6buPldy0IhTwiauasKnhyBYGcmyN84k0H8SftADRoO2v+uOQHl6li/zETAw==:
```

The signature base, line by line:

```
"@status": 200
"content-type": text/markdown; charset=utf-8
"content-digest": sha-256=:YfSIot2m45x3ctsg60TBP+ccy1YRMZn5VNiAQtXSxBA=:
"trooth-semanto-version": smv_sf26uv6f5niw6xllfj2i6ru6ym
"trooth-page-hash": sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410
"@signature-params": ("@status" "content-type" "content-digest" "trooth-semanto-version" "trooth-page-hash");created=1792670400;expires=1792670700;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";alg="ed25519";tag="trooth-semanto"
```

## Web Bot Auth, the other direction

Semanto also verifies the agent's request signature per draft-ietf-webbotauth-httpsig-protocol: tag `web-bot-auth`, `@authority` and `signature-agent` covered, `created` and `expires` present, the key fetched from the Signature-Agent's directory at `/.well-known/http-message-signatures-directory`, the nonce kept against replay. A request that checks out names a key directory, and only that: a read receipt records the directory, never a guess from the User-Agent string (`src/readers/webbotauth.ts`, `verifier/test-vectors/v1/web-bot-auth-request.json`).

## Errors

Every error is an RFC 9457 problem (`application/problem+json`) with `code`, `retryable`, `next_action`, `terminal`, and a markdown form for `Accept: text/markdown`. Error responses are signed the same way as successful ones, with `@status` covered, so a reader can tell a signed not-found from a dropped connection.

## In the Internet-Draft

`docs/draft-trooth-signed-web-content-00.md` specifies the same mechanism with generic names: tag `signed-web-content`, header fields `Content-Version` and `Content-Hash`, the JWK Set at `/.well-known/signed-web-content-keys.json`, the TXT record at `_swc.<domain>`. The Trooth names above are the deployed implementation and are given in the draft as implementation notes.
