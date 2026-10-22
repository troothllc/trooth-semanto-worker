// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Discovery: the list of a site's public urls, from five sources, before any
// page is rendered. Practices followed:
//
//   robots.txt   RFC 9309 (Robots Exclusion Protocol): group selection by
//                product token, longest-match Allow and Disallow, Sitemap
//                lines; a Disallow is respected and the url is listed as
//                excluded, never fetched
//   sitemaps     sitemaps.org protocol 0.9: urlset and sitemapindex, lastmod
//                kept as the site wrote it
//   crawl        the homepage and internal links, breadth first, same
//                registrable domain, https only, no fragments, no query
//                strings, rel=canonical preferred over the url it was found at
//   llms.txt     links from the site's own llms.txt (llmstxt.org), if present
//   well-known   a short list of paths most company sites have
//
// Login, cart, account and personalized paths are listed as excluded with a
// reason so the coverage receipt can say why a url was left out.

import type { Fetcher, FetchOk, FetchOutcome } from "./fetch";
import { parseHtml, walk } from "./html";
import { normalizePageUrl, pathOf, hostOf, sameRegistrableDomain } from "./url";

export type DiscoverySource = "robots" | "sitemap" | "homepage" | "crawl" | "llms" | "well_known" | "canonical";

export interface DiscoveredUrl {
  url: string;
  source: DiscoverySource[];
  lastmod?: string;
  /** Set when the url is public but Trooth does not read it. */
  excluded?: { reason: string };
  /** The HTTP status seen when discovery fetched the url. */
  status?: number;
}

export interface RobotsRules {
  /** The group that applies to Trooth: its allow and disallow path patterns. */
  allow: string[];
  disallow: string[];
  sitemaps: string[];
  /** The product token whose group was used, or "*". */
  group: string;
  present: boolean;
}

export interface DiscoverOptions {
  /** Most urls listed, excluded ones included. Default 500. */
  cap?: number;
  wellKnown?: string[];
  /** The product token matched against robots.txt groups. */
  productToken?: string;
  /** Most sitemaps read, counting index files. */
  maxSitemaps?: number;
  /**
   * Called with each page discovery read, as soon as its links are taken.
   * With keepFetched false the page is not kept in the result, so a build
   * can write each body away and hold no page in memory (src/compiler/stream.ts).
   */
  onFetched?: (page: FetchOk) => Promise<void>;
  /** Keep every fetched page in the result (default true). */
  keepFetched?: boolean;
  /** Called after each page fetch with the urls found so far and the pages read so far. */
  onProgress?: (found: number, fetched: number) => Promise<void>;
}

export interface DiscoveryResult {
  domain: string;
  urls: DiscoveredUrl[];
  robots: RobotsRules;
  /** Every successful fetch discovery made, so the build need not fetch twice. */
  fetched: Record<string, FetchOk>;
  /** The llms.txt body, when the site publishes one. */
  llmsTxt: string | null;
}

export const WELL_KNOWN_PATHS = ["/about", "/security", "/privacy", "/terms", "/pricing", "/contact", "/careers", "/blog"];

const EXCLUDED_SEGMENTS: Record<string, string> = {
  login: "login page", "log-in": "login page", signin: "login page", "sign-in": "login page", logout: "login page", "wp-login.php": "login page",
  register: "account page", signup: "account page", "sign-up": "account page", account: "account page", accounts: "account page", "my-account": "account page",
  profile: "account page", dashboard: "account page", settings: "account page", preferences: "account page", password: "account page",
  "reset-password": "account page", "forgot-password": "account page", auth: "login page", oauth: "login page", session: "login page",
  cart: "cart page", basket: "cart page", checkout: "cart page", orders: "account page", order: "account page", wishlist: "personalized page",
  admin: "admin page", "wp-admin": "admin page", user: "account page", users: "account page", unsubscribe: "personalized page",
};

/** The reason a path is not read, or null when it is an ordinary public page. */
export function exclusionReason(url: string): string | null {
  const path = pathOf(url).toLowerCase();
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    const kind = EXCLUDED_SEGMENTS[seg];
    if (kind) return `${kind} (path segment "${seg}")`;
  }
  return null;
}

// ---------------------------------------------------------------- robots.txt

export function parseRobots(text: string | null, productToken = "TroothSemanto"): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [], sitemaps: [], group: "*", present: text !== null };
  if (!text) return rules;
  type Group = { agents: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "sitemap") {
      if (value) rules.sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow") {
      if (value) current.disallow.push(value);
    } else if (field === "allow") {
      if (value) current.allow.push(value);
    }
  }
  const token = productToken.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a === token || (a !== "*" && token.startsWith(a))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  rules.group = mine.length ? productToken : "*";
  for (const g of chosen) {
    rules.allow.push(...g.allow);
    rules.disallow.push(...g.disallow);
  }
  return rules;
}

function patternToRegex(p: string): RegExp {
  let anchored = false;
  let pat = p;
  if (pat.endsWith("$")) {
    anchored = true;
    pat = pat.slice(0, -1);
  }
  const esc = pat.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${esc}${anchored ? "$" : ""}`);
}

/** RFC 9309 section 2.2.2: the longest matching rule wins; a tie goes to Allow. */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  const u = new URL(url);
  const target = u.pathname + u.search;
  let best: { len: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (patternToRegex(p).test(target)) {
        const len = p.length;
        if (!best || len > best.len || (len === best.len && allow && !best.allow)) best = { len, allow };
      }
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best === null ? true : (best as { allow: boolean }).allow;
}

// ---------------------------------------------------------------- sitemaps

export interface SitemapParse {
  urls: { loc: string; lastmod?: string }[];
  sitemaps: string[];
}

function xmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

export function parseSitemap(xml: string): SitemapParse {
  const out: SitemapParse = { urls: [], sitemaps: [] };
  const isIndex = /<\s*sitemapindex[\s>]/i.test(xml);
  const entryRe = isIndex ? /<\s*sitemap[\s>]([\s\S]*?)<\/\s*sitemap\s*>/gi : /<\s*url[\s>]([\s\S]*?)<\/\s*url\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1]!;
    const loc = /<\s*loc\s*>([\s\S]*?)<\/\s*loc\s*>/i.exec(body);
    if (!loc) continue;
    const lm = /<\s*lastmod\s*>([\s\S]*?)<\/\s*lastmod\s*>/i.exec(body);
    const locText = xmlText(loc[1]!);
    if (isIndex) out.sitemaps.push(locText);
    else out.urls.push(lm ? { loc: locText, lastmod: xmlText(lm[1]!) } : { loc: locText });
  }
  if (!isIndex && out.urls.length === 0 && !/<\s*urlset/i.test(xml)) {
    // A plain-text sitemap: one url per line.
    for (const line of xml.split(/\r?\n/)) {
      const t = line.trim();
      if (/^https?:\/\//i.test(t)) out.urls.push({ loc: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------- links in pages

export interface PageLinks {
  links: string[];
  canonical: string | null;
}

/** Anchor hrefs and the canonical link, resolved against the page url, in document order. */
export function extractLinks(html: string, pageUrl: string): PageLinks {
  const root = parseHtml(html);
  const links: string[] = [];
  let canonical: string | null = null;
  let base = pageUrl;
  walk(root, (el) => {
    if (el.tag === "base" && el.attrs["href"]) {
      try {
        base = new URL(el.attrs["href"], pageUrl).href;
      } catch {
        // keep the page url
      }
    }
    if (el.tag === "link" && /(^|\s)canonical(\s|$)/i.test(el.attrs["rel"] ?? "") && el.attrs["href"]) {
      canonical = canonical ?? normalizePageUrl(el.attrs["href"], base);
    }
    if (el.tag === "a" && el.attrs["href"]) {
      const rel = (el.attrs["rel"] ?? "").toLowerCase();
      if (/(^|\s)nofollow(\s|$)/.test(rel)) return;
      const href = el.attrs["href"].trim();
      if (/^(mailto|tel|javascript|data|sms|ftp):/i.test(href) || href.startsWith("#")) return;
      const n = normalizePageUrl(href, base);
      if (n) links.push(n);
    }
  });
  return { links, canonical };
}

/** Markdown links in an llms.txt body. */
export function parseLlmsLinks(text: string, base: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const n = normalizePageUrl(m[1]!, base);
    if (n) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- the run

const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf|eot)$/i;

export async function discover(domain: string, fetcher: Fetcher, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const cap = opts.cap ?? 500;
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const origin = `https://${domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  const home = `${origin}/`;
  const entries = new Map<string, DiscoveredUrl>();
  const order: string[] = [];
  const fetched: Record<string, FetchOk> = {};
  const keep = opts.keepFetched ?? true;
  let fetchedCount = 0;

  const add = (url: string | null, source: DiscoverySource, lastmod?: string): DiscoveredUrl | null => {
    if (!url) return null;
    if (!sameRegistrableDomain(hostOf(url), hostOf(home))) return null;
    if (ASSET_RE.test(pathOf(url))) return null;
    let e = entries.get(url);
    if (!e) {
      if (entries.size >= cap) return null;
      e = { url, source: [] };
      const reason = exclusionReason(url);
      if (reason) e.excluded = { reason };
      entries.set(url, e);
      order.push(url);
    }
    if (!e.source.includes(source)) e.source.push(source);
    if (lastmod && !e.lastmod) e.lastmod = lastmod;
    return e;
  };

  // 1. robots.txt
  const robotsOutcome = await fetcher.fetch(`${origin}/robots.txt`);
  const robots = parseRobots(robotsOutcome.ok && robotsOutcome.status === 200 ? robotsOutcome.text : null, opts.productToken);
  const applyRobots = (e: DiscoveredUrl) => {
    if (!e.excluded && !robotsAllows(robots, e.url)) e.excluded = { reason: "robots.txt disallows this path" };
  };

  // 2. sitemaps, from robots.txt and the default location
  const sitemapQueue = [...robots.sitemaps.map((s) => (s.startsWith("http") ? s : `${origin}${s.startsWith("/") ? "" : "/"}${s}`)), `${origin}/sitemap.xml`];
  const seenSitemaps = new Set<string>();
  let sitemapsRead = 0;
  while (sitemapQueue.length && sitemapsRead < maxSitemaps) {
    const sm = sitemapQueue.shift()!;
    const normalized = sm.replace(/^http:/, "https:");
    if (seenSitemaps.has(normalized) || !sameRegistrableDomain(hostOf(normalized), hostOf(home))) continue;
    seenSitemaps.add(normalized);
    sitemapsRead++;
    const res = await fetcher.fetch(normalized);
    if (!res.ok || res.status !== 200) continue;
    const parsed = parseSitemap(res.text);
    for (const child of parsed.sitemaps) sitemapQueue.push(child);
    for (const u of parsed.urls) add(normalizePageUrl(u.loc), "sitemap", u.lastmod);
  }

  // 3. llms.txt
  let llmsTxt: string | null = null;
  const llms = await fetcher.fetch(`${origin}/llms.txt`);
  if (llms.ok && llms.status === 200 && /^\s*#\s/.test(llms.text)) {
    llmsTxt = llms.text;
    for (const u of parseLlmsLinks(llms.text, home)) add(u, "llms");
  }

  // 4. well-known paths
  for (const p of opts.wellKnown ?? WELL_KNOWN_PATHS) add(normalizePageUrl(p, home), "well_known");

  // 5. homepage and crawl, breadth first
  add(home, "homepage");
  const queue: string[] = [home, ...order.filter((u) => u !== home)];
  const queued = new Set(queue);
  for (const e of entries.values()) applyRobots(e);
  while (queue.length) {
    const url = queue.shift()!;
    const entry = entries.get(url);
    if (!entry || entry.excluded) continue;
    const res: FetchOutcome = await fetcher.fetch(url);
    if (!res.ok) {
      entry.excluded = { reason: `could not be fetched (${res.reason})` };
      continue;
    }
    entry.status = res.status;
    if (res.status !== 200) {
      if (entry.source.length === 1 && entry.source[0] === "well_known") {
        entries.delete(url);
        order.splice(order.indexOf(url), 1);
      }
      continue;
    }
    const ctype = (res.headers["content-type"] ?? "").toLowerCase();
    if (ctype && !/html|xml|text\/plain/.test(ctype)) {
      entry.excluded = { reason: `not an html page (${ctype.split(";")[0]})` };
      continue;
    }
    if (keep) fetched[url] = res;
    fetchedCount++;
    if (opts.onFetched) await opts.onFetched(res);
    const { links, canonical } = extractLinks(res.text, res.finalUrl);
    if (canonical && canonical !== url && sameRegistrableDomain(hostOf(canonical), hostOf(home))) {
      const c = add(canonical, "canonical");
      if (c) {
        entry.excluded = { reason: `canonical is ${canonical}` };
        applyRobots(c);
        if (!queued.has(canonical)) {
          queued.add(canonical);
          queue.push(canonical);
        }
      }
    }
    for (const link of links) {
      const e = add(link, url === home ? "homepage" : "crawl");
      if (!e) continue;
      applyRobots(e);
      if (!queued.has(link)) {
        queued.add(link);
        queue.push(link);
      }
    }
    if (opts.onProgress) await opts.onProgress(entries.size, fetchedCount);
  }

  const urls = [home, ...order.filter((u) => u !== home)].map((u) => entries.get(u)).filter((e): e is DiscoveredUrl => Boolean(e));
  return { domain: hostOf(home), urls, robots, fetched, llmsTxt };
}
