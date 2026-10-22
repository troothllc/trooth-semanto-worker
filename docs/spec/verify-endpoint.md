<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The one-call verify endpoint: what it takes, what it answers, what it never says. Follows src/serve/proof.ts verifyUrl and the RFC 9457 problem format; modeled on the shape of Sigstore's `cosign verify` output: a status word, the signer, and the proof to fetch next. -->

# The verify endpoint

`GET /public/semanto/verify?url=<page url>&hash=<digest>` answers one question in one call: is this hash the one the company signed for this URL? It is for readers that already have page bytes (an agent that fetched the page itself, a person who saved a copy) and want to know, without parsing a Semanto, whether the bytes are the signed ones. It needs no account and no key.

It is not a substitute for offline verification. The answer is Trooth's word; the proof it points at is not. A reader that wants to check without trusting Trooth follows `proof_url` and runs the verifier (`docs/spec/log.md`, `verifier/`).

## Request

| Parameter | Meaning |
| --- | --- |
| `url` | The page URL as it appears in the signed manifest, `https://` and the full path. |
| `hash` | The digest the reader computed over the bytes it holds: `sha256:` plus 64 lowercase hex, over the markdown bytes exactly as served. |

`Accept: application/json` (the default) or `text/markdown` for a plain-words answer.

## Answer

Status 200 with `object: "semanto.verify"` and one of four `status` words. The endpoint never answers anything about whether the content is true, and never a number or grade about the company.

| `status` | Meaning | Other members |
| --- | --- | --- |
| `matches` | The URL is in the current signed version and its manifest hash equals `hash`. | `version`, `version_id`, `signed_at`, `signer` (`kid`, `domain`, `lei` when the record has one), `signed_hash`, `proof_url` |
| `differs` | The URL is in the current signed version but the signed hash is not `hash`. The reader's bytes are not the signed ones: a changed page, a converter's rendering, or an older or newer version. | the same members; `signed_hash` says what was signed so the reader can see the difference |
| `unknown_url` | No company covers this domain, the URL is not valid, or the URL is not a page of the current signed version. | nulls |
| `not_signed` | The company exists but has no signed version yet (state `read` or `confirmed`), or the file carries no signature. | nulls |

Example:

```json
{
  "object": "semanto.verify",
  "status": "matches",
  "url": "https://acme.com/security",
  "hash": "sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410",
  "version": 1,
  "version_id": "smv_sf26uv6f5niw6xllfj2i6ru6ym",
  "signed_at": "2026-10-22T12:00:00Z",
  "signer": { "kid": "F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI", "domain": "acme.com", "lei": "ACMEFIXTURE000000012" },
  "signed_hash": "sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410",
  "proof_url": "https://api.trooth.co/public/semanto/acme/pages/smp_mh2iriw5u3rzy53s3mqowrgbh7/proof"
}
```

The answer itself is a signed response (`docs/spec/response-signatures.md`): it carries `Content-Digest`, `Signature-Input` and `Signature` with tag `trooth-semanto`, `Trooth-Semanto-Version` for the company's current version when one exists, and the `Link` relations to the file, the Trust Profile and the keys. A reader that keeps the answer keeps Trooth's signature on it.

In markdown (`Accept: text/markdown`) the same answer reads as a few sentences: the status word in plain words, who signed, when, and the proof link.

## What `differs` does and does not mean

`differs` means only that the bytes in the reader's hand are not the bytes the company signed for that URL in the current version. It does not say which side is wrong. Common causes, in order of how often they happen: the host served the live HTML converted to markdown by a converter rather than the signed markdown (check `Trooth-Semanto-Version` on the response the reader got); the page changed after signing and the delivery setting serves the live page marked unsigned; the reader holds a page from an earlier version (fetch `/versions/{n}` to compare). The `signed_hash` member lets the reader fetch the signed page by its `smp_` id and diff the two.

## Errors

A missing or malformed `url` or `hash` answers an RFC 9457 problem (`application/problem+json`, code `invalid_request`, `retryable: false`, `next_action` saying what to send). Rate limits answer `429` with `Retry-After`. Problems are also available in markdown.

## First-publication records

Semanto Basic can witness that a text existed at an address on a date (`src/basic/first-publication.ts`). Two public routes let anyone, a platform handling a dispute included, check such a record without an account. Both answers are signed by Trooth's witness key with the response signature.

`GET /public/semanto/first-publication/{smb_id}` answers `object: "semanto.first_publication_record"` with `record` (the witnessed record), `jws` (Trooth's JWS over it, `typ` `first-publication`), `leaf` and `leaf_hash` (its log leaf), `inclusion` (the inclusion proof against the latest tree head, or `null` while it waits to be logged) and `check_url`. An unknown id answers `semanto_not_found` (404).

The record carries `url`, `content_hash` (the digest of the text's UTF-8 bytes), `witnessed_at` and `id`, all witnessed by Trooth, and a separate `declared` block, `{ "stated_by": "requester", "title", "author" }`, holding what the person who asked said about the text. Trooth did not witness the declared block and the record says so; a reader never treats a declared author as witnessed.

`POST /public/semanto/first-publication/check` with `{ "record_id": "<smb_ id>", "markdown": "<the text>" }` answers `object: "semanto.first_publication_check"` with `status` `matches` (the digest of the text sent equals the witnessed `content_hash`) or `differs`, both digests, `witnessed_at`, `url`, the record, its JWS and the inclusion proof. A body that is not that shape answers `invalid_request`. The answer shows that a text existed at that address on that date; it never says who wrote it or who copied whom. The dispute statement a company exports links both routes.

## Relationship to the verifier kits

`semanto-verify page <url>` does what this endpoint does and more, offline after three fetches (the page, the keys, the proof and header): it checks the response signature, the page hash, the inclusion proof, the header, the company signature, the witness, the log leaf, the log inclusion and the tree head, and prints each step. The endpoint is the quick question; the kit is the independent check. Both say `matches` and `differs` in the same sense.
