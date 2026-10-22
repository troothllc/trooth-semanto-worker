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
3. The header hashes to `root_hash`, and the company's detached JWS (typ `semanto-version`) over the header checks out with a key from the company's JWK Set, bound to the domain by `_trooth` DNS.
4. Trooth's witness statement over `{ root_hash, witnessed_at }` checks out.
5. The version's leaf is in the public log under a tree head Trooth signed, and the log grew consistently.
6. The response itself is signed (RFC 9421, tag `trooth-semanto`) with Content-Digest over the body, so the bytes in transit are the bytes on record.
7. The version is in a valid window and not on the revocation list.

None of this says the content is true. It says who published it, when, that it has not changed, and that it was publicly recorded. The formats are in `docs/spec/`.
