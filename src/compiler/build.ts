// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Assembling a version: discovery plus fetched pages plus extracted markdown
// plus facts become one SemantoFile in state "read", with the page bodies,
// the coverage receipt and the llms files beside it. Hashing follows
// src/core/semanto.ts exactly (page hash over the markdown bytes, RFC 6962
// roots, RFC 8785 canonical tier hashes, root_hash over the header), so
// verifyStructure passes on what this module returns.
//
// An incremental rebuild takes the previous version and the set of changed
// urls and reuses every unchanged page entry, body and fact, keeping the old
// witnessed_at because that is when the page was seen. The coverage receipt
// says what was found, what was read, what was left out and why, and what
// changed; it never ranks anything.

import { estimateTokens } from "../core/tokens";
import { digest } from "../core/hash";
import { utf8 } from "../core/encoding";
import { semantoId } from "../core/ids";
import { canonicalize } from "../core/canonical";
import {
  SCHEMA_URL, SEMANTO_CONTRACT, pageId, pagesRoot, factsRoot, tierHash, rootHash,
  type SemantoFile, type SemantoHeader, type PageEntry, type Fact, type Controls, type Identity, type QuestionMapEntry, type DocumentEntry, type TierEntry,
} from "../core/semanto";
import type { DiscoveryResult, DiscoveredUrl } from "./discover";
import { robotsAllows } from "./discover";
import { extract, pageBlockKeys, detectChrome, parseFrontMatter, type IndexSignals } from "./extract";
import { extractFacts } from "./facts";
import { buildLlmsTxt, buildLlmsFull, buildSitemapMd, describePage } from "./llms";
import { pathOf } from "./url";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  source_hash: string;
  /** ISO 8601 when the bytes were received. */
  witnessed_at: string;
  headers?: Record<string, string>;
  truncated?: boolean;
  /** The sitemap lastmod seen at discovery, kept for the next change check. */
  lastmod?: string | null;
}

export interface BuildInput {
  org: string;
  identity: Identity;
  /** The Network copy url, for example https://trooth.co/network/company/acme. */
  profile: string;
  version: number;
  supersedes: number | null;
  built_at: string;
  discovery: Pick<DiscoveryResult, "urls" | "robots"> & Partial<Pick<DiscoveryResult, "domain">>;
  fetched: FetchedPage[];
  controls?: Partial<Controls>;
  question_map?: QuestionMapEntry[];
  documents?: DocumentEntry[];
  products?: unknown[];
  /** The previous version and its bodies by page id, for an incremental rebuild. */
  previous?: { file: SemantoFile; bodies: Record<string, Uint8Array> };
  /** Only these urls changed since `previous`; other pages are reused. */
  changed_urls?: string[];
  /** One or two plain sentences for llms.txt. The homepage's first paragraph when absent. */
  summary?: string;
  /** Pages this large in markdown are split into parts. Default 2,000,000 bytes. */
  partLimitBytes?: number;
  /** Chrome by repetition: fraction of pages above which a block is chrome. Default 0.6. */
  chromeThreshold?: number;
  /** Validity of the version as a statement. Default: no end. */
  not_after?: string | null;
}

export interface CoverageReceipt {
  /** smr_ id over the canonical receipt without the id. */
  id: string;
  trooth_id: string;
  version: number;
  built_at: string;
  found: number;
  read: number;
  left_out: { url: string; reason: string }[];
  /** Urls whose page hash differs from the previous version, or every page on a first build. */
  changed: string[];
  /** Urls in the previous version that are no longer in this one. */
  removed: string[];
}

export interface BuildOutput {
  file: SemantoFile;
  /** Markdown bytes by page id, exactly the bytes the page hash covers. */
  bodies: Record<string, Uint8Array>;
  receipt: CoverageReceipt;
  llms: { llmsTxt: string; llmsFull: string; sitemapMd: string };
  /** Per page: the index signals, for monitors. */
  signals: Record<string, IndexSignals>;
}

export const DEFAULT_CONTROLS: Controls = {
  say_it_this_way: {},
  when_unknown: "Say that the company has not published this.",
  access_policy: "open",
  content_signals: { "ai-train": false, search: true, "ai-input": true },
};

function textBytes(s: string): Uint8Array {
  return utf8(s);
}

/** What a build knows about one fetched page before rendering it: no body. */
export interface FetchedMeta {
  status: number;
  source_hash: string;
  truncated?: boolean;
}

export interface PlanItem {
  url: string;
  action: "render" | "reuse";
}

export interface BuildPlan {
  /** Pages to render or reuse, in discovery order. */
  items: PlanItem[];
  left_out: { url: string; reason: string }[];
}

/**
 * Which discovered urls become pages, and why the others do not. A page is
 * reused from the previous version when it is unchanged (not in changed_urls
 * and its source hash is the same) and its body is on hand.
 */
export function planBuild(
  urls: DiscoveredUrl[],
  fetched: ReadonlyMap<string, FetchedMeta>,
  previous: { manifest: PageEntry[]; hasBody(id: string): boolean } | null,
  changed_urls?: string[],
): BuildPlan {
  const prevByUrl = new Map<string, PageEntry[]>();
  if (previous) for (const p of previous.manifest) prevByUrl.set(p.url, [...(prevByUrl.get(p.url) ?? []), p]);
  const changed = new Set(changed_urls ?? []);
  for (const [url, f] of fetched) {
    const old = prevByUrl.get(url)?.[0];
    if (!old || old.source_hash !== f.source_hash) changed.add(url);
  }
  const left_out: { url: string; reason: string }[] = [];
  const items: PlanItem[] = [];
  for (const d of urls) {
    if (d.excluded) {
      left_out.push({ url: d.url, reason: d.excluded.reason });
      continue;
    }
    const f = fetched.get(d.url);
    const old = prevByUrl.get(d.url);
    if (previous && old && !changed.has(d.url) && old.every((e) => previous.hasBody(e.id))) {
      items.push({ url: d.url, action: "reuse" });
      continue;
    }
    if (!f) {
      left_out.push({ url: d.url, reason: d.status !== undefined && d.status !== 200 ? `answered ${d.status}` : "not fetched" });
      continue;
    }
    if (f.status !== 200) {
      left_out.push({ url: d.url, reason: `answered ${f.status}` });
      continue;
    }
    if (f.truncated) {
      left_out.push({ url: d.url, reason: "HTML above the 2 MB cap" });
      continue;
    }
    items.push({ url: d.url, action: "render" });
  }
  return { items, left_out };
}

/** One page rendered: its manifest entries with their exact bodies, its facts, its signals and a one-line description per entry. */
export interface RenderedPage {
  url: string;
  entries: { entry: PageEntry; bytes: Uint8Array; description: string }[];
  facts: Fact[];
  signals: IndexSignals;
}

export async function renderPage(f: FetchedPage, ctx: { robots: DiscoveryResult["robots"]; chromeKeys: ReadonlySet<string>; partLimitBytes?: number }): Promise<RenderedPage> {
  const robotsBlocked = !robotsAllows(ctx.robots, f.url);
  const ex = extract({ html: f.html, url: f.url, witnessed_at: f.witnessed_at, source_hash: f.source_hash, headers: f.headers, robotsBlocked, chromeKeys: ctx.chromeKeys, partLimitBytes: ctx.partLimitBytes ?? 2_000_000 });
  const original_tokens = estimateTokens(f.html);
  const entries: RenderedPage["entries"] = [];
  for (let i = 0; i < ex.parts.length; i++) {
    const md = ex.parts[i]!;
    const bytes = textBytes(md);
    const entry: PageEntry = {
      id: await pageId(bytes),
      url: f.url,
      title: ex.title,
      hash: await digest(bytes),
      source_hash: f.source_hash,
      bytes: bytes.length,
      tokens: estimateTokens(md),
      original_tokens,
      witnessed_at: f.witnessed_at,
      ...(ex.lang ? { lang: ex.lang } : {}),
      ...(ex.parts.length > 1 ? { part: { n: i + 1, of: ex.parts.length } } : {}),
      status: 200,
      index: { noindex: ex.signals.noindex, nosnippet: ex.signals.nosnippet, canonical: ex.signals.canonical, robots_blocked: ex.signals.robots_blocked },
    };
    entries.push({ entry, bytes, description: describePage(md) });
  }
  const facts = await extractFacts({ url: f.url, witnessed_at: f.witnessed_at, html: f.html, body: ex.body });
  return { url: f.url, entries, facts, signals: ex.signals };
}

/** Facts in page order, the first of each key and value kept. */
export function dedupeFacts(lists: Iterable<Fact[]>): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const f of list) {
      const sig = `${f.key}|${JSON.stringify(f.value ?? null)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      facts.push(f);
    }
  }
  return facts;
}

export interface AssembleInput {
  org: string;
  identity: Identity;
  profile: string;
  version: number;
  supersedes: number | null;
  built_at: string;
  /** How many urls discovery listed. */
  found: number;
  /** Manifest entries in order, each with its one-line description. */
  manifest: { entry: PageEntry; description: string }[];
  facts: Fact[];
  left_out: { url: string; reason: string }[];
  /** The previous version's manifest, for the receipt's changed and removed. */
  previousManifest?: PageEntry[];
  controls?: Partial<Controls>;
  question_map?: QuestionMapEntry[];
  documents?: DocumentEntry[];
  products?: unknown[];
  summary?: string;
  not_after?: string | null;
  /** llms-full.txt, built by the caller from the bodies (it alone holds them), or null when too large to hold. */
  llmsFull: string | null;
}

/** The version from its manifest and facts: tiers, roots, header, receipt and llms files. Hashing follows src/core/semanto.ts. */
export async function assembleVersion(input: AssembleInput): Promise<{ file: SemantoFile; receipt: CoverageReceipt; llms: { llmsTxt: string; llmsFull: string | null; sitemapMd: string } }> {
  const domain = input.identity.domain;
  const manifest = input.manifest.map((m) => m.entry);
  const facts = input.facts;
  const controls: Controls = { ...DEFAULT_CONTROLS, ...(input.controls ?? {}) };
  const question_map = input.question_map ?? [];
  const documents = input.documents ?? [];
  const products = input.products ?? [];

  const tiers: TierEntry[] = [];
  const tierValues: [Exclude<TierEntry["name"], "header">, unknown][] = [
    ["facts", facts], ["controls", controls], ["pages", manifest], ["question_map", question_map], ["documents", documents], ["products", products],
  ];
  const headerCore = { org: input.org, trooth_id: input.identity.trooth_id, domains: [domain], version: input.version, built_at: input.built_at, identity: input.identity };
  tiers.push({ name: "header", tokens: estimateTokens(canonicalize(headerCore)), hash: await tierHash(headerCore) });
  for (const [name, value] of tierValues) {
    const tokens = name === "pages" ? manifest.reduce((a, p) => a + p.tokens, 0) : estimateTokens(canonicalize(value));
    tiers.push({ name, tokens, hash: await tierHash(value) });
  }

  const header: SemantoHeader = {
    schema: SCHEMA_URL,
    contract: SEMANTO_CONTRACT,
    org: input.org,
    trooth_id: input.identity.trooth_id,
    domains: [domain],
    profile: input.profile,
    version: input.version,
    supersedes: input.supersedes,
    built_at: input.built_at,
    state: "read",
    not_before: input.built_at,
    not_after: input.not_after ?? null,
    witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true",
    tiers,
    pages_root: await pagesRoot(manifest),
    facts_root: await factsRoot(facts),
    pages_manifest: manifest,
    identity: input.identity,
  };
  const file: SemantoFile = { header, facts, controls, question_map, documents, products, root_hash: await rootHash(header), signature: null, witness: null, ledger: null };

  // Receipt
  const prevHashByKey = new Map<string, string>();
  for (const p of input.previousManifest ?? []) prevHashByKey.set(`${p.url}#${p.part?.n ?? 1}`, p.hash);
  const changedUrls = new Set<string>();
  for (const p of manifest) if (prevHashByKey.get(`${p.url}#${p.part?.n ?? 1}`) !== p.hash) changedUrls.add(p.url);
  const nowUrls = new Set(manifest.map((p) => p.url));
  const removed = input.previousManifest ? [...new Set(input.previousManifest.map((p) => p.url))].filter((u) => !nowUrls.has(u)) : [];
  const receiptBody = { trooth_id: input.identity.trooth_id, version: input.version, built_at: input.built_at, found: input.found, read: nowUrls.size, left_out: input.left_out, changed: [...changedUrls], removed };
  const receipt: CoverageReceipt = { id: semantoId("smr", await digest(canonicalize(receiptBody))), ...receiptBody };

  // llms files
  const homeEntry = input.manifest.find((p) => pathOf(p.entry.url) === "/" && (!p.entry.part || p.entry.part.n === 1));
  const summary = input.summary ?? (homeEntry ? homeEntry.description : "");
  const llmsTxt = buildLlmsTxt({ siteName: input.org, domain, summary, pages: input.manifest.map((m) => ({ entry: m.entry, description: m.description })), troothId: input.identity.trooth_id, networkUrl: input.profile });
  const sitemapMd = buildSitemapMd(input.org, manifest);
  return { file, receipt, llms: { llmsTxt, llmsFull: input.llmsFull, sitemapMd } };
}

export async function buildVersion(input: BuildInput): Promise<BuildOutput> {
  const partLimit = input.partLimitBytes ?? 2_000_000;
  const prev = input.previous ?? null;
  const fetchedByUrl = new Map(input.fetched.map((f) => [f.url, f] as const));
  const plan = planBuild(input.discovery.urls, fetchedByUrl, prev ? { manifest: prev.file.header.pages_manifest, hasBody: (id) => Boolean(prev.bodies[id]) } : null, input.changed_urls);

  // Chrome by repetition over the pages rendered in this build, by block key.
  const toRender = plan.items.filter((i) => i.action === "render").map((i) => fetchedByUrl.get(i.url)!);
  const chromeKeys = detectChrome(toRender.map((f) => pageBlockKeys(f.html, f.url)), input.chromeThreshold ?? 0.6);

  const prevByUrl = new Map<string, PageEntry[]>();
  const prevFactsByUrl = new Map<string, Fact[]>();
  if (prev) {
    for (const p of prev.file.header.pages_manifest) prevByUrl.set(p.url, [...(prevByUrl.get(p.url) ?? []), p]);
    for (const f of prev.file.facts) prevFactsByUrl.set(f.evidence.url, [...(prevFactsByUrl.get(f.evidence.url) ?? []), f]);
  }

  const manifest: { entry: PageEntry; description: string }[] = [];
  const bodies: Record<string, Uint8Array> = {};
  const signals: Record<string, IndexSignals> = {};
  const factLists: Fact[][] = [];
  const dec = new TextDecoder();
  for (const item of plan.items) {
    if (item.action === "render") {
      const r = await renderPage(fetchedByUrl.get(item.url)!, { robots: input.discovery.robots, chromeKeys, partLimitBytes: partLimit });
      signals[item.url] = r.signals;
      for (const e of r.entries) {
        manifest.push({ entry: e.entry, description: e.description });
        bodies[e.entry.id] = e.bytes;
      }
      factLists.push(r.facts);
      continue;
    }
    for (const e of prevByUrl.get(item.url) ?? []) {
      const body = prev!.bodies[e.id]!;
      manifest.push({ entry: e, description: describePage(dec.decode(body)) });
      bodies[e.id] = body;
      signals[item.url] = { noindex: e.index.noindex, nosnippet: e.index.nosnippet, canonical: e.index.canonical, hreflang: [], robots_blocked: e.index.robots_blocked };
    }
    factLists.push(prevFactsByUrl.get(item.url) ?? []);
  }
  const llmsFull = buildLlmsFull(input.org, manifest.map((m) => ({ entry: m.entry, markdown: dec.decode(bodies[m.entry.id]!) })));
  const out = await assembleVersion({
    org: input.org,
    identity: input.identity,
    profile: input.profile,
    version: input.version,
    supersedes: input.supersedes,
    built_at: input.built_at,
    found: input.discovery.urls.length,
    manifest,
    facts: dedupeFacts(factLists),
    left_out: plan.left_out,
    ...(prev ? { previousManifest: prev.file.header.pages_manifest } : {}),
    ...(input.controls ? { controls: input.controls } : {}),
    ...(input.question_map ? { question_map: input.question_map } : {}),
    ...(input.documents ? { documents: input.documents } : {}),
    ...(input.products ? { products: input.products } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.not_after !== undefined ? { not_after: input.not_after } : {}),
    llmsFull,
  });
  return { file: out.file, bodies, receipt: out.receipt, llms: { llmsTxt: out.llms.llmsTxt, llmsFull, sitemapMd: out.llms.sitemapMd }, signals };
}

/** The body text of a stored page, without front matter. */
export function bodyOfPage(markdown: string): string {
  return parseFrontMatter(markdown)?.body ?? markdown;
}
