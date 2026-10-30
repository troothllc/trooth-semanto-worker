<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->
<!-- The public log: leaves, tree heads, checkpoints, proofs, the per-page proof document, revocation, and what a monitor does. Follows RFC 6962 (Certificate Transparency), the transparency.dev tlog tile layout and the signed-note checkpoint format (golang.org/x/mod/sumdb/note, C2SP tlog-checkpoint), as implemented in src/ledger. -->

# The public log

Every statement Semanto signs is appended to one public, append-only Merkle tree: signed versions, witness statements, coverage receipts, offers, product records, seller attestations, recalls, first publications, revocation lists and keys. Trooth signs a tree head for every size. Anyone can hold two tree heads and check that the log never rewrote its past, and hold a leaf and check that it was in the tree. The reference implementation is `src/ledger/log.ts`, `src/ledger/ports.ts` and `src/ledger/store-d1.ts`; the standalone verifiers in `verifier/` check proofs, tree heads and checkpoints offline, and `verifier/test-vectors/v1/log.json` is a complete five-leaf log.

## Leaves

A leaf is the RFC 8785 canonical JSON of a leaf record:

```json
{"at":"2026-10-22T12:00:00Z","hash":"sha256:9175ea57c5eb516f5d6b2a748f469ec33f8e3e0ea9cde9beacad4db4226fbf76","kind":"semanto_version","ref":"smv_sf26uv6f5niw6xllfj2i6ru6ym","trooth_id":"acme"}
```

| Member | What it is |
| --- | --- |
| `kind` | One of `semanto_version`, `witness`, `receipt`, `offer`, `product_record`, `seller_attestation`, `recall`, `first_publication`, `revocation`, `key`. |
| `trooth_id` | The company the leaf is about, or `null` for Trooth's own entries. |
| `ref` | The `smx_` id of the thing, or the `kid` for a key. |
| `hash` | The digest of the thing being logged. For a version, its `root_hash`. |
| `at` | When the leaf was made, ISO 8601 UTC. |

The leaf hash is `SHA-256(0x00 || leaf bytes)` and an interior node is `SHA-256(0x01 || left || right)`, per RFC 6962 section 2.1, with the largest power of two smaller than n on the left. The empty tree's root is `SHA-256("")`. Leaf bodies are kept in R2 at `semanto/log/leaf/<index>` and hashes in tiles of 256 at `semanto/log/tile/<level>/<index>` (the transparency.dev tlog layout), so a reader can fetch proofs without asking the log to compute them.

## Tree heads

For every published size Trooth signs a tree head: a compact JWS with `typ` `https://trooth.co/types/signed-tree-head` over the canonical payload

```json
{"root_hash":"sha256:2f1c0e190a1f9c15b0e0b151823e5111699e6ae2f371314e28e11c5139e98ce5","signed_at":"2026-10-22T12:00:00Z","tree_size":5}
```

Stored and served as `{ tree_size, root_hash, signed_at, jws }`. The tree head id is `smt_` plus the digest of the canonical payload. A verifier checks the JWS with Trooth's witness key (from `https://api.trooth.co/.well-known/trooth-keys.json`), checks the `typ`, and checks that the stored `tree_size` and `root_hash` agree with the payload inside the JWS (`payload_mismatch` otherwise).

## Checkpoints

The same tree head is published as a checkpoint in the signed-note format that Sigsum, Rekor, Sunlight and the Go checksum database share, so monitors built for those logs read Trooth's log unchanged:

```
trooth.co/semanto/log/v1
5
LxwOGQofnBWw4LFRgj5REWmeauLzcTFOKOEcUTnpjOU=

— trooth.co QvCAblTSKS8XkGzK+6jgKMhLIAbjnfwNjhUy7NrdI+f7715VsRm2fwkz09eqzHZlxmdvt6ZOP//CNwk+65eE5r3KYwY=
```

Line one is the log's origin (`trooth.co/semanto/log/v1`, one log, one origin, never reused). Line two is the tree size. Line three is the base64 of the root hash bytes. After a blank line, each signature line is an em dash, a space, the signer's name (`trooth.co`), a space, and base64 of a 4-byte key hash followed by the 64-byte Ed25519 signature over the body (the first three lines, each ending in a newline). The key hash is the first four bytes of `SHA-256(name || "\n" || 0x01 || public key)`, `0x01` being the note package's Ed25519 algorithm id, which lets a verifier pick the right key from a set. A second signature line appears for every cosigning witness.

A verifier checks a checkpoint only with Trooth's key set, and also checks that the signature line names the signer `trooth.co` (`wrong_signer`) and that line one is exactly the origin `trooth.co/semanto/log/v1` (`wrong_origin`), so a checkpoint from another log, or signed under another name, never passes for this one. Tree heads and revocation lists are likewise checked only with Trooth's keys; a company key never signs them.

## Proofs

Inclusion proofs are RFC 6962 section 2.1.1 (`PATH(m, D[n])`) and consistency proofs are section 2.1.2 (`PROOF(m, D[n])`), each a list of digests printed as `sha256:` plus 64 hex. They are checked with the procedures of sections 2.1.3 and 2.1.4.2, which the three verifier kits implement and test against the Certificate Transparency known roots.

| Endpoint | Returns |
| --- | --- |
| `GET /public/semanto/log/tree-head` | the latest `{ tree_size, root_hash, signed_at, jws }`; the checkpoint text when `Accept` names `text/plain` |
| `GET /public/semanto/log/tree-head?size=<n>` | the tree head at size n |
| `GET /public/semanto/log/checkpoint` and `?size=<n>` | the checkpoint text |
| `GET /public/semanto/log/proof?index=<i>&size=<n>` | `{ index, tree_size, leaf_hash, root_hash, path }` |
| `GET /public/semanto/log/consistency?from=<m>&to=<n>` | `{ from, to, old_root, new_root, path }` |
| `GET /public/semanto/log/leaves/<i>` | `{ index, leaf, leaf_hash }`: the leaf record and its RFC 6962 leaf hash |

`size` defaults to the latest tree head (`to` likewise). An index or size outside the log answers a `log_entry_not_found` problem (404); a value that is not a whole number answers `invalid_request` (400). Every answer is signed by Trooth's witness key with the response signature of `docs/spec/response-signatures.md`. The routes are served by `src/serve/routes.ts` over `src/serve/ledger-port.ts` and the ledger (`TransparencyLog` over `D1LogStore` in the Worker), and are listed in `docs/ARCHITECTURE.md`.

## How the log is stored

An append and a proof never read every leaf (`src/ledger/tiles.ts`):

- The right edge of the tree, the compact range (one perfect subtree root per set bit of the size, as in Certificate Transparency and transparency-dev/merkle), is kept in the `semanto_log_frontier` table. An append pushes one leaf hash and merges equal heights: O(log n) hashes. The new root is the fold of the right edge. For a log that existed before this table, the edge is computed once from the leaves and stored.
- Every hash is also written to R2 as tiles in the transparency.dev tlog layout: level-k tiles of 256 hashes hold the roots of perfect subtrees of 256^k leaves, at `semanto/log/tile/<level>/<index>`, with a partial tile at the right edge stored as `.p/<width>`. A node of any height is read from one tile level and at most 128 hashes are folded.
- Inclusion and consistency proofs are computed from tiles with the RFC 6962 recursion exactly; every left part of a split is one aligned tile node.
- Appends and tree head signing are serial: one Durable Object, `LogDO` (`src/ledger/log-do.ts`, binding `LOG`), runs them one at a time, so two Workers can never append at the same size. The leaf row, the new right edge and the size are written in one D1 batch. Without the binding (tests, local runs) the in-process store refuses an append that is not serialized.

## The per-page proof document

`GET /public/semanto/{trooth_id}/pages/{smp_id}/proof` returns everything a reader needs to check one page offline against the signed version and the log (`src/serve/proof.ts` `PageProof`):

```json
{
  "object": "semanto.proof",
  "page_id": "smp_mh2iriw5u3rzy53s3mqowrgbh7",
  "page_hash": "sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d88042d5d2c410",
  "version": 1,
  "version_id": "smv_sf26uv6f5niw6xllfj2i6ru6ym",
  "pages_root": "sha256:60a29c44bf95d23fe6fcc84decabf1f2fea87f4b1e6379963290d5e09856e794",
  "inclusion": { "index": 1, "size": 3, "path": ["sha256:<sibling>", "sha256:<sibling>"] },
  "root_hash": "sha256:9175ea57c5eb516f5d6b2a748f469ec33f8e3e0ea9cde9beacad4db4226fbf76",
  "signed_at": "2026-10-22T12:00:00Z",
  "witnessed_at": "2026-10-22T12:00:00Z",
  "signature": "<the company's detached JWS over the header>",
  "witness": "<Trooth's detached JWS over { root_hash, witnessed_at }>",
  "ledger": {
    "log": "https://api.trooth.co/public/semanto/log",
    "index": 3,
    "tree_size": 5,
    "leaf": { "kind": "semanto_version", "trooth_id": "acme", "ref": "smv_sf26uv6f5niw6xllfj2i6ru6ym", "hash": "sha256:9175ea57c5eb516f5d6b2a748f469ec33f8e3e0ea9cde9beacad4db4226fbf76", "at": "2026-10-22T12:00:00Z" },
    "leaf_hash": "sha256:b4319649d12ea4a3c8d567f3eec1e674c88c9c61d7262d47b530c69f260e500e",
    "root_hash": "sha256:2f1c0e190a1f9c15b0e0b151823e5111699e6ae2f371314e28e11c5139e98ce5",
    "tree_head_jws": "<compact JWS>",
    "inclusion_path": ["sha256:<sibling>", "sha256:<sibling>", "sha256:<sibling>"]
  }
}
```

The version header is not in the proof; a reader fetches it beside the proof at `/public/semanto/{trooth_id}/versions/{version}` (or already holds the file). `ledger.leaf` is the leaf record so a reader can recompute `leaf_hash` instead of trusting it. `src/serve/proof.ts` builds and checks it the ledger's way, as the vectors and the three verifier kits do.

A verifier works outward, and reports the first step that fails:

1. The page bytes hash to `page_hash` (`page_hash_mismatch`).
2. The page is in `pages_root` at `inclusion.index` of `inclusion.size` (`pages_root_mismatch`).
3. With the header: it hashes to `root_hash`, carries this `pages_root`, and lists this page id and hash at that index with this version number (`root_hash_mismatch`, `manifest_mismatch`); the company's signature over the header checks out with `typ` `semanto-version` (`unknown_key`, `bad_signature`, `wrong_type`, `payload_mismatch`, `key_revoked`), with the company's keys only and the key judged at the signature's `iat`.
4. Trooth's witness statement over `{ root_hash, witnessed_at }` checks out (`witness_<reason>`).
5. The leaf record hashes to `leaf_hash` and names this `root_hash` (`log_leaf_mismatch`).
6. The leaf is under `ledger.root_hash` at `index` of `tree_size` (`log_inclusion_failed`).
7. The tree head JWS checks out with Trooth's key and names that size and root (`tree_head_<reason>`, `tree_head_mismatch`).

Every step is required. Without the header the proof fails (`header_absent`); without the company's signature, `signature_absent`; without the witness, `witness_absent`; without the ledger section, `log_absent`. A reader that knowingly accepts a page with no witness or no log entry yet passes `allowUnwitnessed` or `allowUnlogged` (`--allow-unwitnessed`, `--allow-unlogged`), and the result lists what was absent. Steps 4 and 7 use Trooth's keys only. `semanto-verify page <url>` in any kit fetches the page, the keys, the proof and the header and prints each step.

## Validity and revocation

Every version has `not_before` and `not_after`. A revocation list is a compact JWS with `typ` `https://trooth.co/types/revocation-list` over

```json
{"issued_at":"2026-10-22T12:00:00Z","next_update":"2026-10-23T12:00:00Z","revocations":[{"kind":"version","reason":"superseded","ref":"smv_fixtureoneaaaaaaaaaaaaaaaaaaa","revoked_at":"2026-10-20T12:00:00Z"}],"trooth_id":null}
```

`kind` is `version`, `key`, `offer` or `record`; `ref` names the thing; `revoked_at` is when it stopped standing; `next_update` is `issued_at` plus 24 hours, after which a list is stale. Every revocation entry is appended to the log as a `revocation` leaf when it is made (`POST /os/semanto/{trooth_id}/withdraw` and `POST /os/semanto/{trooth_id}/keys/{kid}/revoke`), so a withdrawal cannot later be undone in secret. An erasure (`POST /os/semanto/{trooth_id}/erase`) revokes every version and key that way, then appends one `erasure` leaf whose hash commits to the Trooth ID, a hash of the domain and the time. The signed list is served at `GET /public/semanto/{trooth_id}/revocations` (and every company's at `GET /public/semanto/revocations`), re-signed on every withdrawal and revocation and nightly. The state of a version at an instant, given the list, is `current`, `superseded`, `behind`, `expired` or `withdrawn` (`src/ledger/revocation.ts` and `stateOf` in each kit; see `docs/spec/semanto-file.md`).

## Time

When `TSA_URL` is set (a founder step), each nightly checkpoint and each signing's tree head is sent to that RFC 3161 time-stamp authority (`src/ledger/timestamp.ts`); the token is kept at `semanto/log/tsa/<size>.tsr` and named on the tree head row. Without `TSA_URL` no tree head is timestamped. The Worker keeps the token as the authority answered it and does not check the token's CMS signature itself (`signature_checked: false`); a reader checks it against the authority's certificate chain. A second, independent cosignature on the checkpoint (a Sigsum or Armored Witness style witness) is prepared in code and is a founder step to configure. Until a second witness signs, the log proves that Trooth cannot change the past without being caught by anyone who kept a tree head; it does not yet prove that Trooth cannot show two readers two different logs. That claim waits for the cosigner.

## Monitors

A monitor is anyone who keeps the last tree head it saw and, on a schedule:

1. Fetches the current tree head and checkpoint, verifies both signatures, and checks that the checkpoint names the same size and root as the tree head.
2. Fetches the consistency proof from its last size to the current size and verifies it. A failure means the log rewrote its past; the monitor publishes both tree heads as evidence.
3. For every leaf it cares about (a company monitors its own versions), fetches the inclusion proof and verifies it against the current tree head.
4. Compares the tree head it got with tree heads other monitors got for the same size. Two different roots at one size are a split view.

`src/ledger/log.ts` `Monitor` implements steps 1 to 3 and reports in plain sentences; `semanto-verify log --from <m> --to <n>` in each kit does steps 1 and 2 from the command line. Trooth's hourly change detection fetches each signed company's own pages (its origin HTML, unsigned, with Trooth's user agent string); it does not read the served Semanto copies and records no read receipt. Trooth has no Web Bot Auth key directory yet.
