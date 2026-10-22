# Semanto verifier test vectors, v1

Shared test vectors for every Semanto verifier (JavaScript, Python, Go, and anyone else's). A verifier that reaches the conclusion listed for each file, and no other, implements the published formats correctly.

Everything here is a fixture. Acme Inc and acme.com are fictional. The keys are fixture keys made for these files; Trooth's production witness key is not among them. No number in any file is a measurement. Every date is fixed to 2026-10-22T12:00:00Z and every check is judged at `now` = 2026-10-22T12:00:10Z, so the files are byte-stable: `npx tsx verifier/test-vectors/generate.ts` writes the same bytes on every run.

The formats are specified in `docs/spec/semanto-file.md`, `docs/spec/response-signatures.md` and `docs/spec/log.md`.

## Files and what a verifier must conclude

| File | What it holds | A verifier must conclude |
| --- | --- | --- |
| `manifest.json` | The list of vector files | Run every file listed. Nothing else on disk is a vector. |
| `keys.json` | The company's JWK Set (as acme.com would serve it at `/.well-known/trooth-keys.json`) with its `_trooth` DNS TXT record, Trooth's JWK Set, and the fixture agent's Web Bot Auth key directory | These are the only keys a verifier may trust while running the vectors. Every `kid` is the RFC 7638 thumbprint of its key. |
| `semanto.json` | A complete Semanto file for Acme: 3 pages, 4 facts, controls, empty question map, documents and products tiers, the company's detached JWS over the header, Trooth's witness statement and the version's place in the log | `ok: true`. `root_hash` is the digest of the canonical header; `pages_root` and `facts_root` recompute; every tier hash matches; every fact id is the digest of its fact; the company signature (typ `semanto-version`) and the witness statement (typ `witness-statement`) check out; the state at `now` is `current`; the version id is `smv_sf26uv6f5niw6xllfj2i6ru6ym`. |
| `pages.json` and `pages/<id>.md` | The markdown of each page exactly as served, by URL and by page id; the same bytes as files | The UTF-8 bytes of each page hash to the `hash` in the manifest. `page_bytes` passes with 3 of 3 pages. |
| `witness.json` | Trooth's detached JWS over `{ root_hash, witnessed_at }` | `ok: true` with Trooth's key and the file's `root_hash` as the detached payload. |
| `log.json` | A log of 5 leaves (Acme's version is leaf 3; a leaf is the canonical JSON of `{ kind, trooth_id, ref, hash, at }`), signed tree heads at sizes 3 and 5 (compact JWS over `{ tree_size, root_hash, signed_at }`), a signed-note checkpoint for size 5 (origin `trooth.co/semanto/log/v1`, signer name `trooth.co`), an inclusion proof for leaf 3 in the tree of 5, and a consistency proof from size 3 to size 5 | Both tree heads are signed by Trooth (typ `signed-tree-head`); the inclusion proof leads from the leaf hash to the size-5 root; the consistency proof connects the size-3 root to the size-5 root; the checkpoint names the same root. `ok: true`. |
| `page-proof.json` | What `GET /public/semanto/acme/pages/<id>/proof` returns for `/security` (`object: semanto.proof`, with `ledger.leaf` carrying the log's leaf record), the version header fetched beside it, and the page's markdown | `ok: true`. The page hashes to `page_hash`; page 2 of 3 is in `pages_root`; the header hashes to `root_hash` and lists the page at that index; the company signature and witness check out; the leaf record hashes to `leaf_hash` and names this `root_hash`; leaf 3 is in the tree of 5; the tree head is signed by Trooth and names that tree. Page proofs are strict: without the header the proof fails (`negative/page-proof-no-header.json`). |
| `response.json` | A signed HTTP response for `GET https://acme.com/security` with `Accept: text/markdown` (status, headers, body) at `now_epoch` | `ok: true`. Content-Digest matches the body; the RFC 9421 signature with tag `trooth-semanto` covers `@status`, `content-type`, `content-digest`, `trooth-semanto-version`, `trooth-page-hash`, `content-signal` and `link`, with `expires` 3,900 seconds after `created`, and checks out with the company's key; `Trooth-Page-Hash` is the digest of the body. |
| `response-page-jsonld.json` | The JSON-LD of `/security` | `ok: true`. `Trooth-Page-Hash` is the digest of the JSON-LD bytes; `Trooth-Signed-Page-Hash` is the manifest hash of the markdown page; the signature covers both. |
| `response-semanto-object.json` | The semanto object (`GET /public/semanto/acme`) | `ok: true`. `Trooth-Page-Hash` is the digest of the JSON served; no `Trooth-Signed-Page-Hash`. |
| `key-rotated-after-signing.json` | The file, with the company's key given `exp` 12:00:05, after it signed at 12:00:00; a per-vector `keys` set | `ok: true`, state `current`: a key is judged at the signature's `iat`. |
| `key-revoked-after-signing.json` | The file, with the company's key given `revoked_at` 12:00:05; a per-vector `keys` set | `ok: true` with the note `key revoked after signing on 2026-10-22T12:00:05Z`. |
| `web-bot-auth-request.json` | A request signed per draft-ietf-webbotauth-httpsig-protocol by the fixture agent | `ok: true`, keyid is the agent's kid, the Signature-Agent is `https://agent.fixture.example`. The same request against another authority fails with `bad_signature`. Exactly one `web-bot-auth` label. |
| `offer.json` | A signed offer (typ `signed-offer`) valid for 7 days from issue | `ok: true` at `now`. The offer id is `smo_` plus the digest of the canonical payload. |
| `revocations.json` | Trooth's signed revocation list (typ `revocation-list`, payload `{ trooth_id, issued_at, next_update, revocations }`) naming a fixture company's old version | The list checks out; Acme's version is not named, so its state at `now` stays `current`. |
| `negative/page-tampered.json` | The page proof with one byte of the page changed (`# Security` became `# Recurity`) | `ok: false`, reason `page_hash_mismatch`. The first check fails; later checks are not relied on. |
| `negative/fact-tampered.json` | The Semanto file with one fact's statement changed after signing | `ok: false`, reason `facts_root_mismatch`. The fact's id also no longer matches. |
| `negative/signature-expired.json` | The response signed 4,500 seconds before `now` with a 3,900 second window | `ok: false`, reason `expired`. |
| `negative/unknown-key.json` | The response signed by a key in no published JWK Set | `ok: false`, reason `unknown_key`. |
| `negative/offer-expired.json` | An offer whose `exp` passed 23 days before `now` | `ok: false`, reason `expired`. |
| `negative/version-withdrawn.json` | A revocation list that names Acme's current version | The list checks out (`ok: true`) and the version's state at `now` is `withdrawn`. |
| `negative/forged-compact-payload.json` | A forged file whose company signature and witness are the published detached JWS made compact with the OLD header and witness payload embedded | `ok: false`, reason `payload_mismatch`: an embedded payload must equal the recomputed one. |
| `negative/page-proof-forged-compact.json` | A forged page and header with the same trick in the page proof | `ok: false`, reason `payload_mismatch`. |
| `negative/witness-company-key.json` | The file with a witness statement signed by the company's key | `ok: false`, reason `witness_unknown_key`: witness statements resolve only against Trooth's keys. |
| `negative/tree-head-company-key.json` | A tree head signed by the company's key (kind `tree-head`) | `ok: false`, reason `unknown_key`. |
| `negative/key-revoked-before-signing.json` | The company's key revoked a day before it signed; a per-vector `keys` set | `ok: false`, reason `key_revoked`. |
| `negative/response-uncovered-header.json` | The JSON-LD response with `Trooth-Signed-Page-Hash` left out of the signature | `ok: false`, reason `header_not_covered`. |
| `negative/response-created-not-integer.json` | The response with `created=abc` | `ok: false`, reason `malformed`. |
| `negative/page-proof-no-header.json` | The page proof without the version header | `ok: false`, reason `header_absent`. |
| `negative/page-proof-unwitnessed.json` | The page proof with no witness statement | `ok: false`, reason `witness_absent` (passes only with `allowUnwitnessed`). |
| `negative/web-bot-auth-two-labels.json` | The Web Bot Auth request with a decoy second `web-bot-auth` label | `ok: false`, reason `more_than_one_label`. |
| `negative/jws-bad-nbf.json` | A witness statement whose header `nbf` is not a date | `ok: false`, reason `malformed`. |
| `negative/jws-header-null.json` | A JWS whose protected header decodes to `null` | `ok: false`, reason `malformed`. |
| `negative/witness-mismatch.json` | A witness statement over a different root, presented with this file's payload | `ok: false`, reason `bad_signature`. |

## Reason codes

Verifiers report the first failing check with one of these codes, so three languages fail the same way: `malformed`, `root_hash_mismatch`, `pages_root_mismatch`, `facts_root_mismatch`, `tier_hash_mismatch`, `fact_id_mismatch`, `page_hash_mismatch`, `manifest_mismatch`, `content_digest_mismatch`, `no_signature`, `unknown_key`, `bad_signature`, `wrong_type`, `wrong_tag`, `missing_component`, `unsupported_alg`, `expired`, `not_yet_valid`, `too_old`, `key_expired`, `key_revoked`, `key_not_yet_valid`, `log_inclusion_failed`, `log_leaf_mismatch`, `tree_head_mismatch`, `payload_mismatch`, `wrong_origin`, `wrong_signer`, `header_not_covered`, `header_absent`, `signature_absent`, `witness_absent`, `log_absent`, `more_than_one_label`. A check prefixed with its part (`witness_`, `tree_head_`) names which signature failed.

## Keys by role

`keys.json` holds the company's set and Trooth's set separately. A verifier checks the company's signatures (versions, offers, catalogs, responses without `Trooth-Signed-By`) only with the company's set and Trooth's (witness statements, tree heads, checkpoints, revocation lists, responses with `Trooth-Signed-By: witness`) only with Trooth's. A vector with its own `keys` member replaces the default sets for that vector. A key is judged at the signature's `iat` (JWS) or `created` (HTTP), and a note is returned when it was revoked later.

## States

`stateOf` answers in the ledger's words (src/ledger/revocation.ts): `current`, `superseded` (a newer version is known), `behind` (before `not_before`), `expired` (at or after `not_after`), `withdrawn` (header state withdrawn or named on a revocation list at or before now), `unsigned` (read, confirmed, or signed state without a signature).

## How to run them

- JavaScript: `npx vitest run test/verifier.test.ts`, or `node verifier/js/cli.mjs file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages`
- Python: `cd verifier/python && python3 -m pytest`
- Go: `cd verifier/go && go test ./semanto/`

## Regenerating

`npx tsx verifier/test-vectors/generate.ts`. The generator reads the fixture keys in `test/fixtures/verifier/` and writes this folder. If a format changes, bump the folder to `v2` and keep `v1` so older verifiers keep their tests.
