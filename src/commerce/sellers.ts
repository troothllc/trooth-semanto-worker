// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Authorized-seller attestations. A brand signs a statement that a seller
// domain may list its products (all of them, or named skus) for a stated
// time. The provenance word is "attested": a named counterparty (the brand)
// stated it about the seller. The check answers with one of four words,
// authorized, not_listed, expired or withdrawn, and the attestation id. It
// never says a seller is good or bad. The brand's product record is the
// official specification; a listing comparison says field by field whether a
// seller's copy matches it. Signed as a JWS (RFC 7515, RFC 8037, RFC 8785).

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { semantoId, isSemantoId } from "../core/ids";
import { signObject, verifyJws, JWS_TYPES } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { Evidence, ValidationIssue } from "../core/semanto";
import type { ProductRecord, VariantAxes } from "./product-record";
import { sameAttributeName, sameAttributeValue, sameSubstance, normalizeName } from "./synonyms";

// ---------------------------------------------------------------- types

export type SellerScope = "all_products" | { skus: string[] };

export interface SellerAttestation {
  object: "semanto.seller_attestation";
  /** sms_ id, the content address of the attestation without its id. */
  id: string;
  brand_trooth_id: string;
  seller_domain: string;
  seller_trooth_id?: string;
  scope: SellerScope;
  not_before: string;
  not_after: string;
  provenance: "attested";
  evidence: Evidence;
}

export type SellerAttestationInput = Omit<SellerAttestation, "id" | "object"> & { object?: "semanto.seller_attestation"; id?: string };

export interface SignedSellerAttestation {
  attestation: SellerAttestation;
  jws: string;
  kid: string;
}

/** What the brand's store holds for one attestation: the statement, and when the brand withdrew it, if it did. */
export interface AttestationEntry {
  attestation: SellerAttestation;
  withdrawn_at?: string;
}

export interface BrandSellers {
  trooth_id: string;
  attestations: AttestationEntry[];
}

// ---------------------------------------------------------------- validation

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS = /^https:\/\//;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function validateSellerAttestation(input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "not an object" }];
  const a = input as Partial<SellerAttestation>;
  if (a.object !== undefined && a.object !== "semanto.seller_attestation") push("object", 'must be "semanto.seller_attestation"');
  if (typeof a.brand_trooth_id !== "string" || !a.brand_trooth_id) push("brand_trooth_id", "required");
  if (typeof a.seller_domain !== "string" || !DOMAIN.test(a.seller_domain)) push("seller_domain", "lowercase domain name");
  if (a.scope !== "all_products" && !(typeof a.scope === "object" && a.scope !== null && Array.isArray(a.scope.skus) && a.scope.skus.length > 0 && a.scope.skus.every((s) => typeof s === "string" && s))) push("scope", '"all_products" or { skus: [at least one] }');
  if (typeof a.not_before !== "string" || !ISO.test(a.not_before)) push("not_before", "ISO 8601 UTC");
  if (typeof a.not_after !== "string" || !ISO.test(a.not_after)) push("not_after", "ISO 8601 UTC (an attestation always ends)");
  if (typeof a.not_before === "string" && typeof a.not_after === "string" && Date.parse(a.not_after) <= Date.parse(a.not_before)) push("not_after", "after not_before");
  if (a.provenance !== "attested") push("provenance", 'a seller attestation is "attested"');
  if (!a.evidence || typeof a.evidence.url !== "string" || !HTTPS.test(a.evidence.url)) push("evidence.url", "https url");
  if (!a.evidence || !ISO.test(a.evidence.witnessed_at ?? "")) push("evidence.witnessed_at", "ISO 8601 UTC");
  return out;
}

// ---------------------------------------------------------------- build, sign, verify

export function attestationContent(input: SellerAttestationInput | SellerAttestation): Omit<SellerAttestation, "id"> {
  const copy: Record<string, unknown> = Object.assign({}, input) as Record<string, unknown>;
  delete copy.id;
  delete copy.signature;
  copy.object = "semanto.seller_attestation";
  return copy as unknown as Omit<SellerAttestation, "id">;
}

export async function sellerAttestationId(input: SellerAttestationInput | SellerAttestation): Promise<string> {
  return semantoId("sms", await digest(canonicalize(attestationContent(input))));
}

export async function buildSellerAttestation(input: SellerAttestationInput): Promise<SellerAttestation> {
  const content = attestationContent(input);
  const issues = validateSellerAttestation(content);
  if (issues.length) throw new Error(`seller attestation: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return Object.assign({ id: await sellerAttestationId(content) }, content) as SellerAttestation;
}

export async function signSellerAttestation(input: SellerAttestationInput, brandKey: PrivateJwk, opts: { iat?: Date } = {}): Promise<SignedSellerAttestation> {
  const attestation = await buildSellerAttestation(input);
  const jws = await signObject(attestation, brandKey, JWS_TYPES.sellerAttestation, { iat: opts.iat, nbf: new Date(attestation.not_before), exp: new Date(attestation.not_after) });
  return { attestation, jws: jws.compact, kid: brandKey.kid };
}

export type SellerAttestationVerification =
  | { ok: true; attestation: SellerAttestation; kid: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "wrong_type" | "not_yet_valid" | "expired" | "id_mismatch" | "invalid_attestation"; issues?: ValidationIssue[] };

export async function verifySellerAttestation(
  jws: string,
  resolveBrandKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null,
  opts: { at?: Date } = {},
): Promise<SellerAttestationVerification> {
  const v = await verifyJws(jws, resolveBrandKey, { expectTyp: JWS_TYPES.sellerAttestation, at: opts.at });
  if (!v.ok) return { ok: false, reason: v.reason };
  const payload = v.payload as Partial<SellerAttestation>;
  const issues = validateSellerAttestation(payload);
  if (payload.object !== "semanto.seller_attestation" || !isSemantoId(payload.id, "sms")) issues.push({ path: "id", message: "sms_ id required" });
  if (issues.length) return { ok: false, reason: "invalid_attestation", issues };
  const attestation = payload as SellerAttestation;
  if ((await sellerAttestationId(attestation)) !== attestation.id) return { ok: false, reason: "id_mismatch" };
  return { ok: true, attestation, kid: v.header.kid };
}

// ---------------------------------------------------------------- official spec pointer

/** The brand's product record is the official specification for a sku. This is how a seller or an agent points at it. */
export interface OfficialSpecPointer {
  object: "semanto.official_spec";
  brand_trooth_id: string;
  sku: string;
  record_id: string;
  record_url: string;
  record_hash: string;
}

export async function officialSpecPointer(brandTroothId: string, record: ProductRecord, publicBase: string): Promise<OfficialSpecPointer> {
  return {
    object: "semanto.official_spec",
    brand_trooth_id: brandTroothId,
    sku: record.sku,
    record_id: record.id,
    record_url: `${publicBase.replace(/\/$/, "")}/products/${record.id}`,
    record_hash: await digest(canonicalize(record)),
  };
}

// ---------------------------------------------------------------- authorization

export type AuthorizationState = "authorized" | "not_listed" | "expired" | "withdrawn";

export interface AuthorizationAnswer {
  state: AuthorizationState;
  /** The attestation the answer rests on; absent for not_listed. */
  attestation_id?: string;
  brand_trooth_id: string;
  seller_domain: string;
  sku: string;
  checked_at: string;
}

function coversSku(scope: SellerScope, sku: string): boolean {
  return scope === "all_products" || scope.skus.includes(sku);
}

/**
 * authorized:  an attestation covers this seller and sku, is in its window and was not withdrawn
 * withdrawn:   the brand withdrew every covering attestation
 * expired:     every covering attestation has passed its not_after
 * not_listed:  the brand made no attestation covering this seller and sku (a
 *              future-dated attestation is not_listed until its not_before)
 */
export function isAuthorized(brand: BrandSellers, seller_domain: string, sku: string, now: Date): AuthorizationAnswer {
  const domain = seller_domain.trim().toLowerCase();
  const t = now.getTime();
  const base = { brand_trooth_id: brand.trooth_id, seller_domain: domain, sku, checked_at: now.toISOString() };
  const covering = brand.attestations.filter((e) => e.attestation.brand_trooth_id === brand.trooth_id && e.attestation.seller_domain.toLowerCase() === domain && coversSku(e.attestation.scope, sku));
  if (covering.length === 0) return Object.assign({ state: "not_listed" as const }, base);
  const live = covering.filter((e) => Date.parse(e.attestation.not_before) <= t && t < Date.parse(e.attestation.not_after));
  const active = live.find((e) => !e.withdrawn_at || Date.parse(e.withdrawn_at) > t);
  if (active) return Object.assign({ state: "authorized" as const, attestation_id: active.attestation.id }, base);
  const withdrawn = covering.filter((e) => e.withdrawn_at && Date.parse(e.withdrawn_at) <= t).sort(byNotAfterDesc);
  if (withdrawn.length) return Object.assign({ state: "withdrawn" as const, attestation_id: withdrawn[0]!.attestation.id }, base);
  const expired = covering.filter((e) => Date.parse(e.attestation.not_after) <= t).sort(byNotAfterDesc);
  if (expired.length) return Object.assign({ state: "expired" as const, attestation_id: expired[0]!.attestation.id }, base);
  return Object.assign({ state: "not_listed" as const }, base);
}

function byNotAfterDesc(a: AttestationEntry, b: AttestationEntry): number {
  return Date.parse(b.attestation.not_after) - Date.parse(a.attestation.not_after);
}

// ---------------------------------------------------------------- listing comparison

/** A seller's listing for one sku, as read from the seller's page or feed. Any field may be absent. */
export interface SellerListing {
  sku: string;
  seller_domain: string;
  name?: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  description?: string;
  url?: string;
  attributes?: { name: string; value: string; unit?: string }[];
  ingredients?: string[];
  variant_axes?: VariantAxes;
  consumer_notice?: string;
}

export type FieldResult = "matches" | "mismatch" | "not_in_listing";

export interface FieldComparison {
  field: string;
  official_value: unknown;
  listing_value: unknown;
  result: FieldResult;
}

export interface ListingComparison {
  object: "semanto.listing_comparison";
  sku: string;
  seller_domain: string;
  official_record_id: string;
  fields: FieldComparison[];
  /** True only when every field the listing states matches and nothing is a mismatch. */
  all_stated_fields_match: boolean;
  mismatches: number;
  not_in_listing: number;
}

function cmpText(field: string, official: string | undefined, listing: string | undefined, eq: (a: string, b: string) => boolean): FieldComparison {
  if (listing === undefined || listing === "") return { field, official_value: official ?? null, listing_value: null, result: "not_in_listing" };
  if (official === undefined) return { field, official_value: null, listing_value: listing, result: "mismatch" };
  return { field, official_value: official, listing_value: listing, result: eq(official, listing) ? "matches" : "mismatch" };
}

const exact = (a: string, b: string) => a.trim() === b.trim();
const folded = (a: string, b: string) => normalizeName(a) === normalizeName(b);
const digits = (a: string, b: string) => a.replace(/\D/g, "").padStart(14, "0") === b.replace(/\D/g, "").padStart(14, "0");

/**
 * Field by field: name, brand, gtin, mpn, description, url, each variant
 * axis, each attribute the official record names, each official ingredient
 * (matched through the synonym table, never by similarity) and the consumer
 * notice. A field the listing leaves out is "not_in_listing", not a mismatch.
 */
export function compareListing(official: ProductRecord, listing: SellerListing): ListingComparison {
  const fields: FieldComparison[] = [];
  fields.push(cmpText("name", official.name, listing.name, folded));
  fields.push(cmpText("brand", official.brand, listing.brand, folded));
  fields.push(cmpText("gtin", official.gtin, listing.gtin, digits));
  fields.push(cmpText("mpn", official.mpn, listing.mpn, folded));
  fields.push(cmpText("description", official.description, listing.description, (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()));
  fields.push(cmpText("url", official.url, listing.url, exact));
  for (const axis of ["size", "color", "formulation", "edition"] as const) {
    const o = official.variant_axes[axis];
    const l = listing.variant_axes?.[axis];
    if (o === undefined && l === undefined) continue;
    fields.push(cmpText(`variant_axes.${axis}`, o, l, sameAttributeValue));
  }
  for (const a of official.attributes) {
    const l = listing.attributes?.find((x) => sameAttributeName(x.name, a.name));
    const ov = a.unit ? `${a.value} ${a.unit}` : a.value;
    const lv = l ? (l.unit ? `${l.value} ${l.unit}` : l.value) : undefined;
    fields.push(cmpText(`attributes.${a.name}`, ov, lv, sameAttributeValue));
  }
  if (official.ingredients && official.ingredients.length) {
    if (!listing.ingredients || listing.ingredients.length === 0) {
      fields.push({ field: "ingredients", official_value: official.ingredients.map((g) => g.name), listing_value: null, result: "not_in_listing" });
    } else {
      for (const g of official.ingredients) {
        const names = [g.name].concat(g.synonyms, g.inci ? [g.inci] : []);
        const hit = listing.ingredients.find((li) => names.some((n) => sameSubstance(n, li).same));
        fields.push({ field: `ingredients.${g.name}`, official_value: g.name, listing_value: hit ?? null, result: hit ? "matches" : "mismatch" });
      }
      for (const li of listing.ingredients) {
        const known = official.ingredients.some((g) => [g.name].concat(g.synonyms, g.inci ? [g.inci] : []).some((n) => sameSubstance(n, li).same));
        if (!known) fields.push({ field: `ingredients.${li}`, official_value: null, listing_value: li, result: "mismatch" });
      }
    }
  }
  if (official.regulatory.consumer_notice !== undefined || listing.consumer_notice !== undefined) {
    fields.push(cmpText("regulatory.consumer_notice", official.regulatory.consumer_notice, listing.consumer_notice, (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()));
  }
  const mismatches = fields.filter((f) => f.result === "mismatch").length;
  const not_in_listing = fields.filter((f) => f.result === "not_in_listing").length;
  return {
    object: "semanto.listing_comparison",
    sku: official.sku,
    seller_domain: listing.seller_domain,
    official_record_id: official.id,
    fields,
    all_stated_fields_match: mismatches === 0,
    mismatches,
    not_in_listing,
  };
}
