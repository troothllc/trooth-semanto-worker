// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The delivery settings a company sets in the dashboard (settings panel,
// section D) and the resolver the adapters call for every request: serve from
// Semanto, fall through to the host, or pass the request through untouched.
// The choice is made on the path and the Accept header only, through
// src/core/negotiate.ts, never on User-Agent. The modes mirror the choice a
// site owner on Cloudflare faces after Markdown for Agents (Cloudflare
// changelog, 26 Feb 2026): who answers a markdown request, Semanto with signed
// bytes or the host's converter with fresh bytes.

import { negotiate, representationFromPath, type Representation } from "../core/negotiate";

export type HostKind =
  | "cloudflare"
  | "vercel"
  | "netlify"
  | "fastly"
  | "akamai"
  | "gcore"
  | "nginx"
  | "apache"
  | "wordpress"
  | "shopify"
  | "webflow"
  | "squarespace"
  | "wix"
  | "head_tag"
  | "unknown";

export const HOST_KINDS: HostKind[] = ["cloudflare", "vercel", "netlify", "fastly", "akamai", "gcore", "nginx", "apache", "wordpress", "shopify", "webflow", "squarespace", "wix", "head_tag", "unknown"];

/**
 * The install guide the setup wizard shows for each host (docs/spec/setup-api.md,
 * install.guide_id). Shopify, Webflow, Squarespace and Wix use the head tag or
 * the platform's app or code panel, as adapters/README.md describes.
 */
export const HOST_GUIDES: Record<HostKind, string> = {
  cloudflare: "cloudflare-worker",
  vercel: "vercel-middleware",
  netlify: "netlify-edge",
  fastly: "fastly-compute",
  akamai: "akamai-edgeworkers",
  // Gcore runs JavaScript only as a standalone FastEdge HTTP app; in front of a site (a CDN resource) it runs Proxy-Wasm
  // apps in Rust or AssemblyScript (docs.gcore.com/fastedge/getting-started). So on Gcore Semanto is the head code.
  gcore: "head-tag",
  nginx: "nginx-config",
  apache: "apache-config",
  wordpress: "wordpress-plugin",
  shopify: "shopify-app",
  webflow: "webflow-head-code",
  squarespace: "squarespace-code-injection",
  wix: "wix-custom-code",
  head_tag: "head-tag",
  unknown: "pick-host",
};

export type MarkdownSource = "semanto_only" | "semanto_then_cloudflare_for_unsigned" | "cloudflare_format_semanto_proof_only";
export const MARKDOWN_SOURCES: MarkdownSource[] = ["semanto_only", "semanto_then_cloudflare_for_unsigned", "cloudflare_format_semanto_proof_only"];

export type WhenPageChanged = "serve_last_signed_marked_behind" | "serve_live_marked_unsigned" | "prompt_to_sign";
export const WHEN_PAGE_CHANGED: WhenPageChanged[] = ["serve_last_signed_marked_behind", "serve_live_marked_unsigned", "prompt_to_sign"];

export interface ContentSignals {
  "ai-train": boolean;
  search: boolean;
  "ai-input": boolean;
}

export interface DeliverySettings {
  where: {
    /** Always on: the Trooth-hosted copy at api.trooth.co. */
    trooth_hosted: true;
    /** Serve the same bytes from the company's own domain through an adapter. */
    own_domain: boolean;
  };
  host: HostKind;
  formats: {
    markdown: boolean;
    jsonld: boolean;
    llms: boolean;
    sitemap_md: boolean;
    /** Always on: the whole signed file. */
    whole_file: true;
  };
  markdown_source: MarkdownSource;
  when_page_changed: WhenPageChanged;
  content_signals: ContentSignals;
}

export const DEFAULT_SETTINGS: DeliverySettings = {
  where: { trooth_hosted: true, own_domain: false },
  host: "unknown",
  formats: { markdown: true, jsonld: true, llms: true, sitemap_md: true, whole_file: true },
  markdown_source: "semanto_only",
  when_page_changed: "serve_last_signed_marked_behind",
  content_signals: { "ai-train": false, search: true, "ai-input": true },
};

export const PROOF_ONLY_WARNING = "Individual pages cannot be checked in this mode, because the converter's bytes change on every request";

// ---------------------------------------------------------------- validation

export interface SettingsIssue {
  path: string;
  message: string;
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Plain-language validation. Returns an empty list when the settings are usable. */
export function validateSettings(input: unknown): SettingsIssue[] {
  const out: SettingsIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "Settings must be an object." }];
  const s = input as Partial<DeliverySettings>;

  if (!s.where || typeof s.where !== "object") push("where", "Say where the file is served. The Trooth-hosted copy is always on.");
  else {
    if (s.where.trooth_hosted !== true) push("where.trooth_hosted", "The Trooth-hosted copy cannot be turned off.");
    if (!isBool(s.where.own_domain)) push("where.own_domain", "Own domain must be on or off.");
  }

  if (!HOST_KINDS.includes(s.host as HostKind)) push("host", `Host must be one of: ${HOST_KINDS.join(", ")}.`);

  if (!s.formats || typeof s.formats !== "object") push("formats", "Choose which formats to serve. The whole file is always on.");
  else {
    if (s.formats.whole_file !== true) push("formats.whole_file", "The whole file cannot be turned off.");
    for (const k of ["markdown", "jsonld", "llms", "sitemap_md"] as const) {
      if (!isBool(s.formats[k])) push(`formats.${k}`, `${k} must be on or off.`);
    }
  }

  if (!MARKDOWN_SOURCES.includes(s.markdown_source as MarkdownSource)) push("markdown_source", `Markdown source must be one of: ${MARKDOWN_SOURCES.join(", ")}.`);
  if (!WHEN_PAGE_CHANGED.includes(s.when_page_changed as WhenPageChanged)) push("when_page_changed", `When a page changes must be one of: ${WHEN_PAGE_CHANGED.join(", ")}.`);

  if (!s.content_signals || typeof s.content_signals !== "object") push("content_signals", "Set the three content signals: ai-train, search, ai-input.");
  else {
    for (const k of ["ai-train", "search", "ai-input"] as const) {
      if (!isBool(s.content_signals[k])) push(`content_signals.${k}`, `${k} must be yes or no.`);
    }
  }

  if (out.length === 0) {
    const src = s.markdown_source as MarkdownSource;
    const host = s.host as HostKind;
    if (src !== "semanto_only" && host !== "cloudflare") push("markdown_source", "Only Cloudflare runs a markdown converter. On this host choose semanto_only.");
    if (s.formats && s.formats.markdown === false && src !== "cloudflare_format_semanto_proof_only") push("formats.markdown", "Markdown is off, so Semanto cannot be the markdown source. Turn markdown on or choose the proof-only mode.");
    if (s.where && s.where.own_domain === false && host !== "unknown" && host !== "head_tag") push("where.own_domain", "A host adapter only runs when own domain is on.");
  }
  return out;
}

/** Fill a partial settings object with the defaults, then validate. */
export function withDefaults(partial: Partial<DeliverySettings> | null | undefined): DeliverySettings {
  const p = partial ?? {};
  return {
    where: { trooth_hosted: true, own_domain: p.where?.own_domain ?? DEFAULT_SETTINGS.where.own_domain },
    host: p.host ?? DEFAULT_SETTINGS.host,
    formats: { ...DEFAULT_SETTINGS.formats, ...(p.formats ?? {}), whole_file: true },
    markdown_source: p.markdown_source ?? DEFAULT_SETTINGS.markdown_source,
    when_page_changed: p.when_page_changed ?? DEFAULT_SETTINGS.when_page_changed,
    content_signals: { ...DEFAULT_SETTINGS.content_signals, ...(p.content_signals ?? {}) },
  };
}

/** The Content-Signal header value, contentsignals.org form: "ai-train=yes, search=yes, ai-input=no". */
export function contentSignalHeader(cs: ContentSignals): string {
  const yn = (b: boolean) => (b ? "yes" : "no");
  return `ai-train=${yn(cs["ai-train"])}, search=${yn(cs.search)}, ai-input=${yn(cs["ai-input"])}`;
}

// ---------------------------------------------------------------- resolver

/** What the adapter knows about the requested page when it asks. */
export interface ResolveRequest {
  /** The path on the company's domain. */
  path: string;
  accept: string | null | undefined;
  /** Is this url a page of the current signed version? */
  page_signed: boolean;
  /** For a signed page: does the live page still match the signed bytes? */
  live: "current" | "behind" | "unknown";
}

export type ResolveAction = "serve_semanto" | "fall_through_host" | "passthrough";

export interface Resolution {
  action: ResolveAction;
  /** The representation chosen on Accept or path suffix. */
  rep: Representation;
  /** The path with any format suffix removed. */
  base_path: string;
  /** For serve_semanto: which thing to serve. */
  serve?: "page" | "page_jsonld" | "llms" | "llms_full" | "sitemap" | "facts" | "well_known_semanto" | "well_known_keys" | "problem";
  /** When serve is "problem": the problem code to answer with. */
  problem?: "page_not_found";
  /** Header the adapter adds on a fall-through of a page whose live copy no longer matches the signature. */
  state_header?: "behind" | "unsigned";
  /** The company should be asked to sign the live page. */
  prompt_to_sign?: boolean;
  /** Plain-language description of the mode for the dashboard. */
  mode: string;
  warning?: string;
}

const WELL_KNOWN_SEMANTO = "/.well-known/trooth.semanto";
const WELL_KNOWN_KEYS = "/.well-known/trooth-keys.json";

export function describeMode(s: DeliverySettings): { mode: string; warning?: string } {
  switch (s.markdown_source) {
    case "semanto_only":
      return { mode: "Semanto answers every markdown and JSON-LD request with the signed bytes. Pages that are not in the signed file answer with a not-found notice in markdown." };
    case "semanto_then_cloudflare_for_unsigned":
      return { mode: "Semanto answers first for every signed page, so the host's converter never touches them. Pages that are not signed fall through to Cloudflare's converter and carry no proof." };
    case "cloudflare_format_semanto_proof_only":
      return {
        mode: "Cloudflare's converter answers every markdown request. Semanto serves the signed file, the facts, llms.txt and the proofs only.",
        warning: PROOF_ONLY_WARNING,
      };
  }
}

/** Decide what the adapter does for one request. Pure. */
export function resolve(settings: DeliverySettings, req: ResolveRequest): Resolution {
  const s = settings;
  const { mode, warning } = describeMode(s);
  const base = (r: Omit<Resolution, "mode" | "warning">): Resolution => ({ ...r, mode, ...(warning ? { warning } : {}) });
  const fromPath = representationFromPath(req.path);
  const path = req.path;

  // The well-known documents and the site-wide files are always Semanto's, whatever the mode.
  if (path === WELL_KNOWN_SEMANTO) return base({ action: "serve_semanto", rep: "json", base_path: path, serve: "well_known_semanto" });
  if (path === WELL_KNOWN_KEYS) return base({ action: "serve_semanto", rep: "json", base_path: path, serve: "well_known_keys" });
  if (path === "/llms.txt" || path === "/llms-full.txt") {
    if (!s.formats.llms) return base({ action: "passthrough", rep: "html", base_path: path });
    return base({ action: "serve_semanto", rep: "markdown", base_path: path, serve: path === "/llms.txt" ? "llms" : "llms_full" });
  }
  if (path === "/sitemap.md") {
    if (!s.formats.sitemap_md) return base({ action: "passthrough", rep: "html", base_path: path });
    return base({ action: "serve_semanto", rep: "markdown", base_path: path, serve: "sitemap" });
  }
  if (path === "/facts.jsonld") {
    if (!s.formats.jsonld) return base({ action: "passthrough", rep: "html", base_path: path });
    return base({ action: "serve_semanto", rep: "jsonld", base_path: "/", serve: "facts" });
  }

  const rep: Representation = fromPath.rep ?? negotiate(req.accept, ["markdown", "jsonld", "html"], "html");
  const base_path = fromPath.basePath;

  // HTML is the host's. Semanto never serves HTML.
  if (rep === "html" || rep === "json") return base({ action: "passthrough", rep: "html", base_path });

  if (rep === "jsonld") {
    if (!s.formats.jsonld) return base({ action: "passthrough", rep, base_path });
    if (!req.page_signed) return base({ action: "serve_semanto", rep, base_path, serve: "problem", problem: "page_not_found" });
    return base({ action: "serve_semanto", rep, base_path, serve: "page_jsonld", ...(req.live === "behind" ? { state_header: "behind" as const } : {}) });
  }

  // rep === "markdown"
  if (s.markdown_source === "cloudflare_format_semanto_proof_only") return base({ action: "fall_through_host", rep, base_path });
  if (!s.formats.markdown) return base({ action: "fall_through_host", rep, base_path });

  if (!req.page_signed) {
    if (s.markdown_source === "semanto_then_cloudflare_for_unsigned") return base({ action: "fall_through_host", rep, base_path, state_header: "unsigned" });
    return base({ action: "serve_semanto", rep, base_path, serve: "problem", problem: "page_not_found" });
  }

  // A signed page: Semanto answers first, so a converter never produces a second, unsigned copy of the same page.
  if (req.live === "behind") {
    switch (s.when_page_changed) {
      case "serve_live_marked_unsigned":
        return base({ action: "fall_through_host", rep, base_path, state_header: "unsigned" });
      case "prompt_to_sign":
        return base({ action: "serve_semanto", rep, base_path, serve: "page", state_header: "behind", prompt_to_sign: true });
      case "serve_last_signed_marked_behind":
        return base({ action: "serve_semanto", rep, base_path, serve: "page", state_header: "behind" });
    }
  }
  return base({ action: "serve_semanto", rep, base_path, serve: "page" });
}
