// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The signed product and variant record. One record per sellable variant, so
// an agent asked about "the 500 ml blue one" finds exactly that one or is told
// plainly that the question is ambiguous. Follows GS1 General Specifications
// (release 24, January 2024) for GTIN-8, 12, 13 and 14 check digits, and the
// Google Merchant Center product data specification (2026) for which fields a
// variant must carry (item group, color, size). Signed as a JWS (RFC 7515,
// EdDSA per RFC 8037) over RFC 8785 canonical JSON; the id is the content
// address of the record without its id and signature, so the same record has
// the same id everywhere.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId, isSemantoId } from "../core/ids";
import { signObject, verifyJws, JWS_TYPES, type CompactJws } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { Evidence, ValidationIssue } from "../core/semanto";

// ---------------------------------------------------------------- types

export interface ProductAttribute {
  name: string;
  value: string;
  unit?: string;
}

export interface Ingredient {
  name: string;
  synonyms: string[];
  /** International Nomenclature of Cosmetic Ingredients name, when the product is a cosmetic. */
  inci?: string;
}

export type ConsumerNoticeType = "prop_65" | "safety_warning" | "legal_disclaimer";

export interface Regulatory {
  /** GHS hazard statements or plain hazard words, as the brand states them. */
  hazard?: string[];
  /** The consumer notice text (the Merchant Center and UCP attribute), for example a Prop 65 warning. */
  consumer_notice?: string;
  consumer_notice_type?: ConsumerNoticeType;
  /** Minimum buyer age in years. */
  age_restriction?: number;
  /** ISO 3166-1 alpha-2 codes where the product may not be sold. */
  country_restrictions?: string[];
}

export interface MediaItem {
  url: string;
  /** "sha256:" plus 64 hex of the bytes at url. */
  hash: string;
}

export interface VariantAxes {
  size?: string;
  color?: string;
  formulation?: string;
  edition?: string;
}

export const VARIANT_AXIS_NAMES = ["size", "color", "formulation", "edition"] as const;
export type VariantAxisName = (typeof VARIANT_AXIS_NAMES)[number];

export interface ProductRecord {
  object: "semanto.product";
  /** smk_ id, the content address of the record without id and signature. */
  id: string;
  product_id: string;
  variant_id?: string;
  gtin?: string;
  sku: string;
  mpn?: string;
  brand: string;
  name: string;
  description: string;
  attributes: ProductAttribute[];
  ingredients?: Ingredient[];
  regulatory: Regulatory;
  media: MediaItem[];
  url: string;
  /** For a variant: the product_id of the parent (the item group). */
  parent_product_id?: string;
  variant_axes: VariantAxes;
  /** A product record is what the brand said about its own product. */
  provenance: "declared";
  evidence: Evidence;
  not_before: string;
  not_after?: string;
}

/** What a caller supplies; the id is computed, the object word is fixed. */
export type ProductRecordInput = Omit<ProductRecord, "id" | "object"> & { object?: "semanto.product"; id?: string };

export interface SignedProductRecord {
  record: ProductRecord;
  /** Compact JWS, typ product-record, payload present. */
  jws: string;
  kid: string;
}

// ---------------------------------------------------------------- GTIN (GS1)

const GTIN_LENGTHS = [8, 12, 13, 14];

/**
 * GS1 modulo-10 check digit over the digits that precede it. Weights 3 and 1
 * alternate starting with 3 at the rightmost data digit.
 */
export function gtinCheckDigit(dataDigits: string): number {
  if (!/^\d+$/.test(dataDigits)) throw new Error("gtinCheckDigit: digits only");
  let sum = 0;
  let weight = 3;
  for (let i = dataDigits.length - 1; i >= 0; i--) {
    sum += Number(dataDigits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(gtin: unknown): gtin is string {
  if (typeof gtin !== "string" || !/^\d+$/.test(gtin)) return false;
  if (!GTIN_LENGTHS.includes(gtin.length)) return false;
  const data = gtin.slice(0, -1);
  const check = Number(gtin[gtin.length - 1]);
  return gtinCheckDigit(data) === check;
}

/** GS1 says a GTIN-8, 12 or 13 padded on the left with zeros to 14 digits names the same item. */
export function normalizeGtin(gtin: string): string {
  return gtin.padStart(14, "0");
}

// ---------------------------------------------------------------- validation

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HTTPS = /^https:\/\//;

export function validateProductRecord(input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "not an object" }];
  const r = input as Partial<ProductRecord>;
  if (r.object !== undefined && r.object !== "semanto.product") push("object", 'must be "semanto.product"');
  if (typeof r.product_id !== "string" || !r.product_id) push("product_id", "required");
  if (typeof r.sku !== "string" || !r.sku) push("sku", "required");
  if (typeof r.brand !== "string" || !r.brand) push("brand", "required");
  if (typeof r.name !== "string" || !r.name) push("name", "required");
  if (typeof r.description !== "string") push("description", "required (may be empty)");
  if (typeof r.url !== "string" || !HTTPS.test(r.url)) push("url", "https url");
  if (r.gtin !== undefined && !isValidGtin(r.gtin)) push("gtin", "GTIN-8, 12, 13 or 14 with a valid GS1 check digit");
  if (!Array.isArray(r.attributes)) push("attributes", "array");
  else r.attributes.forEach((a, i) => {
    if (!a || typeof a.name !== "string" || !a.name) push(`attributes[${i}].name`, "required");
    if (!a || typeof a.value !== "string") push(`attributes[${i}].value`, "string");
  });
  if (r.ingredients !== undefined) {
    if (!Array.isArray(r.ingredients)) push("ingredients", "array");
    else r.ingredients.forEach((g, i) => {
      if (!g || typeof g.name !== "string" || !g.name) push(`ingredients[${i}].name`, "required");
      if (!g || !Array.isArray(g.synonyms)) push(`ingredients[${i}].synonyms`, "array");
    });
  }
  if (typeof r.regulatory !== "object" || r.regulatory === null) push("regulatory", "object (may be empty)");
  else {
    const g = r.regulatory;
    if (g.age_restriction !== undefined && (!Number.isInteger(g.age_restriction) || g.age_restriction < 0)) push("regulatory.age_restriction", "whole number of years");
    if (g.country_restrictions !== undefined && (!Array.isArray(g.country_restrictions) || g.country_restrictions.some((c) => !/^[A-Z]{2}$/.test(c)))) push("regulatory.country_restrictions", "ISO 3166-1 alpha-2 codes");
    if (g.consumer_notice_type !== undefined && !["prop_65", "safety_warning", "legal_disclaimer"].includes(g.consumer_notice_type)) push("regulatory.consumer_notice_type", "prop_65, safety_warning or legal_disclaimer");
  }
  if (!Array.isArray(r.media)) push("media", "array");
  else r.media.forEach((m, i) => {
    if (!m || typeof m.url !== "string" || !HTTPS.test(m.url)) push(`media[${i}].url`, "https url");
    if (!m || !DIGEST.test(m.hash ?? "")) push(`media[${i}].hash`, "digest");
  });
  if (typeof r.variant_axes !== "object" || r.variant_axes === null) push("variant_axes", "object (may be empty)");
  else {
    for (const k of Object.keys(r.variant_axes)) {
      if (!(VARIANT_AXIS_NAMES as readonly string[]).includes(k)) push(`variant_axes.${k}`, "unknown axis");
    }
  }
  if (r.variant_id !== undefined && !r.parent_product_id) push("parent_product_id", "a variant names its parent product");
  if (r.provenance !== "declared") push("provenance", 'a product record is "declared"');
  if (!r.evidence || typeof r.evidence.url !== "string" || !HTTPS.test(r.evidence.url)) push("evidence.url", "https url");
  if (!r.evidence || !ISO.test(r.evidence.witnessed_at ?? "")) push("evidence.witnessed_at", "ISO 8601 UTC");
  if (typeof r.not_before !== "string" || !ISO.test(r.not_before)) push("not_before", "ISO 8601 UTC");
  if (r.not_after !== undefined && !ISO.test(r.not_after)) push("not_after", "ISO 8601 UTC");
  if (r.not_after !== undefined && typeof r.not_before === "string" && Date.parse(r.not_after) <= Date.parse(r.not_before)) push("not_after", "after not_before");
  return out;
}

// ---------------------------------------------------------------- ids

/** The canonical content of a record: everything except id and signature. */
export function recordContent(input: ProductRecordInput | ProductRecord): Omit<ProductRecord, "id"> {
  const copy: Record<string, unknown> = Object.assign({}, input) as Record<string, unknown>;
  delete copy.id;
  delete copy.signature;
  copy.object = "semanto.product";
  return copy as unknown as Omit<ProductRecord, "id">;
}

export async function productRecordId(input: ProductRecordInput | ProductRecord): Promise<string> {
  return semantoId("smk", await digest(canonicalize(recordContent(input))));
}

export async function buildProductRecord(input: ProductRecordInput): Promise<ProductRecord> {
  const issues = validateProductRecord(input);
  if (issues.length) throw new Error(`product record: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const content = recordContent(input);
  const id = await productRecordId(content);
  return Object.assign({ id }, content) as ProductRecord;
}

// ---------------------------------------------------------------- sign and verify

export async function signProductRecord(input: ProductRecordInput, priv: PrivateJwk, opts: { iat?: Date } = {}): Promise<SignedProductRecord> {
  const record = await buildProductRecord(input);
  const jws: CompactJws = await signObject(record, priv, JWS_TYPES.productRecord, {
    iat: opts.iat,
    nbf: new Date(record.not_before),
    exp: record.not_after ? new Date(record.not_after) : undefined,
  });
  return { record, jws: jws.compact, kid: priv.kid };
}

export type ProductRecordVerification =
  | { ok: true; record: ProductRecord; kid: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "wrong_type" | "not_yet_valid" | "expired" | "id_mismatch" | "invalid_record"; issues?: ValidationIssue[] };

export async function verifyProductRecord(
  jws: string,
  resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null,
  opts: { at?: Date } = {},
): Promise<ProductRecordVerification> {
  const v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.productRecord, at: opts.at });
  if (!v.ok) return { ok: false, reason: v.reason };
  const payload = v.payload as Partial<ProductRecord>;
  const issues = validateProductRecord(payload);
  if (payload.object !== "semanto.product" || !isSemantoId(payload.id, "smk")) issues.push({ path: "id", message: "smk_ id required" });
  if (issues.length) return { ok: false, reason: "invalid_record", issues };
  const record = payload as ProductRecord;
  if ((await productRecordId(record)) !== record.id) return { ok: false, reason: "id_mismatch" };
  return { ok: true, record, kid: v.header.kid };
}

// ---------------------------------------------------------------- variant resolution

export interface VariantQuery {
  gtin?: string;
  sku?: string;
  mpn?: string;
  product_id?: string;
  variant_id?: string;
  size?: string;
  color?: string;
  formulation?: string;
  edition?: string;
}

export type VariantResolution =
  | { kind: "one"; record: ProductRecord }
  | { kind: "ambiguous"; candidates: ProductRecord[]; /** The axes whose values differ among the candidates: ask for one of these. */ axes_to_ask: VariantAxisName[] }
  | { kind: "none" };

const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Exact matching on every field the query gives. The answer is one record, an
 * explicit list of candidates with the axes that would tell them apart, or
 * none. Never a best guess.
 */
export function resolveVariant(records: ProductRecord[], query: VariantQuery): VariantResolution {
  const given = Object.keys(query).filter((k) => (query as Record<string, unknown>)[k] !== undefined && (query as Record<string, unknown>)[k] !== "");
  if (given.length === 0) return records.length === 1 ? { kind: "one", record: records[0]! } : records.length === 0 ? { kind: "none" } : ambiguous(records);
  const wantGtin = query.gtin && /^\d+$/.test(query.gtin) ? normalizeGtin(query.gtin) : query.gtin;
  const matches = records.filter((r) => {
    if (query.gtin !== undefined && !(r.gtin !== undefined && normalizeGtin(r.gtin) === wantGtin)) return false;
    if (query.sku !== undefined && !same(r.sku, query.sku)) return false;
    if (query.mpn !== undefined && !same(r.mpn, query.mpn)) return false;
    if (query.variant_id !== undefined && !same(r.variant_id, query.variant_id)) return false;
    if (query.product_id !== undefined && !(same(r.product_id, query.product_id) || same(r.parent_product_id, query.product_id))) return false;
    for (const axis of VARIANT_AXIS_NAMES) {
      const q = query[axis];
      if (q !== undefined && !same(r.variant_axes[axis], q)) return false;
    }
    return true;
  });
  if (matches.length === 1) return { kind: "one", record: matches[0]! };
  if (matches.length === 0) return { kind: "none" };
  return ambiguous(matches);
}

function ambiguous(candidates: ProductRecord[]): VariantResolution {
  const axes_to_ask: VariantAxisName[] = [];
  for (const axis of VARIANT_AXIS_NAMES) {
    const values = new Set(candidates.map((c) => (c.variant_axes[axis] ?? "").trim().toLowerCase()));
    if (values.size > 1) axes_to_ask.push(axis);
  }
  return { kind: "ambiguous", candidates, axes_to_ask };
}
