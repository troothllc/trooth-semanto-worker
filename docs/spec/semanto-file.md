<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The Semanto file format: what is in it, how every hash is computed, what the ids mean, what the states are. Follows the schema in src/core/semanto.ts, with RFC 8785 for canonical JSON, RFC 6962 for the Merkle roots, RFC 7515 and RFC 8037 for the signatures. -->

# The Semanto file

A Semanto is one JSON document that holds a company's entire public website as the company signed it: every page word for word, every fact tied to its source, the controls the company set, and the signatures and proofs that let anyone check it offline. The schema is `https://trooth.co/schemas/semanto/v1.json`, contract `1`. The reference implementation of the schema and the hashing rules is `src/core/semanto.ts`; the standalone verifiers in `verifier/` re-implement them without importing it, and the shared vectors in `verifier/test-vectors/v1/` show a complete file.

## Top level

| Member | What it is |
| --- | --- |
| `header` | The signed part. Everything else is committed to by a hash inside it. |
| `facts` | The facts tier: an array of facts, each with its id, key, statement, value, provenance and evidence. |
| `controls` | How the company wants to be quoted: `say_it_this_way`, `when_unknown`, `access_policy`, `content_signals`. |
| `question_map` | Questions readers ask and where the site answers them. Empty array when none. |
| `documents` | PDFs and other documents with their hashes. Empty array when none. |
| `products` | The commerce tier (records defined in `src/commerce`). Empty array for companies without products. |
| `root_hash` | `sha256:` plus the SHA-256 of the canonical header. The version's identity. |
| `signature` | The company's detached JWS over the header (`typ` `https://trooth.co/types/semanto-version`), with `alg`, `kid`, `jws` and `key` (the JWK Set URL with the kid as fragment). `null` until signed. |
| `witness` | Trooth's detached JWS over `{ root_hash, witnessed_at }` (`typ` `https://trooth.co/types/witness-statement`), with `by: "Trooth"`, `at`, `kid`, `jws`. `null` until witnessed. |
| `ledger` | Where the version sits in the public log: `log`, `index`, `tree_size`, `tree_head` (the root hash of that tree). `null` until appended. |

## The header

| Member | What it is |
| --- | --- |
| `schema`, `contract` | The schema URL and contract number above. |
| `org`, `trooth_id`, `domains`, `profile` | The company's name, its Trooth id (a lowercase slug), the domains the file covers, the Trust Profile URL. |
| `version`, `supersedes` | A positive integer and the version it replaces, or `null` for the first. |
| `built_at` | When Trooth assembled it, ISO 8601 UTC. |
| `state` | `read`, `confirmed`, `signed` or `withdrawn`. See [States](#states). |
| `not_before`, `not_after` | The window in which this version is a standing statement. `not_after` may be `null`. |
| `witness_meaning` | The fixed sentence "Witnessed means Trooth observed it, with a source and a date, not that it is true". It is in the signed bytes so nobody can quote a witness statement without its meaning. |
| `tiers` | One entry per tier: `name`, `tokens` (an estimate, see `src/core/tokens.ts`) and `hash`. |
| `pages_root`, `facts_root` | The two Merkle roots. |
| `pages_manifest` | One entry per page: `id`, `url`, `title`, `hash`, `source_hash`, `bytes`, `tokens`, `witnessed_at`, optional `lang`, optional `part`, `status` (always 200), and `index` (the eligibility signals seen: `noindex`, `nosnippet`, `canonical`, `robots_blocked`). |
| `identity` | `domain`, `trooth_id`, optional `legal_name`, `lei`, `vlei`, `authorized_by`, and `key_binding` (`jwks_url`, `dns_record`). |

Page bodies are not in the file. They are addressed by their hash and served beside it, so a file for a large site stays small and a reader fetches only the pages it needs.

## Hashing rules

Every hash is SHA-256 printed as `sha256:` followed by 64 lowercase hexadecimal characters, in full. Every JSON value that is hashed or signed is first serialized with RFC 8785 (JSON Canonicalization Scheme): members sorted by UTF-16 code units, no whitespace, the shortest string escapes, integers only. Semanto never signs a non-integer number; amounts are integers in minor units.

| What | How |
| --- | --- |
| Page hash | SHA-256 of the markdown bytes exactly as served. |
| `source_hash` | SHA-256 of the HTML as fetched, so a later reader can show which capture the markdown came from. |
| Page id | `smp_` plus the page hash (see [Ids](#ids)). |
| Fact id | `smf_` plus the SHA-256 of the canonical fact with the `id` member removed. |
| `pages_root` | The RFC 6962 Merkle root over the page hashes in manifest order. Leaf hash `SHA-256(0x00 || hash bytes)`, node hash `SHA-256(0x01 || left || right)`, the largest power of two smaller than n on the left. An empty manifest has the root `SHA-256("")`. |
| `facts_root` | The RFC 6962 Merkle root over the canonical bytes of each fact (with its id), in ascending id order. |
| Tier hash | SHA-256 of the canonical JSON of the tier's value. For `pages` the value is the manifest array, since page bodies are addressed by their own hashes. The `header` tier is never listed in `tiers`. |
| `root_hash` | SHA-256 of the canonical header. Because the header lists every tier hash, both roots and the whole manifest, signing the header signs everything. |
| Version id | `smv_` plus `root_hash`. |

## Ids

An id is a short type prefix, an underscore, and the first 26 characters of the base32 (RFC 4648 lowercase alphabet `a` to `z` and `2` to `7`) encoding of a digest: 130 bits, content-addressed, the same everywhere and forever. The registry is in `src/core/ids.ts`: `smv_` a version, `smr_` a coverage receipt, `smp_` a page, `smf_` a fact, `smo_` a signed offer, `smk_` a product or variant record, `sms_` a seller attestation, `smn_` a recall notice, `smt_` a signed tree head, `smd_` a read receipt, `smb_` a first-publication record, `smg_` a gap report. A Trooth id is a lowercase slug, never reused.

## Provenance

Every fact carries one of four words and nothing else: `witnessed` (Trooth observed it, with a source and a date), `public_record` (read from a public registry, with the registry named in `evidence.source`), `attested` (a named counterparty stated it), `declared` (the company stated it). A declared fact is never shown as witnessed. Three negatives stay apart as values: `no` (the record holds a negative), `not_published` (the company has not published it), `not_read` (Trooth's reading did not read it).

## States

The header's `state` and the file's validity together give the state a reader acts on.

| Header state | Meaning |
| --- | --- |
| `read` | Trooth read the site and built the file. Nothing is served to the public. |
| `confirmed` | The company confirmed the contents. Still not served. |
| `signed` | The company signed the header. The file is served and witnessed. |
| `withdrawn` | The company withdrew it. |

A verifier judging a version at an instant answers in the ledger's words (`src/ledger/revocation.ts`, mirrored by `stateOf` in every verifier kit): `current` (signed, inside its window, not revoked, no newer version known), `superseded` (a newer version is known), `behind` (before `not_before`), `expired` (at or after `not_after`), `withdrawn` (header withdrawn, or named on a signed revocation list at or before the instant), `unsigned` (read, confirmed, or a `signed` header with no signature).

## Signatures

Both signatures are RFC 7515 JWS in compact serialization with RFC 8037 EdDSA (Ed25519), the payload detached: the signed bytes are the canonical JSON of the payload, which any verifier recomputes. The protected header carries `alg: "EdDSA"`, `kid` (the RFC 7638 thumbprint of the key), `typ` (the statement type, checked by every verifier so a signature is never replayed as a different kind of statement), `iat`, and `nbf` or `exp` when the statement has a window. The company's key is found in the JWK Set at `identity.key_binding.jwks_url` (by default `/.well-known/trooth-keys.json` on the domain) and bound to the domain by a TXT record at `_trooth-keys.<domain>` of the form `v=trooth1; kid=<thumbprint>`. Trooth's witness keys are at `https://api.trooth.co/.well-known/trooth-keys.json`.

## What a verifier checks, in order

1. Structure: the required members, the schema and contract, digests where digests belong.
2. `root_hash` equals the digest of the canonical header.
3. `pages_root` and `facts_root` recompute from the manifest and the facts.
4. Every tier hash matches its tier; every fact id matches its fact.
5. For every page whose bytes are at hand, the bytes hash to the manifest entry.
6. The company's signature over the header, with `typ` `semanto-version`, with a key from the published set that is valid at the instant.
7. Trooth's witness statement over `{ root_hash, witnessed_at }`, with `typ` `witness-statement`.
8. The state at the instant, with the revocation list when one is at hand.

The first failing step is the reported reason. The reason codes are listed in `verifier/test-vectors/v1/README.md`.

## Serving

The file is at `GET /public/semanto/{trooth_id}` (JSON) and, on the company's own domain, at `/.well-known/trooth.semanto`. Versions are at `/versions/{n}`; a page's markdown at `/pages/{smp_id}` with its proof at `/pages/{smp_id}/proof` (see `docs/spec/response-signatures.md` and `docs/spec/log.md`). Every representation of a page carries the same content; the format is chosen by `Accept` or a path suffix, never by `User-Agent` (`docs/spec/delivery.md`).
