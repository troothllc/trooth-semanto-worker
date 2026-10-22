// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The one decision every host adapter makes, in plain JavaScript with no
// dependencies, so a Cloudflare Worker, a Vercel middleware, a Netlify edge
// function, a Fastly Compute service, an Akamai EdgeWorker and a Gcore FastEdge
// app all answer the same way:
//
//   decide(path, accept, manifest, config)  -> { serve: true, url } or { serve: false }
//   copyHeaders(response)                   -> only the headers the API sent that
//                                              the adapter forwards, byte for byte
//   createManifestCache(options)            -> the manifest, fetched once and kept
//                                              with its ETag (If-None-Match on refresh)
//   handleRequest(options)                  -> the whole adapter in one call for
//                                              hosts with a Fetch API
//
// A reader that signed its request (Web Bot Auth) reaches the API with its
// Signature fields unchanged, and, when the adapter holds a connector key
// (TROOTH_CONNECTOR_KEY), with Trooth-Forwarded-Authority and
// Trooth-Forwarded-For signed by that key, so the API can prove the reader
// against the host it addressed (src/readers/forwarded.ts). Every response the
// adapter touches, HTML included, carries Vary: Accept merged with any Vary
// already there.
//
// Negotiation follows RFC 9110 section 12.5.1 with the outcomes Cloudflare's
// Markdown for Agents documents (changelog, 26 February 2026): the same table as
// src/core/negotiate.ts, reimplemented here because adapters never import
// internal modules. Nothing in this file reads User-Agent. Serving by user
// agent is cloaking under Google's spam policies (clarified for AI Overviews
// and AI Mode on 15 May 2026); serving by Accept or path suffix is not.

import { signForwarding } from "./sign-request.mjs";

export const DEFAULT_API_BASE = "https://api.trooth.co";

export const MODES = ["semanto_only", "semanto_then_cloudflare_for_unsigned", "proof_only"];

/** The response headers an adapter forwards from the API, and nothing else. */
export const TROOTH_HEADERS = [
  "Content-Type",
  "ETag",
  "Vary",
  "Content-Digest",
  "Signature-Input",
  "Signature",
  "Trooth-Contract",
  "Trooth-Semanto-Version",
  "Trooth-Page-Hash",
  "Trooth-Signed-Page-Hash",
  "Trooth-Signed-By",
  "Trooth-Semanto-State",
  "Link",
  "Content-Signal",
  "x-markdown-tokens",
  "x-original-tokens",
];

/** The request headers an adapter passes to the API. Never User-Agent. */
export const FORWARDED_REQUEST_HEADERS = ["Accept", "Accept-Language", "If-None-Match", "Signature-Input", "Signature", "Signature-Agent"];

export const REL_SEMANTO = "https://trooth.co/rel/semanto";

/**
 * Where each file lives on the public API, relative to
 * `{apiBase}/public/semanto/{trooth_id}`. One table, so a renamed route is a
 * one-line change here and in the nginx, Apache and PHP copies of it.
 */
export const API_PATHS = {
  manifest: "",
  keys: "/keys.json",
  facts: "/facts.jsonld",
  llms: "/llms.txt",
  llmsFull: "/llms-full.txt",
  sitemap: "/sitemap.md",
  page: "/pages/",
  byPath: "/by-path",
};

/** Files served on the customer's domain from the Trooth-hosted copy. */
export const WELL_KNOWN_FILES = {
  "/.well-known/trooth.semanto": { api: API_PATHS.manifest, group: "well_known" },
  "/.well-known/trooth-keys.json": { api: API_PATHS.keys, group: "well_known" },
  "/llms.txt": { api: API_PATHS.llms, group: "llms" },
  "/llms-full.txt": { api: API_PATHS.llmsFull, group: "llms" },
  "/sitemap.md": { api: API_PATHS.sitemap, group: "llms" },
};

// ---------------------------------------------------------------- Accept

const MEDIA = { html: "text/html", markdown: "text/markdown", jsonld: "application/ld+json" };

export function parseAccept(accept) {
  if (!accept || !String(accept).trim()) return [];
  const out = [];
  String(accept)
    .split(",")
    .forEach((part, order) => {
      const [mt, ...params] = part.trim().split(";");
      if (!mt) return;
      const slash = mt.indexOf("/");
      if (slash < 0) return;
      const type = mt.slice(0, slash).trim().toLowerCase();
      const subtype = mt.slice(slash + 1).trim().toLowerCase();
      let q = 1;
      for (const p of params) {
        const [k, v] = p.split("=").map((s) => s.trim());
        if (k && k.toLowerCase() === "q" && v !== undefined) {
          const n = Number(v);
          q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
        }
      }
      const specificity = type === "*" ? 0 : subtype === "*" ? 1 : 2;
      out.push({ type, subtype, q, order, specificity });
    });
  return out;
}

function matches(r, media) {
  const [t, s] = media.split("/");
  return (r.type === "*" || r.type === t) && (r.subtype === "*" || r.subtype === s);
}

/**
 * Same algorithm as src/core/negotiate.ts: client q wins, specificity breaks
 * ties, then server order. A wildcard-only request gets html. The adapter
 * offers markdown first, so "text/*" gets markdown, the outcome Cloudflare
 * documents; a browser's "*\/*" still gets html through the fallback.
 */
export const OFFERED = ["markdown", "html", "jsonld"];

export function negotiate(accept, offered = OFFERED, fallback = "html") {
  const ranges = parseAccept(accept);
  if (ranges.length === 0) return fallback;
  let best = null;
  offered.forEach((rep, idx) => {
    const media = MEDIA[rep];
    let chosen = null;
    for (const r of ranges) {
      if (!matches(r, media)) continue;
      if (!chosen || r.specificity > chosen.specificity) chosen = r;
    }
    if (!chosen || chosen.q === 0) return;
    if (chosen.specificity === 0 && rep !== fallback) return;
    const cand = { rep, q: chosen.q, spec: chosen.specificity, order: chosen.order, idx };
    if (!best || cand.q > best.q || (cand.q === best.q && (cand.spec > best.spec || (cand.spec === best.spec && cand.idx < best.idx)))) best = cand;
  });
  return best ? best.rep : fallback;
}

/** A path that asks for a format by suffix, for agents that send no Accept header. */
export function representationFromPath(pathname) {
  if (pathname.endsWith("/index.md")) return { rep: "markdown", basePath: pathname.slice(0, -"index.md".length) };
  if (pathname.endsWith(".md")) return { rep: "markdown", basePath: pathname.slice(0, -3) || "/" };
  if (pathname.endsWith("/facts.jsonld")) return { rep: "jsonld", basePath: pathname.slice(0, -"facts.jsonld".length) };
  if (pathname.endsWith(".jsonld")) return { rep: "jsonld", basePath: pathname.slice(0, -7) || "/" };
  return { rep: null, basePath: pathname };
}

// ---------------------------------------------------------------- manifest

/** "/pricing/" and "/pricing" are the same page; "/" stays "/". */
export function normalizePath(pathname) {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Accepts the whole Semanto file (header.pages_manifest), a header, an object
 * with `pages`, or a plain array of { url, id }.
 */
export function pagesOf(manifest) {
  if (!manifest) return [];
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest.pages_manifest)) return manifest.pages_manifest;
  if (manifest.header && Array.isArray(manifest.header.pages_manifest)) return manifest.header.pages_manifest;
  if (Array.isArray(manifest.pages)) return manifest.pages;
  return [];
}

export function manifestVersion(manifest) {
  if (!manifest) return null;
  if (manifest.header && manifest.header.version !== undefined) return String(manifest.header.version);
  if (manifest.version !== undefined) return String(manifest.version);
  return null;
}

/** The path of an absolute url without the URL class, which some edge runtimes lack. */
function pathOfUrl(u) {
  const s = String(u);
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(s);
  if (m) return normalizePath(m[1] || "/");
  return normalizePath(s.split(/[?#]/)[0]);
}

/** The manifest entry whose url has this path on the customer's domain, or null. */
export function findPage(manifest, pathname) {
  const want = normalizePath(pathname);
  for (const p of pagesOf(manifest)) {
    if (p && p.url && pathOfUrl(p.url) === want) return p;
  }
  return null;
}

// ---------------------------------------------------------------- the decision

export function apiRoot(config) {
  const base = String((config && config.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, "");
  if (!config || !config.troothId) throw new Error("TROOTH_ID is not set");
  return `${base}/public/semanto/${encodeURIComponent(config.troothId)}`;
}

export function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : "semanto_only";
}

/**
 * The decision. Inputs are the request path, the Accept header and the cached
 * manifest. The output is where to fetch from, or `serve: false` with a reason
 * so the host answers.
 *
 *   reason "method"      not GET or HEAD
 *   reason "html"        a browser or a reader that asked for html
 *   reason "mode"        proof_only serves only the two well-known files
 *   reason "not_listed"  semanto_then_cloudflare_for_unsigned and the page is
 *                        not in the manifest, so Cloudflare converts it
 */
export function decide(path, accept, manifest, config = {}) {
  const mode = normalizeMode(config.mode);
  const method = (config.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return { serve: false, reason: "method" };
  const pathname = normalizeQueryless(path);
  const root = apiRoot(config);

  const wk = WELL_KNOWN_FILES[pathname];
  if (wk) {
    if (mode === "proof_only" && wk.group !== "well_known") return { serve: false, reason: "mode" };
    return { serve: true, url: root + wk.api, kind: wk.group, representation: null };
  }
  if (mode === "proof_only") return { serve: false, reason: "mode" };

  const bySuffix = representationFromPath(pathname);
  const rep = bySuffix.rep || negotiate(accept);
  if (rep === "html") return { serve: false, reason: "html" };

  const page = findPage(manifest, bySuffix.basePath);
  if (rep === "jsonld") {
    // The site root's /facts.jsonld is the company's facts. Any other JSON-LD request is the page's JSON-LD, fetched by
    // path with the same path and Accept, so the bytes are the API's answer for that path.
    if (normalizePath(pathname) === "/facts.jsonld") return { serve: true, url: root + API_PATHS.facts, kind: "facts", representation: "jsonld" };
    if (!page && mode === "semanto_then_cloudflare_for_unsigned") return { serve: false, reason: "not_listed" };
    return { serve: true, url: root + API_PATHS.byPath + pathname, kind: "page_jsonld", representation: "jsonld" };
  }

  // The ".md" suffix fixes the representation at the API whatever Accept the reader sent (a ".md" path with an
  // Accept of application/ld+json is markdown here, so it must be markdown there too).
  if (page && page.id) return { serve: true, url: root + API_PATHS.page + encodeURIComponent(page.id) + ".md", kind: "page", representation: "markdown", page };
  if (mode === "semanto_then_cloudflare_for_unsigned") return { serve: false, reason: "not_listed" };
  return { serve: true, url: root + API_PATHS.byPath + pathname, kind: "page_lookup", representation: "markdown" };
}

function normalizeQueryless(path) {
  let p = String(path || "/");
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);
  if (/^https?:\/\//i.test(p)) p = pathOfUrl(p);
  return p || "/";
}

// ---------------------------------------------------------------- headers

/** Only the listed headers, in the API's spelling and value, from a Response or a Headers. */
export function copyHeaders(responseOrHeaders) {
  const src = responseOrHeaders && responseOrHeaders.headers ? responseOrHeaders.headers : responseOrHeaders;
  const out = new Headers();
  for (const name of TROOTH_HEADERS) {
    const v = typeof src.get === "function" ? src.get(name) : src[name] || src[name.toLowerCase()];
    if (v !== null && v !== undefined && v !== "") out.set(name, v);
  }
  return out;
}

/** The request headers to pass to the API from the reader's request. */
export function forwardRequestHeaders(requestHeaders) {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = requestHeaders.get(name);
    if (v) out.set(name, v);
  }
  return out;
}

/**
 * The headers added to the host's own HTML so an agent can find the signed
 * copy: the version it was built from and Link relations to the hosted file
 * and, when the page is listed, to its markdown on this domain.
 */
export function proofHeaders(manifest, pathname, config) {
  const out = {};
  const version = manifestVersion(manifest);
  if (version) out["Trooth-Semanto-Version"] = version;
  const links = [`<${apiRoot(config)}>; rel="${REL_SEMANTO}"`];
  const page = findPage(manifest, normalizeQueryless(pathname));
  if (page) {
    const base = normalizePath(normalizeQueryless(pathname));
    const md = base === "/" ? "/index.md" : `${base}.md`;
    links.push(`<${md}>; rel="alternate"; type="text/markdown"`);
  }
  out["Link"] = links.join(", ");
  return out;
}

/** A Vary value with Accept added once to whatever was there ("*" already covers it). */
export function mergeVary(existing) {
  const parts = String(existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((p) => p === "*" || p.toLowerCase() === "accept")) return parts.join(", ");
  return [...parts, "Accept"].join(", ");
}

/**
 * The host's own response, with Vary: Accept merged in (the answer at this
 * url depends on Accept, so a cache must key on it) and, on HTML, the proof
 * headers. The body is never touched.
 */
export function withProofHeaders(response, manifest, pathname, config) {
  const headers = new Headers(response.headers);
  headers.set("Vary", mergeVary(headers.get("Vary")));
  const ct = response.headers.get("Content-Type") || "";
  if (/^text\/html/i.test(ct)) {
    const add = proofHeaders(manifest, pathname, config);
    for (const [k, v] of Object.entries(add)) {
      if (k === "Link" && headers.has("Link")) headers.set("Link", `${headers.get("Link")}, ${v}`);
      else headers.set(k, v);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ---------------------------------------------------------------- manifest cache

/**
 * Fetch the manifest once and keep it with its ETag. On refresh, send
 * If-None-Match; a 304 keeps the cached copy. `store` is any object with
 * async get(key) and put(key, value); the default is memory. The Cloudflare
 * Worker wraps the Cache API, Netlify and Vercel use memory plus the host's
 * fetch cache, Fastly and Akamai use memory per instance.
 */
export function createManifestCache({ config, fetchImpl = globalThis.fetch, store = memoryStore(), ttlSeconds = 300, now = () => Date.now() } = {}) {
  const key = `${apiRoot(config)}${API_PATHS.manifest}#manifest`;
  let inflight = null;

  async function refresh(cached) {
    const headers = new Headers({ Accept: "application/json" });
    if (cached && cached.etag) headers.set("If-None-Match", cached.etag);
    let res;
    try {
      res = await fetchImpl(apiRoot(config) + API_PATHS.manifest, { headers });
    } catch {
      return cached ? cached.manifest : null;
    }
    if (res.status === 304 && cached) {
      await store.put(key, { ...cached, fetchedAt: now() });
      return cached.manifest;
    }
    if (!res.ok) return cached ? cached.manifest : null;
    let manifest;
    try {
      manifest = await res.json();
    } catch {
      return cached ? cached.manifest : null;
    }
    await store.put(key, { etag: res.headers.get("ETag") || null, manifest, fetchedAt: now() });
    return manifest;
  }

  return {
    async get() {
      const cached = await store.get(key);
      if (cached && now() - cached.fetchedAt < ttlSeconds * 1000) return cached.manifest;
      if (!inflight) inflight = refresh(cached).finally(() => (inflight = null));
      return inflight;
    },
    async peek() {
      const cached = await store.get(key);
      return cached ? cached.manifest : null;
    },
  };
}

export function memoryStore() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
  };
}

// ---------------------------------------------------------------- serving

/** The client address the host saw, from the headers each platform sets. The host may pass it as config.clientAddress. */
export function clientAddress(request, config = {}) {
  if (config.clientAddress) return String(config.clientAddress);
  for (const name of ["CF-Connecting-IP", "Fastly-Client-IP", "True-Client-IP", "X-Real-IP"]) {
    const v = request.headers.get(name);
    if (v) return v.trim();
  }
  const xff = request.headers.get("X-Forwarded-For");
  return xff ? xff.split(",")[0].trim() : "";
}

/** The connector key from config: a private JWK object, or its JSON (TROOTH_CONNECTOR_KEY). Null when absent or unreadable. */
export function connectorKeyOf(config = {}) {
  const k = config.connectorKey;
  if (!k) return null;
  if (typeof k === "object") return k.d && k.x && k.kid ? k : null;
  try {
    const j = JSON.parse(String(k));
    return j && j.d && j.x && j.kid ? j : null;
  } catch {
    return null;
  }
}

/**
 * The headers for the request to the API. A reader's Signature fields pass
 * unchanged. When the reader signed its request and the adapter holds a
 * connector key, the host it addressed and its address are added and signed
 * with that key, so the API can prove the reader; without a key nothing is
 * added (an unsigned forwarded header would be ignored anyway).
 */
export async function forwardingHeaders(decision, request, config = {}, now = config.now || (() => Math.floor(Date.now() / 1000))) {
  const headers = forwardRequestHeaders(request.headers);
  const key = connectorKeyOf(config);
  const signedReader = headers.get("Signature-Input") && headers.get("Signature") && headers.get("Signature-Agent");
  if (key && signedReader) {
    headers.set("Trooth-Forwarded-Authority", new URL(request.url).host.toLowerCase());
    headers.set("Trooth-Forwarded-For", clientAddress(request, config));
    const sig = await signForwarding({ method: "GET", url: decision.url, headers, privateJwk: key, created: now() });
    for (const [k, v] of Object.entries(sig)) headers.set(k, v);
  }
  return headers;
}

/** Fetch the decided URL from the API and return its bytes and the listed headers, unchanged, with Vary: Accept merged in. */
export async function fetchSigned(decision, request, fetchImpl = globalThis.fetch, extraInit = {}, config = {}) {
  const headers = await forwardingHeaders(decision, request, config);
  const res = await fetchImpl(decision.url, { method: request.method === "HEAD" ? "HEAD" : "GET", headers, redirect: "follow", ...extraInit });
  const out = copyHeaders(res);
  out.set("Vary", mergeVary(out.get("Vary")));
  return new Response(res.status === 304 || request.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}

/**
 * The whole adapter for a host with a Fetch API. `next` returns the host's own
 * response for a request the adapter does not serve.
 */
export async function handleRequest({ request, config, manifestCache, fetchImpl = globalThis.fetch, next, fetchInit = {} }) {
  const url = new URL(request.url);
  // Every mode reads the manifest: it maps a path to a page id, and its
  // version goes on the host's HTML. A failed fetch leaves it null and the
  // adapter still answers by path.
  const manifest = manifestCache ? await manifestCache.get() : null;
  const decision = decide(url.pathname, request.headers.get("Accept"), manifest, { ...config, method: request.method });
  if (decision.serve) return fetchSigned(decision, request, fetchImpl, fetchInit, config);
  const hostResponse = await next(request);
  if (!hostResponse) return hostResponse;
  return withProofHeaders(hostResponse, manifest, url.pathname, config);
}

/** Read the three settings from an env-like object, with plain names. */
export function configFromEnv(env = {}) {
  return {
    troothId: env.TROOTH_ID,
    apiBase: env.TROOTH_API_BASE || DEFAULT_API_BASE,
    mode: normalizeMode(env.TROOTH_MODE || env.MODE),
    // The private JWK (JSON) of this adapter's connector key, registered in the dashboard under Delivery, Connectors.
    ...(env.TROOTH_CONNECTOR_KEY ? { connectorKey: env.TROOTH_CONNECTOR_KEY } : {}),
  };
}
