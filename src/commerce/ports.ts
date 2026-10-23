// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The storage port for the commerce layer, and an in-memory implementation
// used by tests. The D1 implementation (tables semanto_products,
// semanto_offers, semanto_sellers and semanto_recalls in
// migrations/0001_semanto.sql) lives in src/db and satisfies this same
// interface; nothing in src/commerce speaks SQL. The pattern is the ports and
// adapters style (Cockburn, 2005) the rest of the worker uses.

import type { SignedProductRecord } from "./product-record";
import type { SignedOffer, OfferPolicy } from "./offers";
import type { AttestationEntry } from "./sellers";
import type { SignedRecall } from "./recalls";
import type { FeedCompany } from "./feeds";

export interface CommerceStore {
  company(trooth_id: string): Promise<FeedCompany | null>;
  offerPolicy(trooth_id: string): Promise<OfferPolicy>;
  records(trooth_id: string): Promise<SignedProductRecord[]>;
  record(trooth_id: string, record_id: string): Promise<SignedProductRecord | null>;
  offers(trooth_id: string, sku?: string): Promise<SignedOffer[]>;
  attestations(brand_trooth_id: string): Promise<AttestationEntry[]>;
  recalls(trooth_id: string): Promise<SignedRecall[]>;
  putRecord(trooth_id: string, signed: SignedProductRecord): Promise<void>;
  putOffer(trooth_id: string, signed: SignedOffer): Promise<void>;
  putAttestation(brand_trooth_id: string, entry: AttestationEntry): Promise<void>;
  putRecall(trooth_id: string, signed: SignedRecall): Promise<void>;
  /** Take every offer for a sku out (a product the connector sent as discontinued). Answers how many were removed. */
  removeOffers(trooth_id: string, sku: string): Promise<number>;
}

interface Bucket {
  company: FeedCompany | null;
  policy: OfferPolicy;
  records: Map<string, SignedProductRecord>;
  offers: Map<string, SignedOffer>;
  attestations: Map<string, AttestationEntry>;
  recalls: Map<string, SignedRecall>;
}

export class InMemoryCommerceStore implements CommerceStore {
  private buckets = new Map<string, Bucket>();

  constructor(private defaultPolicy: OfferPolicy = { validity_minutes: 15, fresh_minutes: 5 }) {}

  private bucket(id: string): Bucket {
    let b = this.buckets.get(id);
    if (!b) {
      b = { company: null, policy: this.defaultPolicy, records: new Map(), offers: new Map(), attestations: new Map(), recalls: new Map() };
      this.buckets.set(id, b);
    }
    return b;
  }

  setCompany(company: FeedCompany, policy?: OfferPolicy): void {
    const b = this.bucket(company.trooth_id);
    b.company = company;
    if (policy) b.policy = policy;
  }

  async company(trooth_id: string): Promise<FeedCompany | null> {
    return this.bucket(trooth_id).company;
  }
  async offerPolicy(trooth_id: string): Promise<OfferPolicy> {
    return this.bucket(trooth_id).policy;
  }
  async records(trooth_id: string): Promise<SignedProductRecord[]> {
    return Array.from(this.bucket(trooth_id).records.values());
  }
  async record(trooth_id: string, record_id: string): Promise<SignedProductRecord | null> {
    return this.bucket(trooth_id).records.get(record_id) ?? null;
  }
  async offers(trooth_id: string, sku?: string): Promise<SignedOffer[]> {
    const all = Array.from(this.bucket(trooth_id).offers.values());
    return sku === undefined ? all : all.filter((o) => o.offer.sku === sku);
  }
  async attestations(brand_trooth_id: string): Promise<AttestationEntry[]> {
    return Array.from(this.bucket(brand_trooth_id).attestations.values());
  }
  async recalls(trooth_id: string): Promise<SignedRecall[]> {
    return Array.from(this.bucket(trooth_id).recalls.values());
  }
  async putRecord(trooth_id: string, signed: SignedProductRecord): Promise<void> {
    this.bucket(trooth_id).records.set(signed.record.id, signed);
  }
  async putOffer(trooth_id: string, signed: SignedOffer): Promise<void> {
    this.bucket(trooth_id).offers.set(signed.offer.id, signed);
  }
  async putAttestation(brand_trooth_id: string, entry: AttestationEntry): Promise<void> {
    this.bucket(brand_trooth_id).attestations.set(entry.attestation.id, entry);
  }
  async putRecall(trooth_id: string, signed: SignedRecall): Promise<void> {
    this.bucket(trooth_id).recalls.set(signed.notice.id, signed);
  }
  async removeOffers(trooth_id: string, sku: string): Promise<number> {
    const offers = this.bucket(trooth_id).offers;
    let n = 0;
    for (const [id, o] of offers) if (o.offer.sku === sku && offers.delete(id)) n++;
    return n;
  }
}
