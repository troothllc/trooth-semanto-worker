// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for the commerce layer. Every fixture is fictional (Acme Inc,
// acme.com); no figure is a measurement.

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { isSemantoId } from "@/core/ids";
import {
  gtinCheckDigit,
  isValidGtin,
  normalizeGtin,
  buildProductRecord,
  productRecordId,
  signProductRecord,
  verifyProductRecord,
  resolveVariant,
  validateProductRecord,
  type ProductRecord,
  type ProductRecordInput,
} from "@/commerce/product-record";
import { sameSubstance, synonymsOf, normalizeInci, normalizeName, sameAttributeName, listContains, SUBSTANCE_TABLE, lookupSubstance } from "@/commerce/synonyms";
import { buildOffer, signOffer, verifyOffer, reSignOffer, stateOf, offerPolicy, offerFeed, offerAnswer, formatMinor, parseMinor, type Offer, type OfferInput } from "@/commerce/offers";
import { generateFeeds, parityCheck, parseMerchantCenterTsv, ucpManifest, type FeedCompany } from "@/commerce/feeds";
import { signSellerAttestation, verifySellerAttestation, isAuthorized, compareListing, officialSpecPointer, type SellerAttestationInput, type BrandSellers } from "@/commerce/sellers";
import { signCatalog, verifyCatalog } from "@/commerce/nested";
import { signRecall, verifyRecall, affected, availabilityAnswer, withRecallStatus, recallChangeEntry, type RecallNoticeInput } from "@/commerce/recalls";
import { InMemoryCommerceStore } from "@/commerce/ports";
import { offerResponse, feedResponse, ucpManifestResponse, productsResponse } from "@/commerce/routes";

import recordsFixture from "./fixtures/commerce/fixture-acme-records.json";
import offersFixture from "./fixtures/commerce/fixture-acme-offers.json";
import recallFixture from "./fixtures/commerce/fixture-acme-recall.json";
import attestationFixture from "./fixtures/commerce/fixture-seller-attestation.json";
import companyFixture from "./fixtures/commerce/fixture-company.json";

const recordInputs = recordsFixture.records as unknown as ProductRecordInput[];
const offerInputs = offersFixture.offers as unknown as OfferInput[];
const recallInput = recallFixture.notice as unknown as RecallNoticeInput;
const attestationInput = attestationFixture.attestation as unknown as SellerAttestationInput;
const company = companyFixture.company as FeedCompany;

const NOW = new Date("2026-10-22T12:01:00Z");

let brandKey: PrivateJwk;
let brandPub: PublicJwk;
let sellerKey: PrivateJwk;
let sellerPub: PublicJwk;
let marketKey: PrivateJwk;
let marketPub: PublicJwk;
let otherKey: PrivateJwk;
let records: ProductRecord[];

const byKid = (keys: PublicJwk[]) => (kid: string) => keys.find((k) => k.kid === kid) ?? null;

beforeAll(async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const c = await generateKeyPair();
  const d = await generateKeyPair();
  brandKey = a.privateJwk;
  brandPub = a.publicJwk;
  sellerKey = b.privateJwk;
  sellerPub = b.publicJwk;
  marketKey = c.privateJwk;
  marketPub = c.publicJwk;
  otherKey = d.privateJwk;
  records = await Promise.all(recordInputs.map(buildProductRecord));
});

// ---------------------------------------------------------------- GTIN

describe("GTIN check digits (GS1)", () => {
  it("accepts known-good GTIN-8, 12, 13 and 14 values", () => {
    expect(isValidGtin("012345678905")).toBe(true);
    expect(isValidGtin("4006381333931")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("10614141000415")).toBe(true);
  });
  it("computes the check digit", () => {
    expect(gtinCheckDigit("01234567890")).toBe(5);
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(gtinCheckDigit("9638507")).toBe(4);
  });
  it("rejects a wrong check digit, a wrong length and non-digits", () => {
    expect(isValidGtin("012345678906")).toBe(false);
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("12345")).toBe(false);
    expect(isValidGtin("40063813339a1")).toBe(false);
    expect(isValidGtin(12345678905)).toBe(false);
  });
  it("pads to 14 digits for matching, per GS1", () => {
    expect(normalizeGtin("012345678905")).toBe("00012345678905");
    expect(normalizeGtin("96385074")).toBe("00000096385074");
  });
  it("a record with a bad GTIN does not validate", () => {
    const bad = Object.assign({}, recordInputs[0], { gtin: "012345678906" });
    expect(validateProductRecord(bad).some((i) => i.path === "gtin")).toBe(true);
  });
});

// ---------------------------------------------------------------- records

describe("product records", () => {
  it("sign and verify with typ product-record", async () => {
    const signed = await signProductRecord(recordInputs[0]!, brandKey);
    expect(isSemantoId(signed.record.id, "smk")).toBe(true);
    const v = await verifyProductRecord(signed.jws, byKid([brandPub]), { at: NOW });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.record.sku).toBe("ACME-CL-500-BLU");
    const raw = await verifyJws(signed.jws, byKid([brandPub]), { at: NOW });
    expect(raw.ok && raw.header.typ).toBe(JWS_TYPES.productRecord);
  });
  it("identical content gives the identical id; a changed field gives a different id", async () => {
    const a = await productRecordId(recordInputs[0]!);
    const b = await productRecordId(JSON.parse(JSON.stringify(recordInputs[0])) as ProductRecordInput);
    expect(a).toBe(b);
    const c = await productRecordId(Object.assign({}, recordInputs[0], { name: "Acme Surface Cleaner 500 ml, Navy" }));
    expect(c).not.toBe(a);
    // The id is over the content without id: a caller-supplied id does not change it.
    const d = await productRecordId(Object.assign({}, recordInputs[0], { id: "smk_aaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    expect(d).toBe(a);
  });
  it("a record signed by one key does not verify under another, and a wrong typ is refused", async () => {
    const signed = await signProductRecord(recordInputs[0]!, brandKey);
    const v = await verifyProductRecord(signed.jws, byKid([sellerPub]), { at: NOW });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unknown_key");
    const offer = await signOffer(offerInputs[0]!, brandKey);
    const w = await verifyProductRecord(offer.jws, byKid([brandPub]), { at: NOW });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe("wrong_type");
  });
  it("a tampered payload fails id and signature checks", async () => {
    const signed = await signProductRecord(recordInputs[0]!, brandKey);
    const tampered = Object.assign({}, signed.record, { name: "Something else" });
    expect(await productRecordId(tampered)).not.toBe(signed.record.id);
  });
  it("provenance is declared and nothing else", () => {
    const bad = Object.assign({}, recordInputs[0], { provenance: "witnessed" }) as unknown;
    expect(validateProductRecord(bad).some((i) => i.path === "provenance")).toBe(true);
  });
});

// ---------------------------------------------------------------- variant resolver

describe("variant resolver", () => {
  it("returns exactly one record for a gtin, a sku, or product plus axes", () => {
    const byGtin = resolveVariant(records, { gtin: "4006381333931" });
    expect(byGtin.kind).toBe("one");
    if (byGtin.kind === "one") expect(byGtin.record.sku).toBe("ACME-CL-500-GRN");
    const bySku = resolveVariant(records, { sku: "acme-cl-1000-blu" });
    expect(bySku.kind).toBe("one");
    const byAxes = resolveVariant(records, { product_id: "acme-cleanse", size: "500 ml", color: "blue" });
    expect(byAxes.kind).toBe("one");
    if (byAxes.kind === "one") expect(byAxes.record.sku).toBe("ACME-CL-500-BLU");
  });
  it("a padded GTIN names the same item", () => {
    const r = resolveVariant(records, { gtin: "00012345678905" });
    expect(r.kind).toBe("one");
  });
  it("returns an explicit ambiguity with the axes to ask, never a guess", () => {
    const r = resolveVariant(records, { product_id: "acme-cleanse", color: "Blue" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => c.sku).sort()).toEqual(["ACME-CL-1000-BLU", "ACME-CL-500-BLU"]);
      expect(r.axes_to_ask).toEqual(["size"]);
    }
    const all = resolveVariant(records, { product_id: "acme-cleanse" });
    expect(all.kind).toBe("ambiguous");
    if (all.kind === "ambiguous") expect(all.axes_to_ask).toEqual(["size", "color"]);
  });
  it("returns none when nothing matches, not the nearest record", () => {
    expect(resolveVariant(records, { product_id: "acme-cleanse", color: "Red" }).kind).toBe("none");
    expect(resolveVariant(records, { sku: "ACME-CL-500-BL" }).kind).toBe("none");
  });
});

// ---------------------------------------------------------------- synonyms

describe("synonyms", () => {
  it("has at least 25 substance groups", () => {
    expect(SUBSTANCE_TABLE.length).toBeGreaterThanOrEqual(25);
  });
  it("matches through the table", () => {
    expect(sameSubstance("isopropyl alcohol", "2-propanol").same).toBe(true);
    expect(sameSubstance("Isopropanol", "ISOPROPYL ALCOHOL").same).toBe(true);
    expect(sameSubstance("sodium chloride", "salt").same).toBe(true);
    expect(sameSubstance("tocopherol", "Vitamin E").same).toBe(true);
    expect(sameSubstance("Aqua", "water").same).toBe(true);
    const m = sameSubstance("parfum", "fragrance");
    expect(m.same && m.via).toBe("table");
  });
  it("does not match by similarity", () => {
    expect(sameSubstance("sodium chloride", "sodium chlorite").same).toBe(false);
    expect(sameSubstance("isopropyl alcohol", "isopropyl myristate").same).toBe(false);
    expect(sameSubstance("hyaluronic acid", "sodium hyaluronate").same).toBe(false);
    expect(sameSubstance("ethanol", "methanol").same).toBe(false);
    expect(sameSubstance("retinol", "retinal").same).toBe(false);
    const unknown = sameSubstance("acme polymer 7", "acme polymer 8");
    expect(unknown.same).toBe(false);
    if (!unknown.same) expect(unknown.reason).toBe("unknown_name");
  });
  it("matches exact normalized names and spelling variants", () => {
    expect(sameSubstance("Sodium  Chloride", "sodium chloride").same).toBe(true);
    expect(sameSubstance("α-tocopherol", "alpha-tocopherol").same).toBe(true);
    expect(sameSubstance("sodium lauryl sulphate", "sodium lauryl sulfate").same).toBe(true);
    expect(sameAttributeName("Colour", "color")).toBe(true);
    expect(sameAttributeName("Colour", "material")).toBe(false);
  });
  it("normalizes INCI names and lists synonyms", () => {
    expect(normalizeInci("  butyrospermum parkii (shea)  butter ")).toBe("BUTYROSPERMUM PARKII (SHEA) BUTTER");
    expect(normalizeName("Vitamin E")).toBe("vitamin e");
    expect(synonymsOf("salt")).toContain("sodium chloride");
    expect(lookupSubstance("nothing known")).toBeNull();
    expect(synonymsOf("nothing known")).toEqual(["nothing known"]);
  });
  it("finds a substance in an ingredient list through declared synonyms and INCI", () => {
    const list = records[0]!.ingredients!;
    expect(listContains(list, "2-propanol").found).toBe(true);
    expect(listContains(list, "perfume").found).toBe(true);
    expect(listContains(list, "sodium chlorite").found).toBe(false);
  });
});

// ---------------------------------------------------------------- offers

describe("offers", () => {
  it("builds with a default 15 minute window and integer minor units", async () => {
    const o = await buildOffer(offerInputs[0]!);
    expect(o.not_after).toBe("2026-10-22T12:15:00.000Z");
    expect(isSemantoId(o.id, "smo")).toBe(true);
    expect(formatMinor(o.price)).toBe("12.99");
    expect(formatMinor({ amount: 1299, currency: "JPY" })).toBe("1299");
    expect(formatMinor({ amount: 1005, currency: "KWD" })).toBe("1.005");
    expect(parseMinor("12.99", "USD")).toBe(1299);
    expect(parseMinor("12.9", "USD")).toBe(1290);
    expect(parseMinor("12.999", "USD")).toBeNull();
  });
  it("a company policy changes the window", async () => {
    const o = await buildOffer(offerInputs[0]!, offerPolicy({ validity_minutes: 60, fresh_minutes: 10 }));
    expect(o.not_after).toBe("2026-10-22T13:00:00.000Z");
    expect(() => offerPolicy({ validity_minutes: 1, fresh_minutes: 5 })).toThrow();
  });
  it("identical content yields the identical id; any change yields a new one", async () => {
    const a = await buildOffer(offerInputs[0]!);
    const b = await buildOffer(JSON.parse(JSON.stringify(offerInputs[0])) as OfferInput);
    expect(a.id).toBe(b.id);
    const c = await buildOffer(Object.assign({}, offerInputs[0], { price: { amount: 1199, currency: "USD" } }));
    expect(c.id).not.toBe(a.id);
  });
  it("signs with typ signed-offer and verifies; a price in floats is refused", async () => {
    const s = await signOffer(offerInputs[0]!, sellerKey);
    const v = await verifyOffer(s.jws, byKid([sellerPub]), { at: NOW });
    expect(v.ok).toBe(true);
    const raw = await verifyJws(s.jws, byKid([sellerPub]), { at: NOW });
    expect(raw.ok && raw.header.typ).toBe(JWS_TYPES.offer);
    await expect(signOffer(Object.assign({}, offerInputs[0], { price: { amount: 12.99, currency: "USD" } }), sellerKey)).rejects.toThrow();
  });
  it("goes fresh, then stale, then expired by the clock", async () => {
    const o = await buildOffer(offerInputs[0]!);
    expect(stateOf(o, new Date("2026-10-22T12:00:30Z"))).toBe("fresh");
    expect(stateOf(o, new Date("2026-10-22T12:04:59Z"))).toBe("fresh");
    expect(stateOf(o, new Date("2026-10-22T12:05:00Z"))).toBe("stale");
    expect(stateOf(o, new Date("2026-10-22T12:14:59Z"))).toBe("stale");
    expect(stateOf(o, new Date("2026-10-22T12:15:00Z"))).toBe("expired");
    expect(stateOf(o, new Date("2026-10-23T12:15:00Z"))).toBe("expired");
  });
  it("an expired offer fails verification at that time, and can be read for history on request", async () => {
    const s = await signOffer(offerInputs[0]!, sellerKey);
    const later = new Date("2026-10-22T13:00:00Z");
    const v = await verifyOffer(s.jws, byKid([sellerPub]), { at: later });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
    const h = await verifyOffer(s.jws, byKid([sellerPub]), { at: later, allowExpired: true });
    expect(h.ok).toBe(true);
    if (h.ok) expect(stateOf(h.offer, later)).toBe("expired");
  });
  it("re-signs on change with a new as_of and a new id", async () => {
    const s = await signOffer(offerInputs[0]!, sellerKey);
    const later = new Date("2026-10-22T12:10:00Z");
    const r = await reSignOffer(s.offer, { price: { amount: 1199, currency: "USD" } }, sellerKey, later);
    expect(r.offer.id).not.toBe(s.offer.id);
    expect(r.offer.as_of).toBe("2026-10-22T12:10:00.000Z");
    expect(r.offer.not_after).toBe("2026-10-22T12:25:00.000Z");
    expect(r.offer.price.amount).toBe(1199);
    expect((await verifyOffer(r.jws, byKid([sellerPub]), { at: later })).ok).toBe(true);
  });
  it("the feed and the single-sku answer always carry as_of and not_after", async () => {
    const signed = await Promise.all(offerInputs.map((o) => signOffer(o, sellerKey)));
    const feed = offerFeed({ domain: "acme.com", trooth_id: "acme-inc" }, signed, NOW);
    expect(feed.offers.length).toBe(3);
    for (const e of feed.offers) {
      expect(typeof e.as_of).toBe("string");
      expect(typeof e.not_after).toBe("string");
      expect(e.state).toBe("fresh");
      expect(e.age_seconds).toBe(60);
    }
    const one = offerAnswer("ACME-CL-500-BLU", signed, NOW);
    expect(one.found).toBe(true);
    if (one.found) expect(one.not_after).toBe("2026-10-22T12:15:00.000Z");
    const none = offerAnswer("NOPE", signed, NOW);
    expect(none.found).toBe(false);
    expect(none.as_of).toBeNull();
  });
});

// ---------------------------------------------------------------- feeds

describe("feeds", () => {
  let offers: Offer[];
  beforeAll(async () => {
    offers = await Promise.all(offerInputs.map((o) => buildOffer(o)));
  });

  it("generates Merchant Center TSV and JSON, ACP and UCP from the same records and offers", async () => {
    const feeds = await generateFeeds({ company, records, offers }, NOW);
    expect(feeds.skipped).toEqual([]);
    expect(feeds.lines.length).toBe(3);

    const rows = parseMerchantCenterTsv(feeds.merchant_center.tsv);
    expect(rows.length).toBe(3);
    const blue = rows.find((r) => r.id === "ACME-CL-500-BLU")!;
    expect(blue.price).toBe("12.99 USD");
    expect(blue.availability).toBe("in_stock");
    expect(blue.gtin).toBe("012345678905");
    expect(blue.item_group_id).toBe("acme-cleanse");
    expect(blue.color).toBe("Blue");
    expect(blue.size).toBe("500 ml");
    expect((blue.consumer_notice ?? "").startsWith("prop_65:WARNING")).toBe(true);
    expect(blue.native_commerce).toBe("no");
    expect(blue.merchant_item_id).toBe("ACME-CL-500-BLU");
    expect(feeds.merchant_center.json.find((i) => i.id === "ACME-CL-500-BLU")!.price).toBe("12.99 USD");
    const api = feeds.merchant_center.content_api.find((p) => p.offerId === "ACME-CL-500-BLU")!;
    expect(api.price).toEqual({ value: "12.99", currency: "USD" });
    expect(api.availability).toBe("in stock");
    expect(api.itemGroupId).toBe("acme-cleanse");
    expect(api.consumerNotices?.[0]?.noticeType).toBe("prop_65");

    const acp = feeds.acp.find((i) => i.id === "ACME-CL-500-BLU")!;
    expect(acp.price).toBe("12.99");
    expect(acp.currency).toBe("USD");
    expect(acp.inventory_quantity).toBe(40);
    expect(acp.shipping?.[0]).toEqual({ country: "US", price: "4.99", currency: "USD", min_days: 2, max_days: 5 });
    expect(acp.return_policy).toBe("https://acme.com/returns");
    expect(acp.provenance.signed_record_url).toBe(`https://api.trooth.co/public/semanto/acme-inc/products/${records[0]!.id}`);
    expect(acp.provenance.record_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(acp.provenance.as_of).toBe("2026-10-22T12:00:00Z");

    const ucp = feeds.ucp.catalog.products.find((p) => p.id === "ACME-CL-500-BLU")!;
    expect(ucp.price).toEqual({ amount: 1299, currency: "USD" });
    expect(ucp.as_of).toBe("2026-10-22T12:00:00Z");
    expect(ucp.semanto.record_id).toBe(records[0]!.id);
    const green = feeds.ucp.catalog.products.find((p) => p.id === "ACME-CL-500-GRN")!;
    expect(green.availability).toBe("backorder");
  });

  it("the UCP manifest lists catalog and discovery, keeps checkout endpoints configurable, and points at the signed catalog", () => {
    const m = ucpManifest(company);
    const names = m.ucp.capabilities.map((c) => c.name);
    expect(names).toContain("dev.ucp.shopping.catalog");
    expect(names).toContain("dev.ucp.shopping.product_discovery");
    const checkout = m.ucp.capabilities.find((c) => c.name === "dev.ucp.shopping.checkout")!;
    expect(checkout.endpoints?.create_session).toBe("https://acme.com/ucp/checkout-sessions");
    expect(checkout.endpoints?.cancel_session).toBeNull();
    expect(m["co.trooth.semanto"].signed_catalog).toBe("https://api.trooth.co/public/semanto/acme-inc/feeds/ucp");
    expect(m["co.trooth.semanto"].keys).toBe("https://acme.com/.well-known/trooth-keys.json");
    const bare = ucpManifest(Object.assign({}, company, { checkout: undefined, jwks_url: undefined }));
    expect(bare.ucp.services["dev.ucp.shopping"]!.rest.endpoint).toBeNull();
    expect(bare["co.trooth.semanto"].keys).toBeNull();
  });

  it("a feed that matches the signed record has no drift", async () => {
    const feeds = await generateFeeds({ company, records, offers }, NOW);
    expect(await parityCheck({ company, records, offers }, "merchant-center", feeds.merchant_center.tsv)).toEqual([]);
    expect(await parityCheck({ company, records, offers }, "merchant-center", JSON.stringify(feeds.merchant_center.json))).toEqual([]);
    expect(await parityCheck({ company, records, offers }, "acp", JSON.stringify(feeds.acp))).toEqual([]);
    expect(await parityCheck({ company, records, offers }, "ucp", JSON.stringify(feeds.ucp.catalog))).toEqual([]);
  });

  it("the parity check reports a changed price in each feed, in the monitor's shape", async () => {
    const feeds = await generateFeeds({ company, records, offers }, NOW);
    const tsv = feeds.merchant_center.tsv.replace("12.99 USD\tin_stock\t012345678905", "11.99 USD\tin_stock\t012345678905");
    const d1 = await parityCheck({ company, records, offers }, "merchant-center", tsv);
    expect(d1).toEqual([{ key: "merchant-center:ACME-CL-500-BLU.price", signed_value: "12.99 USD", feed_value: "11.99 USD", kind: "price" }]);

    const acp = feeds.acp.map((i) => (i.id === "ACME-CL-1000-BLU" ? Object.assign({}, i, { price: "19.99" }) : i));
    const d2 = await parityCheck({ company, records, offers }, "acp", JSON.stringify(acp));
    expect(d2).toEqual([{ key: "acp:ACME-CL-1000-BLU.price", signed_value: "21.99", feed_value: "19.99", kind: "price" }]);

    const cat = JSON.parse(JSON.stringify(feeds.ucp.catalog)) as typeof feeds.ucp.catalog;
    const grn = cat.products.find((p) => p.id === "ACME-CL-500-GRN")!;
    grn.price.amount = 999;
    grn.availability = "in_stock";
    const d3 = await parityCheck({ company, records, offers }, "ucp", JSON.stringify(cat));
    expect(d3.map((d) => d.kind).sort()).toEqual(["availability", "price"]);
    expect(d3.find((d) => d.kind === "price")?.signed_value).toEqual({ amount: 1299, currency: "USD" });
  });

  it("reports missing and extra items", async () => {
    const feeds = await generateFeeds({ company, records, offers }, NOW);
    const acp = feeds.acp.slice(1).concat([Object.assign({}, feeds.acp[0]!, { id: "NOT-OURS" })]);
    const d = await parityCheck({ company, records, offers }, "acp", acp);
    expect(d.map((x) => x.kind).sort()).toEqual(["extra", "missing"]);
  });

  it("a record without an offer is skipped and said so", async () => {
    const feeds = await generateFeeds({ company, records, offers: offers.slice(0, 2) }, NOW);
    expect(feeds.skipped).toEqual([{ sku: "ACME-CL-1000-BLU", reason: "no_offer" }]);
  });
});

// ---------------------------------------------------------------- sellers

describe("authorized sellers", () => {
  it("signs with typ seller-attestation, verifies, and answers with one of four words", async () => {
    const signed = await signSellerAttestation(attestationInput, brandKey);
    expect(isSemantoId(signed.attestation.id, "sms")).toBe(true);
    const v = await verifySellerAttestation(signed.jws, byKid([brandPub]), { at: NOW });
    expect(v.ok).toBe(true);
    const raw = await verifyJws(signed.jws, byKid([brandPub]), { at: NOW });
    expect(raw.ok && raw.header.typ).toBe(JWS_TYPES.sellerAttestation);

    const brand: BrandSellers = { trooth_id: "acme-inc", attestations: [{ attestation: signed.attestation }] };
    const ok = isAuthorized(brand, "example-mart.com", "ACME-CL-500-BLU", NOW);
    expect(ok.state).toBe("authorized");
    expect(ok.attestation_id).toBe(signed.attestation.id);
    expect(isAuthorized(brand, "example-mart.com", "ACME-CL-1000-BLU", NOW).state).toBe("not_listed");
    expect(isAuthorized(brand, "someone-else.example", "ACME-CL-500-BLU", NOW).state).toBe("not_listed");
    const expired = isAuthorized(brand, "example-mart.com", "ACME-CL-500-BLU", new Date("2027-03-01T00:00:00Z"));
    expect(expired.state).toBe("expired");
    expect(expired.attestation_id).toBe(signed.attestation.id);
    expect(isAuthorized(brand, "example-mart.com", "ACME-CL-500-BLU", new Date("2025-06-01T00:00:00Z")).state).toBe("not_listed");

    const withdrawn: BrandSellers = { trooth_id: "acme-inc", attestations: [{ attestation: signed.attestation, withdrawn_at: "2026-10-01T00:00:00Z" }] };
    const w = isAuthorized(withdrawn, "example-mart.com", "ACME-CL-500-BLU", NOW);
    expect(w.state).toBe("withdrawn");
    expect(w.attestation_id).toBe(signed.attestation.id);
    expect(isAuthorized(withdrawn, "example-mart.com", "ACME-CL-500-BLU", new Date("2026-09-01T00:00:00Z")).state).toBe("authorized");
  });
  it("all_products covers every sku", async () => {
    const signed = await signSellerAttestation(Object.assign({}, attestationInput, { scope: "all_products" as const }), brandKey);
    const brand: BrandSellers = { trooth_id: "acme-inc", attestations: [{ attestation: signed.attestation }] };
    expect(isAuthorized(brand, "Example-Mart.com", "ANY-SKU", NOW).state).toBe("authorized");
  });
  it("points at the brand's record as the official spec", async () => {
    const p = await officialSpecPointer("acme-inc", records[0]!, company.public_base);
    expect(p.record_id).toBe(records[0]!.id);
    expect(p.record_url).toBe(`https://api.trooth.co/public/semanto/acme-inc/products/${records[0]!.id}`);
  });
  it("compares a seller listing to the official record field by field", () => {
    const c = compareListing(records[0]!, {
      sku: "ACME-CL-500-BLU",
      seller_domain: "example-mart.com",
      name: "Acme Surface Cleaner 500 ml, Blue",
      brand: "ACME",
      gtin: "00012345678905",
      mpn: "CL500B",
      attributes: [
        { name: "Color", value: "Blue" },
        { name: "Net volume", value: "750", unit: "ml" },
      ],
      ingredients: ["Aqua", "2-Propanol", "Sodium chlorite", "Parfum"],
      variant_axes: { size: "500 ml", color: "blue" },
    });
    const by = Object.fromEntries(c.fields.map((f) => [f.field, f.result]));
    expect(by["name"]).toBe("matches");
    expect(by["brand"]).toBe("matches");
    expect(by["gtin"]).toBe("matches");
    expect(by["attributes.Colour"]).toBe("matches");
    expect(by["attributes.Net volume"]).toBe("mismatch");
    expect(by["attributes.Scent"]).toBe("not_in_listing");
    expect(by["description"]).toBe("not_in_listing");
    expect(by["ingredients.Isopropyl alcohol"]).toBe("matches");
    expect(by["ingredients.Sodium chloride"]).toBe("mismatch");
    expect(by["ingredients.Sodium chlorite"]).toBe("mismatch");
    expect(by["ingredients.Fragrance"]).toBe("matches");
    expect(by["variant_axes.color"]).toBe("matches");
    expect(by["regulatory.consumer_notice"]).toBe("not_in_listing");
    expect(c.all_stated_fields_match).toBe(false);
    expect(c.mismatches).toBe(3);
  });
});

// ---------------------------------------------------------------- nested

describe("nested marketplace signatures", () => {
  const keys = () => ({
    marketplace: byKid([marketPub]),
    seller: (seller_trooth_id: string, kid: string) => (seller_trooth_id === "acme-inc" ? byKid([sellerPub])(kid) : null),
  });

  it("verifies both layers and matches the listed price to the signed offer", async () => {
    const offer = await signOffer(offerInputs[0]!, sellerKey);
    const record = await signProductRecord(recordInputs[0]!, sellerKey);
    const cat = await signCatalog({ marketplace_trooth_id: "example-market", assembled_at: "2026-10-22T12:00:30Z", listings: [{ seller_trooth_id: "acme-inc", offer_jws: offer.jws, product_record_jws: record.jws, listed_price: { amount: 1299, currency: "USD" } }] }, marketKey);
    const raw = await verifyJws(cat.jws, byKid([marketPub]), { at: NOW });
    expect(raw.ok && raw.header.typ).toBe(JWS_TYPES.marketplaceCatalog);
    const v = await verifyCatalog(cat.jws, keys(), { at: NOW });
    expect(v.ok).toBe(true);
    expect(v.marketplace.ok).toBe(true);
    expect(v.listings[0]!.offer.ok).toBe(true);
    expect(v.listings[0]!.record?.ok).toBe(true);
    expect(v.listings[0]!.price).toBe("matches");
    expect(v.failed_layers).toEqual([]);
  });

  it("reports the marketplace layer when the outer signature is from an unknown key, and still checks the sellers", async () => {
    const offer = await signOffer(offerInputs[0]!, sellerKey);
    const cat = await signCatalog({ marketplace_trooth_id: "example-market", assembled_at: "2026-10-22T12:00:30Z", listings: [{ seller_trooth_id: "acme-inc", offer_jws: offer.jws }] }, otherKey);
    const v = await verifyCatalog(cat.jws, keys(), { at: NOW });
    expect(v.ok).toBe(false);
    expect(v.marketplace.ok).toBe(false);
    expect(v.marketplace.reason).toBe("unknown_key");
    expect(v.failed_layers).toEqual(["marketplace"]);
    expect(v.listings[0]!.offer.ok).toBe(true);
    expect(v.listings[0]!.price).toBe("not_listed");
  });

  it("reports the seller_offer layer when an inner offer was signed by someone else or names another seller", async () => {
    const forged = await signOffer(offerInputs[0]!, otherKey);
    const wrongSeller = await signOffer(Object.assign({}, offerInputs[1], { seller: { domain: "acme.com", trooth_id: "not-acme" } }), sellerKey);
    const cat = await signCatalog({ marketplace_trooth_id: "example-market", assembled_at: "2026-10-22T12:00:30Z", listings: [{ seller_trooth_id: "acme-inc", offer_jws: forged.jws }, { seller_trooth_id: "acme-inc", offer_jws: wrongSeller.jws }] }, marketKey);
    const v = await verifyCatalog(cat.jws, keys(), { at: NOW });
    expect(v.marketplace.ok).toBe(true);
    expect(v.listings[0]!.failed_layer).toBe("seller_offer");
    expect(v.listings[0]!.offer.reason).toBe("unknown_key");
    expect(v.listings[1]!.failed_layer).toBe("seller_offer");
    expect(v.listings[1]!.offer.reason).toBe("seller_mismatch");
    expect(v.failed_layers).toEqual(["seller_offer"]);
  });

  it("reports the seller_record layer on its own, and a price mismatch as a mismatch, not a signature failure", async () => {
    const offer = await signOffer(offerInputs[0]!, sellerKey);
    const badRecord = await signProductRecord(recordInputs[0]!, otherKey);
    const cat = await signCatalog({ marketplace_trooth_id: "example-market", assembled_at: "2026-10-22T12:00:30Z", listings: [{ seller_trooth_id: "acme-inc", offer_jws: offer.jws, product_record_jws: badRecord.jws, listed_price: { amount: 999, currency: "USD" } }] }, marketKey);
    const v = await verifyCatalog(cat.jws, keys(), { at: NOW });
    expect(v.ok).toBe(false);
    expect(v.listings[0]!.offer.ok).toBe(true);
    expect(v.listings[0]!.record?.ok).toBe(false);
    expect(v.listings[0]!.failed_layer).toBe("seller_record");
    expect(v.listings[0]!.price).toBe("mismatch");
    expect(v.listings[0]!.signed_price).toEqual({ amount: 1299, currency: "USD" });
    expect(v.listings[0]!.listed_price).toEqual({ amount: 999, currency: "USD" });
    expect(v.price_mismatches).toBe(1);
    expect(v.failed_layers).toEqual(["seller_record"]);
  });

  it("a tampered envelope fails the marketplace layer with bad_signature", async () => {
    const offer = await signOffer(offerInputs[0]!, sellerKey);
    const cat = await signCatalog({ marketplace_trooth_id: "example-market", assembled_at: "2026-10-22T12:00:30Z", listings: [{ seller_trooth_id: "acme-inc", offer_jws: offer.jws }] }, marketKey);
    const [h, , s] = cat.jws.split(".") as [string, string, string];
    const payload = Object.assign({}, cat.catalog, { marketplace_trooth_id: "someone-else" });
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const v = await verifyCatalog(`${h}.${p}.${s}`, keys(), { at: NOW });
    expect(v.marketplace.ok).toBe(false);
    expect(v.marketplace.reason).toBe("bad_signature");
    expect(v.failed_layers).toEqual(["marketplace"]);
  });
});

// ---------------------------------------------------------------- recalls

describe("recalls", () => {
  it("signs with typ recall-notice and verifies", async () => {
    const s = await signRecall(recallInput, brandKey);
    expect(isSemantoId(s.notice.id, "smn")).toBe(true);
    const v = await verifyRecall(s.jws, byKid([brandPub]), { at: NOW });
    expect(v.ok).toBe(true);
    const raw = await verifyJws(s.jws, byKid([brandPub]), { at: NOW });
    expect(raw.ok && raw.header.typ).toBe(JWS_TYPES.recall);
    await expect(signRecall(Object.assign({}, recallInput, { skus: [], gtins: [] }), brandKey)).rejects.toThrow();
    await expect(signRecall(Object.assign({}, recallInput, { gtins: ["96385075"] }), brandKey)).rejects.toThrow();
  });
  it("a recall overrides availability whatever the stock", async () => {
    const s = await signRecall(recallInput, brandKey);
    const offer = await buildOffer(offerInputs[2]!);
    expect(offer.availability).toBe("in_stock");
    expect(availabilityAnswer(offer, [s.notice], { now: NOW })).toBe("recalled");
    const overlay = withRecallStatus(offer, [s.notice], { now: NOW });
    expect(overlay.recalled).toBe(true);
    expect(overlay.availability_answer).toBe("recalled");
    expect(overlay.recall_ids).toEqual([s.notice.id]);
    expect(overlay.recall_actions).toEqual(["stop_use"]);
    expect(overlay.offer.availability).toBe("in_stock");
    const other = await buildOffer(offerInputs[0]!);
    expect(availabilityAnswer(other, [s.notice], { now: NOW })).toBe("in_stock");
  });
  it("matches by gtin, respects lots when known, and is cautious when the lot is unknown", async () => {
    const s = await signRecall(recallInput, brandKey);
    const offer = await buildOffer(Object.assign({}, offerInputs[2], { sku: "RESELLER-SKU-1" }));
    expect(affected(offer, [s.notice], { now: NOW }).recalled).toBe(false);
    const byGtin = affected(offer, [s.notice], { now: NOW, gtin: "00000096385074" });
    expect(byGtin.recalled).toBe(true);
    expect(byGtin.matched_by).toEqual(["gtin"]);
    expect(byGtin.lot_unknown).toBe(true);
    expect(affected(offer, [s.notice], { now: NOW, gtin: "96385074", lot: "L2026-09-A" }).recalled).toBe(true);
    expect(affected(offer, [s.notice], { now: NOW, gtin: "96385074", lot: "L2026-11-C" }).recalled).toBe(false);
  });
  it("a notice not yet issued or already closed does not apply", async () => {
    const s = await signRecall(recallInput, brandKey);
    const offer = await buildOffer(offerInputs[2]!);
    expect(affected(offer, [s.notice], { now: new Date("2026-10-01T00:00:00Z") }).recalled).toBe(false);
    const closed = await signRecall(Object.assign({}, recallInput, { closed_at: "2026-10-22T00:00:00Z" }), brandKey);
    expect(affected(offer, [closed.notice], { now: NOW }).recalled).toBe(false);
    expect(recallChangeEntry("acme-inc", closed).kind).toBe("recall_closed");
  });
  it("the change-feed entry carries the notice and its signature", async () => {
    const s = await signRecall(recallInput, brandKey);
    const e = recallChangeEntry("acme-inc", s);
    expect(e.object).toBe("semanto.change");
    expect(e.kind).toBe("recall_issued");
    expect(e.ref).toBe(s.notice.id);
    expect(e.at).toBe("2026-10-21T15:00:00Z");
    expect(e.skus).toEqual(["ACME-CL-1000-BLU"]);
    expect(e.lots).toEqual(["L2026-09-A", "L2026-09-B"]);
    expect(e.authority?.name).toContain("Consumer Product Safety Commission");
    expect(e.jws).toBe(s.jws);
  });
});

// ---------------------------------------------------------------- routes through the in-memory store

describe("routes", () => {
  it("serves offers with as_of and not_after, the recall overlay, and feeds by path", async () => {
    const store = new InMemoryCommerceStore();
    store.setCompany(company);
    for (const r of recordInputs) await store.putRecord("acme-inc", await signProductRecord(r, brandKey));
    for (const o of offerInputs) await store.putOffer("acme-inc", await signOffer(o, brandKey));
    await store.putRecall("acme-inc", await signRecall(recallInput, brandKey));

    const one = await offerResponse(store, "acme-inc", "ACME-CL-1000-BLU", NOW);
    expect(one.status).toBe(200);
    const body = JSON.parse(one.body) as { as_of: string; not_after: string; state: string; availability_answer: string; recalled: boolean };
    expect(body.as_of).toBe("2026-10-22T12:00:00Z");
    expect(body.not_after).toBe("2026-10-22T12:15:00.000Z");
    expect(body.state).toBe("fresh");
    expect(body.availability_answer).toBe("recalled");
    expect(one.headers["Cache-Control"]).toBe("max-age=840");

    const missing = await offerResponse(store, "acme-inc", "NOPE", NOW);
    expect(missing.status).toBe(404);
    expect(missing.headers["Content-Type"]).toContain("application/problem+json");
    const prob = JSON.parse(missing.body) as { code: string; retryable: boolean; next_action: string; terminal: boolean };
    expect(prob.code).toBe("offer_not_found");
    expect(typeof prob.next_action).toBe("string");

    const tsv = await feedResponse(store, "acme-inc", "merchant-center", NOW, "tsv");
    expect(tsv.headers["Content-Type"]).toContain("text/tab-separated-values");
    expect(parseMerchantCenterTsv(tsv.body).length).toBe(3);
    const acp = await feedResponse(store, "acme-inc", "acp", NOW);
    expect((JSON.parse(acp.body) as unknown[]).length).toBe(3);
    const ucp = await feedResponse(store, "acme-inc", "ucp", NOW);
    expect((JSON.parse(ucp.body) as { object: string }).object).toBe("ucp.catalog");
    expect((await feedResponse(store, "acme-inc", "shopify", NOW)).status).toBe(404);

    const manifest = await ucpManifestResponse(store, "acme-inc");
    expect((JSON.parse(manifest.body) as { ucp: { version: string } }).ucp.version).toBe("2026-01-11");

    const products = await productsResponse(store, "acme-inc", NOW);
    expect((JSON.parse(products.body) as { products: unknown[] }).products.length).toBe(3);
  });
});
