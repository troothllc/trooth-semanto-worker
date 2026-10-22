// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The comparison: the signed Semanto record against every surface that was
// read. Google's AI features guide (15 June 2026) and its UCP guidance for
// Merchant Center say a mismatch between what Merchant Center holds and what
// the website shows lowers trust in both; Business Profile guidance says the
// same of name, address, phone and hours. So each mismatch carries both values
// and both sources, a kind (differs, missing_on_surface, missing_in_record,
// stale) and a severity (trust when Google compares it, visibility when
// structured data is absent, note otherwise). Comparisons are tolerant
// (src/monitor/normalize.ts) so a phone written two ways is one phone.
// Output is a run object shaped like the semanto_monitor_runs table.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId } from "../core/ids";
import { displayValue, equivalent, familyOf, normalizeAddress, normalizeFor, normalizePhone, normalizeText, phonesInText, whatDiffers } from "./normalize";
import { signedFacts } from "./surfaces";
import type { IndexabilityReport, LivePageRead, Mismatch, MismatchKind, MonitorRun, MonitorRunRow, Severity, SignedFact, SignedRecord, Surface, SurfaceFact, SurfaceRead, SurfaceStatus, SurfaceValue } from "./types";

// ------------------------------------------------------------ coverage

/** Which keys a surface is expected to carry, so a missing value is only a mismatch where the surface has a field for it. */
export function surfaceCovers(surface: Surface, key: string): boolean {
  switch (surface) {
    case "merchant_center":
      return /^product\.[^.]+\.(name|price|availability|gtin|url|brand|consumer_notice)$/.test(key);
    case "ucp":
      return /^product\.[^.]+\.(name|price|availability|gtin|url|brand|consumer_notice)$/.test(key);
    case "acp":
      return /^product\.[^.]+\.(name|price|availability|gtin|url|brand)$/.test(key);
    case "business_profile":
      return /^(identity\.legal_name|contact\.phone|contact\.address|contact\.website|hours\.[a-z]+)$/.test(key);
    case "live_page":
      return false;
    case "semanto":
      return false;
  }
}

const TRUST_KEY = /^(contact\.phone|contact\.address|identity\.legal_name|hours\.[a-z]+|product\.[^.]+\.(price|availability|name))$/;

export function severityFor(key: string, kind: MismatchKind): Severity {
  if (key === "page.jsonld") return "visibility";
  if (kind === "missing_in_record") return "note";
  if (TRUST_KEY.test(key)) return "trust";
  return "note";
}

/** Keys worth reporting when a surface has them and the record does not. */
const RECORD_WORTHY = /^(identity\.legal_name|contact\.phone|contact\.address|hours\.[a-z]+|product\.[^.]+\.(price|availability|name|gtin|consumer_notice))$/;

// ----------------------------------------------------------- comparing

function mismatch(kind: MismatchKind, key: string, signed: SignedFact | null, surface: Surface, found: SurfaceFact | null, surfaceUrl: string | null, observed: string | null, detail?: string): Mismatch {
  const m: Mismatch = {
    key,
    signed_value: signed ? signed.value : null,
    signed_fact_id: signed ? signed.fact_id : null,
    signed_evidence_url: signed ? signed.evidence_url : null,
    signed_witnessed_at: signed ? signed.witnessed_at : null,
    surface,
    surface_value: found ? found.value : null,
    surface_url: found ? found.url : surfaceUrl,
    surface_observed_at: found ? found.observed_at : observed,
    kind,
    severity: severityFor(key, kind),
  };
  if (detail) m.detail = detail;
  return m;
}

function isStale(signed: SignedFact, found: SurfaceFact): boolean {
  const a = Date.parse(found.observed_at);
  const b = Date.parse(signed.witnessed_at);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

function differenceDetail(key: string, signed: SurfaceValue, found: SurfaceValue): string {
  const fam = familyOf(key);
  if (fam === "name" || fam === "text" || fam === "notice" || fam === "address") return whatDiffers(String(Array.isArray(signed) ? signed.join(" ") : typeof signed === "object" ? "" : signed), String(Array.isArray(found) ? found.join(" ") : typeof found === "object" ? "" : found));
  return `record ${displayValue(key, signed)}, surface ${displayValue(key, found)}`;
}

/** Compare one value-bearing surface (feed or listing) against the signed facts. */
export function compareSurface(signed: SignedFact[], read: SurfaceRead): Mismatch[] {
  const out: Mismatch[] = [];
  const byKey = new Map<string, SurfaceFact>();
  for (const f of read.facts) if (!byKey.has(f.key)) byKey.set(f.key, f);
  const signedKeys = new Set<string>();
  for (const s of signed) {
    signedKeys.add(s.key);
    const found = byKey.get(s.key);
    if (!found) {
      if (surfaceCovers(read.surface, s.key) && surfaceHasAnyOf(read, s.key)) out.push(mismatch("missing_on_surface", s.key, s, read.surface, null, read.url, read.observed_at));
      continue;
    }
    if (equivalent(s.key, s.value, found.value)) continue;
    const detail = differenceDetail(s.key, s.value, found.value);
    out.push(mismatch(isStale(s, found) ? "stale" : "differs", s.key, s, read.surface, found, null, null, detail));
  }
  const productsInRecord = new Set<string>();
  for (const k of signedKeys) {
    const m = /^product\.([^.]+)\./.exec(k);
    if (m && m[1]) productsInRecord.add(m[1]);
  }
  const reported = new Set<string>();
  for (const f of read.facts) {
    if (signedKeys.has(f.key)) continue;
    const pm = /^product\.([^.]+)\./.exec(f.key);
    if (pm && pm[1]) {
      if (productsInRecord.has(pm[1])) {
        if (RECORD_WORTHY.test(f.key)) out.push(mismatch("missing_in_record", f.key, null, read.surface, f, null, null));
      } else if (!reported.has(pm[1])) {
        reported.add(pm[1]);
        const nameFact = read.facts.find((x) => x.key === `product.${pm[1]}.name`);
        out.push(mismatch("missing_in_record", `product.${pm[1]}`, null, read.surface, nameFact ?? f, null, null, "this product is on the surface but not in the signed record"));
      }
      continue;
    }
    if (RECORD_WORTHY.test(f.key)) out.push(mismatch("missing_in_record", f.key, null, read.surface, f, null, null));
  }
  return out;
}

/** For product keys: the surface lists this product at all (otherwise the whole product is reported once, not every field). */
function surfaceHasAnyOf(read: SurfaceRead, key: string): boolean {
  const pm = /^product\.([^.]+)\./.exec(key);
  if (!pm) return true;
  const prefix = `product.${pm[1]}.`;
  return read.facts.some((f) => f.key.startsWith(prefix));
}

/** Products in the record that a product surface does not list at all. */
export function productsMissingOnSurface(signed: SignedFact[], read: SurfaceRead): Mismatch[] {
  if (!(read.surface === "merchant_center" || read.surface === "acp" || read.surface === "ucp")) return [];
  const out: Mismatch[] = [];
  const seen = new Set<string>();
  for (const s of signed) {
    const pm = /^product\.([^.]+)\./.exec(s.key);
    if (!pm || !pm[1] || seen.has(pm[1])) continue;
    seen.add(pm[1]);
    const prefix = `product.${pm[1]}.`;
    if (read.facts.some((f) => f.key.startsWith(prefix))) continue;
    if (read.surface === "ucp" && !read.facts.some((f) => f.key.startsWith("product."))) continue;
    const nameFact = signed.find((x) => x.key === `${prefix}name`) ?? s;
    out.push(mismatch("missing_on_surface", `product.${pm[1]}`, nameFact, read.surface, null, read.url, read.observed_at, "this product is in the signed record but not on the surface"));
  }
  return out;
}

/**
 * Compare a live page. Structured values the page emits are compared like any
 * surface; for a fact whose evidence is this page and which the page's data
 * does not carry, the visible text is searched for the value. A page without
 * any JSON-LD gets one visibility mismatch; a page whose bytes changed since
 * the record was signed gets a page.content note with both dates.
 */
export function compareLivePage(record: SignedRecord, signed: SignedFact[], page: LivePageRead): Mismatch[] {
  const out: Mismatch[] = [];
  if (page.status !== 200) return out;
  const byKey = new Map<string, SurfaceFact>();
  for (const f of page.facts) if (!byKey.has(f.key)) byKey.set(f.key, f);
  const pageUrl = normalizeFor("x.url", page.url);
  const entry = record.pages.find((p) => normalizeFor("x.url", p.url) === pageUrl);
  for (const s of signed) {
    const found = byKey.get(s.key);
    if (found) {
      if (!equivalent(s.key, s.value, found.value)) out.push(mismatch("differs", s.key, s, "live_page", found, null, null, differenceDetail(s.key, s.value, found.value)));
      continue;
    }
    if (normalizeFor("x.url", s.evidence_url) !== pageUrl) continue;
    if (familyOf(s.key) === "hours" || familyOf(s.key) === "price" || typeof s.value === "boolean") continue;
    if (!textCarries(s.key, s.value, page.text)) out.push(mismatch("missing_on_surface", s.key, s, "live_page", null, page.url, page.observed_at, "the page text no longer shows this value"));
  }
  if (!page.jsonld.length) out.push(mismatch("missing_on_surface", "page.jsonld", null, "live_page", null, page.url, page.observed_at, "no JSON-LD block on the page"));
  if (entry && entry.source_hash !== page.source_hash) {
    const m = mismatch("differs", "page.content", null, "live_page", null, page.url, page.observed_at, `page changed since it was signed; signed ${entry.witnessed_at}, seen ${page.observed_at}`);
    m.signed_witnessed_at = entry.witnessed_at;
    m.signed_evidence_url = entry.url;
    m.signed_value = entry.source_hash;
    m.surface_value = page.source_hash;
    out.push(m);
  }
  return out;
}

function textCarries(key: string, value: SurfaceValue, text: string): boolean {
  const fam = familyOf(key);
  if (fam === "phone" && typeof value === "string") {
    const want = normalizePhone(value);
    return want !== null && phonesInText(text).includes(want);
  }
  if (fam === "address" && typeof value === "string") return normalizeAddress(text).includes(normalizeAddress(value));
  const hay = ` ${normalizeText(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const items = Array.isArray(value) ? value : typeof value === "object" ? [] : [String(value)];
  for (const item of items) {
    const needle = normalizeText(item).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (needle && !hay.includes(` ${needle} `)) return false;
  }
  return true;
}

// -------------------------------------------------------------- the run

export interface CompareInput {
  record: SignedRecord;
  /** Every surface that was read. Absent surfaces are simply not here; they are listed in `statuses`. */
  reads: SurfaceRead[];
  pages: LivePageRead[];
  at: string;
}

export function compareAll(input: CompareInput): Mismatch[] {
  const signed = signedFacts(input.record, input.at);
  let out: Mismatch[] = [];
  for (const read of input.reads) {
    if (read.surface === "semanto" || read.surface === "live_page") continue;
    out = out.concat(compareSurface(signed, read), productsMissingOnSurface(signed, read));
  }
  for (const page of input.pages) out = out.concat(compareLivePage(input.record, signed, page));
  return sortMismatches(out);
}

const SEVERITY_ORDER: Record<Severity, number> = { trust: 0, visibility: 1, note: 2 };
const KIND_ORDER: Record<MismatchKind, number> = { differs: 0, stale: 1, missing_on_surface: 2, missing_in_record: 3 };

export function sortMismatches(list: Mismatch[]): Mismatch[] {
  return list.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key) || a.surface.localeCompare(b.surface));
}

export function countBySeverity(list: Mismatch[]): Record<Severity, number> {
  const c: Record<Severity, number> = { trust: 0, visibility: 0, note: 0 };
  for (const m of list) c[m.severity] += 1;
  return c;
}

export async function buildRun(trooth_id: string, ran_at: string, surfaces: SurfaceStatus[], mismatches: Mismatch[], indexability: IndexabilityReport): Promise<MonitorRun> {
  const body = { trooth_id, ran_at, surfaces, mismatches, indexability };
  const id = semantoId("smm", await digest(canonicalize(body)));
  return { id, trooth_id, ran_at, surfaces, mismatches, indexability };
}

export function runToRow(run: MonitorRun): MonitorRunRow {
  return {
    id: run.id,
    trooth_id: run.trooth_id,
    ran_at: run.ran_at,
    surfaces_json: JSON.stringify(run.surfaces),
    mismatches_json: JSON.stringify(run.mismatches),
    indexability_json: JSON.stringify(run.indexability),
  };
}

export function runFromRow(row: MonitorRunRow): MonitorRun {
  return {
    id: row.id,
    trooth_id: row.trooth_id,
    ran_at: row.ran_at,
    surfaces: JSON.parse(row.surfaces_json) as SurfaceStatus[],
    mismatches: JSON.parse(row.mismatches_json) as Mismatch[],
    indexability: JSON.parse(row.indexability_json) as IndexabilityReport,
  };
}
