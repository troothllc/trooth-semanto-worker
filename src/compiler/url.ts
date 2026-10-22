// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// URL helpers shared by discovery and the fetcher: the registrable domain
// (the Public Suffix List idea, with a built-in table of the common
// two-label suffixes since no list can be loaded here), and the one
// normal form every page url takes in a Semanto: https, lower-case host,
// no fragment, no query string, no default port.

const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "co.in", "net.in", "org.in", "co.kr", "or.kr",
  "com.br", "net.br", "org.br", "com.mx", "org.mx", "com.ar", "com.cn", "net.cn", "org.cn",
  "co.za", "org.za", "com.sg", "com.hk", "com.tw", "com.tr", "com.my", "co.id", "com.ph",
  "com.pk", "com.ng", "co.ke", "com.eg", "com.sa", "com.ua", "com.pl", "co.il", "com.vn",
]);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

export function sameRegistrableDomain(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/**
 * The normal form of a page url, or null when the url cannot be one of the
 * site's pages: not https after upgrade, or not parseable.
 */
export function normalizePageUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return null;
  u.hash = "";
  u.search = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.port === "443") u.port = "";
  if (u.username || u.password) return null;
  if (!u.pathname) u.pathname = "/";
  return u.href;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
