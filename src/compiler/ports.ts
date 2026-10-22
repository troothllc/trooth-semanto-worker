// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The ports the compiler talks to the outside world through: an HTTP client
// that does one request and never follows a redirect on its own, a clock and
// a sleeper for the per-host rate limit, and an optional resolver so the
// SSRF guard can look at the addresses a name points to. Tests use the
// in-memory implementations here; the Worker uses the Web fetch adapter.
// Practice followed: hexagonal ports and adapters, so every compiler module
// is a pure function of plain values.

export interface HttpRequest {
  url: string;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  /** Stop reading the body after this many bytes; the adapter reports `truncated`. */
  maxBytes: number;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
}

export interface HttpPort {
  /** One request. Redirects are returned as 3xx with a `location` header, never followed. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): Date;
}

export type Sleeper = (ms: number) => Promise<void>;

/** Resolve a host name to the IP addresses it points to, when the runtime can. */
export type Resolver = (host: string) => Promise<string[]>;

export interface CompilerPorts {
  http: HttpPort;
  clock?: Clock;
  sleep?: Sleeper;
  resolve?: Resolver;
}

// ----------------------------------------------------------- in-memory HTTP

export interface MemoryPage {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/**
 * A fake site: a map from url to response. Unknown urls answer 404. The
 * fetcher's conditional GET is honored: an `etag` or `last-modified` header
 * on the page answers 304 when the request carries the matching validator.
 */
export class MemoryHttp implements HttpPort {
  readonly log: HttpRequest[] = [];
  private readonly pages = new Map<string, MemoryPage>();

  constructor(pages: Record<string, MemoryPage | string> = {}) {
    for (const [url, page] of Object.entries(pages)) this.set(url, typeof page === "string" ? { body: page } : page);
  }

  set(url: string, page: MemoryPage): void {
    this.pages.set(url, page);
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.log.push(req);
    const page = this.pages.get(req.url);
    if (!page) return { status: 404, headers: { "content-type": "text/html" }, body: new Uint8Array(0), truncated: false };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(page.headers ?? {})) headers[k.toLowerCase()] = v;
    if (!headers["content-type"]) headers["content-type"] = "text/html; charset=utf-8";
    const status = page.status ?? 200;
    const inm = req.headers["if-none-match"] ?? req.headers["If-None-Match"];
    const ims = req.headers["if-modified-since"] ?? req.headers["If-Modified-Since"];
    if (status === 200 && ((inm && headers["etag"] && inm === headers["etag"]) || (ims && headers["last-modified"] && ims === headers["last-modified"]))) {
      return { status: 304, headers, body: new Uint8Array(0), truncated: false };
    }
    const raw = page.body ?? "";
    const full = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    const truncated = full.length > req.maxBytes;
    const body = req.method === "HEAD" ? new Uint8Array(0) : truncated ? full.slice(0, req.maxBytes) : full;
    return { status, headers, body, truncated };
  }
}

export class FixedClock implements Clock {
  private t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A sleeper that only moves a FixedClock forward and records what it was asked. */
export function fakeSleeper(clock: FixedClock): { sleep: Sleeper; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.advance(ms);
    },
  };
}

// ----------------------------------------------------------- Web fetch adapter

/** The adapter for Workers and browsers: `fetch` with manual redirects and a capped read. */
export class WebFetchHttp implements HttpPort {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.fetchFn(req.url, { method: req.method, headers: req.headers, redirect: "manual" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (res.body && req.method !== "HEAD") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.length > req.maxBytes) {
          chunks.push(value.slice(0, req.maxBytes - total));
          total = req.maxBytes;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    }
    const body = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      body.set(c, o);
      o += c.length;
    }
    return { status: res.status, headers, body, truncated };
  }
}
