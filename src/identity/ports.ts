// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ports for identity: DNS lookups (TXT records for _trooth-keys.<domain>),
// HTTPS fetches (a company's JWKS, the GLEIF API) and the vLEI verifier slot.
// Each has an in-memory implementation for tests and a platform one for the
// Worker. DNS over HTTPS follows RFC 8484 with the JSON answer form Cloudflare
// documents for https://cloudflare-dns.com/dns-query (application/dns-json).

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpPort {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

export class MemoryHttp implements HttpPort {
  readonly calls: string[] = [];
  constructor(private readonly routes: Record<string, HttpResponse | ((url: string) => HttpResponse | Promise<HttpResponse>)>) {}
  async get(url: string): Promise<HttpResponse> {
    this.calls.push(url);
    const r = this.routes[url];
    if (!r) return { status: 404, headers: {}, body: "" };
    return typeof r === "function" ? r(url) : r;
  }
}

export function platformHttp(f: typeof fetch = fetch): HttpPort {
  return {
    async get(url, headers = {}) {
      const res = await f(url, { method: "GET", headers, redirect: "follow" });
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        h[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: h, body: await res.text() };
    },
  };
}

// ---------------------------------------------------------------- DNS

export interface DnsPort {
  /** TXT records at `name`, each as its joined string, or an empty list. */
  txt(name: string): Promise<string[]>;
}

export class MemoryDns implements DnsPort {
  constructor(private readonly records: Record<string, string[]> = {}) {}
  set(name: string, values: string[]): void {
    this.records[name.toLowerCase().replace(/\.$/, "")] = values;
  }
  async txt(name: string): Promise<string[]> {
    return this.records[name.toLowerCase().replace(/\.$/, "")] ?? [];
  }
}

export const DOH_URL = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
  Status: number;
  Answer?: { name: string; type: number; TTL: number; data: string }[];
}

/** RFC 8484 over the JSON form: GET ?name=<name>&type=TXT with Accept: application/dns-json. */
export function dohDns(http: HttpPort, base: string = DOH_URL): DnsPort {
  return {
    async txt(name) {
      const url = `${base}?name=${encodeURIComponent(name)}&type=TXT`;
      const res = await http.get(url, { accept: "application/dns-json" });
      if (res.status !== 200) return [];
      let parsed: DohAnswer;
      try {
        parsed = JSON.parse(res.body) as DohAnswer;
      } catch {
        return [];
      }
      if (parsed.Status !== 0 || !Array.isArray(parsed.Answer)) return [];
      // TXT data arrives as one or more quoted strings; join the pieces as RFC 7208 section 3.3 does for SPF.
      return parsed.Answer.filter((a) => a.type === 16).map((a) => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1")).join("") || a.data);
    },
  };
}

// ---------------------------------------------------------------- vLEI

export interface VleiCredentialRef {
  /** The credential's self-addressing identifier (KERI SAID). */
  said: string;
  /** The issuer's AID. */
  issuer: string;
  /** The ACDC schema SAID. */
  schema: string;
}

export type VleiCheck =
  | { status: "checked"; checked_at: string; lei: string; legal_name?: string; role?: string; person?: string }
  | { status: "not_wired"; sentence: string }
  | { status: "failed"; reason: string };

export interface VleiVerifier {
  verify(ref: VleiCredentialRef): Promise<VleiCheck>;
}

/** The stub that ships: it says plainly that no KERI verifier is wired. It never returns "checked". */
export class VleiNotWired implements VleiVerifier {
  async verify(): Promise<VleiCheck> {
    return { status: "not_wired", sentence: "A vLEI credential was presented. Trooth has not checked it: no KERI verifier is connected yet." };
  }
}
