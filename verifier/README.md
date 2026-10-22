# The Semanto verifier kit

Anyone can check a Semanto without an account and without trusting Trooth's servers: the file, a single page's proof, a signed HTTP response, and the public log. The kit has three implementations of the same functions with the same reason codes, one set of shared test vectors, and a command line in each language.

| Folder | What | Needs |
| --- | --- | --- |
| `js/` | `verify.mjs` (ES module, WebCrypto, no dependencies) and `cli.mjs` | Node 20+ or a browser |
| `python/` | package `trooth_semanto_verify` and the `semanto-verify` command | Python 3.11+, `pip install cryptography` |
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

Keys have roles. The company's set and Trooth's set are never merged: a company key cannot witness, sign a tree head or a checkpoint, and a Trooth key cannot sign for a company. The command lines load the company's keys from the domain and Trooth's from `https://api.trooth.co/.well-known/trooth-keys.json`, and `--keys` files may label each set. A key is judged when it signed; a key revoked later still verifies and the result carries a note saying when.

A JWS with an embedded payload passes only when that payload is byte for byte the payload the verifier recomputed (`payload_mismatch`).

Page proofs are strict. A proof without the header, the company's signature, the witness or the log section fails (`header_absent`, `signature_absent`, `witness_absent`, `log_absent`). `--allow-unwitnessed` and `--allow-unlogged` (`allowUnwitnessed`, `allowUnlogged` in code) accept a page knowingly without those parts, and the output lists what was absent. On the command line a header or proof that cannot be fetched is a failure, not a skipped step. The Go command accepts flags before or after the file path.

None of this says the content is true. It says who published it, when, that it has not changed, and that it was publicly recorded. The formats are in `docs/spec/`.
