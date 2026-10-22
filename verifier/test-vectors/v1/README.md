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
| `page-proof.json` | What `GET /public/semanto/acme/pages/<id>/proof` returns for `/security` (`object: semanto.proof`, with `ledger.leaf` carrying the log's leaf record), the version header fetched beside it, and the page's markdown | `ok: true`. The page hashes to `page_hash`; page 2 of 3 is in `pages_root`; the header hashes to `root_hash` and lists the page at that index; the company signature and witness check out; the leaf record hashes to `leaf_hash` and names this `root_hash`; leaf 3 is in the tree of 5; the tree head is signed by Trooth and names that tree. Without the header, the header and company signature checks are skipped and said to be skipped; everything else still passes. |
| `response.json` | A signed HTTP response for `GET https://acme.com/security` with `Accept: text/markdown` (status, headers, body) at `now_epoch` | `ok: true`. Content-Digest matches the body; the RFC 9421 signature with tag `trooth-semanto` covers `@status`, `content-type`, `content-digest`, `trooth-semanto-version` and `trooth-page-hash` and checks out with the company's key; `Trooth-Page-Hash` is the digest of the body. |
| `web-bot-auth-request.json` | A request signed per draft-ietf-webbotauth-httpsig-protocol by the fixture agent | `ok: true`, keyid is the agent's kid, the Signature-Agent is `https://agent.fixture.example`. The same request against another authority fails with `bad_signature`. |
| `offer.json` | A signed offer (typ `signed-offer`) valid for 7 days from issue | `ok: true` at `now`. The offer id is `smo_` plus the digest of the canonical payload. |
| `revocations.json` | Trooth's signed revocation list (typ `revocation-list`, payload `{ trooth_id, issued_at, next_update, revocations }`) naming a fixture company's old version | The list checks out; Acme's version is not named, so its state at `now` stays `current`. |
| `negative/page-tampered.json` | The page proof with one byte of the page changed (`# Security` became `# Recurity`) | `ok: false`, reason `page_hash_mismatch`. The first check fails; later checks are not relied on. |
| `negative/fact-tampered.json` | The Semanto file with one fact's statement changed after signing | `ok: false`, reason `facts_root_mismatch`. The fact's id also no longer matches. |
| `negative/signature-expired.json` | The response signed 600 seconds before `now` with a 300 second window | `ok: false`, reason `expired`. |
| `negative/unknown-key.json` | The response signed by a key in no published JWK Set | `ok: false`, reason `unknown_key`. |
| `negative/offer-expired.json` | An offer whose `exp` passed 23 days before `now` | `ok: false`, reason `expired`. |
| `negative/version-withdrawn.json` | A revocation list that names Acme's current version | The list checks out (`ok: true`) and the version's state at `now` is `withdrawn`. |
| `negative/witness-mismatch.json` | A witness statement over a different root, presented with this file's payload | `ok: false`, reason `bad_signature`. |

## Reason codes

Verifiers report the first failing check with one of these codes, so three languages fail the same way: `malformed`, `root_hash_mismatch`, `pages_root_mismatch`, `facts_root_mismatch`, `tier_hash_mismatch`, `fact_id_mismatch`, `page_hash_mismatch`, `manifest_mismatch`, `content_digest_mismatch`, `no_signature`, `unknown_key`, `bad_signature`, `wrong_type`, `wrong_tag`, `missing_component`, `unsupported_alg`, `expired`, `not_yet_valid`, `too_old`, `key_expired`, `key_revoked`, `key_not_yet_valid`, `log_inclusion_failed`, `log_leaf_mismatch`, `tree_head_mismatch`, `payload_mismatch`, `wrong_origin`.

## States

`stateOf` answers in the ledger's words (src/ledger/revocation.ts): `current`, `superseded` (a newer version is known), `behind` (before `not_before`), `expired` (at or after `not_after`), `withdrawn` (header state withdrawn or named on a revocation list at or before now), `unsigned` (read, confirmed, or signed state without a signature).

## How to run them

- JavaScript: `npx vitest run test/verifier.test.ts`, or `node verifier/js/cli.mjs file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages`
- Python: `cd verifier/python && python3 -m pytest`
- Go: `cd verifier/go && go test ./semanto/`

## Regenerating

`npx tsx verifier/test-vectors/generate.ts`. The generator reads the fixture keys in `test/fixtures/verifier/` and writes this folder. If a format changes, bump the folder to `v2` and keep `v1` so older verifiers keep their tests.
