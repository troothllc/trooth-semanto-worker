# Signature and identity layer: report

Area: `src/ledger`, `src/identity`, `src/readers`. Requirements covered: 9, 10, 11, 12, 13, 14, 17, and the key custody part of 8.

Tests: `npx vitest run test/ledger.test.ts test/identity.test.ts test/readers.test.ts` (48 tests, all pass). `npx tsc --noEmit` reports no errors in these folders or their tests. Nothing in `src/core` was changed.

## What was built, file by file

### src/ledger

`ports.ts`
: The `LogLeaf` type (kind, trooth_id, ref, hash, at), the ten leaf kinds, `leafBytes` (RFC 8785 canonical JSON) and `hashLeaf` (RFC 6962 leaf hash through `src/core/merkle.ts`). The `LogStore` port and `MemoryLogStore`. A `FetchPort` with `MemoryFetch` for tests and `platformFetch` for the Worker.

`log.ts`
: `TransparencyLog`: `append(leaf)` returns `{ index, tree_size, root, tree_head }` and signs a tree head for every size; `getTreeHead(size)`, `latestTreeHead()`, `inclusionProof(index, size)` and `consistencyProof(from, to)` return digests (`sha256:` plus 64 hex); `checkpoint(size)` returns the transparency.dev / Sigsum checkpoint text. The tree head is `{ tree_size, root_hash, signed_at }` as a JWS with `typ` `JWS_TYPES.treeHead`, signed by the witness key; `treeHeadId` gives its `smt_` id. `verifyTreeHead`, `verifyInclusionDigests` and `verifyConsistencyDigests` are the reader-side checks. The checkpoint is a signed note (golang.org/x/mod/sumdb/note): origin line `trooth.co/semanto/log/v1`, tree size, base64 root hash, blank line, then `— trooth.co <base64(4-byte key hash || Ed25519 signature)>`; `parseCheckpoint`, `signCheckpoint`, `verifyCheckpoint` and `noteKeyHash` implement it so an existing monitor reads it unchanged. `Monitor.check(previous, current, knownLeaves)` verifies both tree head signatures, the consistency proof between them, and the inclusion of every leaf it was told about, and reports plain sentences; it detects a forked log, a shrinking log, a bad signature and a missing leaf.

`store-d1.ts`
: `D1LogStore` over `semanto_log` and `semanto_tree_heads` from `migrations/0001_semanto.sql`, with leaf bodies at `semanto/log/leaf/<index>` in R2 and tlog tiles of 256 hashes at `semanto/log/tile/<level>/<index>` (partial tiles as `.p/<width>`). `tileKey`, `tileFor`, `splitTile` and `tileUp` are pure and tested; the D1 and R2 calls need the Worker runtime and are not run in Node.

`timestamp.ts`
: A by-hand DER encoder and decoder (X.690) and the RFC 3161 pieces: `buildTimeStampRequest(rootHash)` produces a `TimeStampReq` with version 1, a SHA-256 message imprint, an 8-byte random nonce and `certReq TRUE`; `decodeTimeStampRequest` reads it back; `parseTimeStampResponse` walks `TimeStampResp` to `TSTInfo` and extracts `genTime`, the imprint, the nonce, the policy and the serial, refusing a token whose imprint or nonce is not what was sent; `timestampTreeHead(head, tsaUrl, fetchPort)` does the round trip. `buildTestTimeStampResponse` makes a granted response for tests (no CMS signature, said so in its comment). The CMS signature over `TSTInfo` is not checked here: the token result carries `signature_checked: false` and the token bytes are kept for `openssl ts -verify` against the TSA's chain. The alternate anchor: `prepareCosignatureLeaf(head)` builds a `witness_cosignature` record (with the exact checkpoint body) for a second log, and `acceptCosignature` checks a cosignature in the c2sp.org/tlog-cosignature form (`cosignature/v1\ntime <unix>\n` plus the body) and returns the signature line to append.

`revocation.ts`
: `stateOf(version, now, revocations, latest)` returns one of `current`, `superseded`, `behind`, `withdrawn`, `expired` with a plain sentence. `supersedesChain` builds the chain from a set of versions. `signRevocationList` signs `{ trooth_id, issued_at, next_update, revocations }` as a JWS with `typ` `JWS_TYPES.revocation`, `nbf` = issued_at and `exp` = issued_at plus 24 hours; `verifyRevocationList` returns `stale` for a list past its window with the sentence "Treat it as missing, not as empty." `revocationLeaf` turns an entry into a log leaf; `keyState` describes a key's validity in words.

### src/identity

`ports.ts`
: `HttpPort` (`MemoryHttp`, `platformHttp`), `DnsPort` (`MemoryDns`, and `dohDns` over `https://cloudflare-dns.com/dns-query` with `Accept: application/dns-json`), and the `VleiVerifier` port with `VleiNotWired`, the stub that answers "presented, not checked" and never "checked".

`keys.ts`
: `createHostedKey` (Ed25519 through `src/core/keys.ts`, `nbf` now, the private half returned once). `buildJwks` publishes the set for `/.well-known/trooth-keys.json` with `nbf`, `exp` and `revoked_at` carried, private members stripped, expired keys kept for a year so old signatures stay checkable. `rotateHostedKey` gives the new key `nbf` now and the old key `exp` in 30 days; both sit in the JWKS during the overlap; `currentKey` picks the signer. `revokeKey` sets `revoked_at`. `jwksUrl`, `dnsName` (`_trooth-keys.<domain>`) and `dnsKeyRecord` (`v=trooth1; kid=<thumbprint>`). `bindingStatus(domain, kid, http, dns)` reports whether the JWKS is served on the domain with the kid, whether DNS names the kid, and the level `domain_and_dns`, `domain_only` or `trooth_hosted_only`. Customer custody: `acceptCustomerPublicKey` takes a public JWK only and refuses anything carrying `d`; `versionSigningInput(header, kid)` gives the exact detached-JWS signing input string (`base64url(protected) + "." + base64url(canonical header)`) for the client to sign; `assembleJws` builds the detached and compact forms from the 64 signature bytes; `checkAssembledJws` verifies the result as a `semanto-version`.

`lei.ts`
: `validateLei` (20 characters, ISO 17442, ISO 7064 MOD 97-10 check digits in `mod97`), `leiCheckDigits`. `lookupLei` reads `https://api.gleif.org/api/v1/lei-records/<lei>` through the port and returns legal name, entity status, registration status, `active` (ACTIVE and ISSUED), legal address country, jurisdiction, the URL and the read time; `leiFacts` turns it into `public_record` facts (`identity.lei`, `identity.legal_name`, `identity.registered_country`) with `evidence.source` "GLEIF" and the URL, ids from `factId`. `compareLegalName` normalizes (NFKD, punctuation, corporate suffixes) and returns `match`, `match_ignoring_suffix`, `close` or `different` with the words that differ. `recordVlei` accepts `{ said, issuer, schema }`, asks the verifier, and records `presented_not_checked`, `checked` or `failed`; `vleiForHeader` returns a header entry only for a checked credential, so `vlei.checked_at` is never set without a real check.

`roles.ts`
: `RoleRecord` (`OOR`, `ECR`, `owner`, `admin`, with name, credential, role title, since, subject). `roleFromVlei` maps an OOR or ECR credential and refuses one chained to an unchecked Legal Entity credential; `roleFromWorkspace` maps owners and admins and refuses members and viewers. `mayBeSigned(rootHash, authorizations, policy)` applies the two-officer rule: two distinct subjects over the same root hash; one person twice or two people over different hashes do not count. `toHeaderEntry` and `describeAuthorization` give the `identity.authorized_by` entries and dashboard sentences.

### src/readers

`ports.ts`
: `HttpPort`, `KeyCache` (`MemoryKeyCache`, `KvKeyCache` skeleton), `NonceStore` (`MemoryNonceStore`, `KvNonceStore` skeleton), `ReceiptStore` (`MemoryReceiptStore`, `D1ReceiptStore` over `semanto_read_receipts`).

`webbotauth.ts`
: `verifyWebBotAuth(request, deps)` per draft-ietf-webbotauth-httpsig-protocol-00: `Signature-Agent` parsed as a structured-field string holding an https URL; the signature with tag `web-bot-auth` chosen by tag, not by label; `@authority` and `signature-agent` required; `created` and `expires` both present, `expires` at most five minutes plus skew after `created`; a nonce required; replay window 300 seconds and skew 60 seconds; keys fetched from `<origin>/.well-known/http-message-signatures-directory` as a JWK Set through the cache (TTL from `Cache-Control`); kids checked against RFC 7638 thumbprints; the directory's own signature (Appendix B.1, tag `http-message-signatures-directory` over `@authority` and `content-digest`, one per key) checked when present; the signature checked with `src/core/httpsig.ts`; the nonce claimed only after the signature verifies. Result `{ proven: true, agent_key_url, keyid, directory_signed }` or `{ proven: false, reason, sentence }`. `KNOWN_DIRECTORIES` maps a directory origin to a display name and is keyed by URL only; `directoryDisplayName` answers "unproven reader" for anything not proven. Nothing reads User-Agent.

`receipts.ts`
: `hashIp(address, secret, at)` is SHA-256 over a daily salt (`ipHashSalt` = SHA-256 of secret and UTC day) and the normalized address; `makeReceipt` builds `{ id (smd_), trooth_id, version, page_id, representation, agent_key_url, keyid, proof, read_at, ip_hash }` with no address field at all; `recordRead` stores it. `summarize` and `signDailyDigest` produce the per-company daily digest (counts by agent, page and representation, plus the receipt ids) as a JWS with `typ` `JWS_TYPES.readReceipt`; `verifyDailyDigest` checks it. `dashboardRows` names a reader only when `proof` is `web_bot_auth` and otherwise shows one "unproven reader" row. `receiptsCsv` exports RFC 4180 CSV, one row per receipt, with formula-injection guarding.

### test

`test/ledger.test.ts` (21), `test/identity.test.ts` (15), `test/readers.test.ts` (12). Fixtures: `test/fixtures/ledger/fixture-leaves.json` (ten fictional leaves for Acme) and `fixture-checkpoint-foreign.txt` (a foreign checkpoint, parsed and refused). Identity and reader fixtures are inline (Acme Inc, acme.com, agent.example). The two LEIs in the tests are public identifiers used only for the check-digit arithmetic; the GLEIF record bodies are fixtures.

## Requirement coverage

| Requirement | Where |
| --- | --- |
| 8 (key custody part) | `src/identity/keys.ts`: hosted keys, customer public-key-only custody, signing input and JWS assembly |
| 9 public log | `src/ledger/log.ts`, `src/ledger/ports.ts`, `src/ledger/store-d1.ts` |
| 10 third-party time | `src/ledger/timestamp.ts` (RFC 3161 and the cosignature anchor) |
| 11 validity and revocation | `src/ledger/revocation.ts` |
| 12 key discovery and binding | `src/identity/keys.ts`, `src/identity/ports.ts` (JWKS, DNS TXT, binding levels) |
| 13 LEI and vLEI | `src/identity/lei.ts` |
| 14 who authorized | `src/identity/roles.ts` |
| 17 proven readers and receipts | `src/readers/webbotauth.ts`, `src/readers/receipts.ts` |

## Stubbed, or needing a founder step

1. **Witness key.** `TROOTH_WITNESS_KEY` must be set as a Worker secret (a private JWK JSON string from `generateKeyPair`). The same key signs tree heads, checkpoints and revocation lists. Its public half should be published at a Trooth well-known URL and announced with the checkpoint origin `trooth.co/semanto/log/v1` and signer name `trooth.co` so outside monitors can configure it.
2. **Append serialization.** `D1LogStore.appendLeaf` computes the index from the row count. Two concurrent appends could collide. Put a Durable Object in front of the log, or run appends only from the nightly cron and the compile queue consumer, before launch.
3. **Time-stamp authority.** `TSA_URL` is unset. Pick a public RFC 3161 TSA (FreeTSA, DigiCert, Sectigo, or the one worker-f anchors with), set the URL, and store the returned token at `semanto/log/tsa/<tree size>.tsr` in R2 with `tsa_token_key` and `tsa_time` on the tree head row. The CMS signature in the token is not checked in code; keep the TSA certificate chain and check with `openssl ts -verify` in the nightly job until a CMS verifier is written.
4. **Second log cosignature.** `prepareCosignatureLeaf` and `acceptCosignature` are ready; no witness is configured. Candidates: a Sigsum witness or the Armored Witness network, both of which take the checkpoint body as is.
5. **vLEI verifier.** `VleiNotWired` ships. Until a KERI/ACDC verifier (for example a hosted vLEI verifier endpoint or the GLEIF reference verifier) is wired behind `VleiVerifier`, every presented vLEI stays "presented, not checked" and never enters the Semanto header.
6. **GLEIF.** No account is needed for `lookupLei`; GLEIF rate limits apply (their published limit should be read before scheduling bulk lookups). The lookup goes through `platformHttp`.
7. **DNS.** `dohDns` uses Cloudflare's resolver. Customers publish `_trooth-keys.<domain> TXT "v=trooth1; kid=<thumbprint>"`; the dashboard copy for that step should quote `dnsKeyRecord(kid)` verbatim.
8. **Known directories.** `KNOWN_DIRECTORIES` holds one entry (`https://chatgpt.com`). Check every entry against the operator's own documentation before launch and add others only from published sources. A directory not in the table is still proven; it is shown by its host name.
9. **Nonce store.** `KvNonceStore` is eventually consistent, so a replay inside KV's propagation window could pass twice at two edges. A Durable Object keyed by directory is the exact version. `MemoryNonceStore` is for tests only.
10. **IP hash secret.** `hashIp` needs a secret of at least 16 characters, to be added to `Env` by the serve agent (suggested name `RECEIPT_IP_SALT_SECRET`) and set as a Worker secret. It must rotate only by replacing the secret, which breaks same-day correlation for that day; the daily rotation is automatic.
11. **Enterprise signing policy.** `mayBeSigned` takes `{ officers: "single" | "two_officer" }`; which workspaces are two-officer is a settings question for `src/settings`.

## Notes for the serve and compiler agents

- Tree head and proof routes: `log.getTreeHead(size)`, `log.inclusionProof(index, size)`, `log.consistencyProof(from, to)`, `log.checkpoint()` map to `/public/semanto/log/tree-head`, `/log/proof`, `/log/consistency` and a `/log/checkpoint` text route (`text/plain; charset=utf-8`).
- After a version is signed: `log.append({ kind: "semanto_version", trooth_id, ref: smv_id, hash: root_hash, at })`, then the witness leaf, and write `{ log: LEDGER_URL, index, tree_size, tree_head: smt_id }` into `SemantoFile.ledger`.
- On every served representation: `verifyWebBotAuth` then `recordRead`, with `proofFromResult` deciding what the receipt says. Never pass the address anywhere but `recordRead`.
- The header's `identity.authorized_by` comes from the `authorized_by` field of `mayBeSigned`; `identity.vlei` from `vleiForHeader`; `identity.key_binding.dns_record` from the `dns_names_kid` field of `bindingStatus`.
