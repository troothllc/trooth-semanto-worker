// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto file: one signed, witnessed record of a company's entire public
// website, built for people and agents. This module is the schema every other
// module builds against, plus the hashing rules that make a Semanto checkable
// offline:
//
//   page hash     digest of the page's markdown bytes exactly as served
//   pages_root    RFC 6962 Merkle root over page hashes in manifest order
//   facts_root    RFC 6962 Merkle root over canonical facts in id order
//   tier hash     digest of the tier's canonical JSON (pages tier: digest of
//                 the manifest, since page bodies are addressed by their own
//                 hashes)
//   root_hash     digest of the canonical header, which lists every tier hash
//                 and both Merkle roots. Signing the header signs everything.
//
// Provenance words are Trooth's four, and no fact is ever shown as one it is
// not: witnessed (Trooth observed it), public_record (read from a registry),
// attested (a named counterparty stated it), declared (the company stated it).
// Three negatives are kept apart: "no", "not_published" and "not_read".

import { canonicalize } from "./canonical";
import { digest, isDigest, digestBytes } from "./hash";
import { rootFromLeafHashes, leafHash } from "./merkle";
import { toHex } from "./encoding";
import { semantoId } from "./ids";

export const SEMANTO_CONTRACT = 1 as const;
export const SCHEMA_URL = "https://trooth.co/schemas/semanto/v1.json" as const;

export type SemantoState = "read" | "confirmed" | "signed" | "withdrawn";
export type Provenance = "witnessed" | "public_record" | "attested" | "declared";
export type Negative = "no" | "not_published" | "not_read";
export type TierName = "header" | "facts" | "controls" | "pages" | "question_map" | "documents" | "products";

export interface TierEntry {
  name: TierName;
  tokens: number;
  hash: string;
}

export interface PageEntry {
  /** smp_ id, the digest of the markdown bytes. */
  id: string;
  url: string;
  title: string;
  /** Digest of the markdown bytes exactly as served. */
  hash: string;
  /** Digest of the HTML as fetched, so a later reader can show the capture was of this page. */
  source_hash: string;
  bytes: number;
  tokens: number;
  /** ISO 8601, when Trooth fetched and rendered the page. */
  witnessed_at: string;
  /** Language tag when the page states one. */
  lang?: string;
  /** For pages above the part limit: part n of m, same url. */
  part?: { n: number; of: number };
  /** The HTTP status Trooth saw; only 200 pages are in the tier. */
  status: number;
  /** Google eligibility signals seen on the page (write-back for the index). */
  index: { noindex: boolean; nosnippet: boolean; canonical: string | null; robots_blocked: boolean };
}

export interface Evidence {
  url: string;
  witnessed_at: string;
  /** A text anchor on the page, so the sentence can be found again. */
  anchor?: string;
  /** For public_record and attested: who said it. */
  source?: string;
}

export interface Fact {
  /** smf_ id, the digest of the canonical fact without `id`. */
  id: string;
  /** A dotted key such as "security.mfa_methods" or "identity.legal_name". */
  key: string;
  statement: string;
  value?: string | number | boolean | string[] | Negative;
  provenance: Provenance;
  evidence: Evidence;
  /** schema.org property path this fact writes back to, if any (for the JSON-LD write-back). */
  schema?: { type: string; property: string };
}

export interface Controls {
  say_it_this_way: Record<string, string>;
  when_unknown: string;
  /** Which reader classes get which representation; never by user agent. */
  access_policy: "open" | "semanto_only" | "signed_agents_only";
  /** Content Signals (contentsignals.org), carried inside the signed record. */
  content_signals: { "ai-train": boolean; search: boolean; "ai-input": boolean };
}

export interface QuestionMapEntry {
  question: string;
  answered_on_site: boolean;
  passages: { url: string; anchor?: string }[];
  fact_ids?: string[];
}

export interface DocumentEntry {
  url: string;
  title: string;
  kind: "pdf" | "other";
  hash: string;
  bytes: number;
  witnessed_at: string;
}

export interface Identity {
  domain: string;
  trooth_id: string;
  legal_name?: string;
  /** ISO 17442 Legal Entity Identifier, 20 characters, read from GLEIF (public_record). */
  lei?: string;
  /** A vLEI Legal Entity credential reference, when the company presents one. */
  vlei?: { said: string; issuer: string; checked_at: string };
  /** Who authorized the signature, from a vLEI role credential or a Trooth role record. */
  authorized_by?: { role: "OOR" | "ECR" | "owner" | "admin"; name?: string; credential?: string }[];
  /** How the signing key is bound to the domain: the published JWKS and the DNS record. */
  key_binding: { jwks_url: string; dns_record: boolean };
}

export interface SemantoHeader {
  schema: typeof SCHEMA_URL;
  contract: typeof SEMANTO_CONTRACT;
  org: string;
  trooth_id: string;
  domains: string[];
  profile: string;
  version: number;
  supersedes: number | null;
  built_at: string;
  state: SemantoState;
  /** Validity of this version as a statement. */
  not_before: string;
  not_after: string | null;
  witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true";
  tiers: TierEntry[];
  pages_root: string;
  facts_root: string;
  pages_manifest: PageEntry[];
  identity: Identity;
}

export interface SemantoFile {
  header: SemantoHeader;
  facts: Fact[];
  controls: Controls;
  question_map: QuestionMapEntry[];
  documents: DocumentEntry[];
  /** Commerce tier; empty for companies without products. Records are defined in src/commerce. */
  products: unknown[];
  /** root_hash = digest(canonical header). */
  root_hash: string;
  /** The company's detached JWS over the header (typ semanto-version). Absent until signed. */
  signature: { alg: "EdDSA"; kid: string; jws: string; key: string } | null;
  /** Trooth's detached JWS over { root_hash, witnessed_at } (typ witness-statement). */
  witness: { by: "Trooth"; at: string; kid: string; jws: string } | null;
  /** Where the version sits in Trooth's public log. */
  ledger: { log: string; index: number; tree_size: number; tree_head: string } | null;
}

// ---------------------------------------------------------------- hashing

export async function factId(f: Omit<Fact, "id">): Promise<string> {
  return semantoId("smf", await digest(canonicalize(f)));
}

export async function pageId(markdownBytes: Uint8Array): Promise<string> {
  return semantoId("smp", await digest(markdownBytes));
}

export async function pagesRoot(manifest: PageEntry[]): Promise<string> {
  const leaves = await Promise.all(manifest.map((p) => leafHash(digestBytes(p.hash))));
  return `sha256:${toHex(await rootFromLeafHashes(leaves))}`;
}

export async function factsRoot(facts: Fact[]): Promise<string> {
  const sorted = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const leaves = await Promise.all(sorted.map((f) => leafHash(new TextEncoder().encode(canonicalize(f)))));
  return `sha256:${toHex(await rootFromLeafHashes(leaves))}`;
}

export async function tierHash(value: unknown): Promise<string> {
  return digest(canonicalize(value));
}

export async function rootHash(header: SemantoHeader): Promise<string> {
  return digest(canonicalize(header));
}

export function versionId(root: string): string {
  return semantoId("smv", root);
}

// ---------------------------------------------------------------- validation

export interface ValidationIssue {
  path: string;
  message: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PROVENANCE: Provenance[] = ["witnessed", "public_record", "attested", "declared"];
const STATES: SemantoState[] = ["read", "confirmed", "signed", "withdrawn"];

/** Structural checks that need no network and no keys. The hashes are checked by `verifyStructure`. */
export function validate(file: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof file !== "object" || file === null) return [{ path: "", message: "not an object" }];
  const f = file as Partial<SemantoFile>;
  const h = f.header as Partial<SemantoHeader> | undefined;
  if (!h) push("header", "missing");
  else {
    if (h.schema !== SCHEMA_URL) push("header.schema", `expected ${SCHEMA_URL}`);
    if (h.contract !== SEMANTO_CONTRACT) push("header.contract", `expected ${SEMANTO_CONTRACT}`);
    if (typeof h.org !== "string" || !h.org) push("header.org", "required");
    if (!Array.isArray(h.domains) || h.domains.length === 0) push("header.domains", "at least one domain");
    if (!Number.isInteger(h.version) || (h.version as number) < 1) push("header.version", "positive integer");
    if (h.supersedes !== null && h.supersedes !== undefined && (!Number.isInteger(h.supersedes) || (h.supersedes as number) >= (h.version as number))) push("header.supersedes", "must be an earlier version or null");
    if (typeof h.built_at !== "string" || !ISO.test(h.built_at)) push("header.built_at", "ISO 8601 UTC");
    if (typeof h.not_before !== "string" || !ISO.test(h.not_before)) push("header.not_before", "ISO 8601 UTC");
    if (h.not_after !== null && (typeof h.not_after !== "string" || !ISO.test(h.not_after))) push("header.not_after", "ISO 8601 UTC or null");
    if (!STATES.includes(h.state as SemantoState)) push("header.state", `one of ${STATES.join(", ")}`);
    if (!isDigest(h.pages_root)) push("header.pages_root", "digest");
    if (!isDigest(h.facts_root)) push("header.facts_root", "digest");
    if (!Array.isArray(h.tiers)) push("header.tiers", "array");
    else h.tiers.forEach((t, i) => { if (!isDigest(t.hash)) push(`header.tiers[${i}].hash`, "digest"); });
    if (!Array.isArray(h.pages_manifest)) push("header.pages_manifest", "array");
    else {
      const seen = new Set<string>();
      h.pages_manifest.forEach((p, i) => {
        if (!isDigest(p.hash)) push(`header.pages_manifest[${i}].hash`, "digest");
        if (!isDigest(p.source_hash)) push(`header.pages_manifest[${i}].source_hash`, "digest");
        if (typeof p.url !== "string" || !/^https:\/\//.test(p.url)) push(`header.pages_manifest[${i}].url`, "https url");
        const key = `${p.url}#${p.part?.n ?? 1}`;
        if (seen.has(key)) push(`header.pages_manifest[${i}].url`, "duplicate page");
        seen.add(key);
        if (p.status !== 200) push(`header.pages_manifest[${i}].status`, "only pages that answered 200 are in the tier");
      });
    }
    const id = h.identity as Partial<Identity> | undefined;
    if (!id || typeof id.domain !== "string") push("header.identity.domain", "required");
    if (id?.lei !== undefined && !/^[A-Z0-9]{18}[0-9]{2}$/.test(id.lei)) push("header.identity.lei", "20 characters, ISO 17442");
  }
  if (!Array.isArray(f.facts)) push("facts", "array");
  else f.facts.forEach((x, i) => {
    if (!PROVENANCE.includes(x.provenance)) push(`facts[${i}].provenance`, `one of ${PROVENANCE.join(", ")}`);
    if (!x.evidence || typeof x.evidence.url !== "string") push(`facts[${i}].evidence.url`, "required");
    if (!x.evidence || !ISO.test(x.evidence.witnessed_at ?? "")) push(`facts[${i}].evidence.witnessed_at`, "ISO 8601 UTC");
    if (typeof x.statement !== "string" || !x.statement) push(`facts[${i}].statement`, "required");
  });
  if (!f.controls || typeof f.controls.when_unknown !== "string") push("controls.when_unknown", "required");
  if (f.controls && !["open", "semanto_only", "signed_agents_only"].includes(f.controls.access_policy)) push("controls.access_policy", "unknown policy");
  if (!isDigest(f.root_hash)) push("root_hash", "digest");
  if (h?.state === "signed" && !f.signature) push("signature", "a signed Semanto carries the company's signature");
  return out;
}

/** Recompute every hash the header claims. Needs the page bytes for the pages tier. */
export async function verifyStructure(file: SemantoFile, pageBytes?: (entry: PageEntry) => Promise<Uint8Array | null>): Promise<ValidationIssue[]> {
  const out = validate(file);
  if (out.length) return out;
  const h = file.header;
  if ((await rootHash(h)) !== file.root_hash) out.push({ path: "root_hash", message: "does not match the canonical header" });
  if ((await pagesRoot(h.pages_manifest)) !== h.pages_root) out.push({ path: "header.pages_root", message: "does not match the manifest" });
  if ((await factsRoot(file.facts)) !== h.facts_root) out.push({ path: "header.facts_root", message: "does not match the facts" });
  const tiers: Record<string, unknown> = {
    facts: file.facts,
    controls: file.controls,
    question_map: file.question_map,
    documents: file.documents,
    products: file.products,
    pages: h.pages_manifest,
  };
  for (const t of h.tiers) {
    if (t.name === "header") continue;
    const v = tiers[t.name];
    if (v === undefined) {
      out.push({ path: `header.tiers.${t.name}`, message: "tier listed but absent" });
      continue;
    }
    if ((await tierHash(v)) !== t.hash) out.push({ path: `header.tiers.${t.name}`, message: "hash does not match the tier" });
  }
  for (const f of file.facts) {
    const { id, ...rest } = f;
    if ((await factId(rest)) !== id) out.push({ path: `facts.${id}`, message: "id does not match the fact" });
  }
  if (pageBytes) {
    for (const p of h.pages_manifest) {
      const b = await pageBytes(p);
      if (b === null) continue;
      if ((await digest(b)) !== p.hash) out.push({ path: `pages.${p.url}`, message: "bytes do not match the manifest" });
    }
  }
  return out;
}
