// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Generates the shared verifier test vectors under verifier/test-vectors/v1.
// Every verifier (JavaScript, Python, Go) runs the same files, the way the
// Certificate Transparency reference tests (RFC 6962) and the RFC 8785 test
// suite are shared across implementations. The generator is deterministic:
// fixed keys from test/fixtures/verifier, every date fixed to
// 2026-10-22T12:00:00Z, no Date.now() and no randomness, so running it twice
// writes the same bytes. Run with: npx tsx verifier/test-vectors/generate.ts
//
// The company is fictional (Acme Inc, acme.com). Every number in a vector is a
// fixture value, never a measurement.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../src/core/canonical";
import { digest, digestBytes } from "../../src/core/hash";
import { toBase64, toHex, utf8 } from "../../src/core/encoding";
import { consistencyProof, inclusionProof, leafHash, rootFromLeafHashes } from "../../src/core/merkle";
import { toPublic, type PrivateJwk, type PublicJwk, dnsKeyRecord, importPrivate, sign as rawSign } from "../../src/core/keys";
import { JWS_TYPES, signObject } from "../../src/core/jws";
import { contentDigest, SEMANTO_RESPONSE_COMPONENTS, signMessage } from "../../src/core/httpsig";
import { semantoId } from "../../src/core/ids";
import { estimateTokens } from "../../src/core/tokens";
import {
  factId,
  factsRoot,
  pagesRoot,
  rootHash,
  tierHash,
  versionId,
  SCHEMA_URL,
  type Controls,
  type Fact,
  type PageEntry,
  type SemantoFile,
  type SemantoHeader,
} from "../../src/core/semanto";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const out = join(here, "v1");
const pagesDir = join(out, "pages");

// ------------------------------------------------------------- fixed values

const T = "2026-10-22T12:00:00Z";
const T_EPOCH = 1792670400; // Date.parse(T) / 1000
const NOW = "2026-10-22T12:00:10Z";
const NOW_EPOCH = T_EPOCH + 10;
const DAY = 86400;
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(".000Z", "Z");

const LOG_URL = "https://api.trooth.co/public/semanto/log";
const LOG_ORIGIN = "trooth.co/semanto/log/v1"; // src/ledger/log.ts LOG_ORIGIN
const LOG_SIGNER_NAME = "trooth.co"; // src/ledger/log.ts LOG_SIGNER_NAME
const REL_PROOF = "https://trooth.co/rel/proof"; // src/serve/headers.ts REL.proof
const REL_KEYS = "https://trooth.co/rel/keys";
const API = "https://api.trooth.co/public/semanto/acme";

function fixtureKey(name: string): PrivateJwk {
  const raw = JSON.parse(readFileSync(join(repo, "test", "fixtures", "verifier", name), "utf8")) as PrivateJwk & { _fixture?: string };
  const { _fixture: _note, ...jwk } = raw;
  return jwk;
}

const acmeKey = fixtureKey("acme-signing-key.fixture.json");
const troothKey = fixtureKey("trooth-witness-key.fixture.json");
const agentKey = fixtureKey("agent-key.fixture.json");
const unknownKey = fixtureKey("unknown-key.fixture.json");

const acmeJwks = { keys: [toPublic(acmeKey)] };
const troothJwks = { keys: [toPublic(troothKey)] };
const agentJwks = { keys: [toPublic(agentKey)] };

// ------------------------------------------------------------- the pages

const PAGES: { url: string; title: string; markdown: string; html: string }[] = [
  {
    url: "https://acme.com/",
    title: "Acme Inc",
    markdown: "# Acme Inc\n\nAcme Inc makes workflow software for small teams.\n\nFounded in Portland, Oregon. Offices in Portland and Austin.\n\n- [Security](https://acme.com/security)\n- [Pricing](https://acme.com/pricing)\n",
    html: "<html><head><title>Acme Inc</title></head><body><h1>Acme Inc</h1><p>Acme Inc makes workflow software for small teams.</p></body></html>",
  },
  {
    url: "https://acme.com/security",
    title: "Security at Acme",
    markdown: "# Security at Acme\n\nEvery employee account uses multi-factor authentication.\n\nCustomer data is stored in the United States. Backups are taken every day and kept for 30 days.\n\nReport a security issue to security@acme.com.\n",
    html: "<html><head><title>Security at Acme</title></head><body><h1>Security at Acme</h1><p>Every employee account uses multi-factor authentication.</p></body></html>",
  },
  {
    url: "https://acme.com/pricing",
    title: "Pricing",
    markdown: "# Pricing\n\n| Plan | Price | Seats |\n| --- | --- | --- |\n| Starter | 49 USD a month | up to 5 |\n| Team | 149 USD a month | up to 25 |\n\nEvery plan includes a 14 day trial. No card is needed to start.\n",
    html: "<html><head><title>Pricing</title></head><body><h1>Pricing</h1><table><tr><td>Starter</td><td>49 USD a month</td></tr></table></body></html>",
  },
];

async function pageEntry(p: (typeof PAGES)[number]): Promise<PageEntry> {
  const bytes = utf8(p.markdown);
  const hash = await digest(bytes);
  return {
    id: semantoId("smp", hash),
    url: p.url,
    title: p.title,
    hash,
    source_hash: await digest(p.html),
    bytes: bytes.length,
    tokens: estimateTokens(p.markdown),
    witnessed_at: T,
    lang: "en",
    status: 200,
    index: { noindex: false, nosnippet: false, canonical: p.url, robots_blocked: false },
  };
}

// ------------------------------------------------------------- the facts

const FACT_BODIES: Omit<Fact, "id">[] = [
  {
    key: "identity.legal_name",
    statement: "The company's legal name is Acme Inc.",
    value: "Acme Inc",
    provenance: "declared",
    evidence: { url: "https://acme.com/", witnessed_at: T, anchor: "Acme Inc makes workflow software" },
    schema: { type: "Organization", property: "legalName" },
  },
  {
    key: "security.mfa",
    statement: "Every employee account uses multi-factor authentication.",
    value: true,
    provenance: "declared",
    evidence: { url: "https://acme.com/security", witnessed_at: T, anchor: "Every employee account uses multi-factor authentication" },
  },
  {
    key: "pricing.starter_monthly_usd",
    statement: "The Starter plan costs 49 USD a month for up to 5 seats.",
    value: 49,
    provenance: "declared",
    evidence: { url: "https://acme.com/pricing", witnessed_at: T, anchor: "Starter | 49 USD a month" },
    schema: { type: "Offer", property: "price" },
  },
  {
    key: "identity.lei",
    statement: "Acme Inc has the Legal Entity Identifier ACMEFIXTURE000000012.",
    value: "ACMEFIXTURE000000012",
    provenance: "public_record",
    evidence: { url: "https://search.gleif.org/#/record/ACMEFIXTURE000000012", witnessed_at: T, source: "GLEIF" },
  },
];

const CONTROLS: Controls = {
  say_it_this_way: { company: "Acme Inc", product: "Acme Workflow" },
  when_unknown: "Say that Acme has not published this.",
  access_policy: "open",
  content_signals: { "ai-train": false, search: true, "ai-input": true },
};

// ------------------------------------------------------------- helpers

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
}

const hexDigest = (b: Uint8Array): string => `sha256:${toHex(b)}`;

/** The log leaf, exactly src/ledger/ports.ts LogLeaf: canonical JSON of these five fields. */
interface LeafRecord {
  kind: "semanto_version";
  trooth_id: string | null;
  ref: string;
  hash: string;
  at: string;
}

const leafBytes = (r: LeafRecord): Uint8Array => utf8(canonicalize(r));

/** C2SP checkpoint (signed note, as src/ledger/log.ts signCheckpoint writes it): origin, size, base64 root, then a signature line named by the signer. */
async function checkpoint(size: number, root: Uint8Array): Promise<string> {
  const body = `${LOG_ORIGIN}\n${size}\n${toBase64(root)}\n`;
  const pubBytes = Uint8Array.from(Buffer.from(troothKey.x.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  // Key hash per the note format: SHA-256(name || "\n" || 0x01 || pubkey), first 4 bytes.
  const keyHashInput = new Uint8Array([...utf8(LOG_SIGNER_NAME), 0x0a, 0x01, ...pubBytes]);
  const keyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", keyHashInput)).slice(0, 4);
  const sig = await rawSign(await importPrivate(troothKey), utf8(body));
  const sigLine = toBase64(new Uint8Array([...keyHash, ...sig]));
  return `${body}\n— ${LOG_SIGNER_NAME} ${sigLine}\n`;
}

// ------------------------------------------------------------- main

async function main(): Promise<void> {
  mkdirSync(pagesDir, { recursive: true });

  const manifest = await Promise.all(PAGES.map(pageEntry));
  const facts: Fact[] = [];
  for (const body of FACT_BODIES) facts.push({ id: await factId(body), ...body });

  const tiers: SemantoHeader["tiers"] = [
    { name: "facts", tokens: estimateTokens(canonicalize(facts)), hash: await tierHash(facts) },
    { name: "controls", tokens: estimateTokens(canonicalize(CONTROLS)), hash: await tierHash(CONTROLS) },
    { name: "pages", tokens: manifest.reduce((a, p) => a + p.tokens, 0), hash: await tierHash(manifest) },
    { name: "question_map", tokens: 0, hash: await tierHash([]) },
    { name: "documents", tokens: 0, hash: await tierHash([]) },
    { name: "products", tokens: 0, hash: await tierHash([]) },
  ];

  const header: SemantoHeader = {
    schema: SCHEMA_URL,
    contract: 1,
    org: "Acme Inc",
    trooth_id: "acme",
    domains: ["acme.com"],
    profile: "https://trooth.co/network/company/acme",
    version: 1,
    supersedes: null,
    built_at: T,
    state: "signed",
    not_before: T,
    not_after: iso(T_EPOCH + 90 * DAY),
    witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true",
    tiers,
    pages_root: await pagesRoot(manifest),
    facts_root: await factsRoot(facts),
    pages_manifest: manifest,
    identity: {
      domain: "acme.com",
      trooth_id: "acme",
      legal_name: "Acme Inc",
      lei: "ACMEFIXTURE000000012",
      authorized_by: [{ role: "owner", name: "Fixture Owner" }],
      key_binding: { jwks_url: "https://acme.com/.well-known/trooth-keys.json", dns_record: true },
    },
  };

  const root = await rootHash(header);
  const smv = versionId(root);
  const companySig = await signObject(header, acmeKey, JWS_TYPES.semantoVersion, { iat: new Date(T) });
  const witnessPayload = { root_hash: root, witnessed_at: T };
  const witnessSig = await signObject(witnessPayload, troothKey, JWS_TYPES.witness, { iat: new Date(T) });

  // The log: five leaves, Acme's version at index 3.
  const leafRecords: LeafRecord[] = [
    { kind: "semanto_version", trooth_id: "fixture-one", ref: "smv_fixtureoneaaaaaaaaaaaaaaaaaaa", hash: await digest("fixture-one v1"), at: iso(T_EPOCH - 4 * DAY) },
    { kind: "semanto_version", trooth_id: "fixture-two", ref: "smv_fixturetwoaaaaaaaaaaaaaaaaaaa", hash: await digest("fixture-two v1"), at: iso(T_EPOCH - 3 * DAY) },
    { kind: "semanto_version", trooth_id: "fixture-one", ref: "smv_fixtureoneaaaaaaaaaaaaaaaaaab", hash: await digest("fixture-one v2"), at: iso(T_EPOCH - 2 * DAY) },
    { kind: "semanto_version", trooth_id: "acme", ref: smv, hash: root, at: T },
    { kind: "semanto_version", trooth_id: "fixture-three", ref: "smv_fixturethreeaaaaaaaaaaaaaaaaa", hash: await digest("fixture-three v1"), at: T },
  ];
  const leafHashes = await Promise.all(leafRecords.map((r) => leafHash(leafBytes(r))));
  const root5 = await rootFromLeafHashes(leafHashes);
  const root3 = await rootFromLeafHashes(leafHashes.slice(0, 3));
  // Tree head payload exactly as src/ledger/log.ts signs it: { tree_size, root_hash, signed_at }.
  const head5Payload = { tree_size: 5, root_hash: hexDigest(root5), signed_at: T };
  const head3Payload = { tree_size: 3, root_hash: hexDigest(root3), signed_at: iso(T_EPOCH - 2 * DAY) };
  const head5 = await signObject(head5Payload, troothKey, JWS_TYPES.treeHead, { iat: new Date(T) });
  const head3 = await signObject(head3Payload, troothKey, JWS_TYPES.treeHead, { iat: new Date(iso(T_EPOCH - 2 * DAY)) });
  const logInclusion = await inclusionProof(leafHashes, 3);
  const logConsistency = await consistencyProof(leafHashes, 3);

  const file: SemantoFile = {
    header,
    facts,
    controls: CONTROLS,
    question_map: [],
    documents: [],
    products: [],
    root_hash: root,
    signature: { alg: "EdDSA", kid: acmeKey.kid, jws: companySig.detached, key: `https://acme.com/.well-known/trooth-keys.json#${acmeKey.kid}` },
    witness: { by: "Trooth", at: T, kid: troothKey.kid, jws: witnessSig.detached },
    ledger: { log: LOG_URL, index: 3, tree_size: 5, tree_head: hexDigest(root5) },
  };

  const pagesByUrl: Record<string, string> = {};
  const pagesById: Record<string, string> = {};
  for (const p of PAGES) {
    const e = manifest.find((m) => m.url === p.url)!;
    pagesByUrl[p.url] = p.markdown;
    pagesById[e.id] = p.markdown;
    writeFileSync(join(pagesDir, `${e.id}.md`), p.markdown);
  }

  // The page proof for /security (manifest index 1).
  const pageIndex = 1;
  const pageLeafHashes = await Promise.all(manifest.map((m) => leafHash(digestBytes(m.hash))));
  const pagePath = await inclusionProof(pageLeafHashes, pageIndex);
  const securityPage = manifest[pageIndex]!;
  // The proof document in the shape src/serve/proof.ts PageProof serves, plus `ledger.leaf`
  // (the log's leaf record, so a reader can recompute leaf_hash). The header travels
  // beside it: a reader fetches the version (Link rel alternate, or /versions/{n}).
  const pageProof = {
    object: "semanto.proof",
    page_id: securityPage.id,
    page_hash: securityPage.hash,
    version: header.version,
    version_id: smv,
    pages_root: header.pages_root,
    inclusion: { index: pageIndex, size: manifest.length, path: pagePath.map(hexDigest) },
    root_hash: root,
    signed_at: T,
    witnessed_at: T,
    signature: companySig.detached,
    witness: witnessSig.detached,
    ledger: {
      log: LOG_URL,
      index: 3,
      tree_size: 5,
      leaf: leafRecords[3],
      leaf_hash: hexDigest(leafHashes[3]!),
      root_hash: hexDigest(root5),
      tree_head_jws: head5.compact,
      inclusion_path: logInclusion.map(hexDigest),
    },
  };

  // A signed response for /security over the markdown bytes.
  const body = pagesByUrl[securityPage.url]!;
  const baseHeaders: Record<string, string> = {
    "content-type": "text/markdown; charset=utf-8",
    "content-digest": await contentDigest(body),
    "content-length": String(utf8(body).length),
    "trooth-contract": "1",
    "trooth-semanto-version": smv,
    "trooth-page-hash": securityPage.hash,
    link: `<${securityPage.url}>; rel="canonical", <${API}/pages/${securityPage.id}/proof>; rel="${REL_PROOF}", <https://acme.com/.well-known/trooth-keys.json>; rel="${REL_KEYS}", <https://acme.com/.well-known/trooth.semanto>; rel="https://trooth.co/rel/semanto"`,
    vary: "Accept",
    etag: `"${securityPage.hash.slice(7)}"`,
    "cache-control": "public, max-age=300",
    "content-signal": "ai-train=no, search=yes, ai-input=yes",
  };
  const signResponse = async (key: PrivateJwk, created: number) =>
    signMessage({ kind: "response", status: 200, headers: baseHeaders }, key, { components: [...SEMANTO_RESPONSE_COMPONENTS], created, ttlSeconds: 300, tag: "trooth-semanto" });
  const goodSig = await signResponse(acmeKey, T_EPOCH);
  const response = { url: securityPage.url, status: 200, headers: { ...baseHeaders, ...goodSig }, body };

  // A Web Bot Auth signed request from a fixture agent.
  const reqHeaders: Record<string, string> = {
    host: "acme.com",
    accept: "text/markdown",
    "signature-agent": '"https://agent.fixture.example"',
  };
  const reqSig = await signMessage({ kind: "request", method: "GET", url: securityPage.url, headers: reqHeaders }, agentKey, {
    components: ["@authority", "signature-agent"],
    created: T_EPOCH,
    ttlSeconds: 60,
    tag: "web-bot-auth",
    nonce: "fixture-nonce-0001",
  });

  // A signed offer.
  const offerPayload = {
    sku: "ACME-STARTER",
    name: "Acme Starter plan",
    url: "https://acme.com/pricing",
    price: { amount: 4900, currency: "USD", per: "month" },
    seller: { trooth_id: "acme", domain: "acme.com" },
    semanto_version: smv,
    issued_at: T,
  };
  const offer = await signObject(offerPayload, acmeKey, JWS_TYPES.offer, { iat: new Date(T), nbf: new Date(T), exp: new Date(iso(T_EPOCH + 7 * DAY)) });
  const expiredOffer = await signObject({ ...offerPayload, issued_at: iso(T_EPOCH - 30 * DAY) }, acmeKey, JWS_TYPES.offer, {
    iat: new Date(iso(T_EPOCH - 30 * DAY)),
    nbf: new Date(iso(T_EPOCH - 30 * DAY)),
    exp: new Date(iso(T_EPOCH - 23 * DAY)),
  });
  const offerId = semantoId("smo", await digest(canonicalize(offerPayload)));

  // Revocation lists.
  // The list exactly as src/ledger/revocation.ts signs it: { trooth_id, issued_at, next_update, revocations }.
  const revocationPayload = {
    trooth_id: null as string | null,
    issued_at: T,
    next_update: iso(T_EPOCH + DAY),
    revocations: [{ kind: "version", ref: "smv_fixtureoneaaaaaaaaaaaaaaaaaaa", reason: "superseded", revoked_at: iso(T_EPOCH - 2 * DAY) }],
  };
  const revocations = await signObject(revocationPayload, troothKey, JWS_TYPES.revocation, { iat: new Date(T) });
  const withdrawnPayload = {
    ...revocationPayload,
    revocations: [...revocationPayload.revocations, { kind: "version", ref: smv, reason: "withdrawn by the company", revoked_at: NOW }],
  };
  const withdrawn = await signObject(withdrawnPayload, troothKey, JWS_TYPES.revocation, { iat: new Date(NOW) });

  // ------------------------------------------------------------- write

  writeJson("keys.json", {
    description: "Public keys for the vectors. The company's set is what acme.com would serve at /.well-known/trooth-keys.json; Trooth's set is what api.trooth.co serves; the agent's set is what the Signature-Agent URL serves.",
    company: { jwks_url: "https://acme.com/.well-known/trooth-keys.json", jwks: acmeJwks, dns_txt: [dnsKeyRecord(acmeKey.kid)], dns_name: "_trooth-keys.acme.com" },
    trooth: { jwks_url: "https://api.trooth.co/.well-known/trooth-keys.json", jwks: troothJwks },
    agent: { directory_url: "https://agent.fixture.example/.well-known/http-message-signatures-directory", jwks: agentJwks },
  });

  writeJson("semanto.json", {
    kind: "semanto-file",
    description: "A complete signed and witnessed Semanto for the fictional Acme Inc: 3 pages, 4 facts, controls, an empty products tier.",
    now: NOW,
    file,
    expect: { ok: true, state: "current", version_id: smv },
  });

  writeJson("pages.json", {
    kind: "pages",
    description: "The markdown of every page, exactly as served. Hash the UTF-8 bytes of each string to get the manifest hash. The same bytes are in pages/<id>.md.",
    by_url: pagesByUrl,
    by_id: pagesById,
    expect: { ok: true },
  });

  writeJson("witness.json", {
    kind: "witness",
    description: "Trooth's detached JWS over { root_hash, witnessed_at } with typ witness-statement.",
    now: NOW,
    payload: witnessPayload,
    jws: witnessSig.detached,
    kid: troothKey.kid,
    expect: { ok: true },
  });

  writeJson("log.json", {
    kind: "log",
    description: "A public log of five leaves. Leaf data is the canonical JSON of the leaf record { kind, trooth_id, ref, hash, at }; leaf hash is SHA-256(0x00 || data) per RFC 6962. Acme's version is leaf 3. The checkpoint is a signed note with the origin and signer name the log publishes.",
    now: NOW,
    origin: LOG_ORIGIN,
    signer_name: LOG_SIGNER_NAME,
    log: LOG_URL,
    leaves: leafRecords.map((r, i) => ({ index: i, record: r, data: canonicalize(r), leaf_hash: hexDigest(leafHashes[i]!) })),
    tree_heads: {
      "3": { payload: head3Payload, jws: head3.compact, kid: troothKey.kid },
      "5": { payload: head5Payload, jws: head5.compact, kid: troothKey.kid },
    },
    checkpoint: await checkpoint(5, root5),
    inclusion: { index: 3, tree_size: 5, leaf_hash: hexDigest(leafHashes[3]!), root_hash: hexDigest(root5), path: logInclusion.map(hexDigest) },
    consistency: { from: 3, to: 5, old_root: hexDigest(root3), new_root: hexDigest(root5), path: logConsistency.map(hexDigest) },
    expect: { ok: true },
  });

  writeJson("page-proof.json", {
    kind: "page-proof",
    description: "What GET /public/semanto/acme/pages/<id>/proof returns for /security (object semanto.proof), the version header fetched beside it, and the page markdown. The proof holds the page's place in pages_root, the company signature, the witness statement and the version's place in the log.",
    now: NOW,
    proof: pageProof,
    header,
    page_markdown: pagesByUrl[securityPage.url],
    expect: { ok: true },
  });

  writeJson("response.json", {
    kind: "response",
    description: "A signed HTTP response for GET https://acme.com/security with Accept: text/markdown. RFC 9421 over @status, content-type, content-digest, trooth-semanto-version and trooth-page-hash, tag trooth-semanto, with RFC 9530 Content-Digest.",
    now: NOW,
    now_epoch: NOW_EPOCH,
    response,
    expect: { ok: true, keyid: acmeKey.kid },
  });

  writeJson("web-bot-auth-request.json", {
    kind: "web-bot-auth-request",
    description: "A request signed per draft-ietf-webbotauth-httpsig-protocol: tag web-bot-auth, @authority and signature-agent covered, keys at the Signature-Agent directory.",
    now: NOW,
    now_epoch: NOW_EPOCH,
    request: { method: "GET", url: securityPage.url, headers: { ...reqHeaders, ...reqSig } },
    expect: { ok: true, keyid: agentKey.kid, agent: "https://agent.fixture.example" },
  });

  writeJson("offer.json", {
    kind: "offer",
    description: "A signed offer (typ signed-offer) valid for seven days from issue. Amounts are integer minor units.",
    now: NOW,
    offer_id: offerId,
    payload: offerPayload,
    jws: offer.compact,
    kid: acmeKey.kid,
    expect: { ok: true },
  });

  writeJson("revocations.json", {
    kind: "revocations",
    description: "Trooth's signed revocation list. It names a fixture company's old version, not Acme's, so Acme's version stays current.",
    now: NOW,
    payload: revocationPayload,
    jws: revocations.compact,
    kid: troothKey.kid,
    version_id: smv,
    expect: { ok: true, state: "current" },
  });

  // ------------------------------------------------------------- negatives

  const tamperedPage = Buffer.from(utf8(pagesByUrl[securityPage.url]!));
  tamperedPage[2] = tamperedPage[2]! ^ 0x01; // "# S" becomes "# R": one byte changed
  writeJson("negative/page-tampered.json", {
    kind: "page-proof",
    description: "The same proof as page-proof.json, with one byte of the page changed. The page hash no longer matches the manifest.",
    now: NOW,
    proof: pageProof,
    header,
    page_markdown: tamperedPage.toString("utf8"),
    expect: { ok: false, reason: "page_hash_mismatch" },
  });

  const tamperedFile = structuredClone(file);
  tamperedFile.facts[1]!.statement = "Some employee accounts use multi-factor authentication.";
  writeJson("negative/fact-tampered.json", {
    kind: "semanto-file",
    description: "The Semanto file with one fact's statement changed after signing. facts_root and the fact's id no longer match.",
    now: NOW,
    file: tamperedFile,
    expect: { ok: false, reason: "facts_root_mismatch" },
  });

  const expiredSig = await signResponse(acmeKey, T_EPOCH - 600);
  writeJson("negative/signature-expired.json", {
    kind: "response",
    description: "The response signed 600 seconds before the vector's now with a 300 second window. The signature has expired.",
    now: NOW,
    now_epoch: NOW_EPOCH,
    response: { ...response, headers: { ...baseHeaders, ...expiredSig } },
    expect: { ok: false, reason: "expired" },
  });

  const strangerSig = await signResponse(unknownKey, T_EPOCH);
  writeJson("negative/unknown-key.json", {
    kind: "response",
    description: "The response signed by a key that is in no published JWK Set.",
    now: NOW,
    now_epoch: NOW_EPOCH,
    response: { ...response, headers: { ...baseHeaders, ...strangerSig } },
    expect: { ok: false, reason: "unknown_key" },
  });

  writeJson("negative/offer-expired.json", {
    kind: "offer",
    description: "An offer whose exp passed 23 days before now.",
    now: NOW,
    offer_id: offerId,
    payload: { ...offerPayload, issued_at: iso(T_EPOCH - 30 * DAY) },
    jws: expiredOffer.compact,
    kid: acmeKey.kid,
    expect: { ok: false, reason: "expired" },
  });

  writeJson("negative/version-withdrawn.json", {
    kind: "revocations",
    description: "A revocation list that names Acme's current version. Its state is withdrawn.",
    now: NOW,
    payload: withdrawnPayload,
    jws: withdrawn.compact,
    kid: troothKey.kid,
    version_id: smv,
    expect: { ok: true, state: "withdrawn" },
  });

  const wrongWitness = await signObject({ root_hash: await digest("another root"), witnessed_at: T }, troothKey, JWS_TYPES.witness, { iat: new Date(T) });
  writeJson("negative/witness-mismatch.json", {
    kind: "witness",
    description: "A witness statement over a different root_hash, presented with this file's payload. The signature does not verify.",
    now: NOW,
    payload: witnessPayload,
    jws: wrongWitness.detached,
    kid: troothKey.kid,
    expect: { ok: false, reason: "bad_signature" },
  });

  writeJson("manifest.json", {
    version: "v1",
    generated_for: T,
    files: [
      "keys.json",
      "semanto.json",
      "pages.json",
      "witness.json",
      "log.json",
      "page-proof.json",
      "response.json",
      "web-bot-auth-request.json",
      "offer.json",
      "revocations.json",
      "negative/page-tampered.json",
      "negative/fact-tampered.json",
      "negative/signature-expired.json",
      "negative/unknown-key.json",
      "negative/offer-expired.json",
      "negative/version-withdrawn.json",
      "negative/witness-mismatch.json",
    ],
  });

  console.log(`wrote vectors to ${out} (version ${smv})`);
}

mkdirSync(join(out, "negative"), { recursive: true });
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
