<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# The Semanto verifier kit

Anyone can check a Semanto without an account, offline, with the published keys: the file, a single page's proof, a signed HTTP response, and the public log. The checks still rest on Trooth's witness key and Trooth's log; until an independent cosigner signs the log's checkpoints (a founder step, `docs/spec/log.md`), the kit does not remove the need to trust Trooth's log, and it says nothing about whether content is true. The kit has three implementations of the same functions with the same reason codes, one set of shared test vectors, and a command line in each language.

| Folder | What | Needs |
| --- | --- | --- |
| `js/` | `verify.mjs` (ES module, WebCrypto, no dependencies) and `cli.mjs` | Node 20+ or a browser |
| `python/` | the `trooth` distribution on PyPI: package `trooth_semanto_verify`, `SemantoClient`, the `semanto-verify` command and the framework extras | Python 3.11+, `pip install trooth` |
| `go/` | module `github.com/troothllc/trooth-semanto-verify`, package `semanto`, `cmd/semanto-verify` | Go 1.22+, standard library only |
| `test-vectors/v1/` | the shared vectors, positive and negative, with a README that says what each must conclude | nothing |

What a verifier checks, in this order, and what each step proves:

1. The page bytes hash to the manifest entry (`Trooth-Page-Hash`): these are the exact bytes the company signed.
2. The page is in `pages_root`, an RFC 6962 inclusion proof against the header.
3. The header hashes to `root_hash`, and the company's detached JWS (typ `semanto-version`) over the header checks out with a key from the company's JWK Set, bound to the domain by `_trooth` DNS, judged at the signature's `iat`.
4. Trooth's witness statement over `{ root_hash, witnessed_at }` checks out with a key from Trooth's set.
5. The version's leaf is in the public log under a tree head Trooth signed, and the log grew consistently.
6. The response itself is signed (RFC 9421, tag `trooth-semanto`) with Content-Digest over the body, so the bytes in transit are the bytes on record.
7. The version is in a valid window and not on the revocation list.

Keys have roles. The company's set and Trooth's set are never merged: a company key cannot witness, sign a tree head or a checkpoint, and a Trooth key cannot sign for a company. The command lines load the company's keys from the domain and Trooth's from `https://api.trooth.co/public/semanto/.well-known/trooth-keys.json` (the Semanto Worker serves it; `--trooth <base>` reads `<base>/.well-known/trooth-keys.json` instead), and `--keys` files may label each set. worker-f may also serve the same set at `https://api.trooth.co/.well-known/trooth-keys.json`; adding that route is a founder step. A key is judged when it signed; a key revoked later still verifies and the result carries a note saying when.

A JWS with an embedded payload passes only when that payload is byte for byte the payload the verifier recomputed (`payload_mismatch`).

Page proofs are strict. A proof without the header, the company's signature, the witness or the log section fails (`header_absent`, `signature_absent`, `witness_absent`, `log_absent`). `--allow-unwitnessed`, `--allow-unlogged` and `--allow-unsigned` (`allowUnwitnessed`, `allowUnlogged`, `allowUnsigned` in code) accept a page knowingly without those parts (`--allow-unsigned` is for a Semanto Basic page, witnessed by Trooth and not signed by the company), and the output lists what was absent. On the command line a header or proof that cannot be fetched is a failure, not a skipped step. The Go command accepts flags before or after the file path.

None of this says the content is true. It says who published it, when, that it has not changed, and that it was publicly recorded. The formats are in `docs/spec/`.

## License

The verifier kit, and only the `verifier/` folder, is open source under the Apache License 2.0 (`verifier/LICENSE`); every file in it carries `SPDX-License-Identifier: Apache-2.0`. An open verifier needs an open license, so anyone can read, run, port and ship the checks. The rest of this repository (the Worker, the adapters, the dashboard components, the docs) stays proprietary to Trooth, LLC (`LicenseRef-Trooth-Proprietary`).
