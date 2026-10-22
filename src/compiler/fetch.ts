// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The fetcher Trooth reads a company's pages with. It sits behind the HttpPort
// so tests run on an in-memory site, and it enforces the guards a crawler
// needs when the url comes from someone else's page:
//
//   SSRF     refuse anything that is not https; refuse hosts that are, or
//            resolve to, loopback, private (RFC 1918), link-local, carrier-grade
//            NAT, multicast, unspecified and cloud metadata addresses (RFC 6890
//            special-purpose registry, plus 169.254.169.254 and fd00:ec2::254);
//            refuse redirects that leave the registrable domain; at most five
//            hops (RFC 9110 section 15.4)
//   size     read at most 2 MB of body per page and say when it was cut
//   polite   one request per host per interval, identified by the user agent
//            "TroothSemanto/1.0 (+https://trooth.co/semanto; witness)"; the
//            user agent names Trooth to the site and never picks a format
//   revalidate conditional GET with If-None-Match and If-Modified-Since
//            (RFC 9110 section 13.1) so an unchanged page costs one 304
//
// The raw bytes are hashed to source_hash so a later reader can tell which
// capture a page's markdown came from. A ChangeDetector on top of the fetcher
// reports a change only when the bytes differ.

import { digest } from "../core/hash";
import { fromUtf8 } from "../core/encoding";
import type { CompilerPorts, HttpResponse } from "./ports";
import { hostOf, sameRegistrableDomain } from "./url";

export const USER_AGENT = "TroothSemanto/1.0 (+https://trooth.co/semanto; witness)";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type SsrfReason = "not_https" | "no_host" | "loopback" | "private" | "link_local" | "metadata" | "unspecified" | "multicast" | "reserved" | "local_name";

export type UrlCheck = { ok: true; host: string } | { ok: false; reason: SsrfReason; detail: string };

// ---------------------------------------------------------------- address guards

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function expandIpv6(s: string): number[] | null {
  let str = s.toLowerCase();
  if (str.startsWith("[") && str.endsWith("]")) str = str.slice(1, -1);
  const zone = str.indexOf("%");
  if (zone >= 0) str = str.slice(0, zone);
  // Embedded IPv4 tail.
  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(str);
  if (tail) {
    const v4 = parseIpv4(tail[1]!);
    if (!v4) return null;
    str = str.slice(0, tail.index) + `:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(missing).fill("0") : []), ...rest];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** Classify a literal IP address. `null` means a public address. */
export function classifyAddress(ip: string): SsrfReason | null {
  const v4 = parseIpv4(ip);
  if (v4) return classifyV4(v4);
  const v6 = expandIpv6(ip);
  if (!v6) return null;
  const allZero = v6.every((g) => g === 0);
  if (allZero) return "unspecified";
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible.
  if (v6.slice(0, 5).every((g) => g === 0) && (v6[5] === 0xffff || v6[5] === 0)) {
    const a = v6[6]!;
    const b = v6[7]!;
    return classifyV4([a >> 8, a & 255, b >> 8, b & 255]);
  }
  const first = v6[0]!;
  if ((first & 0xfe00) === 0xfc00) {
    // fd00:ec2::254 is the AWS IMDS address on IPv6.
    if (first === 0xfd00 && v6[1] === 0x0ec2 && v6[7] === 0x254 && v6.slice(2, 7).every((g) => g === 0)) return "metadata";
    return "private";
  }
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (first === 0x2001 && v6[1] === 0x0db8) return "reserved";
  if (first === 0x0064 && v6[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64: judge the embedded IPv4.
    const a = v6[6]!;
    const b = v6[7]!;
    return classifyV4([a >> 8, a & 255, b >> 8, b & 255]);
  }
  return null;
}

function classifyV4(p: number[]): SsrfReason | null {
  const [a, b, c, d] = p as [number, number, number, number];
  if (a === 169 && b === 254 && c === 169 && d === 254) return "metadata";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified";
  if (a === 169 && b === 254) return "link_local";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return null;
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet|test|example|invalid)$/i;

/** Check a url before any request is made. Names are checked by suffix; addresses by range. */
export function checkUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "no_host", detail: "not a url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https", detail: `scheme ${u.protocol.replace(":", "")} is not https` };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "no_host", detail: "no host" };
  if (host === "metadata.google.internal" || host === "metadata" || host === "instance-data") return { ok: false, reason: "metadata", detail: host };
  const literal = host.startsWith("[") || /^[0-9.]+$/.test(host) || host.includes(":");
  if (literal) {
    const cls = classifyAddress(host);
    if (cls) return { ok: false, reason: cls, detail: host };
    return { ok: true, host };
  }
  if (LOCAL_NAME_RE.test(host)) return { ok: false, reason: "local_name", detail: host };
  return { ok: true, host };
}

/** Check the addresses a name resolves to, when a resolver is available. */
export function checkResolved(host: string, addresses: string[]): UrlCheck {
  for (const a of addresses) {
    const cls = classifyAddress(a);
    if (cls) return { ok: false, reason: cls, detail: `${host} resolves to ${a}` };
  }
  return { ok: true, host };
}

// ---------------------------------------------------------------- fetch results

export interface FetchOk {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text: string;
  truncated: boolean;
  /** Digest of the raw body bytes as received (after any cut at the cap). */
  source_hash: string;
  etag: string | null;
  lastModified: string | null;
  /** ISO 8601 instant of the request. */
  fetchedAt: string;
  redirects: string[];
}

export type FetchFailReason = SsrfReason | "too_many_redirects" | "redirect_off_domain" | "redirect_without_location" | "network_error" | "disallowed_by_caller";

export interface FetchFail {
  ok: false;
  url: string;
  reason: FetchFailReason;
  detail: string;
  fetchedAt: string;
}

export type FetchOutcome = FetchOk | FetchFail;

export interface FetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  method?: "GET" | "HEAD";
}

export interface FetcherOptions {
  maxBytes?: number;
  /** Minimum gap between two requests to the same host, in milliseconds. */
  minIntervalMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Extra Accept header; markdown is never asked for because the raw HTML is the witness. */
  accept?: string;
}

export class Fetcher {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly minIntervalMs: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;
  private readonly accept: string;

  constructor(private readonly ports: CompilerPorts, opts: FetcherOptions = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
    this.minIntervalMs = opts.minIntervalMs ?? 500;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.accept = opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";
  }

  private now(): Date {
    return this.ports.clock ? this.ports.clock.now() : new Date();
  }

  private async politeWait(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host);
    const now = this.now().getTime();
    if (last !== undefined && now - last < this.minIntervalMs) {
      const wait = this.minIntervalMs - (now - last);
      if (this.ports.sleep) await this.ports.sleep(wait);
      else await new Promise<void>((r) => setTimeout(r, wait));
    }
    this.lastRequestAt.set(host, this.now().getTime());
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
    const started = this.now().toISOString();
    const origin = checkUrl(url);
    if (!origin.ok) return { ok: false, url, reason: origin.reason, detail: origin.detail, fetchedAt: started };
    const redirects: string[] = [];
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const check = checkUrl(current);
      if (!check.ok) return { ok: false, url, reason: check.reason, detail: check.detail, fetchedAt: started };
      if (this.ports.resolve) {
        let addrs: string[] = [];
        try {
          addrs = await this.ports.resolve(check.host);
        } catch {
          addrs = [];
        }
        const r = checkResolved(check.host, addrs);
        if (!r.ok) return { ok: false, url, reason: r.reason, detail: r.detail, fetchedAt: started };
      }
      await this.politeWait(check.host);
      const headers: Record<string, string> = { "user-agent": this.userAgent, accept: this.accept, "accept-language": "en, *;q=0.5" };
      if (opts.etag) headers["if-none-match"] = opts.etag;
      if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
      let res: HttpResponse;
      try {
        res = await this.ports.http.request({ url: current, method: opts.method ?? "GET", headers, maxBytes: this.maxBytes });
      } catch (e) {
        return { ok: false, url, reason: "network_error", detail: e instanceof Error ? e.message : String(e), fetchedAt: started };
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers["location"];
        if (!loc) return { ok: false, url, reason: "redirect_without_location", detail: `status ${res.status} without a location`, fetchedAt: started };
        let next: string;
        try {
          next = new URL(loc, current).href;
        } catch {
          return { ok: false, url, reason: "redirect_without_location", detail: `location ${loc} is not a url`, fetchedAt: started };
        }
        if (!sameRegistrableDomain(hostOf(next), hostOf(url))) return { ok: false, url, reason: "redirect_off_domain", detail: `redirect to ${next}`, fetchedAt: started };
        redirects.push(next);
        current = next;
        continue;
      }
      const body = res.body;
      return {
        ok: true,
        url,
        finalUrl: current,
        status: res.status,
        headers: res.headers,
        body,
        text: fromUtf8(body),
        truncated: res.truncated,
        source_hash: await digest(body),
        etag: res.headers["etag"] ?? null,
        lastModified: res.headers["last-modified"] ?? null,
        fetchedAt: started,
        redirects,
      };
    }
    return { ok: false, url, reason: "too_many_redirects", detail: `more than ${this.maxRedirects} redirects`, fetchedAt: started };
  }
}

// ---------------------------------------------------------------- change detection

export interface PreviousCapture {
  /** The sitemap lastmod seen when this capture was made. */
  lastmod?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  source_hash: string;
}

export type ChangeReason = "no_previous" | "sitemap_lastmod_same" | "not_modified" | "same_bytes" | "new_bytes" | "fetch_failed" | "status_changed";

export interface ChangeResult {
  url: string;
  changed: boolean;
  reason: ChangeReason;
  /** Present whenever a request was made. */
  fetch?: FetchOutcome;
}

/**
 * Cheapest signal first: an unchanged sitemap lastmod means no request; a
 * conditional GET answered 304 means no body; a 200 is compared by hash so a
 * page re-sent with new validators but the same bytes is still unchanged.
 */
export class ChangeDetector {
  constructor(private readonly fetcher: Fetcher) {}

  async check(url: string, previous: PreviousCapture | null, sitemapLastmod?: string | null): Promise<ChangeResult> {
    if (previous && sitemapLastmod && previous.lastmod && sitemapLastmod === previous.lastmod) {
      return { url, changed: false, reason: "sitemap_lastmod_same" };
    }
    const outcome = await this.fetcher.fetch(url, previous ? { etag: previous.etag ?? null, lastModified: previous.lastModified ?? null } : {});
    if (!outcome.ok) return { url, changed: false, reason: "fetch_failed", fetch: outcome };
    if (!previous) return { url, changed: true, reason: "no_previous", fetch: outcome };
    if (outcome.status === 304) return { url, changed: false, reason: "not_modified", fetch: outcome };
    if (outcome.status !== 200) return { url, changed: true, reason: "status_changed", fetch: outcome };
    if (outcome.source_hash === previous.source_hash) return { url, changed: false, reason: "same_bytes", fetch: outcome };
    return { url, changed: true, reason: "new_bytes", fetch: outcome };
  }
}
