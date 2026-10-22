// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Nested signatures for marketplaces. A marketplace publishes a catalog
// envelope that carries each seller's own signed offer (and signed product
// record, when the seller has one) unchanged, and signs the envelope. A
// reader checks two layers independently: the marketplace's signature over
// the envelope, and each seller's signature over its own offer. When a check
// fails the answer names the layer: marketplace, seller_offer or
// seller_record. A price the marketplace lists that differs from the price in
// the seller's signed offer is reported as a price mismatch, not as a
// signature failure. JWS per RFC 7515 and RFC 8037 over RFC 8785 JSON; the
// nesting follows the JWS general rule that an inner JWS is opaque payload
// text to the outer one.

import { fromBase64Url, fromUtf8 } from "../core/encoding";
import { signObject, verifyJws, JWS_TYPES } from "../core/jws";
import type { PrivateJwk, PublicJwk } from "../core/keys";
import type { ValidationIssue } from "../core/semanto";
import { verifyOffer, type Offer, type Money } from "./offers";
import { verifyProductRecord, type ProductRecord } from "./product-record";

// ---------------------------------------------------------------- types

export interface CatalogListing {
  seller_trooth_id: string;
  /** The seller's compact JWS over its offer, carried byte for byte. */
  offer_jws: string;
  /** The seller's (or brand's) compact JWS over the product record, when there is one. */
  product_record_jws?: string;
  /** The price the marketplace shows for this listing. Compared with the signed offer. */
  listed_price?: Money;
}

export interface MarketplaceCatalog {
  object: "semanto.catalog";
  marketplace_trooth_id: string;
  /** When the marketplace assembled this envelope, ISO 8601 UTC. */
  assembled_at: string;
  listings: CatalogListing[];
}

export type MarketplaceCatalogInput = Omit<MarketplaceCatalog, "object"> & { object?: "semanto.catalog" };

export interface SignedCatalog {
  catalog: MarketplaceCatalog;
  jws: string;
  kid: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function validateCatalog(input: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (path: string, message: string) => out.push({ path, message });
  if (typeof input !== "object" || input === null) return [{ path: "", message: "not an object" }];
  const c = input as Partial<MarketplaceCatalog>;
  if (c.object !== undefined && c.object !== "semanto.catalog") push("object", 'must be "semanto.catalog"');
  if (typeof c.marketplace_trooth_id !== "string" || !c.marketplace_trooth_id) push("marketplace_trooth_id", "required");
  if (typeof c.assembled_at !== "string" || !ISO.test(c.assembled_at)) push("assembled_at", "ISO 8601 UTC");
  if (!Array.isArray(c.listings)) push("listings", "array");
  else c.listings.forEach((l, i) => {
    if (!l || typeof l.seller_trooth_id !== "string" || !l.seller_trooth_id) push(`listings[${i}].seller_trooth_id`, "required");
    if (!l || typeof l.offer_jws !== "string" || l.offer_jws.split(".").length !== 3) push(`listings[${i}].offer_jws`, "compact JWS");
    if (l && l.product_record_jws !== undefined && (typeof l.product_record_jws !== "string" || l.product_record_jws.split(".").length !== 3)) push(`listings[${i}].product_record_jws`, "compact JWS");
    if (l && l.listed_price !== undefined && (!Number.isInteger(l.listed_price.amount) || !/^[A-Z]{3}$/.test(l.listed_price.currency ?? ""))) push(`listings[${i}].listed_price`, "integer minor units and ISO 4217 code");
  });
  return out;
}

// ---------------------------------------------------------------- sign

export async function signCatalog(input: MarketplaceCatalogInput, marketplaceKey: PrivateJwk, opts: { iat?: Date; exp?: Date } = {}): Promise<SignedCatalog> {
  const catalog: MarketplaceCatalog = Object.assign({}, input, { object: "semanto.catalog" as const });
  const issues = validateCatalog(catalog);
  if (issues.length) throw new Error(`catalog: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const jws = await signObject(catalog, marketplaceKey, JWS_TYPES.marketplaceCatalog, { iat: opts.iat ?? new Date(catalog.assembled_at), nbf: new Date(catalog.assembled_at), exp: opts.exp });
  return { catalog, jws: jws.compact, kid: marketplaceKey.kid };
}

// ---------------------------------------------------------------- verify

export type Layer = "marketplace" | "seller_offer" | "seller_record";

export interface LayerResult {
  ok: boolean;
  reason?: string;
  kid?: string;
}

export interface ListingVerification {
  index: number;
  seller_trooth_id: string;
  offer: LayerResult & { offer?: Offer };
  /** null when the listing carries no product record. */
  record: (LayerResult & { record?: ProductRecord }) | null;
  /** matches: listed price equals the signed offer price. mismatch: it does not. not_listed: the marketplace shows no price. unchecked: the offer did not verify. */
  price: "matches" | "mismatch" | "not_listed" | "unchecked";
  listed_price?: Money;
  signed_price?: Money;
  failed_layer: Layer | null;
}

export interface CatalogVerification {
  ok: boolean;
  marketplace: LayerResult & { marketplace_trooth_id?: string };
  listings: ListingVerification[];
  /** Every layer that failed anywhere, in order of first failure. */
  failed_layers: Layer[];
  price_mismatches: number;
}

export interface KeyResolvers {
  /** The marketplace's key by kid. */
  marketplace: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null;
  /** A seller's key by (seller_trooth_id, kid). The seller is the one the listing names; a key that belongs to another company returns null. */
  seller: (seller_trooth_id: string, kid: string) => Promise<PublicJwk | null> | PublicJwk | null;
}

/**
 * Verify the outer marketplace signature, then every inner seller signature,
 * independently. An outer failure does not stop the inner checks: a reader
 * still learns which seller offers stand on their own.
 */
export async function verifyCatalog(jws: string, keys: KeyResolvers, opts: { at?: Date; allowExpiredOffers?: boolean } = {}): Promise<CatalogVerification> {
  const failed: Layer[] = [];
  const fail = (l: Layer) => { if (!failed.includes(l)) failed.push(l); };
  const outer = await verifyJws(jws, keys.marketplace, { expectTyp: JWS_TYPES.marketplaceCatalog, at: opts.at });
  const marketplace: CatalogVerification["marketplace"] = outer.ok ? { ok: true, kid: outer.header.kid } : { ok: false, reason: outer.reason };
  let catalog: MarketplaceCatalog | null = null;
  if (outer.ok) {
    const issues = validateCatalog(outer.payload);
    if (issues.length) {
      marketplace.ok = false;
      marketplace.reason = "invalid_catalog";
    } else {
      catalog = outer.payload as MarketplaceCatalog;
      marketplace.marketplace_trooth_id = catalog.marketplace_trooth_id;
    }
  } else {
    // The outer signature failed; still read the envelope so the inner layers can be checked and reported.
    catalog = readUnverifiedCatalog(jws);
  }
  if (!marketplace.ok) fail("marketplace");

  const listings: ListingVerification[] = [];
  if (catalog) {
    for (let i = 0; i < catalog.listings.length; i++) {
      const l = catalog.listings[i]!;
      const lv: ListingVerification = { index: i, seller_trooth_id: l.seller_trooth_id, offer: { ok: false }, record: null, price: "unchecked", failed_layer: null };
      if (l.listed_price) lv.listed_price = l.listed_price;
      const ov = await verifyOffer(l.offer_jws, (kid) => keys.seller(l.seller_trooth_id, kid), { at: opts.at, allowExpired: opts.allowExpiredOffers });
      if (!ov.ok) {
        lv.offer = { ok: false, reason: ov.reason };
      } else if (ov.offer.seller.trooth_id !== l.seller_trooth_id) {
        lv.offer = { ok: false, reason: "seller_mismatch", kid: ov.kid };
      } else {
        lv.offer = { ok: true, kid: ov.kid, offer: ov.offer };
        lv.signed_price = ov.offer.price;
        if (!l.listed_price) lv.price = "not_listed";
        else lv.price = l.listed_price.amount === ov.offer.price.amount && l.listed_price.currency === ov.offer.price.currency ? "matches" : "mismatch";
      }
      if (!lv.offer.ok) {
        lv.failed_layer = "seller_offer";
        fail("seller_offer");
      }
      if (l.product_record_jws !== undefined) {
        const rv = await verifyProductRecord(l.product_record_jws, (kid) => keys.seller(l.seller_trooth_id, kid), { at: opts.at });
        if (!rv.ok) {
          lv.record = { ok: false, reason: rv.reason };
          if (!lv.failed_layer) lv.failed_layer = "seller_record";
          fail("seller_record");
        } else if (lv.offer.ok && lv.offer.offer && rv.record.sku !== lv.offer.offer.sku) {
          lv.record = { ok: false, reason: "sku_mismatch", kid: rv.kid, record: rv.record };
          if (!lv.failed_layer) lv.failed_layer = "seller_record";
          fail("seller_record");
        } else {
          lv.record = { ok: true, kid: rv.kid, record: rv.record };
        }
      }
      listings.push(lv);
    }
  }
  const price_mismatches = listings.filter((l) => l.price === "mismatch").length;
  return { ok: marketplace.ok && failed.length === 0 && price_mismatches === 0, marketplace, listings, failed_layers: failed, price_mismatches };
}

function readUnverifiedCatalog(jws: string): MarketplaceCatalog | null {
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(fromUtf8(fromBase64Url(parts[1]))) as unknown;
    return validateCatalog(payload).length === 0 ? (payload as MarketplaceCatalog) : null;
  } catch {
    return null;
  }
}
