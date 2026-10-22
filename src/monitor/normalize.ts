// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tolerant comparisons for the consistency monitor. Two surfaces that say the
// same thing in different clothes are a match: phone numbers go to E.164
// (ITU-T E.164), addresses to one spacing and one set of street abbreviations
// (USPS Publication 28 short forms), prices to an amount and an ISO 4217
// currency, hours to one span format per day, availability to the schema.org
// ItemAvailability names Merchant Center also uses, names to letters and
// digits only. When two values still differ, `whatDiffers` says which words
// differ so the alert can say it too.

import type { Price, SurfaceValue } from "./types";

// ------------------------------------------------------------------ phones

/** E.164: a plus sign and up to 15 digits. Ten digits with no country code are read as the default country. */
export function normalizePhone(input: string, defaultCountryCode = "1"): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (!hasPlus && digits.startsWith("00")) digits = digits.slice(2);
  else if (!hasPlus && digits.length === 10) digits = defaultCountryCode + digits;
  if (digits.length < 7 || digits.length > 15) return null;
  return "+" + digits;
}

/** A readable E.164 for alerts: +1 312 555 0100 for North American numbers, grouped loosely elsewhere. */
export function displayPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `+1 ${m[1]} ${m[2]} ${m[3]}`;
  return e164.replace(/^(\+\d{1,3})(\d+)$/, (_s, cc: string, rest: string) => `${cc} ${rest.replace(/(\d{3})(?=\d)/g, "$1 ")}`);
}

/** Phone-shaped runs in a page's text, each normalized. */
export function phonesInText(text: string, defaultCountryCode = "1"): string[] {
  const out: string[] = [];
  const re = /(\+?\d[\d\s().-]{6,}\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = normalizePhone(m[1] ?? "", defaultCountryCode);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

// --------------------------------------------------------------- addresses

const STREET_SHORT: Record<string, string> = {
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  road: "rd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  square: "sq",
  parkway: "pkwy",
  highway: "hwy",
  suite: "ste",
  apartment: "apt",
  floor: "fl",
  building: "bldg",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  usa: "us",
  "united states": "us",
  "united states of america": "us",
};

export function normalizeAddress(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/united states of america|united states/g, "us");
  s = s.replace(/[.,;#\n\r\t]+/g, " ");
  s = s.replace(/[^a-z0-9 -]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const words = s.split(" ").map((w) => STREET_SHORT[w] ?? w);
  return words.join(" ");
}

/** A schema.org PostalAddress or a Business Profile storefrontAddress, joined into one line. */
export function joinAddress(parts: { lines?: Array<string | undefined>; locality?: string; region?: string; postal?: string; country?: string }): string {
  const segs: string[] = [];
  for (const l of parts.lines ?? []) if (l && l.trim()) segs.push(l.trim());
  const cityLine = [parts.locality, parts.region].filter((x): x is string => Boolean(x && x.trim())).join(", ");
  const withPostal = [cityLine, parts.postal].filter((x): x is string => Boolean(x && x.trim())).join(" ");
  if (withPostal) segs.push(withPostal);
  if (parts.country && parts.country.trim()) segs.push(parts.country.trim());
  return segs.join(", ");
}

// ------------------------------------------------------------------ prices

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "C$": "CAD", "A$": "AUD" };

/** Read a price from any of the shapes the surfaces use. Returns amount as a string with two decimals. */
export function parsePrice(input: unknown): Price | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return { amount: input.toFixed(2), currency: "" };
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const amount = o.amount ?? o.value ?? o.price;
    const currency = o.currency ?? o.currency_code ?? o.currencyCode ?? o.priceCurrency ?? "";
    if (amount === undefined || amount === null) return null;
    const n = typeof amount === "number" ? amount : Number(String(amount).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(n)) return null;
    return { amount: n.toFixed(2), currency: String(currency).toUpperCase() };
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  let currency = "";
  const code = /\b([A-Z]{3})\b/.exec(s);
  if (code && code[1]) currency = code[1];
  else {
    for (const sym of Object.keys(SYMBOLS)) if (s.includes(sym)) currency = SYMBOLS[sym] ?? "";
  }
  const num = /-?\d[\d,]*(?:\.\d+)?/.exec(s);
  if (!num) return null;
  const n = Number(num[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return { amount: n.toFixed(2), currency };
}

export function samePrice(a: Price, b: Price): boolean {
  if (Number(a.amount) !== Number(b.amount)) return false;
  if (a.currency && b.currency && a.currency.toUpperCase() !== b.currency.toUpperCase()) return false;
  return true;
}

export function displayPrice(p: Price): string {
  return p.currency ? `${p.amount} ${p.currency}` : p.amount;
}

// ------------------------------------------------------------ availability

export function normalizeAvailability(input: string): string {
  const s = input.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/[^a-z]/g, "");
  switch (s) {
    case "instock":
    case "available":
    case "yes":
      return "in_stock";
    case "outofstock":
    case "soldout":
    case "unavailable":
    case "no":
      return "out_of_stock";
    case "preorder":
      return "preorder";
    case "backorder":
    case "onbackorder":
      return "backorder";
    case "limitedavailability":
      return "limited_availability";
    case "discontinued":
      return "discontinued";
    default:
      return s;
  }
}

export function displayAvailability(normalized: string): string {
  switch (normalized) {
    case "in_stock":
      return "in stock";
    case "out_of_stock":
      return "out of stock";
    case "preorder":
      return "pre-order";
    case "backorder":
      return "on back order";
    case "limited_availability":
      return "limited";
    default:
      return normalized.replace(/_/g, " ");
  }
}

// ------------------------------------------------------------------- hours

export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Day = (typeof DAYS)[number];

export function dayFromAny(input: string): Day | null {
  const s = input.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").trim();
  for (const d of DAYS) if (s === d || s === d.slice(0, 3) || s === d.slice(0, 2)) return d;
  return null;
}

function parseClock(s: string): string | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * One day's hours as "HH:MM-HH:MM" spans joined by ", ", sorted, or "closed".
 * Accepts "9:00 AM - 5:00 PM", "09:00-17:00", ["09:00-12:00", "13:00-17:00"], "Closed".
 */
export function normalizeHours(input: SurfaceValue): string | null {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/\s*[,;]\s*/) : [];
  const spans: string[] = [];
  for (const p of parts) {
    const t = String(p).trim();
    if (!t) continue;
    if (/^closed$/i.test(t)) return "closed";
    if (/^(open\s*)?24\s*hours?$/i.test(t)) return "00:00-24:00";
    const m = /^(.+?)\s*(?:-|–|—|to)\s*(.+)$/i.exec(t);
    if (!m) return null;
    const a = parseClock(m[1] ?? "");
    const b = parseClock(m[2] ?? "");
    if (!a || !b) return null;
    spans.push(`${a}-${b}`);
  }
  if (!spans.length) return null;
  spans.sort();
  return spans.join(", ");
}

export function displayHours(normalized: string): string {
  if (normalized === "closed") return "closed";
  return normalized.replace(/-/g, " to ");
}

// --------------------------------------------------------- names and text

export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeGtin(input: string): string {
  return input.replace(/\D/g, "").replace(/^0+/, "");
}

export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    let path = u.pathname.replace(/\/+$/, "");
    if (!path) path = "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return input.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/** The words only in a, and only in b, after name normalization. */
export function whatDiffers(a: string, b: string): string {
  const wa = normalizeName(a).split(" ").filter(Boolean);
  const wb = normalizeName(b).split(" ").filter(Boolean);
  const onlyA = wa.filter((w) => !wb.includes(w));
  const onlyB = wb.filter((w) => !wa.includes(w));
  const bits: string[] = [];
  if (onlyA.length) bits.push(`the record has "${onlyA.join(" ")}"`);
  if (onlyB.length) bits.push(`the surface has "${onlyB.join(" ")}"`);
  if (!bits.length) return "same words, different spacing or punctuation";
  return bits.join("; ");
}

// ------------------------------------------------------------- dispatcher

export type Family = "phone" | "address" | "price" | "availability" | "hours" | "name" | "gtin" | "url" | "notice" | "text" | "flag" | "number" | "list";

export function familyOf(key: string): Family {
  if (key === "contact.phone") return "phone";
  if (key === "contact.address") return "address";
  if (key === "identity.legal_name" || /\.name$/.test(key)) return "name";
  if (key.startsWith("hours.")) return "hours";
  if (/\.price$/.test(key)) return "price";
  if (/\.availability$/.test(key)) return "availability";
  if (/\.gtin$/.test(key)) return "gtin";
  if (/\.(url|website)$/.test(key) || key === "contact.website") return "url";
  if (/\.consumer_notice$/.test(key)) return "notice";
  return "text";
}

/** Normalize a value under its key's family. Returns null when the value cannot be read in that family. */
export function normalizeFor(key: string, value: SurfaceValue): string | null {
  const fam = familyOf(key);
  if (fam === "price") {
    const p = parsePrice(value);
    return p ? `${Number(p.amount).toFixed(2)} ${p.currency.toUpperCase()}` : null;
  }
  if (fam === "hours") return normalizeHours(value);
  if (typeof value === "object" && !Array.isArray(value)) return null;
  const s = Array.isArray(value) ? value.join(", ") : String(value);
  switch (fam) {
    case "phone":
      return normalizePhone(s);
    case "address":
      return normalizeAddress(s);
    case "name":
      return normalizeName(s);
    case "availability":
      return normalizeAvailability(s);
    case "gtin":
      return normalizeGtin(s);
    case "url":
      return normalizeUrl(s);
    default:
      return normalizeText(s);
  }
}

/** Are two values equivalent under the key's family? Prices also tolerate a missing currency on one side. */
export function equivalent(key: string, a: SurfaceValue, b: SurfaceValue): boolean {
  if (familyOf(key) === "price") {
    const pa = parsePrice(a);
    const pb = parsePrice(b);
    return Boolean(pa && pb && samePrice(pa, pb));
  }
  const na = normalizeFor(key, a);
  const nb = normalizeFor(key, b);
  if (na === null || nb === null) return false;
  return na === nb;
}

/** A value as a person would read it in an alert. */
export function displayValue(key: string, value: SurfaceValue | null): string {
  if (value === null) return "nothing";
  const fam = familyOf(key);
  if (fam === "price") {
    const p = parsePrice(value);
    return p ? displayPrice(p) : String(value);
  }
  if (fam === "phone" && typeof value === "string") {
    const p = normalizePhone(value);
    return p ? displayPhone(p) : value;
  }
  if (fam === "availability" && typeof value === "string") return displayAvailability(normalizeAvailability(value));
  if (fam === "hours") {
    const h = normalizeHours(value);
    return h ? displayHours(h) : String(value);
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return displayPrice(value);
  return String(value);
}
