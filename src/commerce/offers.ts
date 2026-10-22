// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Fresh signed offers. An offer is a price and an availability for one sku at
// one instant, signed by the seller, with an explicit validity window so an
// agent always knows how old a price is. Price is in integer minor units
// (ISO 4217 exponent), never a float. Follows the schema.org Offer vocabulary
// for field meaning, the Google Merchant Center availability values (2026)
// for the availability words, and the JWS rules in src/core/jws.ts (RFC 7515,
// RFC 8037, RFC 8785). Identical content yields the identical smo_ id; any
// change is a new offer with a new id and a new signature.

import { canonicalize } from "../core/canonical";
import { fromBase64Url, fromUtf8 } from "../core/encoding";
import { digest } from "../core/hash";
import { semantoId, isSemantoId } from "../core/ids";
import { signObject, verifyJws, JWS_TYPES, type JwsFailure } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { ValidationIssue } from "../core/semanto";

// ---------------------------------------------------------------- types

export type Availability = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "discontinued";
export const AVAILABILITY_VALUES: Availability[] = ["in_stock", "out_of_stock", "preorder", "backorder", "discontinued"];

export interface Money {
  /** Integer minor units: 1299 is 12.99 USD, 1299 is 1299 JPY. */
  amount: number;
  /** ISO 4217 code, upper case. */
  currency: string;
}

export interface ShippingOption {
  /** ISO 3166-1 alpha-2. */
  country: string;
  amount: number;
  currency: string;
  days_min: number;
  days_max: number;
}

export interface Offer {
  object: "semanto.offer";
  /** smo_ id, the content address of the offer without its id. */
  id: string;
  sku: string;
  variant_id?: string;
  price: Money;
  availability: Availability;
  inventory_quantity?: number;
  /** When the seller observed this price and stock, ISO 8601 UTC. */
  as_of: string;
  /** as_of plus the validity window. After this the offer is expired, whatever the stock. */
  not_after: string;
  seller: { domain: string; trooth_id: string };
  url: string;
  shipping?: ShippingOption[];
  return_policy_url?: string;
}

export type OfferInput = Omit<Offer, "id" | "object" | "not_after"> & { object?: "semanto.offer"; id?: string; not_after?: string };

export interface OfferPolicy {
  /** How long an offer is valid after as_of. Default 15 minutes. Set per company. */
  validity_minutes: number;
  /** How long an offer counts as fresh after as_of. Default 5 minutes. */
  fresh_minutes: number;
}

export const DEFAULT_OFFER_POLICY: OfferPolicy = { validity_minutes: 15, fresh_minutes: 5 };

export function offerPolicy(overrides: Partial<OfferPolicy> = {}): OfferPolicy {
  const p = Object.assign({}, DEFAULT_OFFER_POLICY, overrides);
  if (!(p.validity_minutes > 0) || !(p.fresh_minutes > 0)) throw new Error("offer policy: minutes must be positive");
  if (p.fresh_minutes > p.validity_minutes) throw new Error("offer policy: fresh_minutes cannot exceed validity_minutes");
  return p;
}

export interface SignedOffer {
  offer: Offer;
  /** Compact JWS, typ signed-offer, payload present. */
  jws: string;
  kid: string;
}

// ---------------------------------------------------------------- money

/** ISO 4217 minor unit exponents that are not 2. */
const EXPONENTS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, IQD: 3, LYD: 3 };

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** "12.34" from { amount: 1234, currency: "USD" }; "1234" for JPY. */
export function formatMinor(m: Money): string {
  const e = currencyExponent(m.currency);
  if (e === 0) return String(m.amount);
  const sign = m.amount < 0 ? "-" : "";
  const abs = Math.abs(m.amount);
  const whole = Math.floor(abs / 10 ** e);
  const frac = String(abs % 10 ** e).padStart(e, "0");
  return `${sign}${whole}.${frac}`;
}

/** Integer minor units from a decimal string such as "12.34". Returns null when the string is not a plain decimal. */
export function parseMinor(decimal: string, currency: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) return null;
  const e = currencyExponent(currency);
  const frac = (m[3] ?? "").padEnd(e, "0");
  if (frac.length > e) return null;
  const n = Number(m[2]) * 10 ** e + (e > 0 ? Number(frac) : 0);
  return m[1] === "-" ? -n : n;
}

// ---------------------------------------------------------------- validation

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS = /^https:\/\//;

export function validateOffer(input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "not an object" }];
  const o = input as Partial<Offer>;
  if (o.object !== undefined && o.object !== "semanto.offer") push("object", 'must be "semanto.offer"');
  if (typeof o.sku !== "string" || !o.sku) push("sku", "required");
  if (!o.price || !Number.isInteger(o.price.amount) || o.price.amount < 0) push("price.amount", "integer minor units, zero or more");
  if (!o.price || !/^[A-Z]{3}$/.test(o.price.currency ?? "")) push("price.currency", "ISO 4217 code");
  if (!AVAILABILITY_VALUES.includes(o.availability as Availability)) push("availability", `one of ${AVAILABILITY_VALUES.join(", ")}`);
  if (o.inventory_quantity !== undefined && (!Number.isInteger(o.inventory_quantity) || o.inventory_quantity < 0)) push("inventory_quantity", "whole number, zero or more");
  if (typeof o.as_of !== "string" || !ISO.test(o.as_of)) push("as_of", "ISO 8601 UTC");
  if (o.not_after !== undefined && (typeof o.not_after !== "string" || !ISO.test(o.not_after))) push("not_after", "ISO 8601 UTC");
  if (o.not_after && o.as_of && Date.parse(o.not_after) <= Date.parse(o.as_of)) push("not_after", "after as_of");
  if (!o.seller || typeof o.seller.domain !== "string" || !o.seller.domain) push("seller.domain", "required");
  if (!o.seller || typeof o.seller.trooth_id !== "string" || !o.seller.trooth_id) push("seller.trooth_id", "required");
  if (typeof o.url !== "string" || !HTTPS.test(o.url)) push("url", "https url");
  if (o.shipping !== undefined) {
    if (!Array.isArray(o.shipping)) push("shipping", "array");
    else o.shipping.forEach((s, i) => {
      if (!s || !/^[A-Z]{2}$/.test(s.country ?? "")) push(`shipping[${i}].country`, "ISO 3166-1 alpha-2");
      if (!s || !Number.isInteger(s.amount) || s.amount < 0) push(`shipping[${i}].amount`, "integer minor units");
      if (!s || !/^[A-Z]{3}$/.test(s.currency ?? "")) push(`shipping[${i}].currency`, "ISO 4217 code");
      if (!s || !Number.isInteger(s.days_min) || !Number.isInteger(s.days_max) || s.days_min > s.days_max) push(`shipping[${i}].days`, "days_min and days_max whole numbers, min at most max");
    });
  }
  if (o.return_policy_url !== undefined && !HTTPS.test(o.return_policy_url)) push("return_policy_url", "https url");
  return out;
}

// ---------------------------------------------------------------- build, id, sign, verify

export function offerContent(input: OfferInput | Offer, policy: OfferPolicy = DEFAULT_OFFER_POLICY): Omit<Offer, "id"> {
  const copy: Record<string, unknown> = Object.assign({}, input) as Record<string, unknown>;
  delete copy.id;
  delete copy.signature;
  copy.object = "semanto.offer";
  if (copy.not_after === undefined && typeof copy.as_of === "string") {
    copy.not_after = new Date(Date.parse(copy.as_of) + policy.validity_minutes * 60_000).toISOString();
  }
  return copy as unknown as Omit<Offer, "id">;
}

export async function offerId(content: Omit<Offer, "id"> | Offer): Promise<string> {
  const c: Record<string, unknown> = Object.assign({}, content) as Record<string, unknown>;
  delete c.id;
  return semantoId("smo", await digest(canonicalize(c)));
}

export async function buildOffer(input: OfferInput, policy: OfferPolicy = DEFAULT_OFFER_POLICY): Promise<Offer> {
  const content = offerContent(input, policy);
  const issues = validateOffer(content);
  if (issues.length) throw new Error(`offer: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const id = await offerId(content);
  return Object.assign({ id }, content) as Offer;
}

export async function signOffer(input: OfferInput, priv: PrivateJwk, policy: OfferPolicy = DEFAULT_OFFER_POLICY, opts: { iat?: Date } = {}): Promise<SignedOffer> {
  const offer = await buildOffer(input, policy);
  const jws = await signObject(offer, priv, JWS_TYPES.offer, { iat: opts.iat ?? new Date(offer.as_of), nbf: new Date(offer.as_of), exp: new Date(offer.not_after) });
  return { offer, jws: jws.compact, kid: priv.kid };
}

/**
 * Re-sign after a change. The new offer carries the new as_of; anything not in
 * `changes` is copied from the previous offer. A change that leaves the content
 * identical still produces a new as_of, so the id changes with the time, which
 * is what a freshness reader needs.
 */
export async function reSignOffer(previous: Offer, changes: Partial<OfferInput>, priv: PrivateJwk, now: Date, policy: OfferPolicy = DEFAULT_OFFER_POLICY): Promise<SignedOffer> {
  const next: Record<string, unknown> = Object.assign({}, previous, changes) as unknown as Record<string, unknown>;
  delete next.id;
  delete next.not_after;
  next.as_of = now.toISOString();
  return signOffer(next as unknown as OfferInput, priv, policy);
}

export type OfferVerification =
  | { ok: true; offer: Offer; kid: string }
  | { ok: false; reason: JwsFailure | "id_mismatch" | "invalid_offer"; issues?: ValidationIssue[] };

/**
 * Verify the signature and the id. The JWS exp is the offer's not_after, so an
 * expired offer fails here with "expired"; pass `allowExpired` to read the
 * content of an expired offer (for history) and judge freshness with stateOf.
 */
export async function verifyOffer(
  jws: string,
  resolveKey: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null,
  opts: { at?: Date; allowExpired?: boolean } = {},
): Promise<OfferVerification> {
  let v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.offer, at: opts.at });
  if (!v.ok && v.reason === "expired" && opts.allowExpired) {
    // Check the signature as of the moment the offer was made.
    const parts = jws.split(".");
    try {
      const payload = JSON.parse(fromUtf8(fromBase64Url(parts[1] ?? ""))) as Partial<Offer>;
      if (typeof payload.as_of === "string") v = await verifyJws(jws, resolveKey, { expectTyp: JWS_TYPES.offer, at: new Date(payload.as_of) });
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  if (!v.ok) return { ok: false, reason: v.reason };
  const payload = v.payload as Partial<Offer>;
  const issues = validateOffer(payload);
  if (payload.object !== "semanto.offer" || !isSemantoId(payload.id, "smo")) issues.push({ path: "id", message: "smo_ id required" });
  if (issues.length) return { ok: false, reason: "invalid_offer", issues };
  const offer = payload as Offer;
  if ((await offerId(offer)) !== offer.id) return { ok: false, reason: "id_mismatch" };
  return { ok: true, offer, kid: v.header.kid };
}

// ---------------------------------------------------------------- freshness

export type OfferState = "fresh" | "stale" | "expired";

/**
 * fresh:   now is within fresh_minutes of as_of (an offer dated slightly ahead
 *          by clock skew is at its freshest)
 * stale:   past the fresh window but before not_after; usable, say its age
 * expired: at or after not_after; do not quote this price
 */
export function stateOf(offer: Pick<Offer, "as_of" | "not_after">, now: Date, policy: OfferPolicy = DEFAULT_OFFER_POLICY): OfferState {
  const t = now.getTime();
  const asOf = Date.parse(offer.as_of);
  const notAfter = Date.parse(offer.not_after);
  if (t >= notAfter) return "expired";
  if (t - asOf < policy.fresh_minutes * 60_000) return "fresh";
  return "stale";
}

export function ageSeconds(offer: Pick<Offer, "as_of">, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(offer.as_of)) / 1000));
}

// ---------------------------------------------------------------- endpoint shapes

/** One entry of the offer feed. as_of and not_after are always present, so a reader knows how old a price is. */
export interface OfferFeedEntry {
  sku: string;
  variant_id?: string;
  as_of: string;
  not_after: string;
  state: OfferState;
  age_seconds: number;
  offer: Offer;
  /** The seller's compact JWS over the offer. */
  jws: string;
}

export interface OfferFeed {
  object: "semanto.offer_feed";
  seller: { domain: string; trooth_id: string };
  generated_at: string;
  policy: OfferPolicy;
  offers: OfferFeedEntry[];
}

export function offerFeedEntry(signed: SignedOffer, now: Date, policy: OfferPolicy = DEFAULT_OFFER_POLICY): OfferFeedEntry {
  const o = signed.offer;
  const entry: OfferFeedEntry = { sku: o.sku, as_of: o.as_of, not_after: o.not_after, state: stateOf(o, now, policy), age_seconds: ageSeconds(o, now), offer: o, jws: signed.jws };
  if (o.variant_id !== undefined) entry.variant_id = o.variant_id;
  return entry;
}

/** GET /public/semanto/{trooth_id}/offers: every current offer, one per sku and variant, newest as_of wins. */
export function offerFeed(seller: { domain: string; trooth_id: string }, signed: SignedOffer[], now: Date, policy: OfferPolicy = DEFAULT_OFFER_POLICY): OfferFeed {
  const newest = new Map<string, SignedOffer>();
  for (const s of signed) {
    const key = `${s.offer.sku}\u0000${s.offer.variant_id ?? ""}`;
    const prev = newest.get(key);
    if (!prev || Date.parse(s.offer.as_of) > Date.parse(prev.offer.as_of)) newest.set(key, s);
  }
  const offers = Array.from(newest.values())
    .sort((a, b) => (a.offer.sku < b.offer.sku ? -1 : a.offer.sku > b.offer.sku ? 1 : 0))
    .map((s) => offerFeedEntry(s, now, policy));
  return { object: "semanto.offer_feed", seller, generated_at: now.toISOString(), policy, offers };
}

/** GET /public/semanto/{trooth_id}/offers/{sku}: the newest offer for one sku, or the fact that there is none. */
export type OfferAnswer =
  | ({ object: "semanto.offer_answer"; found: true } & OfferFeedEntry)
  | { object: "semanto.offer_answer"; found: false; sku: string; as_of: null; not_after: null; state: null };

export function offerAnswer(sku: string, signed: SignedOffer[], now: Date, policy: OfferPolicy = DEFAULT_OFFER_POLICY, variant_id?: string): OfferAnswer {
  const matching = signed.filter((s) => s.offer.sku === sku && (variant_id === undefined || s.offer.variant_id === variant_id));
  if (matching.length === 0) return { object: "semanto.offer_answer", found: false, sku, as_of: null, not_after: null, state: null };
  const newest = matching.reduce((a, b) => (Date.parse(b.offer.as_of) > Date.parse(a.offer.as_of) ? b : a));
  return Object.assign({ object: "semanto.offer_answer" as const, found: true as const }, offerFeedEntry(newest, now, policy));
}
