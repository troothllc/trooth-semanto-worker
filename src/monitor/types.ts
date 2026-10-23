// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Shared shapes for the consistency monitor. Google's AI features guide
// (updated 15 June 2026) says its AI answers come from the normal index, that a
// page must be indexed and snippet-eligible, that structured data, Merchant
// Center and Business Profile help, and (UCP guidance) that a mismatch between
// Merchant Center data and the website lowers trust. The monitor reads every
// surface Google reads, compares each one with the signed Semanto record, and
// names what differs in plain words. It never judges the company; it reports a
// match or a mismatch with both values and both sources.

import type { Fact, PageEntry } from "../core/semanto";

/** The surfaces the monitor reads. "semanto" is the signed record itself. */
export type Surface = "live_page" | "semanto" | "merchant_center" | "business_profile" | "ucp" | "acp";

export const SURFACES: Surface[] = ["live_page", "semanto", "merchant_center", "business_profile", "ucp", "acp"];

/** A price as two parts, never a formatted string, so currencies are compared and not guessed. */
export interface Price {
  amount: string;
  currency: string;
}

export interface ConsumerNotice {
  /** Merchant Center notice types: safety_warning, legal_disclaimer, prop_65. Other values are passed through. */
  type?: string;
  message: string;
}

/**
 * The small product shape the monitor compares feeds against. The commerce
 * module owns the full record; this is only what every feed carries.
 */
export interface Product {
  product_id: string;
  variant_id?: string;
  gtin?: string;
  sku?: string;
  name: string;
  price?: Price;
  availability?: string;
  url: string;
  consumer_notice?: string | ConsumerNotice;
  brand?: string;
  description?: string;
  /** The signed product record id (smk_), when known. */
  record_id?: string;
  /** When the signed record witnessed this product. */
  witnessed_at?: string;
  /** The product's first image in the signed record (its media), when it has one. */
  image_url?: string;
}

/** A fresh signed offer for one sku; it wins over the product's own price when present and in date. */
export interface Offer {
  offer_id?: string;
  sku: string;
  variant_id?: string;
  price: Price;
  availability?: string;
  url?: string;
  as_of: string;
  not_after: string;
}

/** A surface value. Prices stay structured; everything else is text, a number, a flag or a list. */
export type SurfaceValue = string | number | boolean | string[] | Price;

/** One normalized observation from one surface, under the same dotted keys the signed facts use. */
export interface SurfaceFact {
  surface: Surface;
  key: string;
  value: SurfaceValue;
  url: string;
  observed_at: string;
}

/** What one reader produced for one surface. */
export interface SurfaceRead {
  surface: Surface;
  url: string;
  observed_at: string;
  facts: SurfaceFact[];
  /** Short plain notes about what the reader saw or could not read. */
  notes: string[];
}

/** The live page read carries more than facts: the index signals and whether JSON-LD was there at all. */
export interface LivePageRead extends SurfaceRead {
  surface: "live_page";
  status: number;
  title: string | null;
  text: string;
  jsonld: unknown[];
  jsonld_ids: string[];
  microdata: MicrodataItem[];
  index: { noindex: boolean; nosnippet: boolean; canonical: string | null; x_robots_tag: string | null };
  /** Digest of the HTML as fetched, to compare with PageEntry.source_hash. */
  source_hash: string;
}

export interface MicrodataItem {
  type: string | null;
  id: string | null;
  props: Record<string, Array<string | MicrodataItem>>;
}

/** The signed side of every comparison. */
export interface SignedRecord {
  trooth_id: string;
  domain: string;
  org: string;
  version: number;
  /** When the company signed this version (ISO 8601). */
  signed_at: string;
  facts: Fact[];
  pages: PageEntry[];
  products: Product[];
  offers: Offer[];
}

export interface SignedFact {
  key: string;
  value: SurfaceValue;
  fact_id: string;
  evidence_url: string;
  witnessed_at: string;
}

export type MismatchKind = "differs" | "missing_on_surface" | "missing_in_record" | "stale";

/**
 * trust: Google compares it (price, availability, name, address, phone, hours).
 * visibility: structured data absent, so the fact cannot be read as data.
 * note: everything else.
 */
export type Severity = "trust" | "visibility" | "note";

export interface Mismatch {
  key: string;
  signed_value: SurfaceValue | null;
  signed_fact_id: string | null;
  signed_evidence_url: string | null;
  /** When the signed value was witnessed, for the stale rule. */
  signed_witnessed_at: string | null;
  surface: Surface;
  surface_value: SurfaceValue | null;
  surface_url: string | null;
  surface_observed_at: string | null;
  kind: MismatchKind;
  severity: Severity;
  /** What differs, in plain words, when a tolerant comparison can say. */
  detail?: string;
}

export type SurfaceState = "read" | "absent" | "failed";

export interface SurfaceStatus {
  surface: Surface;
  state: SurfaceState;
  url: string | null;
  /** Plain words: why absent or failed, or what was read. */
  note: string;
  facts: number;
}

export type IndexReason = "noindex" | "nosnippet" | "robots_blocked" | "canonical_elsewhere" | "non_200" | "soft_404" | "not_fetched";

export interface PageIndexability {
  url: string;
  page_id: string;
  title: string | null;
  status: number | null;
  eligible: boolean;
  reasons: IndexReason[];
  jsonld_present: boolean;
  /** The generated @id the page was expected to carry. */
  expected_jsonld_id: string;
}

export interface IndexabilityReport {
  pages: PageIndexability[];
  totals: {
    pages: number;
    eligible: number;
    not_eligible: number;
    jsonld_present: number;
    by_reason: Record<IndexReason, number>;
  };
}

/** Matches the semanto_monitor_runs table; the three json columns are these three fields. */
export interface MonitorRun {
  id: string;
  trooth_id: string;
  ran_at: string;
  surfaces: SurfaceStatus[];
  mismatches: Mismatch[];
  indexability: IndexabilityReport;
}

export interface MonitorRunRow {
  id: string;
  trooth_id: string;
  ran_at: string;
  surfaces_json: string;
  mismatches_json: string;
  indexability_json: string;
}

export type AlertKind = "surface_mismatch" | "missing_on_surface" | "missing_in_record" | "stale_surface" | "page_changed" | "not_indexable" | "missing_structured_data";

/** Matches the semanto_alerts table; detail is the json column. */
export interface Alert {
  id: string;
  trooth_id: string;
  kind: AlertKind;
  /** The dotted key or page url the alert is about; kind plus key is the dedupe identity. */
  key: string;
  severity: Severity;
  message: string;
  detail: Record<string, unknown>;
  created_at: string;
  sent_at: string | null;
  resolved_at: string | null;
}

export interface AlertRow {
  id: string;
  trooth_id: string;
  kind: string;
  message: string;
  detail_json: string;
  created_at: string;
  sent_at: string | null;
  resolved_at: string | null;
}
