// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Host detection for a customer domain, so the dashboard can pick the right
// adapter and the right markdown source without asking the owner what their
// host is. Everything is read from response headers and two well-known paths:
//
//   x-markdown-tokens on a text/markdown request   Cloudflare Markdown for
//                                                   Agents is on (changelog,
//                                                   26 Feb 2026)
//   server: cloudflare, cf-ray                      Cloudflare
//   x-vercel-id                                     Vercel
//   x-nf-request-id                                 Netlify
//   x-served-by: cache-<pop>-fastly                 Fastly
//   x-akamai-*, server: AkamaiGHost                 Akamai
//   server: gcore, x-id-fe                          Gcore
//   server: nginx / apache                          nginx, Apache
//   <meta name="generator" content="WordPress">     WordPress (or /wp-json)
//   powered-by: Shopify, x-shopid, cdn.shopify.com  Shopify
//   server: Squarespace                             Squarespace
//   x-wix-request-id                                Wix
//   <meta name="generator" content="Webflow">       Webflow
//
// The last four signals come from docs/audit/workflow-research.md section 6,
// item 5. They have NOT yet been confirmed against live sites; confirm each
// with a live request before relying on it. A site whose signals are not seen
// stays "unknown" and the owner picks the host.
//
// Plus whether /.well-known/trooth.semanto and /.well-known/trooth-keys.json
// are already served and match the Network copy byte for byte, and whether the
// _trooth TXT pointer (v=trooth1; id=<trooth_id>; key=<kid>, never the proof
// record at _trooth-challenge) exists (DNS over HTTPS, RFC 8484, to 1.1.1.1, behind a
// port). All network calls sit behind the DetectPorts interface.

import { bytesEqual, utf8 } from "../core/encoding";
import { POINTER_RE } from "../basic/tier";
import type { HostKind, MarkdownSource } from "../settings/delivery";

export interface FetchResult {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface DetectPorts {
  fetch(url: string, init: { headers: Record<string, string> }): Promise<FetchResult | null>;
  /** TXT records for a name, each as one string; empty when none. */
  dnsTxt(name: string): Promise<string[]>;
  /** The Network's copy of the two well-known documents for this company. */
  networkCopy: { semanto: Uint8Array; keys: Uint8Array };
}

export interface Conflict {
  kind: "double_markdown";
  message: string;
}

export interface DetectionResult {
  domain: string;
  host: HostKind;
  cloudflare_markdown: boolean;
  well_known_served: { semanto: boolean; keys: boolean };
  well_known_matches: { semanto: boolean; keys: boolean };
  dns_pointer: boolean;
  conflicts: Conflict[];
  suggested_markdown_source: MarkdownSource;
  /** The header names that led to the host choice, for the dashboard. */
  evidence: string[];
  checked_at: string;
}

export const DOUBLE_MARKDOWN_MESSAGE = "Cloudflare's converter and Semanto would both answer markdown requests for the same page. Semanto must answer first for signed pages, or the reader gets two different byte strings for one url.";

export function classifyHost(headers: Record<string, string>, body: string): { host: HostKind; evidence: string[] } {
  const h = (k: string) => headers[k.toLowerCase()] ?? "";
  const server = h("server").toLowerCase();
  const ev: string[] = [];
  // Hosted site builders first: they sit behind CDNs (Shopify and Webflow behind Cloudflare or Fastly), so their own signals win.
  if (/shopify/i.test(h("powered-by")) || h("x-shopid") || /cdn\.shopify\.com/i.test(body)) return { host: "shopify", evidence: [h("powered-by") ? "powered-by" : h("x-shopid") ? "x-shopid" : "cdn.shopify.com in the page"] };
  if (/^squarespace/i.test(server)) return { host: "squarespace", evidence: ["server"] };
  if (h("x-wix-request-id")) return { host: "wix", evidence: ["x-wix-request-id"] };
  if (/<meta[^>]+name=["']generator["'][^>]+content=["']Webflow/i.test(body)) return { host: "webflow", evidence: ["generator meta"] };
  if (h("cf-ray") || server === "cloudflare") {
    ev.push(h("cf-ray") ? "cf-ray" : "server");
    return { host: "cloudflare", evidence: ev };
  }
  if (h("x-vercel-id")) return { host: "vercel", evidence: ["x-vercel-id"] };
  if (h("x-nf-request-id")) return { host: "netlify", evidence: ["x-nf-request-id"] };
  if (/cache-[a-z0-9-]*fastly/i.test(h("x-served-by")) || /fastly/i.test(h("x-fastly-request-id") ? "fastly" : "")) return { host: "fastly", evidence: ["x-served-by"] };
  if (Object.keys(headers).some((k) => k.startsWith("x-akamai-")) || /akamaighost/i.test(server) || h("x-check-cacheable")) return { host: "akamai", evidence: ["x-akamai-* or server"] };
  if (/gcore|g-core/i.test(server) || h("x-id-fe")) return { host: "gcore", evidence: ["server or x-id-fe"] };
  if (/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i.test(body) || h("link").includes("wp-json")) return { host: "wordpress", evidence: ["generator meta or wp-json link"] };
  if (/^nginx/i.test(server)) return { host: "nginx", evidence: ["server"] };
  if (/^apache/i.test(server)) return { host: "apache", evidence: ["server"] };
  return { host: "unknown", evidence: [] };
}

function lowerKeys(r: FetchResult | null): Record<string, string> {
  if (!r) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Parse the answer of a DoH JSON query (application/dns-json) into TXT strings. */
export function parseDohTxt(json: unknown): string[] {
  const a = (json as { Answer?: { type?: number; data?: string }[] } | null)?.Answer;
  if (!Array.isArray(a)) return [];
  return a.filter((x) => x.type === 16 && typeof x.data === "string").map((x) => (x.data as string).replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
}

/** A DetectPorts.dnsTxt built on 1.1.1.1 DNS over HTTPS (RFC 8484, JSON form). */
export function dohTxtResolver(fetchFn: typeof fetch = fetch): (name: string) => Promise<string[]> {
  return async (name: string) => {
    try {
      const r = await fetchFn(`https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
      if (!r.ok) return [];
      return parseDohTxt(await r.json());
    } catch {
      return [];
    }
  };
}

export async function detectHost(domain: string, ports: DetectPorts, now: Date = new Date()): Promise<DetectionResult> {
  const origin = `https://${domain}`;
  const [home, md, wkSemanto, wkKeys, txt, wpJson] = await Promise.all([
    ports.fetch(`${origin}/`, { headers: { accept: "text/html" } }),
    ports.fetch(`${origin}/`, { headers: { accept: "text/markdown" } }),
    ports.fetch(`${origin}/.well-known/trooth.semanto`, { headers: { accept: "application/json" } }),
    ports.fetch(`${origin}/.well-known/trooth-keys.json`, { headers: { accept: "application/json" } }),
    ports.dnsTxt(`_trooth.${domain}`),
    ports.fetch(`${origin}/wp-json/`, { headers: { accept: "application/json" } }),
  ]);

  const homeHeaders = lowerKeys(home);
  const mdHeaders = lowerKeys(md);
  const body = home ? new TextDecoder().decode(home.body.slice(0, 65536)) : "";
  let { host, evidence } = classifyHost({ ...mdHeaders, ...homeHeaders }, body);
  if (host === "unknown" && wpJson && wpJson.status === 200 && (wpJson.headers["content-type"] ?? "").includes("json")) {
    host = "wordpress";
    evidence = ["/wp-json"];
  }

  const cloudflare_markdown = Boolean(md && md.status === 200 && mdHeaders["x-markdown-tokens"] && (mdHeaders["content-type"] ?? "").startsWith("text/markdown"));
  if (cloudflare_markdown && host === "unknown") {
    host = "cloudflare";
    evidence = ["x-markdown-tokens"];
  }

  const served = { semanto: Boolean(wkSemanto && wkSemanto.status === 200), keys: Boolean(wkKeys && wkKeys.status === 200) };
  const matches = {
    semanto: Boolean(served.semanto && wkSemanto && bytesEqual(wkSemanto.body, ports.networkCopy.semanto)),
    keys: Boolean(served.keys && wkKeys && bytesEqual(wkKeys.body, ports.networkCopy.keys)),
  };
  // Only the pointer counts: v=trooth1; id=<trooth_id>; key=<kid>. A proof value or any other v=trooth1 record does not.
  const dns_pointer = txt.some((t) => POINTER_RE.test(t.trim().replace(/^"+|"+$/g, "")));

  const conflicts: Conflict[] = [];
  if (cloudflare_markdown) conflicts.push({ kind: "double_markdown", message: DOUBLE_MARKDOWN_MESSAGE });

  const suggested_markdown_source: MarkdownSource = cloudflare_markdown ? "semanto_then_cloudflare_for_unsigned" : "semanto_only";

  return {
    domain,
    host,
    cloudflare_markdown,
    well_known_served: served,
    well_known_matches: matches,
    dns_pointer,
    conflicts,
    suggested_markdown_source,
    evidence,
    checked_at: now.toISOString(),
  };
}

/** A DetectPorts.fetch on the platform fetch, with a short timeout and no redirects off the domain. */
export function liveFetcher(fetchFn: typeof fetch = fetch, timeoutMs = 8000): DetectPorts["fetch"] {
  return async (url, init) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchFn(url, { headers: { ...init.headers, "user-agent": "TroothSemanto/1 (+https://trooth.co/semanto)" }, redirect: "follow", signal: ac.signal });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };
}

export const EMPTY_NETWORK_COPY = { semanto: utf8(""), keys: utf8("") };
