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
// changed; it never scores anything.

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
import { extract, pageBlocks, detectChrome, parseFrontMatter, type IndexSignals } from "./extract";
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

export async function buildVersion(input: BuildInput): Promise<BuildOutput> {
  const domain = input.identity.domain;
  const partLimit = input.partLimitBytes ?? 2_000_000;
  const prev = input.previous ?? null;
  const prevByUrl = new Map<string, PageEntry[]>();
  if (prev) {
    for (const p of prev.file.header.pages_manifest) {
      const list = prevByUrl.get(p.url) ?? [];
      list.push(p);
      prevByUrl.set(p.url, list);
    }
  }
  const fetchedByUrl = new Map(input.fetched.map((f) => [f.url, f] as const));
  const changed = new Set(input.changed_urls ?? []);
  for (const f of input.fetched) {
    const old = prevByUrl.get(f.url)?.[0];
    if (!old || old.source_hash !== f.source_hash) changed.add(f.url);
  }

  // Which discovered urls become pages, and why the others do not.
  const left_out: { url: string; reason: string }[] = [];
  const toRender: { d: DiscoveredUrl; f: FetchedPage }[] = [];
  const toReuse: { d: DiscoveredUrl; entries: PageEntry[] }[] = [];
  for (const d of input.discovery.urls) {
    if (d.excluded) {
      left_out.push({ url: d.url, reason: d.excluded.reason });
      continue;
    }
    const f = fetchedByUrl.get(d.url);
    const old = prevByUrl.get(d.url);
    if (prev && old && !changed.has(d.url)) {
      const reusable = old.every((e) => prev.bodies[e.id]);
      if (reusable) {
        toReuse.push({ d, entries: old });
        continue;
      }
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
    toRender.push({ d, f });
  }

  // Chrome by repetition over the pages rendered in this build.
  const blockLists = toRender.map(({ d, f }) => pageBlocks(f.html, d.url));
  const chrome = detectChrome(blockLists, input.chromeThreshold ?? 0.6);

  const manifest: PageEntry[] = [];
  const bodies: Record<string, Uint8Array> = {};
  const signals: Record<string, IndexSignals> = {};
  const facts: Fact[] = [];
  const factSigs = new Set<string>();
  const addFacts = (list: Fact[]) => {
    for (const f of list) {
      const sig = `${f.key}|${JSON.stringify(f.value ?? null)}`;
      if (factSigs.has(sig)) continue;
      factSigs.add(sig);
      facts.push(f);
    }
  };

  // Keep discovery order: rendered and reused pages interleave as discovered.
  const renderMap = new Map(toRender.map((r) => [r.d.url, r] as const));
  const reuseMap = new Map(toReuse.map((r) => [r.d.url, r] as const));
  const prevFactsByUrl = new Map<string, Fact[]>();
  if (prev) for (const f of prev.file.facts) prevFactsByUrl.set(f.evidence.url, [...(prevFactsByUrl.get(f.evidence.url) ?? []), f]);

  for (const d of input.discovery.urls) {
    const r = renderMap.get(d.url);
    if (r) {
      const { f } = r;
      const robotsBlocked = !robotsAllows(input.discovery.robots, d.url);
      const ex = extract({ html: f.html, url: d.url, witnessed_at: f.witnessed_at, source_hash: f.source_hash, headers: f.headers, robotsBlocked, chrome, partLimitBytes: partLimit });
      signals[d.url] = ex.signals;
      const original_tokens = estimateTokens(f.html);
      for (let i = 0; i < ex.parts.length; i++) {
        const md = ex.parts[i]!;
        const bytes = textBytes(md);
        const hash = await digest(bytes);
        const id = await pageId(bytes);
        const entry: PageEntry = {
          id,
          url: d.url,
          title: ex.title,
          hash,
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
        manifest.push(entry);
        bodies[id] = bytes;
      }
      addFacts(await extractFacts({ url: d.url, witnessed_at: f.witnessed_at, html: f.html, body: ex.body }));
      continue;
    }
    const u = reuseMap.get(d.url);
    if (u && prev) {
      for (const e of u.entries) {
        manifest.push(e);
        bodies[e.id] = prev.bodies[e.id]!;
        signals[d.url] = { noindex: e.index.noindex, nosnippet: e.index.nosnippet, canonical: e.index.canonical, hreflang: [], robots_blocked: e.index.robots_blocked };
      }
      addFacts(prevFactsByUrl.get(d.url) ?? []);
    }
  }

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
  const file: SemantoFile = {
    header,
    facts,
    controls,
    question_map,
    documents,
    products,
    root_hash: await rootHash(header),
    signature: null,
    witness: null,
    ledger: null,
  };

  // Receipt
  const prevHashByKey = new Map<string, string>();
  if (prev) for (const p of prev.file.header.pages_manifest) prevHashByKey.set(`${p.url}#${p.part?.n ?? 1}`, p.hash);
  const changedUrls = new Set<string>();
  for (const p of manifest) if (prevHashByKey.get(`${p.url}#${p.part?.n ?? 1}`) !== p.hash) changedUrls.add(p.url);
  const nowUrls = new Set(manifest.map((p) => p.url));
  const removed = prev ? [...new Set(prev.file.header.pages_manifest.map((p) => p.url))].filter((u) => !nowUrls.has(u)) : [];
  const receiptBody = {
    trooth_id: input.identity.trooth_id,
    version: input.version,
    built_at: input.built_at,
    found: input.discovery.urls.length,
    read: nowUrls.size,
    left_out,
    changed: [...changedUrls],
    removed,
  };
  const receipt: CoverageReceipt = { id: semantoId("smr", await digest(canonicalize(receiptBody))), ...receiptBody };

  // llms files
  const dec = new TextDecoder();
  const markdownOf = (p: PageEntry) => dec.decode(bodies[p.id]!);
  const homeEntry = manifest.find((p) => pathOf(p.url) === "/" && (!p.part || p.part.n === 1));
  const summary = input.summary ?? (homeEntry ? describePage(markdownOf(homeEntry)) : "");
  const siteName = input.org;
  const llmsTxt = buildLlmsTxt({
    siteName,
    domain,
    summary,
    pages: manifest.map((entry) => ({ entry, description: describePage(markdownOf(entry)) })),
    troothId: input.identity.trooth_id,
    networkUrl: input.profile,
  });
  const llmsFull = buildLlmsFull(siteName, manifest.map((entry) => ({ entry, markdown: markdownOf(entry) })));
  const sitemapMd = buildSitemapMd(siteName, manifest);

  return { file, bodies, receipt, llms: { llmsTxt, llmsFull, sitemapMd }, signals };
}

/** The body text of a stored page, without front matter. */
export function bodyOfPage(markdown: string): string {
  return parseFrontMatter(markdown)?.body ?? markdown;
}
