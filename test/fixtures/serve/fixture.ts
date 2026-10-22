// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Builds the in-memory fixture estate for the serving tests: Acme Inc
// (acme.com, fictional) with a withdrawn version 1 and a signed version 2 of
// three pages, hosted key custody; and Beta Ltd (beta.example, fictional)
// with no signed version. Hashes, ids, signatures and the log entry are
// computed here with the core rules, so the fixture is a real Semanto file,
// not a hand-typed one. No figure in it is a measurement.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { utf8 } from "@/core/encoding";
import { digest } from "@/core/hash";
import { estimateTokens } from "@/core/tokens";
import { generateKeyPair, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { signObject, JWS_TYPES } from "@/core/jws";
import { factId, factsRoot, pageId, pagesRoot, rootHash, tierHash, versionId, SCHEMA_URL, SEMANTO_CONTRACT, type Controls, type Fact, type PageEntry, type SemantoFile, type SemantoHeader } from "@/core/semanto";
import { MemoryVersionStore, memoryPorts, type MemoryCompany, type MemoryVersion } from "@/serve/memory-ports";
import type { Ports } from "@/serve/ports";

const here = dirname(fileURLToPath(import.meta.url));
export const readFixture = (name: string): string => readFileSync(join(here, name), "utf8");

export const FIXED_NOW = new Date("2026-10-20T12:00:00.000Z");

export interface FixturePage {
  slug: string;
  url: string;
  title: string;
  markdown: string;
  html: string;
}

export const ACME_PAGES: FixturePage[] = [
  { slug: "home", url: "https://acme.com/", title: "Acme Inc", markdown: readFixture("fixture-acme-home.md"), html: readFixture("fixture-acme-home.html") },
  { slug: "about", url: "https://acme.com/about", title: "About Acme Inc", markdown: readFixture("fixture-acme-about.md"), html: readFixture("fixture-acme-about.html") },
  { slug: "pricing", url: "https://acme.com/pricing", title: "Pricing", markdown: readFixture("fixture-acme-pricing.md"), html: readFixture("fixture-acme-pricing.html") },
];

export interface Estate {
  store: MemoryVersionStore;
  ports: ReturnType<typeof memoryPorts>;
  witness: PrivateJwk;
  witnessPublic: PublicJwk;
  companyKey: PrivateJwk;
  companyPublic: PublicJwk;
  acme: { file: SemantoFile; pages: Map<string, Uint8Array>; entries: PageEntry[]; version: MemoryVersion; v1: SemantoFile };
}

async function buildEntries(pages: FixturePage[], witnessed_at: string): Promise<{ entries: PageEntry[]; bytes: Map<string, Uint8Array>; original: Map<string, number> }> {
  const entries: PageEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  const original = new Map<string, number>();
  for (const p of pages) {
    const b = utf8(p.markdown);
    const id = await pageId(b);
    entries.push({
      id,
      url: p.url,
      title: p.title,
      hash: await digest(b),
      source_hash: await digest(utf8(p.html)),
      bytes: b.length,
      tokens: estimateTokens(p.markdown),
      witnessed_at,
      lang: "en",
      status: 200,
      index: { noindex: false, nosnippet: false, canonical: p.url, robots_blocked: false },
    });
    bytes.set(id, b);
    original.set(id, estimateTokens(p.html));
  }
  return { entries, bytes, original };
}

async function buildFacts(witnessed_at: string): Promise<Fact[]> {
  const raw: Omit<Fact, "id">[] = [
    {
      key: "identity.founded",
      statement: "Acme Inc was founded in Springfield in 1952 by two blacksmiths.",
      value: "1952",
      provenance: "declared",
      evidence: { url: "https://acme.com/about", witnessed_at, anchor: "founded in Springfield in 1952" },
      schema: { type: "Organization", property: "foundingDate" },
    },
    {
      key: "security.contact",
      statement: "Our security contact is security@acme.com and we answer within two business days.",
      value: "security@acme.com",
      provenance: "declared",
      evidence: { url: "https://acme.com/about", witnessed_at, anchor: "security contact" },
    },
    {
      key: "support.response_time",
      statement: "Support answers email within one business day.",
      value: "1 business day",
      provenance: "declared",
      evidence: { url: "https://acme.com/", witnessed_at },
    },
  ];
  const out: Fact[] = [];
  for (const f of raw) out.push({ id: await factId(f), ...f });
  return out;
}

const CONTROLS: Controls = {
  say_it_this_way: { company: "Acme Inc" },
  when_unknown: "Say the page does not state it.",
  access_policy: "open",
  content_signals: { "ai-train": false, search: true, "ai-input": true },
};

export async function buildVersion(opts: {
  pages: FixturePage[];
  version: number;
  supersedes: number | null;
  state: SemantoFile["header"]["state"];
  companyKey: PrivateJwk;
  witness: PrivateJwk;
  built_at: string;
  trooth_id: string;
  domain: string;
  org: string;
  kid_url: string;
  ledger?: { log: string; index: number; tree_size: number; tree_head: string } | null;
}): Promise<{ file: SemantoFile; bytes: Map<string, Uint8Array>; original: Map<string, number> }> {
  const witnessed_at = opts.built_at;
  const { entries, bytes, original } = await buildEntries(opts.pages, witnessed_at);
  const facts = await buildFacts(witnessed_at);
  const question_map = [{ question: "How fast does Acme ship?", answered_on_site: true, passages: [{ url: "https://acme.com/", anchor: "within five business days" }] }];
  const documents: SemantoFile["documents"] = [];
  const products: unknown[] = [];
  const tiers: SemantoHeader["tiers"] = [
    { name: "facts", tokens: estimateTokens(JSON.stringify(facts)), hash: await tierHash(facts) },
    { name: "controls", tokens: estimateTokens(JSON.stringify(CONTROLS)), hash: await tierHash(CONTROLS) },
    { name: "pages", tokens: entries.reduce((a, e) => a + e.tokens, 0), hash: await tierHash(entries) },
    { name: "question_map", tokens: estimateTokens(JSON.stringify(question_map)), hash: await tierHash(question_map) },
    { name: "documents", tokens: 0, hash: await tierHash(documents) },
    { name: "products", tokens: 0, hash: await tierHash(products) },
  ];
  const header: SemantoHeader = {
    schema: SCHEMA_URL,
    contract: SEMANTO_CONTRACT,
    org: opts.org,
    trooth_id: opts.trooth_id,
    domains: [opts.domain],
    profile: `https://trooth.co/network/company/${opts.trooth_id}`,
    version: opts.version,
    supersedes: opts.supersedes,
    built_at: opts.built_at,
    state: opts.state,
    not_before: opts.built_at,
    not_after: null,
    witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true",
    tiers,
    pages_root: await pagesRoot(entries),
    facts_root: await factsRoot(facts),
    pages_manifest: entries,
    identity: { domain: opts.domain, trooth_id: opts.trooth_id, legal_name: `${opts.org}.`, key_binding: { jwks_url: opts.kid_url, dns_record: true } },
  };
  const root = await rootHash(header);
  const sig = await signObject(header, opts.companyKey, JWS_TYPES.semantoVersion, { iat: new Date(opts.built_at) });
  const wit = await signObject({ root_hash: root, witnessed_at }, opts.witness, JWS_TYPES.witness, { iat: new Date(opts.built_at) });
  const file: SemantoFile = {
    header,
    facts,
    controls: CONTROLS,
    question_map,
    documents,
    products,
    root_hash: root,
    signature: opts.state === "read" ? null : { alg: "EdDSA", kid: opts.companyKey.kid, jws: sig.detached, key: opts.kid_url },
    witness: { by: "Trooth", at: witnessed_at, kid: opts.witness.kid, jws: wit.detached },
    ledger: opts.ledger ?? null,
  };
  return { file, bytes, original };
}

export async function buildEstate(now: () => Date = () => FIXED_NOW): Promise<Estate> {
  const w = await generateKeyPair();
  const k = await generateKeyPair();
  const store = new MemoryVersionStore();
  const ports = memoryPorts(store, w.privateJwk, { now });
  const kid_url = "https://acme.com/.well-known/trooth-keys.json";

  // Version 1: two pages, later withdrawn.
  const v1 = await buildVersion({ pages: ACME_PAGES.slice(0, 2), version: 1, supersedes: null, state: "withdrawn", companyKey: k.privateJwk, witness: w.privateJwk, built_at: "2026-09-01T09:00:00.000Z", trooth_id: "acme-inc", domain: "acme.com", org: "Acme Inc", kid_url });

  // Version 2: three pages, signed, logged.
  const pre = await buildVersion({ pages: ACME_PAGES, version: 2, supersedes: 1, state: "signed", companyKey: k.privateJwk, witness: w.privateJwk, built_at: "2026-10-01T09:00:00.000Z", trooth_id: "acme-inc", domain: "acme.com", org: "Acme Inc", kid_url });
  // The ledger's leaf records (src/ledger/ports.ts): one semanto_version leaf per signed version.
  await ports.log.append({ kind: "semanto_version", trooth_id: "acme-inc", ref: versionId(v1.file.root_hash), hash: v1.file.root_hash, at: "2026-09-01T10:00:00.000Z" });
  const { index } = await ports.log.append({ kind: "semanto_version", trooth_id: "acme-inc", ref: versionId(pre.file.root_hash), hash: pre.file.root_hash, at: "2026-10-01T10:00:00.000Z" });
  const incl = await ports.log.getInclusion(index);
  pre.file.ledger = { log: incl!.log, index, tree_size: incl!.tree_size, tree_head: incl!.tree_head_jws };

  const version2: MemoryVersion = { file: pre.file, pages: pre.bytes, original_tokens: pre.original, signed_at: "2026-10-01T10:00:00.000Z", withdrawn_at: null };
  const acme: MemoryCompany = {
    record: { trooth_id: "acme-inc", domain: "acme.com", org: "Acme Inc", tier: "full", legal_name: "Acme Inc.", current_version: 2, custody: "hosted" },
    versions: new Map([
      [1, { file: v1.file, pages: v1.bytes, original_tokens: v1.original, signed_at: "2026-09-01T10:00:00.000Z", withdrawn_at: "2026-09-20T10:00:00.000Z" }],
      [2, version2],
    ]),
    live: new Map(),
    jwks: { keys: [k.publicJwk] },
    hostedKey: k.privateJwk,
  };
  store.add(acme);

  // Beta Ltd: read, never signed, customer custody.
  const betaKey = await generateKeyPair();
  const beta = await buildVersion({ pages: [ACME_PAGES[2]!], version: 1, supersedes: null, state: "read", companyKey: betaKey.privateJwk, witness: w.privateJwk, built_at: "2026-10-05T09:00:00.000Z", trooth_id: "beta-ltd", domain: "beta.example", org: "Beta Ltd", kid_url: "https://beta.example/.well-known/trooth-keys.json" });
  store.add({
    record: { trooth_id: "beta-ltd", domain: "beta.example", org: "Beta Ltd", tier: "basic", current_version: null, custody: "customer" },
    versions: new Map([[1, { file: beta.file, pages: beta.bytes, original_tokens: beta.original, signed_at: null, withdrawn_at: null }]]),
    live: new Map(),
    jwks: { keys: [betaKey.publicJwk] },
    hostedKey: null,
  });

  return { store, ports, witness: w.privateJwk, witnessPublic: w.publicJwk, companyKey: k.privateJwk, companyPublic: k.publicJwk, acme: { file: pre.file, pages: pre.bytes, entries: pre.file.header.pages_manifest, version: version2, v1: v1.file } };
}

export type { Ports };
