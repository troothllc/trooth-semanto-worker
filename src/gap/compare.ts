// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Compare what an assistant said with what the company signed. For each fact
// key a question maps to, a simple extractor reads the claim out of the
// answer (money, booleans, hours, phone numbers, addresses, percentages, day
// counts, named values), then the claim is classified against the signed
// fact:
//
//   matches             the claim agrees with the signed value
//   differs             the claim disagrees; the signed statement is the correction
//   not_answered        the answer says nothing about the key
//   unsupported_claim   the answer states something the record does not cover
//                       (no fact, or a fact whose value is not_published or
//                       not_read)
//   cites_third_party   the claim agrees, but no citation is the company's own
//                       domain or the Trooth Network, so the assistant took it
//                       from someone else
//
// Every finding also says where the citations pointed: the company's own
// domain, the Trooth Network, neither, or there were none. Extractors are
// deliberately simple and stated: the signed statement is always printed next
// to the claim so a person can see both. No number here is a judgment of the
// company; it is a count of what an assistant said.

import type { Fact, Negative } from "../core/semanto";
import { sameFactKey } from "../core/fact-keys";
import { keyInfo, type KeyType, type Question } from "./prompts";
import type { Citation, ProviderAnswer } from "./providers";

export type Classification = "matches" | "differs" | "not_answered" | "unsupported_claim" | "cites_third_party";
export const CLASSIFICATIONS: Classification[] = ["matches", "differs", "not_answered", "unsupported_claim", "cites_third_party"];

export type CitationNote = "own_domain" | "trooth_network" | "neither" | "none";

export interface Claim {
  /** The normalized value read out of the answer. */
  value: string | number | boolean;
  /** The sentence it was read from. */
  text: string;
}

export interface Finding {
  provider: ProviderAnswer["provider"];
  question_id: string;
  question: string;
  key: string;
  classification: Classification;
  /** What the assistant said about this key, or null when it said nothing. */
  said: string | null;
  /** The signed statement, or null when the record has no fact under the key. */
  signed_statement: string | null;
  signed_value: Fact["value"] | null;
  fact_id: string | null;
  evidence_url: string | null;
  provenance: Fact["provenance"] | null;
  citation: CitationNote;
}

export interface CompareContext {
  facts: Fact[];
  /** The company's domains, so a citation can be recognized as its own. */
  domains: string[];
  /** The Trooth Network base, for example https://trooth.co/network/company. */
  networkBase: string;
}

const NEGATIVES: Negative[] = ["no", "not_published", "not_read"];

// ------------------------------------------------------------------ text helpers

export function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s*\-#>]+/, "").trim())
    .filter(Boolean);
}

export function mentions(sentence: string, terms: string[]): boolean {
  const low = sentence.toLowerCase();
  return terms.some((t) => low.includes(t.toLowerCase()));
}

function sentencesAbout(text: string, terms: string[], focus?: string): string[] {
  const all = sentences(text);
  const about = all.filter((s) => mentions(s, terms));
  if (!focus) return about;
  const focused = about.filter((s) => mentions(s, [focus]));
  return focused.length ? focused : about;
}

const NEGATION = /\b(not|no|never|without|lacks?|doesn't|does not|don't|do not|isn't|is not|aren't|are not|cannot|can't|unavailable|neither)\b/i;

// ------------------------------------------------------------------ extractors

const MONEY_RE = /(?:([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|EUR|GBP|dollars|euros|pounds))/i;

export function extractMoney(text: string, terms: string[], focus?: string): Claim | null {
  const pool = sentencesAbout(text, terms, focus);
  const candidates = pool.length ? pool : focus ? sentences(text).filter((s) => mentions(s, [focus])) : [];
  for (const s of candidates) {
    const m = MONEY_RE.exec(s);
    if (!m) continue;
    const amount = Number((m[2] ?? m[3] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    return { value: amount, text: s };
  }
  return null;
}

export function extractBoolean(text: string, terms: string[], focus?: string): Claim | null {
  const pool = sentencesAbout(text, terms, focus);
  if (!pool.length) return null;
  const s = pool[0]!;
  return { value: !NEGATION.test(s), text: s };
}

const HOURS_RE = /(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)?\s?(?:-|–|—|to|until)\s?(\d{1,2})(?::(\d{2}))?\s?(a\.?m\.?|p\.?m\.?)/i;

function to24(h: number, min: string | undefined, ap: string | undefined, fallbackAp: string | undefined): string {
  const a = (ap ?? fallbackAp ?? "").toLowerCase().replace(/\./g, "");
  let hh = h % 12;
  if (a.startsWith("p")) hh += 12;
  if (!a && h >= 12) hh = h;
  return `${String(hh).padStart(2, "0")}:${min ?? "00"}`;
}

export function normalizeHours(s: string): string | null {
  const m = HOURS_RE.exec(s);
  if (!m) return null;
  const open = to24(Number(m[1]), m[2], m[3], m[6]);
  const close = to24(Number(m[4]), m[5], m[6], undefined);
  return `${open}-${close}`;
}

export function extractHours(text: string, terms: string[], focus?: string): Claim | null {
  const pool = sentencesAbout(text, terms, focus);
  for (const s of pool.length ? pool : sentences(text)) {
    const v = normalizeHours(s);
    if (v) return { value: v, text: s };
  }
  for (const s of pool) if (/\bclosed\b/i.test(s)) return { value: "closed", text: s };
  return null;
}

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

export function normalizePhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function extractPhone(text: string, terms: string[]): Claim | null {
  const pool = sentencesAbout(text, terms);
  for (const s of pool.length ? pool : sentences(text)) {
    const m = PHONE_RE.exec(s);
    if (m && normalizePhone(m[1]!).length >= 7) return { value: normalizePhone(m[1]!), text: s };
  }
  return null;
}

const STREET = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Square|Sq|Terrace|Highway|Hwy)";
const ADDRESS_RE = new RegExp(`(\\d{1,6}\\s+[A-Za-z0-9.'\\s]{2,40}?\\s${STREET})\\b\\.?`, "i");
const ABBREV: Record<string, string> = { st: "street", ave: "avenue", rd: "road", blvd: "boulevard", ln: "lane", dr: "drive", ct: "court", pl: "place", sq: "square", hwy: "highway" };

export function normalizeAddress(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREV[w] ?? w)
    .join(" ");
}

export function extractAddress(text: string, terms: string[]): Claim | null {
  const pool = sentencesAbout(text, terms);
  for (const s of pool.length ? pool : sentences(text)) {
    const m = ADDRESS_RE.exec(s);
    if (m) return { value: normalizeAddress(m[1]!), text: s };
  }
  return null;
}

export function extractPercent(text: string, terms: string[]): Claim | null {
  for (const s of sentencesAbout(text, terms)) {
    const m = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(s);
    if (m) return { value: Number(m[1]), text: s };
  }
  return null;
}

export function extractDays(text: string, terms: string[]): Claim | null {
  for (const s of sentencesAbout(text, terms)) {
    const m = /(\d{1,4})\s?(?:calendar\s|business\s)?days?\b/i.exec(s);
    if (m) return { value: Number(m[1]), text: s };
    const w = /(one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|sixty|ninety)\s(?:calendar\s|business\s)?days?\b/i.exec(s);
    if (w) return { value: WORDS[w[1]!.toLowerCase()] ?? 0, text: s };
  }
  return null;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };

export function extractNamed(text: string, terms: string[], focus?: string): Claim | null {
  const pool = sentencesAbout(text, terms, focus);
  return pool.length ? { value: pool[0]!, text: pool[0]! } : null;
}

export function extractClaim(type: KeyType, text: string, terms: string[], focus?: string): Claim | null {
  switch (type) {
    case "money": return extractMoney(text, terms, focus);
    case "boolean": return extractBoolean(text, terms, focus);
    case "hours": return extractHours(text, terms, focus);
    case "phone": return extractPhone(text, terms);
    case "address": return extractAddress(text, terms);
    case "percent": return extractPercent(text, terms);
    case "days": return extractDays(text, terms);
    case "named":
    case "list":
    case "text":
      return extractNamed(text, terms, focus);
  }
}

// ------------------------------------------------------------------ comparison of values

function moneyOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = MONEY_RE.exec(v) ?? /(\d[\d,]*(?:\.\d{1,2})?)/.exec(v);
    if (m) return Number((m[2] ?? m[3] ?? m[1] ?? "").replace(/,/g, ""));
  }
  return null;
}

function factBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "no") return false;
  if (typeof v === "string") {
    const low = v.toLowerCase();
    if (["yes", "true", "supported", "offered"].includes(low)) return true;
    if (["false", "none", "not offered", "not supported"].includes(low)) return false;
  }
  return null;
}

export function valuesAgree(type: KeyType, claim: Claim["value"], fact: Fact): boolean {
  const v = fact.value;
  switch (type) {
    case "money": {
      const f = moneyOf(v) ?? moneyOf(fact.statement);
      return f !== null && typeof claim === "number" && Math.abs(claim - f) < 0.005;
    }
    case "boolean": {
      const f = factBoolean(v);
      return f !== null && claim === f;
    }
    case "hours": {
      const f = typeof v === "string" ? (normalizeHours(v) ?? v.toLowerCase()) : normalizeHours(fact.statement);
      return f !== null && String(claim).toLowerCase() === f;
    }
    case "phone": {
      const f = typeof v === "string" ? normalizePhone(v) : normalizePhone(fact.statement);
      return f.length > 0 && claim === f;
    }
    case "address": {
      const f = normalizeAddress(typeof v === "string" ? v : fact.statement);
      const cl = String(claim);
      return f.includes(cl) || cl.includes(f);
    }
    case "percent": {
      const f = typeof v === "number" ? v : typeof v === "string" ? Number(/(\d{1,3}(?:\.\d+)?)/.exec(v)?.[1]) : NaN;
      return Number.isFinite(f) && typeof claim === "number" && Math.abs(claim - f) < 0.0001;
    }
    case "days": {
      const f = typeof v === "number" ? v : typeof v === "string" ? Number(/(\d{1,4})/.exec(v)?.[1]) : NaN;
      return Number.isFinite(f) && claim === f;
    }
    case "named":
    case "text": {
      const needle = typeof v === "string" ? v : fact.statement;
      return String(claim).toLowerCase().includes(needle.toLowerCase());
    }
    case "list": {
      const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      if (!items.length) return false;
      const low = String(claim).toLowerCase();
      return items.some((i) => low.includes(String(i).toLowerCase()));
    }
  }
}

// ------------------------------------------------------------------ citations

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function citationNote(citations: Citation[], domains: string[], networkBase: string): CitationNote {
  if (!citations.length) return "none";
  const own = domains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  const network = hostOf(networkBase);
  let sawOwn = false;
  let sawNetwork = false;
  for (const c of citations) {
    const h = hostOf(c.url);
    if (!h) continue;
    if (own.some((d) => h === d || h.endsWith(`.${d}`))) sawOwn = true;
    if (network && (h === network || h.endsWith(`.${network}`))) sawNetwork = true;
  }
  if (sawOwn) return "own_domain";
  if (sawNetwork) return "trooth_network";
  return "neither";
}

// ------------------------------------------------------------------ the comparison

export function compareAnswer(question: Question, answer: ProviderAnswer, ctx: CompareContext): Finding[] {
  const citation = citationNote(answer.citations, ctx.domains, ctx.networkBase);
  const out: Finding[] = [];
  for (const key of question.keys) {
    const info = keyInfo(key);
    const fact = ctx.facts.find((f) => sameFactKey(f.key, key)) ?? null;
    const claim = answer.answer_text ? extractClaim(info.type, answer.answer_text, info.terms, question.product) : null;
    const base = {
      provider: answer.provider,
      question_id: question.id,
      question: question.text,
      key,
      said: claim ? claim.text : null,
      signed_statement: fact ? fact.statement : null,
      signed_value: fact ? (fact.value ?? null) : null,
      fact_id: fact ? fact.id : null,
      evidence_url: fact ? fact.evidence.url : null,
      provenance: fact ? fact.provenance : null,
      citation,
    };
    let classification: Classification;
    const uncovered = !fact || fact.value === "not_published" || fact.value === "not_read";
    if (!claim) classification = "not_answered";
    else if (uncovered) classification = "unsupported_claim";
    else if (!valuesAgree(info.type, claim.value, fact)) classification = "differs";
    else classification = citation === "neither" ? "cites_third_party" : "matches";
    out.push({ ...base, classification });
  }
  return out;
}

export function isNegative(v: unknown): v is Negative {
  return typeof v === "string" && (NEGATIVES as string[]).includes(v);
}
