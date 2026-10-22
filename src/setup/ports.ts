// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The DNS lookups the setup proof needs: TXT records at a name from two
// public resolvers (so a record still propagating is told apart from a
// missing one) and the domain's NS records (to name the DNS host). DNS over
// HTTPS, RFC 8484, in the JSON form both Cloudflare (cloudflare-dns.com/
// dns-query) and Google (dns.google/resolve) serve. An in-memory form for tests.

import { parseDohTxt } from "../serve/detect";

export interface SetupResolver {
  /** The resolver's host name, shown to the owner. */
  name: string;
  txt(name: string): Promise<string[]>;
}

export interface SetupDnsPort {
  resolvers: SetupResolver[];
  /** NS host names for the domain, lowercase, trailing dot removed. */
  ns(domain: string): Promise<string[]>;
}

export const SETUP_RESOLVERS = [
  { name: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { name: "dns.google", url: "https://dns.google/resolve" },
] as const;

async function dohJson(fetchFn: typeof fetch, base: string, name: string, type: "TXT" | "NS", timeoutMs: number): Promise<unknown> {
  const res = await fetchFn(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`DNS over HTTPS answered ${res.status}`);
  return res.json();
}

/** The Worker's lookups over the two public resolvers. A resolver that fails is reported as failing, never as "no record". */
export function dohSetupDns(fetchFn: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 3000): SetupDnsPort {
  return {
    resolvers: SETUP_RESOLVERS.map((r) => ({ name: r.name, txt: async (name: string) => parseDohTxt(await dohJson(fetchFn, r.url, name, "TXT", timeoutMs)) })),
    ns: async (domain) => {
      const j = (await dohJson(fetchFn, SETUP_RESOLVERS[0].url, domain, "NS", timeoutMs)) as { Answer?: { type?: number; data?: string }[] } | null;
      return (j?.Answer ?? []).filter((a) => a.type === 2 && typeof a.data === "string").map((a) => a.data!.toLowerCase().replace(/\.$/, ""));
    },
  };
}

/** In memory: TXT records per resolver (or the same for both) and NS records per domain. */
export function memorySetupDns(opts: { txt?: Record<string, string[]>; byResolver?: Record<string, Record<string, string[]>>; ns?: Record<string, string[]>; failing?: string[] } = {}): SetupDnsPort & { set(name: string, values: string[], resolver?: string): void } {
  const shared: Record<string, string[]> = { ...(opts.txt ?? {}) };
  const per: Record<string, Record<string, string[]>> = structuredClone(opts.byResolver ?? {});
  return {
    resolvers: SETUP_RESOLVERS.map((r) => ({
      name: r.name,
      txt: async (name: string) => {
        if (opts.failing?.includes(r.name)) throw new Error("resolver failed");
        const key = name.toLowerCase();
        return per[r.name]?.[key] ?? shared[key] ?? [];
      },
    })),
    ns: async (domain) => opts.ns?.[domain] ?? [],
    set(name, values, resolver) {
      if (resolver) (per[resolver] ??= {})[name.toLowerCase()] = values;
      else shared[name.toLowerCase()] = values;
    },
  };
}
