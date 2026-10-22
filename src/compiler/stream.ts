// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A build in pieces, so no single Worker invocation holds a whole site
// (pre-deploy audit finding 4). Cloudflare Workers give an isolate 128 MB
// and a queue message 30 seconds of CPU by default (Workers limits, docs
// 2026); a 500-page site read at once needs more than both. The build is
// split into queue messages:
//
//   discover   robots, sitemaps, llms.txt and the crawl. Each page discovery
//              reads is written away at once: its body to R2, its metadata
//              and block keys (for chrome detection) to D1. No page is kept.
//              Then the plan (render, reuse or left out, in discovery order)
//              and the chrome keys are written, and the first render message
//              is queued.
//   render     at most PAGES_PER_MESSAGE pages: read one body, extract it,
//              write its markdown to its place in the version (R2) and its
//              manifest entries and facts to D1, then the next page. The
//              last render message queues assembly.
//   assemble   the manifest is the ordered list of page entries read back
//              from D1; facts are deduplicated in page order; the roots,
//              header and receipt come from src/compiler/build.ts
//              assembleVersion, the same code a one-shot build runs, so the
//              roots are equal to buildVersion's for the same pages.
//
// Only manifest entries, fact rows and block keys are held in memory, never
// every page's HTML. llms-full.txt is assembled only when every page's
// markdown together fits LLMS_FULL_MAX_BYTES; above that the route builds it
// on request from the stored pages.

import { fromUtf8 } from "../core/encoding";
import type { Controls, Fact, Identity, PageEntry, SemantoFile } from "../core/semanto";
import { discover, type DiscoveredUrl, type RobotsRules } from "./discover";
import { assembleVersion, dedupeFacts, planBuild, renderPage, type CoverageReceipt, type FetchedMeta } from "./build";
import { detectChrome, pageBlockKeys } from "./extract";
import { buildLlmsFull, describePage } from "./llms";
import type { Fetcher, FetchOk } from "./fetch";

export const PAGES_PER_MESSAGE = 25;
export const LLMS_FULL_MAX_BYTES = 8 * 1024 * 1024;

export interface BuildJob {
  trooth_id: string;
  version: number;
  supersedes: number | null;
  /** The previous version whose unchanged pages are reused, or null. */
  previous_version: number | null;
  reason: string;
  changed_urls?: string[];
  org: string;
  identity: Identity;
  profile: string;
  controls?: Partial<Controls>;
  requested_at: string;
}

export type BuildStatus = "queued" | "reading" | "rendering" | "assembling" | "done" | "failed";

export interface BuildState {
  robots: RobotsRules;
  chrome_keys: string[];
  left_out: { url: string; reason: string }[];
  /** Every discovered url with its sitemap lastmod, for the change state. */
  discovered: { url: string; lastmod: string | null }[];
  items: number;
  /** Set once assembled. */
  result?: { root_hash: string; pages: number; facts: number; receipt: CoverageReceipt };
}

export interface BuildRow {
  build_id: string;
  trooth_id: string;
  version: number;
  reason: string;
  /** Read before the domain was proven: stored, not published, served or witnessed. */
  held: boolean;
  status: BuildStatus;
  job: BuildJob;
  found: number;
  fetched: number;
  planned: number;
  rendered: number;
  state: BuildState | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StagedFetch {
  url: string;
  status: number;
  source_hash: string;
  witnessed_at: string;
  headers: Record<string, string>;
  truncated: boolean;
  etag: string | null;
  last_modified: string | null;
  block_keys: string[];
  raw_key: string;
}

export interface StagedItem {
  seq: number;
  url: string;
  action: "render" | "reuse";
}

export interface StagedRender {
  seq: number;
  url: string;
  entries: { entry: PageEntry; description: string }[];
  facts: Fact[];
}

export type StageMessage =
  | { kind: "stage"; stage: "discover"; build_id: string }
  | { kind: "stage"; stage: "render"; build_id: string; from: number; to: number }
  | { kind: "stage"; stage: "assemble"; build_id: string };

/** Where a build is kept while it runs. D1 rows and R2 bodies in the Worker (src/db/d1.ts D1BuildStaging). */
export interface BuildStagingPort {
  createBuild(row: BuildRow): Promise<void>;
  getBuild(build_id: string): Promise<BuildRow | null>;
  updateBuild(build_id: string, patch: Partial<Omit<BuildRow, "build_id" | "trooth_id" | "job">>): Promise<void>;
  /** The newest build of a company, any status. */
  latestBuild(trooth_id: string): Promise<BuildRow | null>;
  putRaw(build_id: string, url: string, bytes: Uint8Array): Promise<string>;
  getRaw(key: string): Promise<Uint8Array | null>;
  putFetched(build_id: string, row: StagedFetch): Promise<void>;
  listFetched(build_id: string): Promise<StagedFetch[]>;
  getFetched(build_id: string, url: string): Promise<StagedFetch | null>;
  putItems(build_id: string, items: StagedItem[]): Promise<void>;
  itemsSlice(build_id: string, from: number, to: number): Promise<StagedItem[]>;
  putRendered(build_id: string, r: StagedRender): Promise<void>;
  listRendered(build_id: string): Promise<StagedRender[]>;
  /** Remove the staged bodies and rows once the version is stored. */
  clear(build_id: string): Promise<void>;
  /** Marks the start of one queue message, for the in-memory meter. */
  beginInvocation?(): void;
}

/** Page bodies at their place in a version (R2 semanto/<trooth_id>/v<n>/pages/<id>.md in the Worker). */
export interface BodyPort {
  putBody(trooth_id: string, version: number, page_id: string, bytes: Uint8Array): Promise<void>;
  getBody(trooth_id: string, version: number, page_id: string): Promise<Uint8Array | null>;
}

export interface StreamDeps {
  staging: BuildStagingPort;
  bodies: BodyPort;
  fetcher: Fetcher;
  now(): Date;
  /** The previous version's file (header and facts), for reuse. */
  previousFile(trooth_id: string, version: number): Promise<SemantoFile | null>;
}

const prevIndex = (file: SemantoFile | null) => {
  const byUrl = new Map<string, PageEntry[]>();
  const factsByUrl = new Map<string, Fact[]>();
  if (file) {
    for (const p of file.header.pages_manifest) byUrl.set(p.url, [...(byUrl.get(p.url) ?? []), p]);
    for (const f of file.facts) factsByUrl.set(f.evidence.url, [...(factsByUrl.get(f.evidence.url) ?? []), f]);
  }
  return { byUrl, factsByUrl };
};

/** Message 1: discover, staging every page as it is read; then plan and queue the first render. */
export async function runDiscover(build_id: string, deps: StreamDeps): Promise<StageMessage> {
  const build = await deps.staging.getBuild(build_id);
  if (!build) throw new Error(`stream: no build ${build_id}`);
  const job = build.job;
  await deps.staging.updateBuild(build_id, { status: "reading", started_at: deps.now().toISOString() });
  const meta = new Map<string, FetchedMeta>();
  const blockKeys = new Map<string, string[]>();
  let lastWrite = 0;
  const discovery = await discover(job.identity.domain, deps.fetcher, {
    keepFetched: false,
    onFetched: async (f: FetchOk) => {
      const raw_key = await deps.staging.putRaw(build_id, f.url, f.body);
      const keys = pageBlockKeys(f.text, f.url);
      await deps.staging.putFetched(build_id, { url: f.url, status: f.status, source_hash: f.source_hash, witnessed_at: f.fetchedAt, headers: f.headers, truncated: f.truncated, etag: f.etag, last_modified: f.lastModified, block_keys: keys, raw_key });
      meta.set(f.url, { status: f.status, source_hash: f.source_hash, truncated: f.truncated });
      blockKeys.set(f.url, keys);
    },
    onProgress: async (found, fetched) => {
      // Progress for the setup screen, written every 5 pages so the poll moves on real counts.
      if (fetched - lastWrite >= 5) {
        lastWrite = fetched;
        await deps.staging.updateBuild(build_id, { found, fetched });
      }
    },
  });
  const previous = job.previous_version !== null ? await deps.previousFile(job.trooth_id, job.previous_version) : null;
  const plan = planBuild(discovery.urls, meta, previous ? { manifest: previous.header.pages_manifest, hasBody: () => true } : null, job.changed_urls);
  const toRender = plan.items.filter((i) => i.action === "render");
  const chrome = detectChrome(toRender.map((i) => blockKeys.get(i.url) ?? []), 0.6);
  const items: StagedItem[] = plan.items.map((i, seq) => ({ seq, url: i.url, action: i.action }));
  await deps.staging.putItems(build_id, items);
  const state: BuildState = {
    robots: discovery.robots,
    chrome_keys: [...chrome],
    left_out: plan.left_out,
    discovered: discovery.urls.map((u: DiscoveredUrl) => ({ url: u.url, lastmod: u.lastmod ?? null })),
    items: items.length,
  };
  await deps.staging.updateBuild(build_id, { status: "rendering", found: discovery.urls.length, fetched: meta.size, planned: items.length, state });
  return items.length ? { kind: "stage", stage: "render", build_id, from: 0, to: Math.min(PAGES_PER_MESSAGE, items.length) } : { kind: "stage", stage: "assemble", build_id };
}

/** Messages 2 to n: render or reuse at most PAGES_PER_MESSAGE pages, one at a time. */
export async function runRender(msg: Extract<StageMessage, { stage: "render" }>, deps: StreamDeps): Promise<StageMessage> {
  if (msg.to - msg.from > PAGES_PER_MESSAGE) throw new Error(`stream: a render message holds at most ${PAGES_PER_MESSAGE} pages`);
  const build = await deps.staging.getBuild(msg.build_id);
  if (!build || !build.state) throw new Error(`stream: no planned build ${msg.build_id}`);
  const job = build.job;
  const chromeKeys = new Set(build.state.chrome_keys);
  const previous = job.previous_version !== null ? await deps.previousFile(job.trooth_id, job.previous_version) : null;
  const prev = prevIndex(previous);
  const items = await deps.staging.itemsSlice(msg.build_id, msg.from, msg.to);
  for (const item of items) {
    if (item.action === "render") {
      const f = await deps.staging.getFetched(msg.build_id, item.url);
      const raw = f ? await deps.staging.getRaw(f.raw_key) : null;
      if (!f || !raw) throw new Error(`stream: page ${item.url} was not staged`);
      const r = await renderPage({ url: f.url, status: f.status, html: fromUtf8(raw), source_hash: f.source_hash, witnessed_at: f.witnessed_at, headers: f.headers, truncated: f.truncated }, { robots: build.state.robots, chromeKeys });
      for (const e of r.entries) await deps.bodies.putBody(job.trooth_id, job.version, e.entry.id, e.bytes);
      await deps.staging.putRendered(msg.build_id, { seq: item.seq, url: item.url, entries: r.entries.map((e) => ({ entry: e.entry, description: e.description })), facts: r.facts });
      continue;
    }
    const entries: StagedRender["entries"] = [];
    for (const e of prev.byUrl.get(item.url) ?? []) {
      const body = await deps.bodies.getBody(job.trooth_id, job.previous_version!, e.id);
      if (!body) throw new Error(`stream: previous body ${e.id} is missing`);
      await deps.bodies.putBody(job.trooth_id, job.version, e.id, body);
      entries.push({ entry: e, description: describePage(fromUtf8(body)) });
    }
    await deps.staging.putRendered(msg.build_id, { seq: item.seq, url: item.url, entries, facts: prev.factsByUrl.get(item.url) ?? [] });
  }
  await deps.staging.updateBuild(msg.build_id, { rendered: msg.to });
  const total = build.state.items;
  if (msg.to < total) return { kind: "stage", stage: "render", build_id: msg.build_id, from: msg.to, to: Math.min(msg.to + PAGES_PER_MESSAGE, total) };
  return { kind: "stage", stage: "assemble", build_id: msg.build_id };
}

export interface AssembledBuild {
  build: BuildRow;
  file: SemantoFile;
  receipt: CoverageReceipt;
  llms: { llmsTxt: string; llmsFull: string | null; sitemapMd: string };
  /** Change-detection rows for every page discovery read. */
  changeRows: { url: string; etag: string | null; last_modified: string | null; raw_hash: string; lastmod: string | null; checked_at: string }[];
}

/** The last message: the manifest from D1 in order, the version from build.ts assembleVersion. */
export async function runAssemble(build_id: string, deps: StreamDeps): Promise<AssembledBuild> {
  const build = await deps.staging.getBuild(build_id);
  if (!build || !build.state) throw new Error(`stream: no planned build ${build_id}`);
  await deps.staging.updateBuild(build_id, { status: "assembling" });
  const job = build.job;
  const rendered = (await deps.staging.listRendered(build_id)).sort((a, b) => a.seq - b.seq);
  const manifest = rendered.flatMap((r) => r.entries);
  const facts = dedupeFacts(rendered.map((r) => r.facts));
  const previous = job.previous_version !== null ? await deps.previousFile(job.trooth_id, job.previous_version) : null;
  const totalBytes = manifest.reduce((n, m) => n + m.entry.bytes, 0);
  let llmsFull: string | null = null;
  if (totalBytes <= LLMS_FULL_MAX_BYTES) {
    const pages: { entry: PageEntry; markdown: string }[] = [];
    for (const m of manifest) {
      const b = await deps.bodies.getBody(job.trooth_id, job.version, m.entry.id);
      pages.push({ entry: m.entry, markdown: b ? fromUtf8(b) : "" });
    }
    llmsFull = buildLlmsFull(job.org, pages);
  }
  const out = await assembleVersion({
    org: job.org,
    identity: job.identity,
    profile: job.profile,
    version: job.version,
    supersedes: job.supersedes,
    built_at: job.requested_at,
    found: build.state.discovered.length,
    manifest,
    facts,
    left_out: build.state.left_out,
    ...(previous ? { previousManifest: previous.header.pages_manifest } : {}),
    ...(job.controls ? { controls: job.controls } : {}),
    llmsFull,
  });
  const lastmod = new Map(build.state.discovered.map((d) => [d.url, d.lastmod] as const));
  const changeRows = (await deps.staging.listFetched(build_id)).map((f) => ({ url: f.url, etag: f.etag, last_modified: f.last_modified, raw_hash: f.source_hash, lastmod: lastmod.get(f.url) ?? null, checked_at: f.witnessed_at }));
  return { build, file: out.file, receipt: out.receipt, llms: out.llms, changeRows };
}

// ---------------------------------------------------------------- in memory

/**
 * The in-memory staging store. It meters what one queue message reads back
 * of the staged HTML, so a test can show that no message holds the site.
 */
export class MemoryBuildStaging implements BuildStagingPort {
  readonly builds = new Map<string, BuildRow>();
  readonly raw = new Map<string, Uint8Array>();
  readonly fetched = new Map<string, Map<string, StagedFetch>>();
  readonly items = new Map<string, StagedItem[]>();
  readonly rendered = new Map<string, StagedRender[]>();
  /** HTML bytes read back in the current message, and the most any one message read. */
  rawReadThisInvocation = 0;
  peakRawReadPerInvocation = 0;
  invocations = 0;

  beginInvocation(): void {
    this.invocations++;
    this.rawReadThisInvocation = 0;
  }
  async createBuild(row: BuildRow): Promise<void> {
    this.builds.set(row.build_id, structuredClone(row));
  }
  async getBuild(id: string): Promise<BuildRow | null> {
    const b = this.builds.get(id);
    return b ? structuredClone(b) : null;
  }
  async updateBuild(id: string, patch: Partial<Omit<BuildRow, "build_id" | "trooth_id" | "job">>): Promise<void> {
    const b = this.builds.get(id);
    if (b) this.builds.set(id, { ...b, ...structuredClone(patch) });
  }
  async latestBuild(trooth_id: string): Promise<BuildRow | null> {
    const all = [...this.builds.values()].filter((b) => b.trooth_id === trooth_id);
    const last = all[all.length - 1];
    return last ? structuredClone(last) : null;
  }
  async putRaw(build_id: string, url: string, bytes: Uint8Array): Promise<string> {
    const key = `semanto/builds/${build_id}/raw/${encodeURIComponent(url)}`;
    this.raw.set(key, bytes.slice());
    return key;
  }
  async getRaw(key: string): Promise<Uint8Array | null> {
    const b = this.raw.get(key);
    if (!b) return null;
    this.rawReadThisInvocation += b.length;
    this.peakRawReadPerInvocation = Math.max(this.peakRawReadPerInvocation, this.rawReadThisInvocation);
    return b.slice();
  }
  async putFetched(build_id: string, row: StagedFetch): Promise<void> {
    const m = this.fetched.get(build_id) ?? new Map<string, StagedFetch>();
    m.set(row.url, structuredClone(row));
    this.fetched.set(build_id, m);
  }
  async listFetched(build_id: string): Promise<StagedFetch[]> {
    return [...(this.fetched.get(build_id)?.values() ?? [])].map((r) => structuredClone(r));
  }
  async getFetched(build_id: string, url: string): Promise<StagedFetch | null> {
    const r = this.fetched.get(build_id)?.get(url);
    return r ? structuredClone(r) : null;
  }
  async putItems(build_id: string, items: StagedItem[]): Promise<void> {
    this.items.set(build_id, structuredClone(items));
  }
  async itemsSlice(build_id: string, from: number, to: number): Promise<StagedItem[]> {
    return (this.items.get(build_id) ?? []).filter((i) => i.seq >= from && i.seq < to).map((i) => ({ ...i }));
  }
  async putRendered(build_id: string, r: StagedRender): Promise<void> {
    const list = (this.rendered.get(build_id) ?? []).filter((x) => x.seq !== r.seq);
    list.push(structuredClone(r));
    this.rendered.set(build_id, list);
  }
  async listRendered(build_id: string): Promise<StagedRender[]> {
    return structuredClone(this.rendered.get(build_id) ?? []);
  }
  async clear(build_id: string): Promise<void> {
    for (const k of [...this.raw.keys()]) if (k.startsWith(`semanto/builds/${build_id}/`)) this.raw.delete(k);
    this.fetched.delete(build_id);
    this.items.delete(build_id);
    this.rendered.delete(build_id);
  }
}

