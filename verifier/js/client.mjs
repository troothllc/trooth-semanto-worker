// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// SemantoClient: read a company's signed copy and check it in one call, for an
// agent or a framework integration. It fetches the page as markdown, the two
// key sets (the company's on its domain and Trooth's), checks the response
// signature with verify.mjs, and checks the signing key against the domain's
// _trooth-keys TXT record over DNS over HTTPS. Key sets and DNS answers are
// kept in memory for `cacheSeconds` (300 by default). No dependencies; works
// wherever fetch and WebCrypto do (Node 20+, Deno, Workers, browsers).
//
//   import { SemantoClient } from "./client.mjs";
//   const client = new SemantoClient();
//   const r = await client.read("https://acme.com/pricing");
//   if (r.ok) use(r.text); else console.log(r.reason, r.checks);

import { parseDnsKeyRecords, verifyResponse, fromUtf8 } from "./verify.mjs";

export const TROOTH_API = "https://api.trooth.co";
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export class SemantoClient {
  /**
   * @param {{ fetch?: typeof fetch, apiBase?: string, doh?: string | null, cacheSeconds?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiBase = (opts.apiBase ?? TROOTH_API).replace(/\/+$/, "");
    this.doh = opts.doh === undefined ? DOH_ENDPOINT : opts.doh;
    this.cacheMs = (opts.cacheSeconds ?? 300) * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.cache = new Map();
  }

  async cached(key, load) {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value;
    const value = await load();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  async json(url) {
    const r = await this.fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  }

  /** The company's key set from its domain and Trooth's, each null-safe. */
  keysFor(domain) {
    return this.cached(`keys:${domain}`, async () => {
      const keys = { company: { keys: [] }, trooth: { keys: [] } };
      const notes = [];
      for (const [role, url] of [
        ["company", `https://${domain}/.well-known/trooth-keys.json`],
        ["trooth", `${this.apiBase}/public/semanto/.well-known/trooth-keys.json`],
      ]) {
        try {
          keys[role] = await this.json(url);
        } catch (e) {
          notes.push(`${url} could not be read (${e.message})`);
        }
      }
      return { keys, notes };
    });
  }

  /** The kids the domain's _trooth-keys TXT record names, over DNS over HTTPS; null when it could not be asked. */
  dnsKids(domain) {
    if (!this.doh) return Promise.resolve(null);
    return this.cached(`dns:${domain}`, async () => {
      try {
        const u = `${this.doh}?name=${encodeURIComponent(`_trooth-keys.${domain}`)}&type=TXT`;
        const r = await this.fetch(u, { headers: { Accept: "application/dns-json" } });
        if (!r.ok) return null;
        const d = await r.json();
        const txt = (d.Answer ?? []).filter((a) => a.type === 16).map((a) => String(a.data).replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
        return parseDnsKeyRecords(txt);
      } catch {
        return null;
      }
    });
  }

  /**
   * Read one URL as markdown and check it. `ok` is true only when the signature checks against a key the company or
   * Trooth publishes; `dns` says whether the domain's DNS names the signing key (null when DNS could not be asked).
   * @returns {Promise<{ ok: boolean, reason: string | null, status: number, text: string, version: string | null, signed_by: string | null, keyid: string | null, dns: boolean | null, checks: { name: string, ok: boolean, detail: string }[], notes: string[] }>}
   */
  async read(url, { accept = "text/markdown" } = {}) {
    const domain = new URL(url).hostname;
    const r = await this.fetch(url, { headers: { Accept: accept } });
    const body = new Uint8Array(await r.arrayBuffer());
    const headers = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    const { keys, notes } = await this.keysFor(domain);
    const res = await verifyResponse(r.status, headers, body, keys, { now: Math.floor(this.now() / 1000) });
    let dns = null;
    if (res.keyid && (headers["trooth-signed-by"] ?? "").toLowerCase() !== "witness") {
      const kids = await this.dnsKids(domain);
      dns = kids === null ? null : kids.includes(res.keyid);
    }
    return {
      ok: res.ok,
      reason: res.ok ? null : res.reason,
      status: r.status,
      text: fromUtf8(body),
      version: headers["trooth-semanto-version"] ?? null,
      signed_by: headers["trooth-signed-by"] ?? null,
      keyid: res.keyid ?? null,
      dns,
      checks: res.checks,
      notes,
    };
  }

  /** A company's facts as JSON-LD from the Trooth API, checked. */
  async facts(troothId) {
    const r = await this.read(`${this.apiBase}/public/semanto/${encodeURIComponent(troothId)}/facts.jsonld`, { accept: "application/ld+json" });
    let data = null;
    try {
      data = JSON.parse(r.text);
    } catch {
      data = null;
    }
    return { ...r, data };
  }
}
