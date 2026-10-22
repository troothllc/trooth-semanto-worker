// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The one SSRF guard every outbound fetch to a URL someone else chose goes
// through: the compiler reading a company's pages, the Web Bot Auth key
// directory fetch, and anything else that follows a URL from a request. It
// follows the IANA special-purpose address registries (RFC 6890, with the
// IPv4 and IPv6 registries as of 2026) and OWASP's SSRF prevention cheat sheet:
//
//   names      https only; no credentials; a trailing dot is removed before
//              any name check ("localhost." is localhost); local and
//              internal names refused by suffix
//   addresses  loopback, private (RFC 1918, RFC 6598 shared space, fc00::/7,
//              fec0::/10 site-local), link-local, multicast, unspecified,
//              cloud metadata and every reserved range refused; IPv6 forms
//              that carry an IPv4 address are decoded and the IPv4 address is
//              judged: IPv4-mapped (::ffff:a.b.c.d and ::ffff:0:a.b.c.d),
//              IPv4-compatible (::a.b.c.d), 6to4 (2002::/16), Teredo
//              (2001::/32, server and client) and NAT64 (64:ff9b::/96;
//              64:ff9b:1::/48 is local use and refused)
//   DNS        dohResolver asks DNS over HTTPS (https://cloudflare-dns.com/
//              dns-query, A and AAAA, RFC 8484 JSON form) and FAILS CLOSED:
//              an error, a refusal or no address at all is a refusal
//
// Two limits a reader of this file should know. A Worker's own outbound
// fetch resolves the name again, and that answer can differ from the DoH
// answer (a DNS rebinding window); the check narrows it and does not close
// it. The second layer is the platform: Cloudflare Workers cannot reach
// private networks without a tunnel (Cloudflare Tunnel or a VPC binding), so
// an address inside RFC 1918 is not reachable from the Worker even when a
// name rebinds to it.

export type SsrfReason = "not_https" | "no_host" | "loopback" | "private" | "link_local" | "metadata" | "unspecified" | "multicast" | "reserved" | "local_name" | "ip_literal" | "credentials" | "unresolvable";

export type UrlCheck = { ok: true; host: string } | { ok: false; reason: SsrfReason; detail: string };

export type Resolver = (host: string) => Promise<string[]>;

// ---------------------------------------------------------------- address parsing

export function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

export function expandIpv6(s: string): number[] | null {
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

const v4From = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

// ---------------------------------------------------------------- classification

export function classifyV4(p: number[]): SsrfReason | null {
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
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return null;
}

/** Classify a literal IP address. `null` means a public address. */
export function classifyAddress(ip: string): SsrfReason | null {
  const v4 = parseIpv4(ip);
  if (v4) return classifyV4(v4);
  const v6 = expandIpv6(ip);
  if (!v6) return null;
  const zeroUpTo = (n: number) => v6.slice(0, n).every((g) => g === 0);
  if (v6.every((g) => g === 0)) return "unspecified";
  if (zeroUpTo(7) && v6[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d.
  if (zeroUpTo(5) && (v6[5] === 0xffff || v6[5] === 0)) return classifyV4(v4From(v6[6]!, v6[7]!)) ?? (v6[5] === 0 ? "reserved" : null);
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765).
  if (zeroUpTo(4) && v6[4] === 0xffff && v6[5] === 0) return classifyV4(v4From(v6[6]!, v6[7]!)) ?? "reserved";
  const first = v6[0]!;
  // 64:ff9b::/96 NAT64: judge the embedded IPv4. 64:ff9b:1::/48 is local-use NAT64 (RFC 8215).
  if (first === 0x0064 && v6[1] === 0xff9b) {
    if (v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0) return classifyV4(v4From(v6[6]!, v6[7]!));
    return "reserved";
  }
  // 6to4 2002::/16: the IPv4 address is bits 16 to 47.
  if (first === 0x2002) return classifyV4(v4From(v6[1]!, v6[2]!));
  // Teredo 2001::/32: the server IPv4 is bits 32 to 63, the client IPv4 the last 32 bits inverted.
  if (first === 0x2001 && v6[1] === 0) {
    const server = classifyV4(v4From(v6[2]!, v6[3]!));
    const client = classifyV4(v4From(~v6[6]! & 0xffff, ~v6[7]! & 0xffff));
    return client ?? server ?? "reserved";
  }
  if (first === 0x2001 && v6[1] === 0x0db8) return "reserved";
  // 2001::/23 IETF protocol assignments (benchmarking, ORCHID and the rest).
  if (first === 0x2001 && v6[1]! < 0x0200) return "reserved";
  // 100::/64 discard-only.
  if (first === 0x0100 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0) return "reserved";
  // 3fff::/20 documentation (RFC 9637), 5f00::/16 SRv6 SIDs.
  if (first === 0x3fff && v6[1]! < 0x1000) return "reserved";
  if (first === 0x5f00) return "reserved";
  if ((first & 0xfe00) === 0xfc00) {
    // fd00:ec2::254 is the AWS IMDS address on IPv6.
    if (first === 0xfd00 && v6[1] === 0x0ec2 && v6[7] === 0x254 && v6.slice(2, 7).every((g) => g === 0)) return "metadata";
    return "private";
  }
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  if ((first & 0xffc0) === 0xfec0) return "private";
  if ((first & 0xff00) === 0xff00) return "multicast";
  // Anything outside 2000::/3 global unicast is not a public address.
  if ((first & 0xe000) !== 0x2000) return "reserved";
  return null;
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|localdomain|home|lan|corp|intranet|test|example|invalid|arpa|onion|home\.arpa)$/i;
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data", "metadata.azure.internal"]);

export interface CheckUrlOptions {
  /** Refuse any IP literal, public or not (the Web Bot Auth directory must be named by a host name). */
  refuseIpLiterals?: boolean;
}

/** Check a url before any request is made. Names are checked by suffix; addresses by range. */
export function checkUrl(raw: string, opts: CheckUrlOptions = {}): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "no_host", detail: "not a url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https", detail: `scheme ${u.protocol.replace(":", "")} is not https` };
  if (u.username || u.password) return { ok: false, reason: "credentials", detail: "credentials in the url" };
  // A trailing dot names the same host ("localhost." is localhost); remove every one before the name checks.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "no_host", detail: "no host" };
  if (METADATA_NAMES.has(host)) return { ok: false, reason: "metadata", detail: host };
  const literal = host.startsWith("[") || /^[0-9.]+$/.test(host) || host.includes(":");
  if (literal) {
    const cls = classifyAddress(host);
    if (cls) return { ok: false, reason: cls, detail: host };
    if (opts.refuseIpLiterals) return { ok: false, reason: "ip_literal", detail: `${host} is an address, not a name` };
    return { ok: true, host };
  }
  if (!host.includes(".") || LOCAL_NAME_RE.test(host)) return { ok: false, reason: "local_name", detail: host };
  return { ok: true, host };
}

/** Check the addresses a name resolves to. No address at all is a refusal: fail closed. */
export function checkResolved(host: string, addresses: string[]): UrlCheck {
  if (addresses.length === 0) return { ok: false, reason: "unresolvable", detail: `${host} has no address` };
  for (const a of addresses) {
    const cls = classifyAddress(a);
    if (cls) return { ok: false, reason: cls, detail: `${host} resolves to ${a}` };
  }
  return { ok: true, host };
}

/** checkUrl, then the resolver; a resolver error is a refusal (fail closed). */
export async function checkUrlResolved(raw: string, resolve: Resolver | undefined, opts: CheckUrlOptions = {}): Promise<UrlCheck> {
  const c = checkUrl(raw, opts);
  if (!c.ok || !resolve) return c;
  if (classifyAddress(c.host) === null && (parseIpv4(c.host) || expandIpv6(c.host))) return c;
  let addrs: string[];
  try {
    addrs = await resolve(c.host);
  } catch (e) {
    return { ok: false, reason: "unresolvable", detail: `${c.host} could not be resolved (${e instanceof Error ? e.message : String(e)})` };
  }
  return checkResolved(c.host, addrs);
}

// ---------------------------------------------------------------- DNS over HTTPS

export const DOH_URL = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
}

/**
 * A production resolver over DNS over HTTPS (RFC 8484, the JSON form
 * Cloudflare serves at /dns-query): A and AAAA in parallel. It throws on any
 * error so callers fail closed: a non-200 answer, a DNS status other than
 * NOERROR (0) or NXDOMAIN (3), or a body that is not the JSON form.
 */
export function dohResolver(fetchImpl: typeof fetch = (input, init) => fetch(input, init), endpoint: string = DOH_URL, timeoutMs = 3000): Resolver {
  const one = async (host: string, type: "A" | "AAAA"): Promise<string[]> => {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, ...(ctrl ? { signal: ctrl.signal } : {}) });
      if (res.status !== 200) throw new Error(`DNS over HTTPS answered ${res.status}`);
      const j = (await res.json()) as DohAnswer;
      if (typeof j !== "object" || j === null || typeof j.Status !== "number") throw new Error("DNS over HTTPS answer is not the JSON form");
      if (j.Status !== 0 && j.Status !== 3) throw new Error(`DNS status ${j.Status}`);
      const want = type === "A" ? 1 : 28;
      return (j.Answer ?? []).filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data!.trim());
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return async (host) => {
    const [a, aaaa] = await Promise.all([one(host, "A"), one(host, "AAAA")]);
    return [...a, ...aaaa];
  };
}
