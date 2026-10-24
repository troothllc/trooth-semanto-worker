// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/compiler against the fictional acme.com fixture site in
// test/fixtures/compiler. Every figure in the fixtures is made up.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryHttp, FixedClock, fakeSleeper } from "@/compiler/ports";
import { Fetcher, ChangeDetector, checkUrl, classifyAddress, contentHash, USER_AGENT } from "@/compiler/fetch";
import { readProgress } from "@/setup/state";
import { discover, parseRobots, robotsAllows, parseSitemap, exclusionReason, extractLinks } from "@/compiler/discover";
import { extract, pageBlocks, detectChrome, sentencesOf, parseFrontMatter, splitBlocks } from "@/compiler/extract";
import { parseHtml, textOf, decodeEntities } from "@/compiler/html";
import { factCandidates, extractFacts, sinceIsAboutTheCompany } from "@/compiler/facts";
import { generateJsonLd, jsonLdScriptTag, markdownLinkTag, headTagsFor } from "@/compiler/jsonld";
import { buildLlmsTxt, buildLlmsFull, buildSitemapMd } from "@/compiler/llms";
import { buildVersion, type BuildInput, type FetchedPage } from "@/compiler/build";
import { registrableDomain, normalizePageUrl } from "@/compiler/url";
import { verifyStructure, validate, factId, type Identity, type SemantoFile } from "@/core/semanto";
import { utf8 } from "@/core/encoding";

const FIXTURES = fileURLToPath(new URL("./fixtures/compiler/", import.meta.url));
const read = (name: string) => readFileSync(FIXTURES + name, "utf8");

const PAGES: Record<string, string> = {
  "https://acme.com/": "index.html",
  "https://acme.com/about": "about.html",
  "https://acme.com/pricing": "pricing.html",
  "https://acme.com/contact": "contact.html",
  "https://acme.com/security": "security.html",
  "https://acme.com/blog/launch-notes": "blog-launch-notes.html",
  "https://acme.com/careers": "careers.html",
  "https://acme.com/login": "login.html",
};
const PUBLIC_PAGES = Object.keys(PAGES).filter((u) => u !== "https://acme.com/login");
const WITNESSED = "2026-10-22T12:00:00Z";

function site(overrides: Record<string, string> = {}): MemoryHttp {
  const http = new MemoryHttp();
  http.set("https://acme.com/robots.txt", { body: read("robots.txt"), headers: { "content-type": "text/plain" } });
  http.set("https://acme.com/sitemap.xml", { body: read("sitemap.xml"), headers: { "content-type": "application/xml" } });
  http.set("https://acme.com/llms.txt", { body: read("llms.txt"), headers: { "content-type": "text/plain" } });
  for (const [url, file] of Object.entries(PAGES)) {
    const headers: Record<string, string> = {};
    if (url === "https://acme.com/about") {
      headers["etag"] = '"about-v1"';
      headers["last-modified"] = "Tue, 15 Sep 2026 10:00:00 GMT";
    }
    if (url === "https://acme.com/careers") headers["x-robots-tag"] = "nosnippet";
    http.set(url, { body: overrides[url] ?? read(file), headers });
  }
  return http;
}

const IDENTITY: Identity = {
  domain: "acme.com",
  trooth_id: "acme",
  legal_name: "Acme Inc",
  key_binding: { jwks_url: "https://acme.com/.well-known/trooth-keys.json", dns_record: false },
};

async function compile(http: MemoryHttp, extra: Partial<BuildInput> = {}) {
  const clock = new FixedClock(WITNESSED);
  const fetcher = new Fetcher({ http, clock, sleep: fakeSleeper(clock).sleep }, { minIntervalMs: 0 });
  const discovery = await discover("acme.com", fetcher);
  const fetched: FetchedPage[] = Object.values(discovery.fetched).map((f) => ({
    url: f.url,
    status: f.status,
    html: f.text,
    source_hash: f.source_hash,
    witnessed_at: f.fetchedAt,
    headers: f.headers,
    truncated: f.truncated,
  }));
  const out = await buildVersion({
    org: "Acme Inc",
    identity: IDENTITY,
    profile: "https://trooth.co/network/company/acme",
    version: 1,
    supersedes: null,
    built_at: WITNESSED,
    discovery,
    fetched,
    ...extra,
  });
  return { discovery, fetched, out };
}

/** The markdown as words: marks, link targets, fences and table pipes removed. */
function plain(markdown: string): string {
  const body = parseFrontMatter(markdown)?.body ?? markdown;
  return body
    .replace(/^```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6} /gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*]|\d+\.) /gm, "")
    .replace(/^: /gm, "")
    .replace(/^\|\s*(?:---\s*\|\s*)+$/gm, "")
    .replace(/\\\|/g, "\u0002")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\u0002/g, "|")
    .replace(/\*\*|~~|`/g, "")
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences of the fixture's <main> as a person reads them: tags stripped, whitespace collapsed. */
function mainSentences(html: string): string[] {
  const m = /<main>([\s\S]*?)<\/main>/.exec(html);
  const inner = m ? m[1]! : "";
  const text = decodeEntities(inner.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<form[\s\S]*?<\/form>/g, "").replace(/<meta[^>]*>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length > 12);
}

// ---------------------------------------------------------------- url and html basics

describe("url helpers", () => {
  it("finds the registrable domain and the normal page form", () => {
    expect(registrableDomain("www.acme.com")).toBe("acme.com");
    expect(registrableDomain("shop.acme.co.uk")).toBe("acme.co.uk");
    expect(normalizePageUrl("http://acme.com/about?utm=1#team")).toBe("https://acme.com/about");
    expect(normalizePageUrl("ftp://acme.com/x")).toBeNull();
    expect(normalizePageUrl("/pricing", "https://acme.com/about")).toBe("https://acme.com/pricing");
  });
});

describe("html parser", () => {
  it("survives malformed markup", () => {
    const root = parseHtml("<div><p>one<p>two<ul><li>a<li>b</ul><br><img src=x alt='y'><!-- never closed");
    const ps = textOf(root);
    expect(ps).toContain("one");
    expect(ps).toContain("two");
    expect(root.children.length).toBe(1);
    expect(decodeEntities("&amp;&#65;&#x42;&nbsp;&unknown;")).toBe("&AB\u00a0&unknown;");
    expect(() => parseHtml("</p></div><<<>>>")).not.toThrow();
  });
});

// ---------------------------------------------------------------- discovery

describe("discovery", () => {
  it("reads robots.txt with longest-match rules and sitemap lines", () => {
    const rules = parseRobots(read("robots.txt"));
    expect(rules.sitemaps).toEqual(["https://acme.com/sitemap.xml"]);
    expect(robotsAllows(rules, "https://acme.com/login")).toBe(false);
    expect(robotsAllows(rules, "https://acme.com/internal/secret")).toBe(false);
    expect(robotsAllows(rules, "https://acme.com/internal/open/page")).toBe(true);
    expect(robotsAllows(rules, "https://acme.com/about")).toBe(true);
    expect(parseRobots(null).present).toBe(false);
  });

  it("parses sitemaps and sitemap indexes with lastmod", () => {
    const sm = parseSitemap(read("sitemap.xml"));
    expect(sm.urls.find((u) => u.loc === "https://acme.com/about")?.lastmod).toBe("2026-09-15");
    const index = parseSitemap('<sitemapindex><sitemap><loc>https://acme.com/a.xml</loc></sitemap><sitemap><loc><![CDATA[https://acme.com/b.xml]]></loc></sitemap></sitemapindex>');
    expect(index.sitemaps).toEqual(["https://acme.com/a.xml", "https://acme.com/b.xml"]);
  });

  it("extracts same-domain links without fragments or query strings and prefers the canonical", () => {
    const { links, canonical } = extractLinks(read("index.html"), "https://acme.com/");
    expect(links).toContain("https://acme.com/pricing");
    expect(links).toContain("https://acme.com/security");
    expect(links.every((l) => !l.includes("#") && !l.includes("?"))).toBe(true);
    expect(canonical).toBe("https://acme.com/");
  });

  it("finds every public page from five sources and excludes the login page with a reason", async () => {
    const http = site();
    const fetcher = new Fetcher({ http }, { minIntervalMs: 0 });
    const result = await discover("acme.com", fetcher);
    const byUrl = new Map(result.urls.map((u) => [u.url, u]));
    for (const u of PUBLIC_PAGES) {
      expect(byUrl.get(u), u).toBeDefined();
      expect(byUrl.get(u)!.excluded, u).toBeUndefined();
      expect(byUrl.get(u)!.status).toBe(200);
    }
    const login = byUrl.get("https://acme.com/login")!;
    expect(login.excluded?.reason).toMatch(/login page/);
    expect(http.log.some((r) => r.url === "https://acme.com/login")).toBe(false);
    expect(byUrl.get("https://acme.com/about")!.lastmod).toBe("2026-09-15");
    expect(byUrl.get("https://acme.com/about")!.source).toContain("sitemap");
    expect(byUrl.get("https://acme.com/about")!.source).toContain("llms");
    expect(byUrl.get("https://acme.com/careers")!.source).toContain("llms");
    expect(byUrl.get("https://acme.com/careers")!.source).toContain("well_known");
    expect(byUrl.get("https://acme.com/pricing")!.source).toContain("homepage");
    expect(result.urls[0]!.url).toBe("https://acme.com/");
    expect(result.robots.sitemaps).toEqual(["https://acme.com/sitemap.xml"]);
    expect(result.llmsTxt).toContain("# Acme Inc");
    // Well-known guesses that answered 404 are dropped; linked pages that 404 stay with their status.
    expect(byUrl.has("https://acme.com/privacy")).toBe(true);
    expect(byUrl.get("https://acme.com/privacy")!.status).toBe(404);
    const urls = result.urls.map((u) => u.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(exclusionReason("https://acme.com/cart/items")).toMatch(/cart page/);
    expect(exclusionReason("https://acme.com/account")).toMatch(/account page/);
    expect(exclusionReason("https://acme.com/about")).toBeNull();
  });

  // A site of n linked pages behind a port that counts requests in flight at once.
  function wideSite(n: number, robots = "User-agent: *\nAllow: /\n") {
    const http = new MemoryHttp({ "https://widecorp.com/robots.txt": { body: robots, headers: { "content-type": "text/plain" } } });
    const links = Array.from({ length: n }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join("");
    http.set("https://widecorp.com/", { body: `<html><head><title>Wide</title></head><body><main>${links}</main></body></html>` });
    for (let i = 0; i < n; i++) http.set(`https://widecorp.com/p${i}`, { body: `<html><head><title>Page ${i}</title></head><body><main><p>Page ${i} words.</p></main></body></html>` });
    let inFlight = 0;
    const counted = {
      peak: 0,
      log: http.log,
      async request(req: Parameters<MemoryHttp["request"]>[0]) {
        inFlight++;
        counted.peak = Math.max(counted.peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await http.request(req);
        } finally {
          inFlight--;
        }
      },
    };
    return { http, counted };
  }

  it("reads up to eight pages at once and keeps the order of the queue", async () => {
    const { counted } = wideSite(40);
    const result = await discover("widecorp.com", new Fetcher({ http: counted }, { minIntervalMs: 0 }));
    expect(counted.peak).toBeGreaterThan(1);
    expect(counted.peak).toBeLessThanOrEqual(8);
    const pages = result.urls.filter((u) => /\/p\d+$/.test(u.url)).map((u) => u.url);
    expect(pages).toEqual(Array.from({ length: 40 }, (_, i) => `https://widecorp.com/p${i}`));
  });

  it("reads one page at a time when robots.txt sets a Crawl-delay", async () => {
    const { counted } = wideSite(6, "User-agent: *\nCrawl-delay: 1\nAllow: /\n");
    const clock = new FixedClock("2026-10-22T12:00:00Z");
    const result = await discover("widecorp.com", new Fetcher({ http: counted, clock, sleep: fakeSleeper(clock).sleep }, { minIntervalMs: 0 }));
    expect(result.robots.crawl_delay_s).toBe(1);
    expect(counted.peak).toBe(1);
  });

  it("slows to one at a time after a 429 and retries the page once after Retry-After", async () => {
    const { http, counted } = wideSite(12);
    let first = true;
    const flaky = {
      get peak() {
        return counted.peak;
      },
      async request(req: Parameters<MemoryHttp["request"]>[0]) {
        if (req.url === "https://widecorp.com/p3" && first) {
          first = false;
          return { status: 429, headers: { "retry-after": "3", "content-type": "text/html" }, body: new Uint8Array(0), truncated: false };
        }
        return counted.request(req);
      },
    };
    const waits: number[] = [];
    const result = await discover("widecorp.com", new Fetcher({ http: flaky }, { minIntervalMs: 0 }), { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toContain(3000);
    expect(result.urls.find((u) => u.url === "https://widecorp.com/p3")?.status).toBe(200);
    expect(http.log.filter((r) => r.url === "https://widecorp.com/p3").length).toBe(1);
  });

  it("respects a cap", async () => {
    const result = await discover("acme.com", new Fetcher({ http: site() }, { minIntervalMs: 0 }), { cap: 3 });
    expect(result.urls.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- fetcher

describe("fetcher", () => {
  it("refuses private, loopback, link-local and metadata addresses and anything that is not https", async () => {
    const fetcher = new Fetcher({ http: new MemoryHttp() }, { minIntervalMs: 0 });
    const cases: [string, string][] = [
      ["https://127.0.0.1/", "loopback"],
      ["https://10.0.0.1/", "private"],
      ["https://169.254.169.254/latest/meta-data/", "metadata"],
      ["http://acme.com/", "not_https"],
      ["https://192.168.1.10/", "private"],
      ["https://172.20.0.1/", "private"],
      ["https://[::1]/", "loopback"],
      ["https://[::ffff:10.0.0.1]/", "private"],
      ["https://[fe80::1]/", "link_local"],
      ["https://[fd00:ec2::254]/", "metadata"],
      ["https://localhost/", "local_name"],
      ["https://metadata.google.internal/", "metadata"],
      ["https://0.0.0.0/", "unspecified"],
    ];
    for (const [url, reason] of cases) {
      const r = await fetcher.fetch(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason, url).toBe(reason);
    }
    expect(checkUrl("https://acme.com/").ok).toBe(true);
    expect(classifyAddress("8.8.8.8")).toBeNull();
    expect(classifyAddress("100.64.0.1")).toBe("private");
  });

  it("refuses a name that resolves to a private address", async () => {
    const fetcher = new Fetcher({ http: site(), resolve: async () => ["10.1.2.3"] }, { minIntervalMs: 0 });
    const r = await fetcher.fetch("https://acme.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private");
  });

  it("follows redirects on the registrable domain only, and caps the hop count", async () => {
    const http = site();
    http.set("https://acme.com/old", { status: 301, headers: { location: "https://www.acme.com/about" } });
    http.set("https://www.acme.com/about", { body: "<html><body><p>moved</p></body></html>" });
    http.set("https://acme.com/away", { status: 302, headers: { location: "https://other.example.net/" } });
    http.set("https://acme.com/loop", { status: 302, headers: { location: "https://acme.com/loop" } });
    const fetcher = new Fetcher({ http }, { minIntervalMs: 0 });
    const ok = await fetcher.fetch("https://acme.com/old");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.finalUrl).toBe("https://www.acme.com/about");
      expect(ok.redirects).toEqual(["https://www.acme.com/about"]);
    }
    const away = await fetcher.fetch("https://acme.com/away");
    expect(away.ok).toBe(false);
    if (!away.ok) expect(away.reason).toBe("redirect_off_domain");
    const loop = await fetcher.fetch("https://acme.com/loop");
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.reason).toBe("too_many_redirects");
  });

  it("sends the Trooth user agent, caps the body and hashes the raw bytes", async () => {
    const http = site();
    http.set("https://acme.com/big", { body: "x".repeat(5000) });
    const fetcher = new Fetcher({ http }, { minIntervalMs: 0, maxBytes: 1024 });
    const r = await fetcher.fetch("https://acme.com/big");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.body.length).toBe(1024);
      expect(r.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(http.log[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("TroothSemanto/1.0 (+https://trooth.co/semanto; witness)");
  });

  it("waits between two requests to the same host", async () => {
    const clock = new FixedClock(WITNESSED);
    const { sleep, waits } = fakeSleeper(clock);
    const fetcher = new Fetcher({ http: site(), clock, sleep }, { minIntervalMs: 500 });
    await fetcher.fetch("https://acme.com/");
    await fetcher.fetch("https://acme.com/about");
    expect(waits).toEqual([500]);
  });

  it("detects change by sitemap lastmod, then conditional GET, then raw hash, never for unchanged bytes", async () => {
    const http = site();
    const fetcher = new Fetcher({ http }, { minIntervalMs: 0 });
    const detector = new ChangeDetector(fetcher);
    const first = await fetcher.fetch("https://acme.com/about");
    if (!first.ok) throw new Error("fixture fetch failed");
    const previous = { lastmod: "2026-09-15", etag: first.etag, lastModified: first.lastModified, source_hash: first.source_hash };

    const requestsBefore = http.log.length;
    const bySitemap = await detector.check("https://acme.com/about", previous, "2026-09-15");
    expect(bySitemap).toMatchObject({ changed: false, reason: "sitemap_lastmod_same" });
    expect(http.log.length).toBe(requestsBefore);

    const byValidator = await detector.check("https://acme.com/about", previous, "2026-10-01");
    expect(byValidator).toMatchObject({ changed: false, reason: "not_modified" });
    expect(byValidator.fetch?.ok && byValidator.fetch.status).toBe(304);

    // New validators, same bytes: still no change.
    http.set("https://acme.com/about", { body: read("about.html"), headers: { etag: '"about-v2"' } });
    const sameBytes = await detector.check("https://acme.com/about", previous, null);
    expect(sameBytes).toMatchObject({ changed: false, reason: "same_bytes" });

    http.set("https://acme.com/about", { body: read("about.html").replace("coyote", "roadrunner"), headers: { etag: '"about-v3"' } });
    const changed = await detector.check("https://acme.com/about", previous, null);
    expect(changed).toMatchObject({ changed: true, reason: "new_bytes" });

    const fresh = await detector.check("https://acme.com/pricing", null, "2026-10-10");
    expect(fresh).toMatchObject({ changed: true, reason: "no_previous" });
  });
});

// ---------------------------------------------------------------- extraction

describe("extraction", () => {
  const html = Object.fromEntries(Object.entries(PAGES).map(([u, f]) => [u, read(f)]));
  const chrome = detectChrome(PUBLIC_PAGES.map((u) => pageBlocks(html[u]!, u)));
  const run = (u: string, extra: Record<string, unknown> = {}) =>
    extract({ html: html[u]!, url: u, witnessed_at: WITNESSED, source_hash: `sha256:${"ab".repeat(32)}`, chrome, ...extra });

  it("is byte deterministic across two runs", () => {
    for (const u of PUBLIC_PAGES) {
      const a = run(u).parts[0]!;
      const b = run(u).parts[0]!;
      expect(a).toBe(b);
      expect(utf8(a)).toEqual(utf8(b));
      expect(a.endsWith("\n")).toBe(true);
      expect(a.endsWith("\n\n")).toBe(false);
      expect(a.includes("\r")).toBe(false);
    }
  });

  it("writes the fixed front matter block", () => {
    const md = run("https://acme.com/").parts[0]!;
    expect(md.startsWith(`---\ntitle: "Acme Inc: anvils and rocket skates"\nurl: https://acme.com/\nlang: en\nwitnessed_at: ${WITNESSED}\nsource_hash: sha256:${"ab".repeat(32)}\n---\n\n`)).toBe(true);
    const fm = parseFrontMatter(md)!;
    expect(fm.fields["title"]).toBe("Acme Inc: anvils and rocket skates");
    expect(fm.body.startsWith("# Anvils and rocket skates since 1949")).toBe(true);
  });

  it("removes chrome by role and by repetition and loses no body sentence", () => {
    expect(chrome.has("Get the Acme newsletter every month.")).toBe(true);
    expect(chrome.has("Acme Inc is a fictional company used in Trooth fixtures.")).toBe(true);
    for (const u of PUBLIC_PAGES) {
      const md = run(u).parts[0]!;
      const text = plain(md);
      for (const sentence of mainSentences(html[u]!)) {
        const needle = sentence.replace(/\s+/g, " ");
        expect(text, `${u}: ${needle}`).toContain(needle);
      }
      expect(md).not.toContain("We use cookies");
      expect(md).not.toContain("newsletter");
      expect(md).not.toContain("fictional company used in Trooth fixtures");
      expect(md).not.toContain("All rights reserved");
      expect(md).not.toContain("Log in");
      expect(md).not.toContain("window.acme");
      expect(md).not.toContain("Subscribe");
    }
  });

  it("keeps headings, lists, tables, links, images, quotes, code and definition lists", () => {
    const home = run("https://acme.com/").body;
    expect(home).toContain("# Anvils and rocket skates since 1949");
    expect(home).toContain("## What we make");
    expect(home).toContain("- [Anvils](https://acme.com/pricing) in three weights");
    expect(home).toContain("- Portable holes\n  - Pocket size\n  - Wall size");
    expect(home).toContain("> We never ship a product we would not drop on our own foot.");
    expect(home).toContain("![The Tucson plant at sunrise](https://acme.com/plant.jpg)");
    expect(home).toContain("**anvils**, rocket skates and *portable holes*");
    const pricing = run("https://acme.com/pricing").body;
    expect(pricing).toContain("| Model | Weight | Price |\n| --- | --- | --- |\n| Anvil Mini | 10 lbs | $49 |");
    expect(pricing).toContain("| Anvil Grand \\| Edition | 500 lbs | $899 |");
    const about = run("https://acme.com/about").body;
    expect(about).toContain("1. Say what the product does.\n2. Ship on the date we said.\n3. Answer the phone.");
    expect(about).toContain("Legal name\n: Acme Inc");
    expect(about).toContain("```text\nACME-PLANT-01\nACME-PLANT-02\n```");
    expect(about).toContain("# About Acme");
    expect(about).toContain("Questions go to hello@acme.com.");
  });

  it("returns the index signals", () => {
    const sec = run("https://acme.com/security").signals;
    expect(sec.noindex).toBe(true);
    expect(sec.nosnippet).toBe(true);
    const home = run("https://acme.com/").signals;
    expect(home.canonical).toBe("https://acme.com/");
    expect(home.hreflang).toEqual([{ lang: "es", url: "https://acme.com/es/" }]);
    expect(home.noindex).toBe(false);
    const careers = run("https://acme.com/careers", { headers: { "x-robots-tag": "googlebot: noindex, nosnippet" }, robotsBlocked: true }).signals;
    expect(careers).toMatchObject({ noindex: true, nosnippet: true, robots_blocked: true });
    const security = run("https://acme.com/security").body;
    expect(security).toContain("Staff sign in with hardware keys; passwords alone never open a production system.");
    expect(security).toContain("Report a problem to security@acme.com");
  });

  it("splits a long page into parts at heading boundaries with part n of m", () => {
    const parts = run("https://acme.com/security", { partLimitBytes: 200 }).parts;
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p).toContain(`part: ${i + 1} of ${parts.length}`);
      expect(p.endsWith("\n")).toBe(true);
    });
    expect(parts[1]!.split("---\n\n")[1]!.startsWith("## ")).toBe(true);
    const joined = parts.map((p) => parseFrontMatter(p)!.body.trim()).join("\n\n");
    expect(joined).toBe(run("https://acme.com/security").body);
    expect(splitBlocks(["a", "b"], 1000)).toEqual([["a", "b"]]);
  });

  it("does not treat repetition as chrome on a tiny site", () => {
    expect(detectChrome([["same"], ["same"]]).size).toBe(0);
    expect(detectChrome([["same"], ["same"], ["same"], ["other"]]).has("same")).toBe(true);
  });
});

// ---------------------------------------------------------------- facts

describe("facts", () => {
  const html = Object.fromEntries(Object.entries(PAGES).map(([u, f]) => [u, read(f)]));
  const bodyOf = (u: string) => extract({ html: html[u]!, url: u, witnessed_at: WITNESSED, source_hash: `sha256:${"ab".repeat(32)}` }).body;

  it("reads JSON-LD and microdata into declared facts with schema mappings and anchors", async () => {
    const facts = await extractFacts({ url: "https://acme.com/", witnessed_at: WITNESSED, html: html["https://acme.com/"]!, body: bodyOf("https://acme.com/") });
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey["identity.legal_name"]?.value).toBe("Acme Inc");
    expect(byKey["identity.legal_name"]?.schema).toEqual({ type: "Organization", property: "legalName" });
    expect(byKey["identity.legal_name"]?.evidence.anchor).toBe("application/ld+json[0]/legalName");
    expect(byKey["contact.address.postal_code"]?.value).toBe("85701");
    expect(byKey["contact.customer_support.telephone"]?.value).toBe("+1-555-010-0100");
    expect(byKey["identity.same_as"]?.value).toEqual(["https://www.linkedin.com/company/acme-fixture", "https://github.com/acme-fixture"]);
    for (const f of facts) {
      expect(f.provenance).toBe("declared");
      expect(f.evidence.url).toBe("https://acme.com/");
      expect(f.evidence.witnessed_at).toBe(WITNESSED);
      expect(f.evidence.anchor && f.evidence.anchor.length > 0).toBe(true);
      const { id, ...rest } = f;
      expect(await factId(rest)).toBe(id);
    }
    const contact = factCandidates({ url: "https://acme.com/contact", witnessed_at: WITNESSED, html: html["https://acme.com/contact"]!, body: bodyOf("https://acme.com/contact") });
    const keys = contact.map((c) => c.key);
    expect(keys).toContain("hours.monday");
    expect(contact.find((c) => c.key === "hours.monday")?.value).toBe("09:00-17:00");
    expect(keys).toContain("contact.address.street_address");
  });

  it("reads 'since 1970' as a time base, not a founding year, when a clock counts from it (trooth.co, 2026-10-23)", () => {
    const body = "created is the time of the attempt in milliseconds since 1970. Serving Tucson since 1987, Acme Inc fixes bikes. The timestamp counts seconds since 1970-01-01 UTC. Family owned since 1952.";
    const facts = factCandidates({ url: "https://acme.com/docs/webhooks", witnessed_at: WITNESSED, html: `<html><body><p>${body}</p></body></html>`, body });
    const years = facts.filter((c) => c.key === "identity.founding_date").map((c) => c.value);
    expect(years).not.toContain("1970");
    expect(years).toEqual(expect.arrayContaining(["1987", "1952"]));
    expect(sinceIsAboutTheCompany("the time in milliseconds since 1970", "the time in milliseconds ".length)).toBe(false);
    expect(sinceIsAboutTheCompany("Unix time counts from since 1970", 22)).toBe(false);
    expect(sinceIsAboutTheCompany("Trusted by families since 1970", "Trusted by families ".length)).toBe(true);
  });

  it("finds text patterns with the exact sentence as anchor and never a placeholder", () => {
    const contact = factCandidates({ url: "https://acme.com/contact", witnessed_at: WITNESSED, html: html["https://acme.com/contact"]!, body: bodyOf("https://acme.com/contact") });
    const find = (key: string, value: string) => contact.find((c) => c.key === key && c.value === value);
    expect(find("contact.address", "1 Coyote Canyon Road, Tucson, AZ 85701")?.evidence.anchor).toBe("Visit Acme Tucson Store at 1 Coyote Canyon Road, Tucson, AZ 85701.");
    expect(find("contact.phone", "+1 555 010 0100")).toBeDefined();
    expect(find("contact.support_email", "support@acme.com")?.evidence.anchor).toBe("Call +1 555 010 0100 or write to support@acme.com.");
    expect(find("hours.opening_hours", "Monday to Friday 9:00 am - 5:00 pm")?.evidence.anchor).toBe("Our store is open Monday to Friday 9:00 am - 5:00 pm.");
    expect(find("identity.founding_date", "1949")?.evidence.anchor).toBe("Founded in 1949, Acme Inc is registered in Arizona.");
    expect(find("identity.legal_name", "Acme Inc")).toBeDefined();
    const pricing = factCandidates({ url: "https://acme.com/pricing", witnessed_at: WITNESSED, html: html["https://acme.com/pricing"]!, body: bodyOf("https://acme.com/pricing") });
    const uptime = pricing.find((c) => c.key === "statement.with_number" && c.statement.startsWith("Our uptime"));
    expect(uptime?.value).toEqual(["99.9%", "12 months"]);
    expect(uptime?.evidence.anchor).toBe(uptime?.statement);
    const placeholders = ["", "n/a", "unknown", "tbd", "null", "undefined", "none"];
    for (const c of [...contact, ...pricing]) {
      const values = Array.isArray(c.value) ? c.value : [String(c.value)];
      for (const v of values) expect(placeholders.includes(v.trim().toLowerCase()), `${c.key}=${v}`).toBe(false);
      expect(c.evidence.anchor!.length).toBeGreaterThan(0);
      expect(c.statement.length).toBeGreaterThan(0);
    }
  });

  it("produces nothing from an empty page and nothing from malformed JSON-LD", () => {
    const none = factCandidates({ url: "https://acme.com/x", witnessed_at: WITNESSED, html: '<html><body><script type="application/ld+json">{not json</script><p>Hello there friend.</p></body></html>', body: "Hello there friend." });
    expect(none).toEqual([]);
  });
});

// ---------------------------------------------------------------- build, jsonld, llms

describe("build", () => {
  it("produces a file in state read that passes verifyStructure with the page bytes", async () => {
    const { out, discovery } = await compile(site());
    expect(out.file.header.state).toBe("read");
    expect(validate(out.file)).toEqual([]);
    const issues = await verifyStructure(out.file, async (entry) => out.bodies[entry.id] ?? null);
    expect(issues).toEqual([]);
    const urls = out.file.header.pages_manifest.map((p) => p.url);
    expect(urls).toEqual(expect.arrayContaining(PUBLIC_PAGES));
    expect(urls).not.toContain("https://acme.com/login");
    expect(urls[0]).toBe("https://acme.com/");
    for (const p of out.file.header.pages_manifest) {
      expect(p.id.startsWith("smp_")).toBe(true);
      expect(p.tokens).toBeGreaterThan(0);
      expect(p.original_tokens).toBeGreaterThan(p.tokens);
      expect(p.bytes).toBe(out.bodies[p.id]!.length);
      expect(p.status).toBe(200);
    }
    const security = out.file.header.pages_manifest.find((p) => p.url === "https://acme.com/security")!;
    expect(security.index).toEqual({ noindex: true, nosnippet: true, canonical: null, robots_blocked: false });
    const careers = out.file.header.pages_manifest.find((p) => p.url === "https://acme.com/careers")!;
    expect(careers.index.nosnippet).toBe(true);
    expect(out.file.header.tiers.map((t) => t.name)).toEqual(["header", "facts", "controls", "pages", "question_map", "documents", "products"]);
    expect(out.file.facts.length).toBeGreaterThan(10);
    expect(out.file.facts.every((f) => f.provenance === "declared")).toBe(true);
    // The receipt says what was found, read and left out, and why.
    expect(out.receipt.id.startsWith("smr_")).toBe(true);
    expect(out.receipt.found).toBe(discovery.urls.length);
    expect(out.receipt.read).toBe(PUBLIC_PAGES.length);
    expect(out.receipt.left_out.find((l) => l.url === "https://acme.com/login")?.reason).toMatch(/login page/);
    expect(out.receipt.left_out.find((l) => l.url === "https://acme.com/privacy")?.reason).toBe("answered 404");
    expect(new Set(out.receipt.changed)).toEqual(new Set(PUBLIC_PAGES));
    expect(out.receipt.removed).toEqual([]);
    // The same bytes under the same hashes: a second build is identical.
    const again = await compile(site());
    expect(again.out.file.root_hash).toBe(out.file.root_hash);
  });

  it("reuses unchanged page ids and bodies on an incremental rebuild", async () => {
    const first = await compile(site());
    const changedPricing = read("pricing.html").replace("$49", "$59");
    const second = await compile(site({ "https://acme.com/pricing": changedPricing }), {
      version: 2,
      supersedes: 1,
      previous: { file: first.out.file, bodies: first.out.bodies },
      changed_urls: ["https://acme.com/pricing"],
    });
    const before = new Map(first.out.file.header.pages_manifest.map((p) => [p.url, p]));
    for (const p of second.out.file.header.pages_manifest) {
      if (p.url === "https://acme.com/pricing") {
        expect(p.id).not.toBe(before.get(p.url)!.id);
        expect(new TextDecoder().decode(second.out.bodies[p.id]!)).toContain("$59");
      } else {
        expect(p.id).toBe(before.get(p.url)!.id);
        expect(p.witnessed_at).toBe(before.get(p.url)!.witnessed_at);
        expect(second.out.bodies[p.id]).toBe(first.out.bodies[p.id]);
      }
    }
    expect(second.out.receipt.changed).toEqual(["https://acme.com/pricing"]);
    expect(second.out.file.header.supersedes).toBe(1);
    expect(await verifyStructure(second.out.file, async (e) => second.out.bodies[e.id] ?? null)).toEqual([]);
    expect(second.out.file.root_hash).not.toBe(first.out.file.root_hash);
  });

  it("writes JSON-LD whose every value traces to a fact id or a named record", async () => {
    const { out } = await compile(site(), {
      products: [{ product_id: "smk_fixture_anvil_grand", sku: "ANV-500", name: "Anvil Grand", brand: "Acme", price: { amount: "899", currency: "USD" }, availability: "in_stock", url: "https://acme.com/pricing" }],
    });
    const faqFact = out.file.facts.find((f) => f.key === "hours.opening_hours")!;
    const file: SemantoFile = { ...out.file, question_map: [{ question: "When is the store open?", answered_on_site: true, passages: [{ url: "https://acme.com/contact" }], fact_ids: [faqFact.id] }] };
    const ld = generateJsonLd(file);
    const graph = ld.graph["@graph"] as Record<string, unknown>[];
    const types = graph.map((n) => n["@type"]);
    expect(types).toContain("LocalBusiness");
    expect(types).toContain("WebSite");
    expect(types).toContain("Product");
    expect(types).toContain("FAQPage");
    expect(types).toContain("Article");
    const org = graph[0]!;
    expect(org["legalName"]).toBe("Acme Inc");
    expect((org["address"] as Record<string, unknown>)["postalCode"]).toBe("85701");
    expect(Array.isArray(org["openingHoursSpecification"])).toBe(true);
    expect(((org["openingHoursSpecification"] as Record<string, unknown>[])[0]!)["opens"]).toBe("09:00");
    const site_ = graph.find((n) => n["@type"] === "WebSite")!;
    expect(site_["sameAs"]).toEqual(["https://trooth.co/network/company/acme"]);
    const product = graph.find((n) => n["@type"] === "Product")!;
    expect((product["offers"] as Record<string, unknown>)["priceCurrency"]).toBe("USD");
    expect((product["offers"] as Record<string, unknown>)["availability"]).toBe("https://schema.org/InStock");
    const factIds = new Set(file.facts.map((f) => f.id));
    const pageIds = new Set(file.header.pages_manifest.map((p) => p.id));
    expect(Object.keys(ld.trace).length).toBeGreaterThan(15);
    for (const [path, src] of Object.entries(ld.trace)) {
      const ok = factIds.has(src) || src === "header:identity.domain" || src === "header:identity.lei" || src === "header:profile" || src === "product:smk_fixture_anvil_grand" || (src.startsWith("page:") && pageIds.has(src.slice(5)));
      expect(ok, `${path} -> ${src}`).toBe(true);
    }
    // Every written leaf of the organization has a trace entry.
    const leaves = (node: Record<string, unknown>, prefix: string): string[] =>
      Object.entries(node).flatMap(([k, v]) => {
        if (k.startsWith("@")) return [];
        if (Array.isArray(v)) return v.every((x) => typeof x !== "object") ? [`${prefix}.${k}`] : v.flatMap((x, i) => leaves(x as Record<string, unknown>, `${prefix}.${k}[${i}]`));
        if (typeof v === "object" && v !== null) return leaves(v as Record<string, unknown>, `${prefix}.${k}`);
        return [`${prefix}.${k}`];
      });
    for (const leaf of leaves(org, "@graph[0]")) expect(ld.trace[leaf], leaf).toBeDefined();
    expect(ld.trace["@graph[0].legalName"]).toBe(file.facts.find((f) => f.key === "identity.legal_name")!.id);
    // Per page blocks and head tags.
    expect(ld.perPage["https://acme.com/"]).toBeDefined();
    const contactBlock = ld.perPage["https://acme.com/contact"]!["@graph"] as Record<string, unknown>[];
    expect(contactBlock.some((n) => n["@type"] === "FAQPage")).toBe(true);
    const blogBlock = ld.perPage["https://acme.com/blog/launch-notes"]!["@graph"] as Record<string, unknown>[];
    expect(blogBlock.some((n) => n["@type"] === "Article")).toBe(true);
    const head = headTagsFor("https://acme.com/", ld);
    expect(head).toContain('<link rel="alternate" type="text/markdown" href="https://acme.com/index.md">');
    expect(head).toContain('<script type="application/ld+json">');
    expect(jsonLdScriptTag({ a: "</script><b>" })).not.toContain("</script><b>");
    expect(markdownLinkTag("https://acme.com/about.md")).toBe('<link rel="alternate" type="text/markdown" href="https://acme.com/about.md">');
    // A mailbox for one job is not the company's email, and one address is one contact point (trooth.co, 2026-10-23).
    const base = file.facts.find((f) => f.key === "identity.legal_name")!;
    const mk = (key: string, value: string, id: string) => ({ ...base, id, key, value, statement: `${key} ${value}` });
    const mail = generateJsonLd({ ...file, facts: [...file.facts.filter((f) => !f.key.startsWith("contact.")), mk("contact.email", "security@acme.com", "f_sec"), mk("contact.email", "hello@acme.com", "f_hello"), mk("contact.desk.email", "help@acme.com", "f_desk"), mk("contact.support_email", "help@acme.com", "f_sup")] });
    const mailOrg = (mail.graph["@graph"] as Record<string, unknown>[])[0]!;
    expect(mailOrg["email"]).toBe("hello@acme.com");
    expect((mailOrg["contactPoint"] as Record<string, unknown>[]).filter((c) => c["email"] === "help@acme.com").length).toBe(1);
    const roleOnly = generateJsonLd({ ...file, facts: [...file.facts.filter((f) => !f.key.startsWith("contact.")), mk("contact.email", "privacy@acme.com", "f_priv")] });
    expect((roleOnly.graph["@graph"] as Record<string, unknown>[])[0]!["email"]).toBeUndefined();
    // Nothing invented: a file without facts writes only the header-backed values.
    const empty = generateJsonLd({ ...file, facts: [], products: [], question_map: [] });
    const emptyOrg = (empty.graph["@graph"] as Record<string, unknown>[])[0]!;
    expect(Object.keys(emptyOrg).sort()).toEqual(["@id", "@type", "url"]);
  });

  it("writes llms.txt with a Trooth section, llms-full.txt in manifest order and a hierarchical sitemap.md", async () => {
    const { out } = await compile(site());
    const { llmsTxt, llmsFull, sitemapMd } = out.llms;
    expect(llmsTxt.startsWith("# Acme Inc\n\n> ")).toBe(true);
    expect(llmsTxt).toContain("## Trooth");
    expect(llmsTxt).toContain("https://acme.com/.well-known/trooth.semanto");
    expect(llmsTxt).toContain("https://trooth.co/network/company/acme");
    expect(llmsTxt).toContain("- [About Acme](https://acme.com/about): Acme Inc was founded in 1949 by a coyote with a dream.");
    expect(llmsTxt).toContain("## Blog");
    const order = out.file.header.pages_manifest.map((p) => llmsFull.indexOf(`<!-- page: ${p.url}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(llmsFull).toContain("# Anvils and rocket skates since 1949");
    expect(sitemapMd).toContain("- [Acme Inc: anvils and rocket skates](https://acme.com/)");
    expect(sitemapMd).toContain("  - Blog\n    - [Launch notes: the Anvil Grand](https://acme.com/blog/launch-notes)");
    const direct = buildLlmsTxt({ siteName: "Acme Inc", domain: "acme.com", summary: "Anvils.", pages: [], troothId: "acme", networkUrl: "https://trooth.co/network/company/acme" });
    expect(direct).toContain("## Trooth");
    expect(buildLlmsFull("Acme Inc", [])).toBe("# Acme Inc: every page\n");
    expect(buildSitemapMd("Acme Inc", [])).toBe("# Acme Inc: sitemap\n\n");
  });

  it("never uses the words the house rules ban about a company, and no ellipsis", () => {
    const sources = ["discover.ts", "fetch.ts", "extract.ts", "facts.ts", "jsonld.ts", "llms.ts", "build.ts", "html.ts", "ports.ts", "url.ts"].map((f) => readFileSync(fileURLToPath(new URL(`../src/compiler/${f}`, import.meta.url)), "utf8"));
    for (const s of sources) {
      const banned = new RegExp(`\\b(${["sc", "veri", "certi"].map((x, i) => x + ["ore", "fied", "fied"][i]).join("|")})\\b`, "i");
      expect(banned.test(s)).toBe(false);
      // The three-dot character never, and three periods never as text (the spread operator is syntax, not an ellipsis).
      expect(s.includes("\u2026")).toBe(false);
      expect(/\.\.\.(?![A-Za-z_$([{])/.test(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- change detection and progress

describe("change detection reads the words, not the bytes", () => {
  const page = (nonce: string, words = "Acme makes anvils.") => `<html><head><script nonce="${nonce}">1</script><meta name="csrf" content="${nonce}"></head><body><main><p>${words}</p></main></body></html>`;

  it("a new script nonce is the same text; new words are not", async () => {
    expect(await contentHash(page("a1"))).toBe(await contentHash(page("b2")));
    expect(await contentHash(page("a1"))).not.toBe(await contentHash(page("a1", "Acme makes rockets.")));
    expect(await contentHash(page("a1"))).toMatch(/^text:sha256:/);
  });

  it("the hourly check calls a page with only a new nonce unchanged", async () => {
    const http = new MemoryHttp({ "https://acme.com/about": page("first") });
    const detector = new ChangeDetector(new Fetcher({ http }, { minIntervalMs: 0 }));
    const previous = { etag: null, lastModified: null, source_hash: await contentHash(page("first")), lastmod: null };
    http.set("https://acme.com/about", { body: page("second") });
    expect((await detector.check("https://acme.com/about", previous)).reason).toBe("same_text");
    http.set("https://acme.com/about", { body: page("third", "Acme makes rockets.") });
    expect((await detector.check("https://acme.com/about", previous)).changed).toBe(true);
  });
});

describe("read progress never counts the wrong thing", () => {
  const start = Date.parse("2026-10-22T12:00:00Z");
  const reading = (checked: number, found: number, fetched: number, s: number) => readProgress({ status: "reading", found, fetched, checked, planned: 0, rendered: 0, started_at: new Date(start).toISOString() }, start + s * 1000);

  it("gives no time until ten addresses are checked, then counts checked addresses, not HTML pages", () => {
    expect(reading(5, 40, 3, 2).eta_seconds).toBeUndefined();
    const p = reading(20, 100, 10, 10);
    expect(p).toMatchObject({ phase: "reading", done: 20, total: 100 });
    expect(p.eta_seconds).toBeGreaterThan(0);
  });

  it("an estimate at a steady pace goes down as the read goes on, even while it finds more addresses", () => {
    const a = reading(20, 100, 10, 10).eta_seconds!;
    const b = reading(60, 120, 30, 30).eta_seconds!;
    const c = reading(110, 120, 55, 55).eta_seconds!;
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
  });

  it("names the writing and finishing phases with their own counts", () => {
    const r = readProgress({ status: "rendering", found: 120, fetched: 60, checked: 120, planned: 60, rendered: 30, started_at: null, rendering_started_at: new Date(start).toISOString() }, start + 3000);
    expect(r).toMatchObject({ phase: "rendering", done: 30, total: 60 });
    expect(readProgress({ status: "assembling", found: 120, fetched: 60, planned: 60, rendered: 60, started_at: null }, start)).toMatchObject({ phase: "assembling", done: 60, total: 60 });
  });
});
