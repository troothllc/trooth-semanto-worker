// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Legal Entity Identifier binding.
//
//   format     ISO 17442: 20 characters, 18 alphanumeric plus two check
//              digits computed with ISO/IEC 7064 MOD 97-10 (the IBAN scheme).
//   lookup     the GLEIF API, https://api.gleif.org/api/v1/lei-records/<lei>
//              (JSON:API, GLEIF API v1 documentation), read behind a port.
//              What comes back is a public_record fact: evidence.source "GLEIF"
//              and the URL that was read. Trooth reports what the registry
//              says; it does not say the record is true.
//   name       a tolerant comparison of the registered legal name with the
//              name the company declared, that says what differs.
//   vLEI       a credential reference { said, issuer, schema } is recorded as
//              presented, not checked, until a KERI/ACDC verifier is wired
//              (GLEIF vLEI Ecosystem Governance Framework). The header's
//              `vlei.checked_at` is only ever set from a real check.

import { digest } from "@/core/hash";
import { canonicalize } from "@/core/canonical";
import { factId, type Fact } from "@/core/semanto";
import type { HttpPort, VleiCheck, VleiCredentialRef, VleiVerifier } from "./ports";

// ---------------------------------------------------------------- format and check digits

export const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;

/** ISO 7064 MOD 97-10 over the whole string, letters as 10 to 35. Valid when the remainder is 1. */
export function mod97(s: string): number {
  let rem = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const v = code >= 48 && code <= 57 ? ch : code >= 65 && code <= 90 ? String(code - 55) : null;
    if (v === null) throw new Error(`mod97: character ${ch} is not allowed`);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem;
}

export type LeiFormat = { ok: true; lei: string } | { ok: false; reason: string };

export function validateLei(input: string): LeiFormat {
  const lei = input.trim().toUpperCase();
  if (lei.length !== 20) return { ok: false, reason: "An LEI is 20 characters." };
  if (!LEI_RE.test(lei)) return { ok: false, reason: "An LEI is 18 letters or digits followed by two digits." };
  if (mod97(lei) !== 1) return { ok: false, reason: "The check digits do not match the rest of the LEI (ISO 7064 MOD 97-10)." };
  return { ok: true, lei };
}

/** The two check digits for an 18-character prefix. */
export function leiCheckDigits(prefix18: string): string {
  const p = prefix18.toUpperCase();
  if (!/^[A-Z0-9]{18}$/.test(p)) throw new Error("leiCheckDigits: 18 letters or digits");
  const check = 98 - mod97(`${p}00`);
  return String(check).padStart(2, "0");
}

// ---------------------------------------------------------------- GLEIF lookup

export const GLEIF_BASE = "https://api.gleif.org/api/v1/lei-records/";

export interface LeiRecord {
  lei: string;
  legal_name: string;
  legal_name_language: string | null;
  /** The entity status GLEIF reports: ACTIVE, INACTIVE, or another registry word. */
  entity_status: string;
  /** The registration status: ISSUED, LAPSED, RETIRED, and the other GLEIF words. */
  registration_status: string;
  /** True only when the entity is ACTIVE and the registration is ISSUED. */
  active: boolean;
  legal_address_country: string | null;
  headquarters_country: string | null;
  jurisdiction: string | null;
  last_update: string | null;
  next_renewal: string | null;
  /** The URL read, kept as evidence. */
  url: string;
  read_at: string;
}

export type LeiLookup = { ok: true; record: LeiRecord } | { ok: false; reason: "bad_format" | "not_found" | "unavailable" | "malformed"; sentence: string };

interface GleifDoc {
  data?: {
    attributes?: {
      lei?: string;
      entity?: {
        legalName?: { name?: string; language?: string };
        legalAddress?: { country?: string };
        headquartersAddress?: { country?: string };
        status?: string;
        jurisdiction?: string;
      };
      registration?: { status?: string; lastUpdateDate?: string; nextRenewalDate?: string };
    };
  };
}

export async function lookupLei(input: string, http: HttpPort, now: Date = new Date(), base: string = GLEIF_BASE): Promise<LeiLookup> {
  const f = validateLei(input);
  if (!f.ok) return { ok: false, reason: "bad_format", sentence: f.reason };
  const url = `${base}${f.lei}`;
  let res: Awaited<ReturnType<HttpPort["get"]>>;
  try {
    res = await http.get(url, { accept: "application/vnd.api+json" });
  } catch (e) {
    return { ok: false, reason: "unavailable", sentence: `GLEIF could not be reached: ${(e as Error).message}` };
  }
  if (res.status === 404) return { ok: false, reason: "not_found", sentence: `GLEIF has no record for ${f.lei}.` };
  if (res.status !== 200) return { ok: false, reason: "unavailable", sentence: `GLEIF answered HTTP ${res.status}.` };
  let doc: GleifDoc;
  try {
    doc = JSON.parse(res.body) as GleifDoc;
  } catch {
    return { ok: false, reason: "malformed", sentence: "GLEIF answered with something that is not JSON." };
  }
  const a = doc.data?.attributes;
  const name = a?.entity?.legalName?.name;
  if (!a || typeof name !== "string" || !name) return { ok: false, reason: "malformed", sentence: "The GLEIF record has no legal name." };
  const entity_status = a.entity?.status ?? "UNKNOWN";
  const registration_status = a.registration?.status ?? "UNKNOWN";
  return {
    ok: true,
    record: {
      lei: f.lei,
      legal_name: name,
      legal_name_language: a.entity?.legalName?.language ?? null,
      entity_status,
      registration_status,
      active: entity_status === "ACTIVE" && registration_status === "ISSUED",
      legal_address_country: a.entity?.legalAddress?.country ?? null,
      headquarters_country: a.entity?.headquartersAddress?.country ?? null,
      jurisdiction: a.entity?.jurisdiction ?? null,
      last_update: a.registration?.lastUpdateDate ?? null,
      next_renewal: a.registration?.nextRenewalDate ?? null,
      url,
      read_at: now.toISOString(),
    },
  };
}

/** The public_record facts from a GLEIF record. Provenance is never anything else. */
export async function leiFacts(record: LeiRecord): Promise<Fact[]> {
  const evidence = { url: record.url, witnessed_at: record.read_at, source: "GLEIF" };
  const bodies: Omit<Fact, "id">[] = [
    {
      key: "identity.lei",
      statement: `GLEIF lists LEI ${record.lei} for ${record.legal_name}. Entity status ${record.entity_status}, registration ${record.registration_status}.`,
      value: record.lei,
      provenance: "public_record",
      evidence,
      schema: { type: "Organization", property: "leiCode" },
    },
    {
      key: "identity.legal_name",
      statement: `The legal name on the LEI record is ${record.legal_name}.`,
      value: record.legal_name,
      provenance: "public_record",
      evidence,
      schema: { type: "Organization", property: "legalName" },
    },
  ];
  if (record.legal_address_country) {
    bodies.push({
      key: "identity.registered_country",
      statement: `The legal address on the LEI record is in ${record.legal_address_country}.`,
      value: record.legal_address_country,
      provenance: "public_record",
      evidence,
    });
  }
  return Promise.all(bodies.map(async (b) => ({ id: await factId(b), ...b })));
}

// ---------------------------------------------------------------- name comparison

const SUFFIXES = new Set([
  "inc", "incorporated", "llc", "l.l.c", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "ag", "sa", "s.a", "nv", "n.v", "bv", "b.v", "llp", "lp", "pty", "srl", "s.r.l", "sas", "oy", "ab", "as", "kk", "se", "ug", "pte", "pvt",
]);

export function normalizeName(name: string): { full: string[]; core: string[] } {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/\.+$/, ""))
    .filter(Boolean);
  const full = base.map((t) => t.replace(/\./g, ""));
  const core = [...full];
  while (core.length > 1 && SUFFIXES.has(core[core.length - 1]!)) core.pop();
  return { full, core: core.filter((t) => t !== "the") };
}

export type NameMatchKind = "match" | "match_ignoring_suffix" | "close" | "different";

export interface NameMatch {
  kind: NameMatchKind;
  declared: string;
  registered: string;
  /** Words only in the declared name. */
  only_in_declared: string[];
  /** Words only in the registered name. */
  only_in_registered: string[];
  /** Plain words. */
  sentence: string;
}

export function compareLegalName(declared: string, registered: string): NameMatch {
  const d = normalizeName(declared);
  const r = normalizeName(registered);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
  const setD = new Set(d.core);
  const setR = new Set(r.core);
  const only_in_declared = d.core.filter((t) => !setR.has(t));
  const only_in_registered = r.core.filter((t) => !setD.has(t));
  if (same(d.full, r.full)) return { kind: "match", declared, registered, only_in_declared: [], only_in_registered: [], sentence: "The declared name matches the registered name." };
  if (same(d.core, r.core)) return { kind: "match_ignoring_suffix", declared, registered, only_in_declared: [], only_in_registered: [], sentence: `The names match apart from the company suffix: "${declared}" and "${registered}".` };
  const union = new Set([...setD, ...setR]).size;
  const inter = [...setD].filter((t) => setR.has(t)).length;
  const jaccard = union === 0 ? 0 : inter / union;
  const diff = [only_in_declared.length ? `declared has ${only_in_declared.join(", ")}` : "", only_in_registered.length ? `registered has ${only_in_registered.join(", ")}` : ""].filter(Boolean).join("; ");
  if (jaccard >= 0.6) return { kind: "close", declared, registered, only_in_declared, only_in_registered, sentence: `The names are close but not the same: ${diff}.` };
  return { kind: "different", declared, registered, only_in_declared, only_in_registered, sentence: `The declared name "${declared}" is not the registered name "${registered}": ${diff || "no words in common"}.` };
}

// ---------------------------------------------------------------- vLEI slot

export type VleiStatus = "presented_not_checked" | "checked" | "failed";

export interface VleiRecord {
  said: string;
  issuer: string;
  schema: string;
  presented_at: string;
  status: VleiStatus;
  /** Only set when status is "checked". */
  checked_at: string | null;
  lei: string | null;
  sentence: string;
}

export function validateVleiRef(ref: unknown): { ok: true; ref: VleiCredentialRef } | { ok: false; reason: string } {
  if (typeof ref !== "object" || ref === null) return { ok: false, reason: "A vLEI reference is an object with said, issuer and schema." };
  const r = ref as Record<string, unknown>;
  for (const k of ["said", "issuer", "schema"] as const) {
    if (typeof r[k] !== "string" || !/^[A-Za-z0-9_-]{44}$/.test(r[k] as string)) return { ok: false, reason: `${k} must be a 44-character CESR self-addressing identifier.` };
  }
  return { ok: true, ref: { said: r.said as string, issuer: r.issuer as string, schema: r.schema as string } };
}

/** Record a presented vLEI. The verifier decides the status; the stub always answers "not wired", so the record says "presented, not checked". */
export async function recordVlei(input: unknown, verifier: VleiVerifier, now: Date = new Date()): Promise<{ ok: true; record: VleiRecord } | { ok: false; reason: string }> {
  const v = validateVleiRef(input);
  if (!v.ok) return v;
  const check: VleiCheck = await verifier.verify(v.ref);
  const base = { said: v.ref.said, issuer: v.ref.issuer, schema: v.ref.schema, presented_at: now.toISOString() };
  if (check.status === "checked") return { ok: true, record: { ...base, status: "checked", checked_at: check.checked_at, lei: check.lei, sentence: `The vLEI credential was checked on ${check.checked_at.slice(0, 10)} and names LEI ${check.lei}.` } };
  if (check.status === "failed") return { ok: true, record: { ...base, status: "failed", checked_at: null, lei: null, sentence: `The vLEI credential did not check out: ${check.reason}` } };
  return { ok: true, record: { ...base, status: "presented_not_checked", checked_at: null, lei: null, sentence: check.sentence } };
}

/** What goes into the Semanto header. Nothing, unless the credential was checked. */
export function vleiForHeader(record: VleiRecord | null): { said: string; issuer: string; checked_at: string } | undefined {
  if (!record || record.status !== "checked" || !record.checked_at) return undefined;
  return { said: record.said, issuer: record.issuer, checked_at: record.checked_at };
}

/** A stable digest of a vLEI record, for the log. */
export async function vleiRecordHash(record: VleiRecord): Promise<string> {
  return digest(canonicalize(record));
}
