// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The fetcher Trooth reads a company's pages with. It sits behind the HttpPort
// so tests run on an in-memory site, and it enforces the guards a crawler
// needs when the url comes from someone else's page:
//
//   SSRF     src/core/ssrf.ts: refuse anything that is not https; refuse
//            hosts that are, or resolve to, loopback, private, link-local,
//            carrier-grade NAT, multicast, unspecified, reserved and cloud
//            metadata addresses (RFC 6890 registries), including IPv4 carried
//            in IPv6 forms; a resolver error or an empty answer is a refusal
//            (fail closed); refuse redirects that leave the registrable
//            domain; at most five hops (RFC 9110 section 15.4)
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
import { checkUrl, checkResolved, type SsrfReason } from "../core/ssrf";

export const USER_AGENT = "TroothSemanto/1.0 (+https://trooth.co/semanto; witness)";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// The address guards live in src/core/ssrf.ts, shared with the Web Bot Auth
// key directory fetch; they are re-exported here for the compiler's callers.
export { checkUrl, checkResolved, classifyAddress, type SsrfReason, type UrlCheck } from "../core/ssrf";

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
        // Fail closed: a resolver error is a refusal, never "no addresses, go ahead".
        let addrs: string[];
        try {
          addrs = await this.ports.resolve(check.host);
        } catch (e) {
          return { ok: false, url, reason: "unresolvable", detail: `${check.host} could not be resolved (${e instanceof Error ? e.message : String(e)})`, fetchedAt: started };
        }
        const literal = /^[0-9.]+$/.test(check.host) || check.host.includes(":");
        const r = literal ? check : checkResolved(check.host, addrs);
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
