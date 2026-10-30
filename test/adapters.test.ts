// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for adapters/shared: the decision table for every Accept outcome and
// every path suffix, each mode, the never-by-user-agent rule, header copying,
// the manifest cache with its ETag, the whole-request handler and the signed
// connector POST (checked with src/core/httpsig, the code the API verifies
// with). The adapters themselves never import src/core; the tests may.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decide,
  negotiate as adapterNegotiate,
  representationFromPath as adapterSuffix,
  copyHeaders,
  createManifestCache,
  memoryStore,
  handleRequest,
  proofHeaders,
  withProofHeaders,
  configFromEnv,
  TROOTH_HEADERS,
  WELL_KNOWN_FILES,
  createStaleStore,
  createBreaker,
  signatureExpiry,
  DELIVERY_HEADER,
  SIGNATURE_HEADERS,
  findPage,
  MODES,
  OFFERED,
} from "../adapters/shared/semanto-adapter.mjs";
import { generateConnectorKey, signPost, postSigned, CONNECTOR_TAG } from "../adapters/shared/sign-request.mjs";
import { negotiate as coreNegotiate, representationFromPath as coreSuffix } from "@/core/negotiate";
import { verifyMessage, verifyContentDigest } from "@/core/httpsig";
import { thumbprint } from "@/core/keys";
import manifestFixture from "./fixtures/adapters/fixture-manifest.json";

const config = { troothId: "acme-inc", apiBase: "https://api.trooth.co", mode: "semanto_only" as const };
const ROOT = "https://api.trooth.co/public/semanto/acme-inc";

describe("adapters/shared decide: Accept outcomes", () => {
  const cases: [string | null, string][] = [
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.9", "markdown"],
    ["text/*", "markdown"],
    ["*/*", "html"],
    [null, "html"],
    ["", "html"],
    ["text/html", "html"],
    ["text/html, text/markdown;q=0.5", "html"],
    ["application/ld+json", "jsonld"],
    ["application/ld+json, text/html;q=0.8", "jsonld"],
    ["text/markdown;q=0", "html"],
    ["text/html;q=0.8, */*;q=0.1, text/markdown", "markdown"],
    ["application/json", "html"],
    ["TEXT/MARKDOWN", "markdown"],
  ];
  for (const [accept, want] of cases) {
    it(`Accept ${JSON.stringify(accept)} -> ${want}`, () => {
      expect(adapterNegotiate(accept)).toBe(want);
      expect(coreNegotiate(accept, [...OFFERED] as ("html" | "markdown" | "jsonld")[])).toBe(want);
      const d = decide("/pricing", accept, manifestFixture, config);
      if (want === "html") expect(d.serve).toBe(false);
      // A page path asks for the page's JSON-LD, by path, exactly as the API answers /by-path/pricing.
      else if (want === "jsonld") expect(d).toMatchObject({ serve: true, url: `${ROOT}/by-path/pricing`, kind: "page_jsonld" });
      else expect(d).toMatchObject({ serve: true, kind: "page", url: `${ROOT}/pages/smp_a2b3c4d5e6f7g2h3j4k5m6n7p2.md` });
    });
  }
});

describe("adapters/shared decide: path suffixes", () => {
  it("every suffix matches src/core/negotiate", () => {
    for (const p of ["/pricing.md", "/pricing/index.md", "/index.md", "/facts.jsonld", "/pricing/facts.jsonld", "/pricing.jsonld", "/pricing", "/", "/docs/a/b.md"]) {
      expect(adapterSuffix(p)).toEqual(coreSuffix(p));
    }
  });
  it(".md and /index.md serve the listed page's markdown without an Accept header", () => {
    expect(decide("/pricing.md", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "page", url: `${ROOT}/pages/smp_a2b3c4d5e6f7g2h3j4k5m6n7p2.md` });
    expect(decide("/pricing/index.md", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "page" });
    expect(decide("/index.md", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "page", url: `${ROOT}/pages/smp_b3c4d5e6f7g2h3j4k5m6n7p2q3.md` });
  });
  it("the site root's /facts.jsonld serves the facts file; any other .jsonld serves the page's JSON-LD by path", () => {
    expect(decide("/facts.jsonld", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "facts", url: `${ROOT}/facts.jsonld` });
    expect(decide("/pricing.jsonld", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "page_jsonld", url: `${ROOT}/by-path/pricing.jsonld` });
    expect(decide("/pricing/facts.jsonld", "text/html", manifestFixture, config)).toMatchObject({ serve: true, kind: "page_jsonld", url: `${ROOT}/by-path/pricing/facts.jsonld` });
  });
  it("the suffix wins over an html Accept", () => {
    expect(decide("/pricing.md", "text/html", manifestFixture, config)).toMatchObject({ serve: true, kind: "page" });
  });
  it("query strings and trailing slashes do not change the page", () => {
    expect(decide("/pricing/?utm=x", "text/markdown", manifestFixture, config)).toMatchObject({ serve: true, kind: "page" });
  });
  it("an unlisted page in semanto_only goes to the API by path", () => {
    expect(decide("/not-listed.md", null, manifestFixture, config)).toMatchObject({ serve: true, kind: "page_lookup", url: `${ROOT}/by-path/not-listed.md` });
  });
  it("only GET and HEAD are served", () => {
    expect(decide("/pricing.md", null, manifestFixture, { ...config, method: "POST" })).toEqual({ serve: false, reason: "method" });
    expect(decide("/pricing.md", null, manifestFixture, { ...config, method: "HEAD" }).serve).toBe(true);
  });
});

describe("adapters/shared decide: the well-known and llms files", () => {
  it("maps each file to its Trooth-hosted copy", () => {
    expect(decide("/.well-known/trooth.semanto", null, null, config)).toMatchObject({ serve: true, url: ROOT, kind: "well_known" });
    expect(decide("/.well-known/trooth-keys.json", "*/*", null, config)).toMatchObject({ serve: true, url: `${ROOT}/keys.json`, kind: "well_known" });
    expect(decide("/llms.txt", "text/html", null, config)).toMatchObject({ serve: true, url: `${ROOT}/llms.txt`, kind: "llms" });
    expect(decide("/llms-full.txt", null, null, config)).toMatchObject({ serve: true, url: `${ROOT}/llms-full.txt` });
    expect(decide("/sitemap.md", null, null, config)).toMatchObject({ serve: true, url: `${ROOT}/sitemap.md` });
    expect(Object.keys(WELL_KNOWN_FILES)).toHaveLength(5);
  });
  it("serves them whatever the Accept header says", () => {
    for (const accept of [null, "*/*", "text/html", "application/json"]) {
      expect(decide("/.well-known/trooth.semanto", accept, null, config).serve).toBe(true);
    }
  });
});

describe("adapters/shared decide: modes", () => {
  it("lists exactly three modes and defaults an unknown one to semanto_only", () => {
    expect(MODES).toEqual(["semanto_only", "semanto_then_cloudflare_for_unsigned", "proof_only"]);
    expect(configFromEnv({ TROOTH_ID: "acme-inc", MODE: "whatever" }).mode).toBe("semanto_only");
    expect(configFromEnv({ TROOTH_ID: "acme-inc", TROOTH_MODE: "proof_only" }).mode).toBe("proof_only");
  });
  it("semanto_then_cloudflare_for_unsigned serves listed pages and leaves the rest to Cloudflare", () => {
    const c = { ...config, mode: "semanto_then_cloudflare_for_unsigned" as const };
    expect(decide("/pricing", "text/markdown", manifestFixture, c)).toMatchObject({ serve: true, kind: "page" });
    expect(decide("/not-listed", "text/markdown", manifestFixture, c)).toEqual({ serve: false, reason: "not_listed" });
    expect(decide("/not-listed.md", null, manifestFixture, c)).toEqual({ serve: false, reason: "not_listed" });
    expect(decide("/.well-known/trooth.semanto", null, manifestFixture, c).serve).toBe(true);
    expect(decide("/llms.txt", null, manifestFixture, c).serve).toBe(true);
    expect(decide("/anything", "application/ld+json", manifestFixture, c)).toEqual({ serve: false, reason: "not_listed" });
    expect(decide("/pricing", "application/ld+json", manifestFixture, c)).toMatchObject({ serve: true, kind: "page_jsonld" });
    expect(decide("/facts.jsonld", null, manifestFixture, c)).toMatchObject({ serve: true, kind: "facts" });
  });
  it("without a manifest, semanto_then_cloudflare_for_unsigned serves no page", () => {
    const c = { ...config, mode: "semanto_then_cloudflare_for_unsigned" as const };
    expect(decide("/pricing", "text/markdown", null, c)).toEqual({ serve: false, reason: "not_listed" });
  });
  it("proof_only serves the two well-known files and nothing else", () => {
    const c = { ...config, mode: "proof_only" as const };
    expect(decide("/.well-known/trooth.semanto", null, manifestFixture, c).serve).toBe(true);
    expect(decide("/.well-known/trooth-keys.json", null, manifestFixture, c).serve).toBe(true);
    expect(decide("/llms.txt", null, manifestFixture, c)).toEqual({ serve: false, reason: "mode" });
    expect(decide("/pricing", "text/markdown", manifestFixture, c)).toEqual({ serve: false, reason: "mode" });
    expect(decide("/pricing.md", null, manifestFixture, c)).toEqual({ serve: false, reason: "mode" });
    expect(decide("/facts.jsonld", null, manifestFixture, c)).toEqual({ serve: false, reason: "mode" });
  });
  it("proof_only adds the version and Link headers to html", () => {
    const h = proofHeaders(manifestFixture, "/pricing", { ...config, mode: "proof_only" });
    expect(h["Trooth-Semanto-Version"]).toBe("7");
    expect(h["Link"]).toContain(`<${ROOT}>; rel="https://trooth.co/rel/semanto"`);
    expect(h["Link"]).toContain('</pricing.md>; rel="alternate"; type="text/markdown"');
    const home = proofHeaders(manifestFixture, "/", config);
    expect(home["Link"]).toContain('</index.md>; rel="alternate"; type="text/markdown"');
    const unlisted = proofHeaders(manifestFixture, "/not-listed", config);
    expect(unlisted["Link"]).not.toContain("alternate");
  });
  it("withProofHeaders adds only Vary: Accept to non-html responses and keeps an existing Link", async () => {
    const css = new Response("a{}", { headers: { "Content-Type": "text/css", Vary: "Origin" } });
    const cssOut = withProofHeaders(css, manifestFixture, "/a.css", config);
    expect(cssOut.headers.get("Vary")).toBe("Origin, Accept");
    expect(cssOut.headers.get("Trooth-Semanto-Version")).toBeNull();
    expect(await cssOut.text()).toBe("a{}");
    const html = new Response("<p>hi</p>", { headers: { "Content-Type": "text/html; charset=utf-8", Link: "</style.css>; rel=preload" } });
    const out = withProofHeaders(html, manifestFixture, "/pricing", config);
    expect(out.headers.get("Link")).toMatch(/^<\/style.css>; rel=preload, </);
    expect(out.headers.get("Trooth-Semanto-Version")).toBe("7");
  });
});

describe("adapters/shared decide: never by User-Agent", () => {
  it("has no way to receive a User-Agent and decides the same for any reader", () => {
    const a = decide("/pricing", "text/markdown", manifestFixture, { ...config, method: "GET" });
    const b = decide("/pricing", "text/markdown", manifestFixture, { ...config, method: "GET" });
    expect(a).toEqual(b);
    const src = decide.toString();
    expect(src.toLowerCase()).not.toContain("user-agent");
    expect(src.toLowerCase()).not.toContain("useragent");
  });
  it("two requests differing only in User-Agent get the same bytes and headers", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push(h.get("User-Agent") || "");
      return new Response("# Pricing\n", { status: 200, headers: apiHeaders() });
    }) as typeof fetch;
    const mk = (ua: string) => new Request("https://acme.com/pricing", { headers: { Accept: "text/markdown", "User-Agent": ua } });
    const next = async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    const r1 = await handleRequest({ request: mk("Mozilla/5.0"), config, manifestCache: null, fetchImpl, next });
    const r2 = await handleRequest({ request: mk("GPTBot/1.0"), config, manifestCache: null, fetchImpl, next });
    expect(await r1.text()).toBe(await r2.text());
    expect(headerList(r1.headers)).toEqual(headerList(r2.headers));
    expect(seen).toEqual(["", ""]);
  });
});

function headerList(h: Headers): [string, string][] {
  const out: [string, string][] = [];
  h.forEach((v, k) => out.push([k, v]));
  return out;
}

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/markdown; charset=utf-8",
    ETag: '"sha256:0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c"',
    Vary: "Accept",
    "Content-Digest": "sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:",
    "Signature-Input": 'sig1=("@status" "content-type" "content-digest" "trooth-semanto-version" "trooth-page-hash");created=1760000000;keyid="fixture-kid";alg="ed25519"',
    Signature: "sig1=:AAAA:",
    "Trooth-Contract": "1",
    "Trooth-Semanto-Version": "7",
    "Trooth-Page-Hash": "sha256:0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    "Trooth-Signed-Page-Hash": "sha256:1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
    "Trooth-Signed-By": "witness",
    "Trooth-Semanto-State": "behind",
    Link: '<https://api.trooth.co/public/semanto/acme-inc>; rel="https://trooth.co/rel/semanto"',
    "Content-Signal": "ai-train=no, search=yes, ai-input=yes",
    "x-markdown-tokens": "12",
    "x-original-tokens": "340",
    "Cache-Control": "public, max-age=60",
    Server: "fixture",
    "Set-Cookie": "never=forwarded",
    "CF-Ray": "fixture",
  };
}

describe("adapters/shared copyHeaders", () => {
  it("copies exactly the listed headers and drops everything else", () => {
    const res = new Response("x", { headers: apiHeaders() });
    const out = copyHeaders(res);
    for (const name of TROOTH_HEADERS) expect(out.get(name)).toBe(res.headers.get(name));
    expect(out.has("Server")).toBe(false);
    expect(out.has("Set-Cookie")).toBe(false);
    expect(out.has("CF-Ray")).toBe(false);
    // Cache-Control is forwarded so no cache downstream keeps a copy past its signature.
    expect(out.get("Cache-Control")).toBe("public, max-age=60");
    expect(headerList(out)).toHaveLength(TROOTH_HEADERS.length);
    expect(TROOTH_HEADERS).toEqual(expect.arrayContaining(["Trooth-Signed-By", "Trooth-Semanto-State", "Trooth-Signed-Page-Hash"]));
  });
  it("lists the headers from the house rules and no X-Semanto header", () => {
    expect(TROOTH_HEADERS).toEqual(expect.arrayContaining(["Content-Type", "ETag", "Vary", "Content-Digest", "Signature-Input", "Signature", "Trooth-Semanto-Version", "Trooth-Page-Hash", "Link", "Content-Signal", "x-markdown-tokens", "x-original-tokens"]));
    expect(TROOTH_HEADERS.some((h) => /^x-semanto/i.test(h))).toBe(false);
  });
});

describe("adapters/shared manifest cache", () => {
  function fakeApi() {
    const calls: { ifNoneMatch: string | null }[] = [];
    let etag = '"v7"';
    let body = JSON.stringify(manifestFixture);
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const inm = h.get("If-None-Match");
      calls.push({ ifNoneMatch: inm });
      if (inm === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(body, { status: 200, headers: { ETag: etag, "Content-Type": "application/json" } });
    }) as typeof fetch;
    return {
      calls,
      fetchImpl,
      bump() {
        etag = '"v8"';
        body = JSON.stringify({ ...manifestFixture, header: { ...manifestFixture.header, version: 8 } });
      },
    };
  }
  it("fetches once, then revalidates with If-None-Match after the ttl", async () => {
    const api = fakeApi();
    let t = 1_000_000;
    const cache = createManifestCache({ config, fetchImpl: api.fetchImpl, store: memoryStore(), ttlSeconds: 60, now: () => t });
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
    expect(api.calls).toHaveLength(1);
    t += 61_000;
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
    await cache.settle();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.ifNoneMatch).toBe('"v7"');
    api.bump();
    t += 61_000;
    // The stored copy answers at once; the new version arrives in the background.
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
    await cache.settle();
    expect(await cache.get()).toMatchObject({ header: { version: 8 } });
    expect(api.calls).toHaveLength(3);
  });
  it("keeps the old copy when the API is unreachable", async () => {
    let fail = false;
    const fetchImpl = (async () => {
      if (fail) throw new Error("down");
      return new Response(JSON.stringify(manifestFixture), { status: 200, headers: { ETag: '"v7"' } });
    }) as typeof fetch;
    let t = 0;
    const cache = createManifestCache({ config, fetchImpl, ttlSeconds: 1, now: () => t });
    await cache.get();
    fail = true;
    t = 5_000;
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
  });
  it("gives up on a slow first fetch after its deadline and answers by path", async () => {
    const slow = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const cache = createManifestCache({ config, fetchImpl: slow, timeoutMs: 20 });
    const started = Date.now();
    expect(await cache.get()).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("answers from the stored copy without waiting when it is past its ttl", async () => {
    let calls = 0;
    let hang = false;
    const fetchImpl = (async () => {
      calls++;
      if (hang) return new Promise<Response>(() => {});
      return new Response(JSON.stringify(manifestFixture), { status: 200, headers: { ETag: '"v7"' } });
    }) as typeof fetch;
    let t = 0;
    const cache = createManifestCache({ config, fetchImpl, ttlSeconds: 1, now: () => t, timeoutMs: 20 });
    await cache.get();
    hang = true;
    t = 5_000;
    expect(await cache.get()).toMatchObject({ header: { version: 7 } });
    expect(calls).toBe(2);
  });
  it("dedupes concurrent first fetches", async () => {
    const api = fakeApi();
    const cache = createManifestCache({ config, fetchImpl: api.fetchImpl });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(api.calls).toHaveLength(1);
  });
});

describe("adapters/shared handleRequest", () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (url === ROOT) return new Response(JSON.stringify(manifestFixture), { status: 200, headers: { ETag: '"v7"', "Content-Type": "application/json" } });
    if (url.endsWith("/pages/smp_a2b3c4d5e6f7g2h3j4k5m6n7p2.md")) {
      if (h.get("If-None-Match") === apiHeaders().ETag) return new Response(null, { status: 304, headers: apiHeaders() });
      return new Response("# Pricing\n\nPlans start here.\n", { status: 200, headers: apiHeaders() });
    }
    if (url.endsWith("/facts.jsonld") || url.endsWith("/by-path/anything")) return new Response('{"@context":"https://schema.org"}', { status: 200, headers: { ...apiHeaders(), "Content-Type": "application/ld+json" } });
    if (url.endsWith("/by-path/missing.md")) return new Response("# Not found\n", { status: 404, headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" } });
    return new Response("no", { status: 500 });
  }) as typeof fetch;
  const next = async (req: Request) => new Response(`<html>${new URL(req.url).pathname}</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });

  it("answers the kid of its connector key, and only the kid, at /.well-known/trooth-semanto-connector (the dashboard's connection test)", async () => {
    const key = await generateConnectorKey();
    const withKey = { ...config, connectorKey: JSON.stringify(key.privateJwk) };
    const res = await handleRequest({ request: new Request("https://acme.com/.well-known/trooth-semanto-connector"), config: withKey, manifestCache: null, fetchImpl, next });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ kid: key.publicJwk.kid, trooth_id: config.troothId ?? null });
    expect(text).not.toContain(key.privateJwk.d);
    // Without a key the path is the host's.
    const none = await handleRequest({ request: new Request("https://acme.com/.well-known/trooth-semanto-connector"), config, manifestCache: null, fetchImpl, next });
    expect(await none.text()).toBe("<html>/.well-known/trooth-semanto-connector</html>");
  });

  it("returns the API's bytes and the listed headers for a markdown request", async () => {
    const cache = createManifestCache({ config, fetchImpl });
    const res = await handleRequest({ request: new Request("https://acme.com/pricing", { headers: { Accept: "text/markdown" } }), config, manifestCache: cache, fetchImpl, next });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Pricing\n\nPlans start here.\n");
    for (const name of TROOTH_HEADERS) expect(res.headers.get(name)).toBe(apiHeaders()[name]);
    expect(res.headers.has("Set-Cookie")).toBe(false);
  });
  it("passes If-None-Match through and returns the 304", async () => {
    const cache = createManifestCache({ config, fetchImpl });
    const res = await handleRequest({ request: new Request("https://acme.com/pricing.md", { headers: { "If-None-Match": apiHeaders().ETag! } }), config, manifestCache: cache, fetchImpl, next });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(apiHeaders().ETag);
  });
  it("hands html requests to the host and adds the proof headers", async () => {
    const cache = createManifestCache({ config, fetchImpl });
    const res = await handleRequest({ request: new Request("https://acme.com/pricing", { headers: { Accept: "text/html" } }), config, manifestCache: cache, fetchImpl, next });
    expect(await res.text()).toBe("<html>/pricing</html>");
    expect(res.headers.get("Trooth-Semanto-Version")).toBe("7");
    expect(res.headers.get("Link")).toContain('</pricing.md>; rel="alternate"; type="text/markdown"');
  });
  it("passes the API's 404 through unchanged for an unlisted page in semanto_only", async () => {
    const cache = createManifestCache({ config, fetchImpl });
    const res = await handleRequest({ request: new Request("https://acme.com/missing.md"), config, manifestCache: cache, fetchImpl, next });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  });
  it("in semanto_then_cloudflare_for_unsigned an unlisted page goes to the host", async () => {
    const c = { ...config, mode: "semanto_then_cloudflare_for_unsigned" as const };
    const cache = createManifestCache({ config: c, fetchImpl });
    const res = await handleRequest({ request: new Request("https://acme.com/missing", { headers: { Accept: "text/markdown" } }), config: c, manifestCache: cache, fetchImpl, next });
    expect(await res.text()).toBe("<html>/missing</html>");
  });
  it("serves the page's JSON-LD by path for application/ld+json", async () => {
    const res = await handleRequest({ request: new Request("https://acme.com/anything", { headers: { Accept: "application/ld+json" } }), config, manifestCache: null, fetchImpl, next });
    expect(res.headers.get("Content-Type")).toBe("application/ld+json");
    expect(await res.text()).toBe('{"@context":"https://schema.org"}');
  });
  it("finds pages by path with or without a trailing slash", () => {
    expect(findPage(manifestFixture, "/pricing/")?.id).toBe("smp_a2b3c4d5e6f7g2h3j4k5m6n7p2");
    expect(findPage(manifestFixture, "/")?.id).toBe("smp_b3c4d5e6f7g2h3j4k5m6n7p2q3");
    expect(findPage(manifestFixture, "/nope")).toBeNull();
  });
});

describe("adapters/shared fail-safe", () => {
  const signedHeaders = (expires: number) => ({ ...apiHeaders(), "Signature-Input": `sig1=("@status" "content-digest");created=${expires - 3900};expires=${expires};keyid="fixture-kid";alg="ed25519"` });
  const next = async (req: Request) => new Response(`<html>${new URL(req.url).pathname}</html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const md = () => new Request("https://acme.com/pricing.md");
  function api(expires: number) {
    let mode: "ok" | "down" | "500" | "hang" = "ok";
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls++;
      if (!String(input).startsWith(ROOT)) return new Response("no", { status: 404 });
      if (mode === "down") throw new Error("unreachable");
      if (mode === "500") return new Response("boom", { status: 503 });
      if (mode === "hang") return new Promise<Response>(() => {});
      return new Response("# Pricing\n", { status: 200, headers: signedHeaders(expires) });
    }) as typeof fetch;
    return { fetchImpl, set: (m: typeof mode) => (mode = m), calls: () => calls };
  }
  const nowS = Math.floor(Date.now() / 1000);

  it("marks a live answer trooth", async () => {
    const a = api(nowS + 3600);
    const res = await handleRequest({ request: md(), config, manifestCache: null, fetchImpl: a.fetchImpl, next, staleStore: createStaleStore(), breaker: createBreaker() });
    expect(res.headers.get(DELIVERY_HEADER)).toBe("trooth");
    expect(await res.text()).toBe("# Pricing\n");
  });
  for (const failure of ["down", "500", "hang"] as const) {
    it(`serves the last good copy, still signed, when the API is ${failure}`, async () => {
      const a = api(nowS + 3600);
      const staleStore = createStaleStore();
      const opts = { config, manifestCache: null, fetchImpl: a.fetchImpl, next, staleStore, breaker: createBreaker(), timeoutMs: 30 };
      await (await handleRequest({ ...opts, request: md() })).text();
      a.set(failure);
      const res = await handleRequest({ ...opts, request: md() });
      expect(res.status).toBe(200);
      expect(res.headers.get(DELIVERY_HEADER)).toBe("stale");
      expect(res.headers.get("Signature")).toBe(apiHeaders().Signature);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe("# Pricing\n");
    });
  }
  it("strips the signature from a stored copy whose signature has expired", async () => {
    const a = api(nowS - 10);
    const staleStore = createStaleStore();
    const opts = { config, manifestCache: null, fetchImpl: a.fetchImpl, next, staleStore, breaker: createBreaker() };
    await (await handleRequest({ ...opts, request: md() })).text();
    a.set("down");
    const res = await handleRequest({ ...opts, request: md() });
    expect(res.headers.get(DELIVERY_HEADER)).toBe("stale-unsigned");
    for (const h of SIGNATURE_HEADERS) expect(res.headers.has(h)).toBe(false);
    expect(res.headers.get("Content-Digest")).toBe(apiHeaders()["Content-Digest"]);
  });
  it("answers with the host's own page, never a 5xx, when there is no stored copy", async () => {
    const a = api(nowS + 3600);
    a.set("500");
    const res = await handleRequest({ request: new Request("https://acme.com/pricing", { headers: { Accept: "text/markdown" } }), config, manifestCache: null, fetchImpl: a.fetchImpl, next, staleStore: createStaleStore(), breaker: createBreaker() });
    expect(res.status).toBe(200);
    expect(res.headers.get(DELIVERY_HEADER)).toBe("host");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(await res.text()).toBe("<html>/pricing</html>");
  });
  it("passes the API's 4xx through; only 5xx and failures fall back", async () => {
    const fetchImpl = (async () => new Response("# Not found\n", { status: 404, headers: { "Content-Type": "text/markdown; charset=utf-8" } })) as typeof fetch;
    const res = await handleRequest({ request: md(), config, manifestCache: null, fetchImpl, next, staleStore: createStaleStore(), breaker: createBreaker() });
    expect(res.status).toBe(404);
    expect(res.headers.get(DELIVERY_HEADER)).toBe("trooth");
  });
  it("stops asking the API after 3 failures in 30 seconds, then lets one request through", async () => {
    let t = 0;
    const breaker = createBreaker({ now: () => t });
    const a = api(nowS + 3600);
    a.set("down");
    const opts = { config, manifestCache: null, fetchImpl: a.fetchImpl, next, staleStore: createStaleStore(), breaker };
    for (let i = 0; i < 3; i++) await handleRequest({ ...opts, request: md() });
    expect(a.calls()).toBe(3);
    expect(breaker.isOpen()).toBe(true);
    await handleRequest({ ...opts, request: md() });
    expect(a.calls()).toBe(3);
    t = 31_000;
    a.set("ok");
    const res = await handleRequest({ ...opts, request: md() });
    expect(a.calls()).toBe(4);
    expect(res.headers.get(DELIVERY_HEADER)).toBe("trooth");
    expect(breaker.isOpen()).toBe(false);
  });
  it("a failed probe opens the breaker again for a full window", () => {
    let t = 0;
    const b = createBreaker({ now: () => t });
    b.failure();
    b.failure();
    b.failure();
    t = 31_000;
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    b.failure();
    t = 40_000;
    expect(b.allow()).toBe(false);
    t = 62_000;
    expect(b.allow()).toBe(true);
  });
  it("reads a signature's expiry from expires=, else created plus 3900 seconds", () => {
    expect(signatureExpiry(new Headers({ "Signature-Input": 'sig1=();created=100;expires=200', Signature: "sig1=:A:" }))).toBe(200);
    expect(signatureExpiry(new Headers({ "Signature-Input": "sig1=();created=100", Signature: "sig1=:A:" }))).toBe(4000);
    expect(signatureExpiry(new Headers({ "Signature-Input": "sig1=();created=100" }))).toBe(0);
    expect(signatureExpiry(new Headers())).toBe(0);
  });
  it("keeps a markdown copy apart from a JSON-LD copy of the same url, and bounds its size", () => {
    const store = createStaleStore({ maxEntries: 2, maxBytes: 4 });
    store.put("a", { body: new ArrayBuffer(4), headers: [], storedAt: 0 });
    store.put("b", { body: new ArrayBuffer(5), headers: [], storedAt: 0 });
    store.put("c", { body: new ArrayBuffer(1), headers: [], storedAt: 0 });
    store.put("d", { body: new ArrayBuffer(1), headers: [], storedAt: 0 });
    expect(store.get("a")).toBeNull();
    expect(store.get("b")).toBeNull();
    expect(store.size()).toBe(2);
  });
});

describe("adapters/shared sign-request", () => {
  it("signs a POST the API verifies with src/core/httpsig", async () => {
    const { publicJwk, privateJwk } = await generateConnectorKey();
    expect(publicJwk.kid).toBe(await thumbprint(publicJwk));
    const url = "https://api.trooth.co/os/semanto/acme-inc/commerce/catalog";
    const body = JSON.stringify({ source: "fixture", products: [] });
    const headers = await signPost({ url, body, privateJwk, created: 1_760_000_000 });
    expect(headers["Signature-Input"]).toContain(`tag="${CONNECTOR_TAG}"`);
    expect(await verifyContentDigest(headers["Content-Digest"], body)).toBe(true);
    const result = await verifyMessage(
      { kind: "request", method: "POST", url, headers },
      { resolveKey: (kid) => (kid === publicJwk.kid ? publicJwk : null), required: ["@method", "@target-uri", "content-digest", "content-type"], tag: CONNECTOR_TAG, now: 1_760_000_010 },
    );
    expect(result.ok).toBe(true);
  });
  it("a changed body fails the digest and a changed url fails the signature", async () => {
    const { publicJwk, privateJwk } = await generateConnectorKey();
    const url = "https://api.trooth.co/os/semanto/acme-inc/commerce/catalog";
    const headers = await signPost({ url, body: "{}", privateJwk, created: 1_760_000_000 });
    expect(await verifyContentDigest(headers["Content-Digest"], "{} ")).toBe(false);
    const r = await verifyMessage({ kind: "request", method: "POST", url: url + "?x=1", headers }, { resolveKey: () => publicJwk, now: 1_760_000_010 });
    expect(r.ok).toBe(false);
  });
  it("postSigned sends the signed headers and the body", async () => {
    const { privateJwk } = await generateConnectorKey();
    let seen: { headers: Headers; body: string } | null = null;
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: String(init?.body) };
      return new Response("", { status: 202 });
    }) as typeof fetch;
    const res = await postSigned({ url: "https://api.trooth.co/os/semanto/acme-inc/commerce/catalog", document: { a: 1 }, privateJwk, fetchImpl });
    expect(res.status).toBe(202);
    expect(seen!.body).toBe('{"a":1}');
    expect(seen!.headers.get("Signature")).toMatch(/^sig1=:/);
  });
});

describe("adapters: fail-safe settings in every host's files", () => {
  const read = (p: string) => readFileSync(new URL(`../adapters/${p}`, import.meta.url), "utf8");
  it("the Vercel build step never writes a response signature into vercel.json", () => {
    const sync = read("vercel/scripts/semanto-sync.mjs");
    const list = /const LASTING_HEADERS = \[([^\]]*)\]/.exec(sync)?.[1] ?? "";
    expect(list).not.toMatch(/"Signature/);
    expect(list).toContain('"Content-Digest"');
    expect(read("vercel/vercel.json")).not.toMatch(/Signature/);
  });
  it("the Vercel route answers no 5xx of its own and falls back through the middleware bypass", () => {
    const route = read("vercel/app/semanto/[[...path]]/route.ts");
    expect(route).not.toMatch(/status: 5\d\d/);
    expect(route).toContain("serveWithFallback");
    expect(read("vercel/middleware.ts")).toContain("BYPASS_HEADER");
  });
  it("nginx has deadlines, stale copies and the host's own page on a Trooth 5xx", () => {
    const proxy = read("nginx/semanto-proxy.conf");
    for (const line of ["proxy_connect_timeout 1s;", "proxy_read_timeout 2s;", "proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;", "error_page 500 502 503 504 = @semanto_host;", "proxy_pass_header Cache-Control;"]) expect(proxy).toContain(line);
    expect(read("nginx/semanto-maps.conf")).toMatch(/proxy_cache_path [^;]*keys_zone=semanto:[^;]*inactive=1h/);
    expect(read("nginx/semanto-server.conf")).toContain("location @semanto_host {");
  });
  it("Apache has deadlines and the host's own page on a Trooth 5xx", () => {
    const conf = read("apache/semanto.conf");
    expect(conf).toContain("ProxySet connectiontimeout=1 timeout=2");
    expect(conf).toContain("ProxyErrorOverride On 500 502 503 504");
    expect(conf).toContain("RewriteCond %{ENV:REDIRECT_STATUS} !^$");
  });
  it("WordPress waits at most 1.5 seconds and never answers a 5xx of its own", () => {
    const client = read("wordpress-plugin/trooth-semanto/includes/class-trooth-semanto-client.php");
    expect(client).toContain("const TIMEOUT = 1.5;");
    expect(client).toContain("'timeout'     => self::TIMEOUT,");
    const serve = read("wordpress-plugin/trooth-semanto/includes/class-trooth-semanto-serve.php");
    expect(serve).not.toMatch(/problem\(\s*5\d\d/);
    expect(serve).not.toMatch(/status_header\(\s*5\d\d/);
  });
  it("Akamai gives the manifest call a deadline", () => {
    expect(read("akamai-edgeworkers/main.js")).toContain("timeout: MANIFEST_TIMEOUT_MS");
  });
});
