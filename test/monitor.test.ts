// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for the consistency monitor. Fixtures are a plainly fictional company
// (Acme Inc, acme.com) under test/fixtures/monitor. No figure here is a
// measurement.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { digest } from "@/core/hash";
import { utf8 } from "@/core/encoding";
import { isSemantoId } from "@/core/ids";
import {
  readLivePageFrom,
  readLivePage,
  parseMerchantCenterContentApi,
  parseMerchantCenterTsv,
  parseMerchantCenterXml,
  merchantCenterRead,
  parseBusinessProfile,
  parseUcpManifest,
  parseUcpCatalogItem,
  ucpCatalogRead,
  parseAcpFeed,
  acpRead,
  signedFacts,
  readSemanto,
} from "@/monitor/surfaces";
import { compareSurface, compareLivePage, compareAll, buildRun, runToRow, runFromRow, severityFor, surfaceCovers } from "@/monitor/consistency";
import { normalizePhone, normalizeAddress, equivalent, normalizeHours, parsePrice, whatDiffers, displayPhone } from "@/monitor/normalize";
import { indexabilityReport, robotsAllows, pageIndexability } from "@/monitor/indexability";
import { merchantCenterPayload, merchantCenterSupplementalFeed, businessProfilePayload, jsonLdDiff, siteJsonLdPayload, acpFeedPayload, ucpCatalogPayload, allPayloads, sendPayload, splitAddress } from "@/monitor/writeback";
import { alertsFrom, dedupeAlerts, applyDailyCap, buildEmail, toDashboard, messageForMismatch, dayWords, alertToRow, alertFromRow, resolvedAlerts } from "@/monitor/alerts";
import { runMonitor } from "@/monitor/run";
import { fetchFromMap, fixedClock, memoryStore, memoryEmail, memoryTokens, type FetchResult } from "@/monitor/ports";
import type { LivePageRead, Mismatch, SignedRecord, SurfaceRead } from "@/monitor/types";

const FIX = new URL("./fixtures/monitor/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIX), "utf8");
const NOW = "2026-10-22T10:00:00.000Z";
// Built from parts so the banned words and the three-dot sequence never appear in this file.
const BANNED = new RegExp(["sc" + "ore", "veri" + "fied", "certi" + "fied"].join("|"), "i");
const THREE_DOTS = String.fromCharCode(46).repeat(3);

const PAGES: Record<string, string> = {
  "https://acme.com/": "fixture-page-home.html",
  "https://acme.com/contact": "fixture-page-contact.html",
  "https://acme.com/pricing": "fixture-page-pricing.html",
  "https://acme.com/security": "fixture-page-security.html",
  "https://acme.com/products/kettle-1": "fixture-page-kettle.html",
};

let record: SignedRecord;

/** The fixture record with every page's source_hash set to the fixture HTML, except the Security page, which stays as changed. */
async function loadRecord(): Promise<SignedRecord> {
  const r = JSON.parse(read("fixture-signed-record.json")) as SignedRecord;
  for (const p of r.pages) {
    if (p.url === "https://acme.com/security") continue;
    p.source_hash = await digest(utf8(read(PAGES[p.url]!)));
  }
  return r;
}

function routes(): Record<string, FetchResult | string> {
  const out: Record<string, FetchResult | string> = {};
  for (const [url, file] of Object.entries(PAGES)) out[url] = read(file);
  out["https://acme.com/robots.txt"] = { status: 200, headers: { "content-type": "text/plain" }, body: read("fixture-robots.txt") };
  out["https://shoppingcontent.googleapis.com/content/v2.1/123/products"] = { status: 200, headers: { "content-type": "application/json" }, body: read("fixture-merchant-center-content-api.json") };
  out["https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890"] = { status: 200, headers: { "content-type": "application/json" }, body: read("fixture-business-profile.json") };
  out["https://acme.com/.well-known/ucp"] = { status: 200, headers: { "content-type": "application/json" }, body: read("fixture-ucp-manifest.json") };
  out["https://acme.com/.well-known/ucp-catalog.json"] = { status: 200, headers: { "content-type": "application/json" }, body: read("fixture-ucp-catalog.json") };
  out["https://acme.com/.well-known/acp-products.jsonl"] = { status: 200, headers: { "content-type": "application/x-ndjson" }, body: read("fixture-acp-feed.jsonl") };
  return out;
}

beforeAll(async () => {
  record = await loadRecord();
});

const byKey = (facts: { key: string; value: unknown }[], key: string) => facts.find((f) => f.key === key)?.value;

// ---------------------------------------------------------------- readers

describe("surface readers", () => {
  it("reads the live home page: JSON-LD facts, index signals, title, @id", async () => {
    const page = await readLivePageFrom("https://acme.com/", { status: 200, headers: { "content-type": "text/html" }, body: read("fixture-page-home.html") }, NOW);
    expect(page.title).toBe("Acme Inc");
    expect(byKey(page.facts, "identity.legal_name")).toBe("Acme Inc");
    expect(byKey(page.facts, "contact.phone")).toBe("+1-312-555-0199");
    expect(byKey(page.facts, "contact.address")).toBe("120 N Main St, Ste 4, Springfield, IL 62701, US");
    expect(byKey(page.facts, "hours.monday")).toBe("09:00-17:00");
    expect(byKey(page.facts, "hours.friday")).toBe("09:00-17:00");
    expect(page.jsonld_ids).toContain("https://acme.com/#semanto");
    expect(page.index).toMatchObject({ noindex: false, nosnippet: false, canonical: "https://acme.com/" });
    expect(page.text).toContain("Call +1 (312) 555-0199");
    expect(page.source_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reads microdata on the contact page into the same keys", async () => {
    const page = await readLivePageFrom("https://acme.com/contact", { status: 200, headers: {}, body: read("fixture-page-contact.html") }, NOW);
    expect(page.microdata.length).toBe(1);
    expect(page.microdata[0]!.type).toBe("https://schema.org/LocalBusiness");
    expect(byKey(page.facts, "contact.phone")).toBe("312.555.0199");
    expect(byKey(page.facts, "contact.address")).toBe("120 North Main Street, Suite 4, Springfield, IL 62701, US");
    expect(byKey(page.facts, "identity.legal_name")).toBe("Acme Inc");
  });

  it("reads a Product in a @graph with sku, gtin, price and availability", async () => {
    const page = await readLivePageFrom("https://acme.com/products/kettle-1", { status: 200, headers: {}, body: read("fixture-page-kettle.html") }, NOW);
    expect(byKey(page.facts, "product.KET-100.price")).toEqual({ amount: "49.00", currency: "USD" });
    expect(byKey(page.facts, "product.KET-100.availability")).toBe("https://schema.org/InStock");
    expect(byKey(page.facts, "product.KET-100.gtin")).toBe("0012345678905");
    expect(byKey(page.facts, "product.KET-100.brand")).toBe("Acme");
  });

  it("sees noindex and the absence of JSON-LD on the pricing page", async () => {
    const page = await readLivePageFrom("https://acme.com/pricing", { status: 200, headers: {}, body: read("fixture-page-pricing.html") }, NOW);
    expect(page.index.noindex).toBe(true);
    expect(page.jsonld.length).toBe(0);
    expect(page.notes).toContain("no JSON-LD block on the page");
  });

  it("reads X-Robots-Tag and the Date header", async () => {
    const page = await readLivePageFrom("https://acme.com/x", { status: 200, headers: { "x-robots-tag": "noindex, nosnippet", date: "Tue, 20 Oct 2026 10:00:00 GMT" }, body: "<html><head><title>X</title></head><body>x</body></html>" }, NOW);
    expect(page.index.noindex).toBe(true);
    expect(page.index.nosnippet).toBe(true);
    expect(page.observed_at).toBe("2026-10-20T10:00:00.000Z");
  });

  it("reads the signed record as facts, with a fresh offer winning over the product price", () => {
    const facts = signedFacts(record, NOW);
    expect(byKey(facts, "contact.phone")).toBe("+1 312 555 0199");
    expect(byKey(facts, "product.KET-100.price")).toEqual({ amount: "49.00", currency: "USD" });
    expect(byKey(facts, "product.TST-200.price")).toEqual({ amount: "27.50", currency: "USD" });
    expect(byKey(facts, "product.KET-100.consumer_notice")).toMatch(/^WARNING/);
    expect(facts.find((f) => f.key === "privacy.dpo_contact")).toBeUndefined();
    const sem = readSemanto(record, NOW, "https://api.trooth.co/public/semanto/acme");
    expect(sem.surface).toBe("semanto");
    expect(sem.facts.length).toBe(facts.length);
  });

  it("parses the Merchant Center Content API shape", () => {
    const products = parseMerchantCenterContentApi(JSON.parse(read("fixture-merchant-center-content-api.json")));
    expect(products.map((p) => p.key)).toEqual(["KET-100", "TST-200", "MUG-300"]);
    expect(products[0]!.price).toEqual({ amount: "45.00", currency: "USD" });
    expect(products[0]!.gtin).toBe("12345678905");
    expect(products[0]!.notice).toBeNull();
    const r = merchantCenterRead(products, "https://example.invalid/feed", NOW, "content_api");
    expect(byKey(r.facts, "product.KET-100.price")).toEqual({ amount: "45.00", currency: "USD" });
    expect(byKey(r.facts, "product.MUG-300.name")).toBe("Acme Mug");
  });

  it("parses a TSV feed with consumer_notice", () => {
    const products = parseMerchantCenterTsv(read("fixture-merchant-center.tsv"));
    expect(products.length).toBe(2);
    expect(products[0]!.notice).toEqual({ type: "prop_65", message: "WARNING: This product can expose you to chemicals known to the State of California to cause cancer." });
    expect(products[0]!.price).toEqual({ amount: "45.00", currency: "USD" });
    expect(products[1]!.gtin).toBeNull();
  });

  it("parses an RSS XML feed with the g: namespace", () => {
    const products = parseMerchantCenterXml(read("fixture-merchant-center.xml"));
    expect(products.length).toBe(2);
    expect(products[0]!.key).toBe("KET-100");
    expect(products[0]!.url).toBe("https://acme.com/products/kettle-1");
    expect(products[0]!.notice?.type).toBe("prop_65");
    expect(products[0]!.notice?.message).toMatch(/^WARNING/);
    expect(products[0]!.availability).toBe("in stock");
  });

  it("parses the Business Profile location shape", () => {
    const r = parseBusinessProfile(JSON.parse(read("fixture-business-profile.json")), "https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890", NOW);
    expect(byKey(r.facts, "identity.legal_name")).toBe("Acme Inc");
    expect(byKey(r.facts, "contact.phone")).toBe("(312) 555-0100");
    expect(byKey(r.facts, "contact.address")).toBe("120 N Main St, Ste 4, Springfield, IL 62701, US");
    expect(byKey(r.facts, "hours.monday")).toBe("09:00-17:00");
    expect(byKey(r.facts, "hours.saturday")).toBe("closed");
    expect(byKey(r.facts, "contact.website")).toBe("https://acme.com/");
    expect(byKey(r.facts, "business.category")).toBe("Kitchen supply store");
  });

  it("parses the UCP manifest and a catalog item", () => {
    const m = parseUcpManifest(JSON.parse(read("fixture-ucp-manifest.json")), "https://acme.com/.well-known/ucp", NOW);
    expect(byKey(m.facts, "ucp.version")).toBe("2026-01-11");
    expect(byKey(m.facts, "ucp.services")).toEqual(["dev.ucp.shopping"]);
    expect(byKey(m.facts, "ucp.capabilities")).toEqual(["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"]);
    expect(byKey(m.facts, "ucp.endpoints")).toEqual(["https://acme.com/ucp/v1"]);
    const cat = JSON.parse(read("fixture-ucp-catalog.json")) as { items: unknown[] };
    const item = parseUcpCatalogItem(cat.items[0]);
    expect(item?.key).toBe("KET-100");
    expect(item?.notice?.message).toMatch(/^WARNING/);
    const r = ucpCatalogRead(cat.items, "https://acme.com/.well-known/ucp-catalog.json", NOW);
    expect(byKey(r.facts, "product.KET-100.native_commerce")).toBe(true);
    expect(byKey(r.facts, "product.KET-100.merchant_item_id")).toBe("p-100");
    expect(byKey(r.facts, "product.KET-100.consumer_notice")).toMatch(/^WARNING/);
  });

  it("parses the ACP feed as JSON lines and as an array", () => {
    const lines = parseAcpFeed(read("fixture-acp-feed.jsonl"));
    expect(lines.length).toBe(2);
    expect(lines[0]!.inventory).toBe(12);
    expect(lines[0]!.price).toEqual({ amount: "49.00", currency: "USD" });
    const arr = parseAcpFeed(JSON.stringify(lines.map((l) => ({ id: l.id, title: l.name, link: l.url, price: "1.00 USD", availability: "in_stock" }))));
    expect(arr.length).toBe(2);
    const r = acpRead(lines, "https://acme.com/.well-known/acp-products.jsonl", NOW);
    expect(byKey(r.facts, "product.KET-100.inventory_quantity")).toBe(12);
  });

  it("reads a page through the fetch port and reports a fetch failure as a note, never as a mismatch", async () => {
    const failing = { get: async () => { throw new Error("network down"); } };
    const page = await readLivePage(failing, "https://acme.com/", NOW);
    expect(page.status).toBe(0);
    expect(page.notes.some((n) => n.startsWith("fetch failed"))).toBe(true);
    expect(compareLivePage(record, signedFacts(record, NOW), page)).toEqual([]);
  });
});

// ------------------------------------------------------------- tolerance

describe("tolerant comparisons", () => {
  it("normalizes phones to E.164 and does not flag equivalent formats", () => {
    expect(normalizePhone("(312) 555-0199")).toBe("+13125550199");
    expect(normalizePhone("+1 312 555 0199")).toBe("+13125550199");
    expect(normalizePhone("312.555.0199")).toBe("+13125550199");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(equivalent("contact.phone", "+1 312 555 0199", "(312) 555-0199")).toBe(true);
    expect(equivalent("contact.phone", "+1 312 555 0199", "(312) 555-0100")).toBe(false);
    expect(displayPhone("+13125550100")).toBe("+1 312 555 0100");
  });

  it("normalizes address spacing and abbreviations", () => {
    expect(normalizeAddress("120 North Main Street,  Suite 4, Springfield, IL 62701, US")).toBe("120 n main st ste 4 springfield il 62701 us");
    expect(equivalent("contact.address", "120 North Main Street, Suite 4, Springfield, IL 62701, US", "120 N Main St, Ste 4, Springfield, IL 62701, United States")).toBe(true);
    expect(equivalent("contact.address", "120 North Main Street, Springfield, IL 62701", "121 North Main Street, Springfield, IL 62701")).toBe(false);
  });

  it("compares prices as amount and currency", () => {
    expect(parsePrice("49.00 USD")).toEqual({ amount: "49.00", currency: "USD" });
    expect(parsePrice("$1,299")).toEqual({ amount: "1299.00", currency: "USD" });
    expect(parsePrice({ value: "45", currency: "usd" })).toEqual({ amount: "45.00", currency: "USD" });
    expect(equivalent("product.x.price", { amount: "49.00", currency: "USD" }, "49 USD")).toBe(true);
    expect(equivalent("product.x.price", { amount: "49.00", currency: "USD" }, "49.00 EUR")).toBe(false);
    expect(equivalent("product.x.price", { amount: "49.00", currency: "USD" }, "45.00 USD")).toBe(false);
  });

  it("compares hours per day and availability by schema.org name", () => {
    expect(normalizeHours("9:00 AM - 5:00 PM")).toBe("09:00-17:00");
    expect(normalizeHours(["13:00-17:00", "09:00-12:00"])).toBe("09:00-12:00, 13:00-17:00");
    expect(normalizeHours("Closed")).toBe("closed");
    expect(equivalent("hours.monday", "9:00 AM - 5:00 PM", "09:00-17:00")).toBe(true);
    expect(equivalent("hours.monday", "9:00 AM - 5:00 PM", "09:00-18:00")).toBe(false);
    expect(equivalent("product.x.availability", "in_stock", "https://schema.org/InStock")).toBe(true);
    expect(equivalent("product.x.availability", "in stock", "out of stock")).toBe(false);
    expect(equivalent("product.x.gtin", "00012345678905", "12345678905")).toBe(true);
  });

  it("compares names without case or punctuation and says what differs", () => {
    expect(equivalent("identity.legal_name", "Acme, Inc.", "ACME INC")).toBe(true);
    expect(equivalent("identity.legal_name", "Acme Inc", "Acme Holdings Inc")).toBe(false);
    expect(whatDiffers("Acme Inc", "Acme Holdings Inc")).toBe('the surface has "holdings"');
  });
});

// ----------------------------------------------------------- consistency

describe("consistency", () => {
  it("produces every kind and severity for the fixture surfaces", async () => {
    const pages: LivePageRead[] = [];
    for (const [url, file] of Object.entries(PAGES)) pages.push(await readLivePageFrom(url, { status: 200, headers: {}, body: read(file) }, NOW));
    const reads: SurfaceRead[] = [
      merchantCenterRead(parseMerchantCenterContentApi(JSON.parse(read("fixture-merchant-center-content-api.json"))), "https://shoppingcontent.googleapis.com/content/v2.1/123/products", NOW, "content_api"),
      parseBusinessProfile(JSON.parse(read("fixture-business-profile.json")), "https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890", NOW),
      acpRead(parseAcpFeed(read("fixture-acp-feed.jsonl")), "https://acme.com/.well-known/acp-products.jsonl", NOW),
    ];
    const list = compareAll({ record, reads, pages, at: NOW });
    const find = (key: string, surface: string) => list.find((m) => m.key === key && m.surface === surface);

    const price = find("product.KET-100.price", "merchant_center");
    expect(price).toMatchObject({ kind: "differs", severity: "trust", signed_fact_id: "smk_aaaaaaaaaaaaaaaaaaaaaaaaaa", signed_evidence_url: "https://acme.com/products/kettle-1" });
    expect(price?.signed_value).toEqual({ amount: "49.00", currency: "USD" });
    expect(price?.surface_value).toEqual({ amount: "45.00", currency: "USD" });

    const phone = find("contact.phone", "business_profile");
    expect(phone).toMatchObject({ kind: "differs", severity: "trust", signed_value: "+1 312 555 0199", surface_value: "(312) 555-0100", signed_fact_id: "smf_bbbbbbbbbbbbbbbbbbbbbbbbbb" });

    const jsonld = find("page.jsonld", "live_page");
    expect(jsonld).toMatchObject({ kind: "missing_on_surface", severity: "visibility", surface_url: "https://acme.com/pricing" });

    const notice = find("product.KET-100.consumer_notice", "merchant_center");
    expect(notice).toMatchObject({ kind: "missing_on_surface", severity: "note" });
    expect(notice?.signed_value).toMatch(/^WARNING/);

    const mug = find("product.MUG-300", "merchant_center");
    expect(mug).toMatchObject({ kind: "missing_in_record", severity: "note", surface_value: "Acme Mug" });

    const changed = find("page.content", "live_page");
    expect(changed).toMatchObject({ kind: "differs", severity: "note", surface_url: "https://acme.com/security", signed_witnessed_at: "2026-10-12T08:00:00.000Z" });

    // Things that match are not reported: address spacing, phone format on the pages, gtin leading zeros, the offer price, hours, closed days.
    expect(find("contact.address", "business_profile")).toBeUndefined();
    expect(find("contact.phone", "live_page")).toBeUndefined();
    expect(find("contact.address", "live_page")).toBeUndefined();
    expect(find("product.KET-100.gtin", "merchant_center")).toBeUndefined();
    expect(find("product.TST-200.price", "merchant_center")).toBeUndefined();
    expect(find("product.TST-200.price", "acp")).toBeUndefined();
    expect(find("hours.monday", "business_profile")).toBeUndefined();
    expect(find("hours.saturday", "business_profile")).toBeUndefined();
    expect(find("identity.legal_name", "live_page")).toBeUndefined();
    expect(find("security.mfa_methods", "live_page")).toBeUndefined();
    // The ACP feed has no consumer_notice field, so it is never asked for one.
    expect(find("product.KET-100.consumer_notice", "acp")).toBeUndefined();
    // Sorted: trust first.
    expect(list[0]!.severity).toBe("trust");
    expect(list[list.length - 1]!.severity).toBe("note");
    expect(list.length).toBe(6);
  });

  it("marks a differing value as stale when the surface was observed before the signed value was witnessed", () => {
    const signed = signedFacts(record, NOW);
    const old: SurfaceRead = { surface: "business_profile", url: "https://example.invalid/loc", observed_at: "2026-10-01T00:00:00.000Z", notes: [], facts: [{ surface: "business_profile", key: "contact.phone", value: "+1 312 555 0100", url: "https://example.invalid/loc", observed_at: "2026-10-01T00:00:00.000Z" }] };
    const list = compareSurface(signed, old);
    const stale = list.find((m) => m.key === "contact.phone");
    expect(stale?.kind).toBe("stale");
    expect(stale?.severity).toBe("trust");
    // Only the phone was on the surface, so only the phone is compared; absent fields on a partial listing are missing_on_surface.
    expect(list.find((m) => m.key === "contact.address")?.kind).toBe("missing_on_surface");
  });

  it("reports a product the surface lists but the record lacks only once, and a record product the surface lacks once", () => {
    const signed = signedFacts(record, NOW);
    const r = merchantCenterRead(parseMerchantCenterContentApi(JSON.parse(read("fixture-merchant-center-content-api.json"))).filter((p) => p.key !== "TST-200"), "https://example.invalid/feed", NOW, "content_api");
    const list = compareAll({ record, reads: [r], pages: [], at: NOW });
    expect(list.filter((m) => m.key.startsWith("product.MUG-300")).length).toBe(1);
    const toaster = list.find((m) => m.key === "product.TST-200");
    expect(toaster?.kind).toBe("missing_on_surface");
    expect(toaster?.signed_value).toBe("Acme Toaster");
  });

  it("knows which keys each surface covers and which severity a key carries", () => {
    expect(surfaceCovers("merchant_center", "product.KET-100.consumer_notice")).toBe(true);
    expect(surfaceCovers("acp", "product.KET-100.consumer_notice")).toBe(false);
    expect(surfaceCovers("business_profile", "hours.monday")).toBe(true);
    expect(surfaceCovers("business_profile", "product.KET-100.price")).toBe(false);
    expect(severityFor("contact.phone", "differs")).toBe("trust");
    expect(severityFor("page.jsonld", "missing_on_surface")).toBe("visibility");
    expect(severityFor("product.x.gtin", "differs")).toBe("note");
    expect(severityFor("contact.phone", "missing_in_record")).toBe("note");
  });

  it("builds a run that round-trips through the semanto_monitor_runs row shape", async () => {
    const run = await buildRun("acme", NOW, [{ surface: "semanto", state: "read", url: null, note: "x", facts: 1 }], [], indexabilityReport([], new Map()));
    expect(isSemantoId(run.id, "smm")).toBe(true);
    const row = runToRow(run);
    expect(Object.keys(row).sort()).toEqual(["id", "indexability_json", "mismatches_json", "ran_at", "surfaces_json", "trooth_id"]);
    expect(runFromRow(row)).toEqual(run);
  });
});

// ---------------------------------------------------------- indexability

describe("indexability", () => {
  it("reports eligibility, reasons and the generated JSON-LD per page with site totals", async () => {
    const live = new Map<string, LivePageRead | null>();
    for (const [url, file] of Object.entries(PAGES)) live.set(url, await readLivePageFrom(url, { status: 200, headers: {}, body: read(file) }, NOW));
    const report = indexabilityReport(record.pages, live, { robotsTxt: read("fixture-robots.txt") });
    const pricing = report.pages.find((p) => p.url === "https://acme.com/pricing");
    expect(pricing).toMatchObject({ eligible: false, reasons: ["noindex"], jsonld_present: false });
    const home = report.pages.find((p) => p.url === "https://acme.com/");
    expect(home).toMatchObject({ eligible: true, reasons: [], jsonld_present: true, expected_jsonld_id: "https://acme.com/#semanto" });
    expect(report.totals).toMatchObject({ pages: 5, eligible: 4, not_eligible: 1, jsonld_present: 4 });
    expect(report.totals.by_reason.noindex).toBe(1);
  });

  it("sees a canonical elsewhere, a non-200, a soft 404 and a robots.txt block", async () => {
    const base = record.pages[0]!;
    const mk = (over: Partial<typeof base>) => Object.assign({}, base, over, { index: Object.assign({}, base.index, over.index ?? {}) });
    const canon = await readLivePageFrom("https://acme.com/a", { status: 200, headers: {}, body: '<html><head><title>A</title><link rel="canonical" href="https://acme.com/b"></head><body></body></html>' }, NOW);
    expect(pageIndexability(mk({ url: "https://acme.com/a", index: { canonical: null } as never }), canon).reasons).toEqual(["canonical_elsewhere"]);
    const gone = await readLivePageFrom("https://acme.com/gone", { status: 410, headers: {}, body: "" }, NOW);
    expect(pageIndexability(mk({ url: "https://acme.com/gone", index: { canonical: null } as never }), gone).reasons).toEqual(["non_200"]);
    const soft = await readLivePageFrom("https://acme.com/soft", { status: 200, headers: {}, body: "<html><head><title>Page not found | Acme</title></head><body></body></html>" }, NOW);
    expect(pageIndexability(mk({ url: "https://acme.com/soft", index: { canonical: null } as never }), soft).reasons).toEqual(["soft_404"]);
    const blocked = pageIndexability(mk({ url: "https://acme.com/drafts/x", index: { canonical: null } as never }), null, { robotsTxt: read("fixture-robots.txt") });
    expect(blocked.reasons).toEqual(["robots_blocked", "not_fetched"]);
    expect(robotsAllows(read("fixture-robots.txt"), "https://acme.com/internal/a")).toBe(false);
    expect(robotsAllows(read("fixture-robots.txt"), "https://acme.com/contact")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /p\nAllow: /pub", "https://acme.com/public")).toBe(true);
  });
});

// ------------------------------------------------------------- write-back

describe("write-back", () => {
  it("builds Merchant Center products.insert bodies with the signed values and the UCP attributes", () => {
    const p = merchantCenterPayload(record, { merchantId: "123", contentLanguage: "en", targetCountry: "US" }, NOW);
    expect(p.method).toBe("POST");
    expect(p.url).toBe("https://shoppingcontent.googleapis.com/content/v2.1/123/products");
    const body = JSON.parse(p.body) as { products: Record<string, unknown>[] };
    const kettle = body.products.find((x) => x.offerId === "KET-100")!;
    expect(kettle.price).toEqual({ value: "49.00", currency: "USD" });
    expect(kettle.gtin).toBe("00012345678905");
    expect(kettle.availability).toBe("in_stock");
    expect(kettle.consumerNotices).toEqual([{ noticeType: "PROP_65", noticeMessage: "WARNING: This product can expose you to chemicals known to the State of California to cause cancer." }]);
    expect(kettle.customAttributes).toEqual(expect.arrayContaining([{ name: "native_commerce", value: "true" }, { name: "merchant_item_id", value: "p-100" }]));
    const toaster = body.products.find((x) => x.offerId === "TST-200")!;
    expect(toaster.price).toEqual({ value: "27.50", currency: "USD" });
    expect(p.dry_run).toContain("Merchant Center account 123");
    const feed = merchantCenterSupplementalFeed(record, NOW);
    expect(feed.body.split("\n")[0]).toBe("id\ttitle\tlink\tprice\tavailability\tgtin\tbrand\tconsumer_notice\tnative_commerce\tmerchant_item_id");
    expect(feed.body).toContain("KET-100\tAcme Kettle 1.7L\thttps://acme.com/products/kettle-1\t49.00 USD\tin_stock\t00012345678905\tAcme\tprop_65:WARNING");
  });

  it("builds a Business Profile locations.patch with an updateMask from the signed facts", () => {
    const p = businessProfilePayload(record, "locations/1234567890");
    expect(p.method).toBe("PATCH");
    expect(p.url).toBe("https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890?updateMask=title%2CphoneNumbers.primaryPhone%2CstorefrontAddress%2CwebsiteUri%2CregularHours");
    const body = JSON.parse(p.body) as Record<string, unknown>;
    expect(body.title).toBe("Acme Inc");
    expect(body.phoneNumbers).toEqual({ primaryPhone: "+13125550199" });
    expect(body.storefrontAddress).toEqual({ regionCode: "US", postalCode: "62701", administrativeArea: "IL", locality: "Springfield", addressLines: ["120 North Main Street", "Suite 4"] });
    const hours = body.regularHours as { periods: Record<string, unknown>[] };
    expect(hours.periods.length).toBe(5);
    expect(hours.periods[0]).toEqual({ openDay: "MONDAY", openTime: { hours: 9, minutes: 0 }, closeDay: "MONDAY", closeTime: { hours: 17, minutes: 0 } });
    expect((p.carries as { updateMask: string[] }).updateMask).toEqual(["title", "phoneNumbers.primaryPhone", "storefrontAddress", "websiteUri", "regularHours"]);
    expect(splitAddress("1 High Street, London, SW1A 1AA, GB")).toMatchObject({ regionCode: "GB", addressLines: ["1 High Street"] });
  });

  it("diffs the page's JSON-LD against the generated block", async () => {
    const page = await readLivePageFrom("https://acme.com/", { status: 200, headers: {}, body: read("fixture-page-home.html") }, NOW);
    const generated = { "@context": "https://schema.org", "@type": "Organization", "@id": "https://acme.com/#semanto", legalName: "Acme Inc", telephone: "+13125550199" };
    const d = jsonLdDiff(page.jsonld, generated);
    expect(d.present).toBe(true);
    expect(d.differing_paths).toContain("telephone");
    expect(d.differing_paths).not.toContain("legalName");
    const absent = jsonLdDiff([], generated);
    expect(absent.present).toBe(false);
    expect(absent.differing_paths.length).toBe(5);
    const payload = siteJsonLdPayload("https://acme.com/", page.jsonld, generated);
    expect(payload.body.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(payload.needs).toBe("site_deploy");
  });

  it("writes the ACP feed and UCP catalog from the same record, and every payload at once", () => {
    const acp = acpFeedPayload(record, NOW);
    const lines = acp.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ id: "KET-100", price: "49.00 USD", availability: "in_stock", gtin: "00012345678905", seller_name: "Acme Inc" });
    expect(lines[1]!.price).toBe("27.50 USD");
    const ucp = ucpCatalogPayload(record, NOW);
    const cat = JSON.parse(ucp.body) as { items: Record<string, unknown>[] };
    expect(cat.items[0]).toMatchObject({ id: "KET-100", merchant_item_id: "p-100", native_commerce: true, consumer_notice: { type: "prop_65" } });
    const all = allPayloads(record, { merchantCenter: { merchantId: "123", contentLanguage: "en", targetCountry: "US" }, businessProfileLocation: "locations/1234567890", pages: [{ url: "https://acme.com/", current: [], generated: { "@type": "Organization", "@id": "https://acme.com/#semanto" } }], at: NOW });
    expect(all.payloads.map((p) => p.connector)).toEqual(["merchant_center", "merchant_center", "business_profile", "site_jsonld", "acp_feed", "ucp_catalog"]);
    expect(all.skipped).toEqual([]);
    const none = allPayloads(record, { at: NOW });
    expect(none.skipped.map((s) => s.connector)).toEqual(["merchant_center", "business_profile", "site_jsonld"]);
  });

  it("one change in the signed record changes every payload", () => {
    const changed: SignedRecord = JSON.parse(JSON.stringify(record)) as SignedRecord;
    changed.products[0]!.price = { amount: "52.00", currency: "USD" };
    const before = allPayloads(record, { merchantCenter: { merchantId: "123", contentLanguage: "en", targetCountry: "US" }, at: NOW }).payloads;
    const after = allPayloads(changed, { merchantCenter: { merchantId: "123", contentLanguage: "en", targetCountry: "US" }, at: NOW }).payloads;
    for (let i = 0; i < before.length; i++) {
      expect(before[i]!.body).not.toBe(after[i]!.body);
      expect(after[i]!.body).toContain("52.00");
    }
  });

  it("sends only with the customer's token through the port", async () => {
    const sent: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
    const fetchPort = fetchFromMap({}, sent);
    const p = businessProfilePayload(record, "locations/1234567890");
    const noToken = await sendPayload(p, { fetch: fetchPort, tokens: memoryTokens({}) });
    expect(noToken.sent).toBe(false);
    expect(sent.length).toBe(0);
    const withToken = await sendPayload(p, { fetch: fetchPort, tokens: memoryTokens({ business_profile: "ya29.fixture" }) });
    expect(withToken.sent).toBe(true);
    expect(sent[0]!.headers.authorization).toBe("Bearer ya29.fixture");
    expect(sent[0]!.method).toBe("PATCH");
    const file = await sendPayload(acpFeedPayload(record, NOW), { fetch: fetchPort, tokens: memoryTokens({ merchant_center: "x" }) });
    expect(file.sent).toBe(false);
    expect(file.sent === false && file.reason).toBe("not_http");
  });
});

// ----------------------------------------------------------------- alerts

describe("alerts", () => {
  const phoneMismatch: Mismatch = { key: "contact.phone", signed_value: "+1 312 555 0199", signed_fact_id: "smf_bbbbbbbbbbbbbbbbbbbbbbbbbb", signed_evidence_url: "https://acme.com/contact", signed_witnessed_at: "2026-10-12T08:00:00.000Z", surface: "business_profile", surface_value: "(312) 555-0100", surface_url: "https://example.invalid/loc", surface_observed_at: NOW, kind: "differs", severity: "trust" };

  it("reads plainly", async () => {
    expect(messageForMismatch(phoneMismatch, record)?.message).toBe("Google's business listing shows your phone as +1 312 555 0100. Your signed record says +1 312 555 0199. Which one is right?");
    const changed: Mismatch = { key: "page.content", signed_value: null, signed_fact_id: null, signed_evidence_url: "https://acme.com/security", signed_witnessed_at: "2026-10-12T08:00:00.000Z", surface: "live_page", surface_value: null, surface_url: "https://acme.com/security", surface_observed_at: "2026-10-20T10:00:00.000Z", kind: "differs", severity: "note" };
    expect(messageForMismatch(changed, record)?.message).toBe("Your Security page changed on 20 October. You signed it on 12 October. Sign the new version or keep the old one.");
    const live = new Map<string, LivePageRead | null>();
    live.set("https://acme.com/pricing", await readLivePageFrom("https://acme.com/pricing", { status: 200, headers: {}, body: read("fixture-page-pricing.html") }, NOW));
    const report = indexabilityReport(record.pages.filter((p) => p.url === "https://acme.com/pricing"), live);
    const alerts = await alertsFrom("acme", { mismatches: [], indexability: report, record }, NOW);
    expect(alerts[0]!.message).toBe("Your Pricing page tells search engines not to index it, so it cannot appear in AI answers.");
    expect(isSemantoId(alerts[0]!.id, "sma")).toBe(true);
    expect(dayWords("2026-10-20T10:00:00.000Z")).toBe("20 October");
    const price: Mismatch = Object.assign({}, phoneMismatch, { key: "product.KET-100.price", surface: "merchant_center" as const, signed_value: { amount: "49.00", currency: "USD" }, surface_value: { amount: "45.00", currency: "USD" } });
    expect(messageForMismatch(price, record)?.message).toBe("Google's shopping listing shows the price of Acme Kettle 1.7L as 45.00 USD. Your signed record says 49.00 USD. Which one is right?");
    for (const a of alerts) {
      expect(a.message).not.toMatch(BANNED);
      expect(a.message).not.toContain(THREE_DOTS);
    }
  });

  it("dedupes against open alerts, resolves what cleared, and respects the daily cap", async () => {
    const fresh = await alertsFrom("acme", { mismatches: [phoneMismatch, Object.assign({}, phoneMismatch, { key: "contact.address", severity: "trust" as const }), Object.assign({}, phoneMismatch, { key: "product.KET-100.gtin", severity: "note" as const })], indexability: indexabilityReport([], new Map()), record }, NOW);
    expect(fresh.length).toBe(3);
    const open = [Object.assign({}, fresh[0]!, { created_at: "2026-10-21T00:00:00.000Z" })];
    const d = dedupeAlerts(fresh, open);
    expect(d.fresh.length).toBe(2);
    expect(d.duplicates.length).toBe(1);
    const resolved = resolvedAlerts(open.concat([Object.assign({}, fresh[1]!, { key: "hours.monday@business_profile" })]), fresh, NOW);
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.resolved_at).toBe(NOW);
    const cap = applyDailyCap(fresh, 4, 5);
    expect(cap.send.length).toBe(1);
    expect(cap.send[0]!.severity).toBe("trust");
    expect(cap.held.length).toBe(2);
    expect(applyDailyCap(fresh, 5, 5).send.length).toBe(0);
  });

  it("builds a plain text and a minimal HTML email in the brand colors with one action link", async () => {
    const alerts = await alertsFrom("acme", { mismatches: [phoneMismatch], indexability: indexabilityReport([], new Map()), record }, NOW);
    const email = buildEmail(alerts, { from: "alerts@trooth.co", to: ["owner@acme.com"], domain: "acme.com", actionUrl: "https://trooth.co/dashboard/semanto/acme/monitor" });
    expect(email.subject).toBe("One thing to check on acme.com");
    expect(email.text).toContain("1. Google's business listing shows your phone as +1 312 555 0100.");
    expect(email.text).toContain("Review and fix: https://trooth.co/dashboard/semanto/acme/monitor");
    expect(email.html).toContain("#202124");
    expect(email.html).toContain("#F7F8F8");
    expect((email.html.match(/#1A73E8/g) ?? []).length).toBe(1);
    expect((email.html.match(/<a /g) ?? []).length).toBe(1);
    const port = memoryEmail();
    await port.send(email);
    expect(port.sent.length).toBe(1);
    const dash = toDashboard(alerts);
    expect(dash[0]).toMatchObject({ severity: "trust", kind: "surface_mismatch", surface: "business_profile", sent: false, resolved: false, action: { label: "Pick the right value" } });
    expect(alertFromRow(alertToRow(alerts[0]!))).toEqual(alerts[0]);
  });
});

// ----------------------------------------------------------------- runner

describe("runner", () => {
  it("runs end to end, stores the run, raises capped alerts, emails, and lists absent surfaces as absent", async () => {
    const store = memoryStore();
    const email = memoryEmail();
    const ports = { fetch: fetchFromMap(routes()), clock: fixedClock(NOW), store, email, tokens: memoryTokens({ merchant_center: "tok-mc", business_profile: "tok-gbp" }) };
    const first = await runMonitor(
      {
        record,
        surfaces: {
          merchant_center: { url: "https://shoppingcontent.googleapis.com/content/v2.1/123/products" },
          business_profile: { url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890" },
          acp: { url: "https://acme.com/.well-known/acp-products.jsonl" },
        },
        email: { from: "alerts@trooth.co", to: ["owner@acme.com"], actionUrl: "https://trooth.co/dashboard/semanto/acme/monitor" },
      },
      ports,
    );
    expect(store.runs.length).toBe(1);
    expect(first.summary.counts).toEqual({ trust: 2, visibility: 1, note: 3 });
    expect(first.summary.fixes[0]!.severity).toBe("trust");
    expect(first.summary.fixes.map((f) => f.severity)).toEqual(["trust", "trust", "visibility", "note", "note", "note"]);
    const ucp = first.summary.surfaces.find((s) => s.surface === "ucp");
    expect(ucp).toMatchObject({ state: "absent", note: "no UCP manifest address given", facts: 0 });
    expect(first.run.mismatches.some((m) => m.surface === "ucp")).toBe(false);
    expect(first.summary.surfaces.find((s) => s.surface === "merchant_center")?.state).toBe("read");
    expect(first.summary.surfaces.find((s) => s.surface === "live_page")?.note).toBe("5 of 5 signed pages answered 200");
    expect(first.summary.pages).toEqual({ checked: 5, eligible: 4, not_eligible: 1, jsonld_present: 4 });
    expect(first.summary.alerts).toMatchObject({ raised: 7, duplicates: 0, held_by_cap: 2, resolved: 0, emailed: true, email_error: null });
    expect(email.sent.length).toBe(1);
    expect(email.sent[0]!.subject).toBe("5 things to check on acme.com");
    expect(store.alerts.filter((a) => a.sent_at !== null).length).toBe(5);

    const second = await runMonitor({ record, surfaces: { merchant_center: { url: "https://shoppingcontent.googleapis.com/content/v2.1/123/products" }, business_profile: { url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/1234567890" }, acp: { url: "https://acme.com/.well-known/acp-products.jsonl" } }, email: { from: "alerts@trooth.co", to: ["owner@acme.com"], actionUrl: "https://trooth.co/x" } }, ports);
    expect(second.summary.alerts).toMatchObject({ raised: 0, duplicates: 7, emailed: false });
    expect(email.sent.length).toBe(1);
    expect(store.runs.length).toBe(2);
  });

  it("treats a surface that failed to read as failed, not as a mismatch, and reads UCP when given", async () => {
    const r = routes();
    delete r["https://shoppingcontent.googleapis.com/content/v2.1/123/products"];
    const store = memoryStore();
    const out = await runMonitor({ record, surfaces: { merchant_center: { url: "https://shoppingcontent.googleapis.com/content/v2.1/123/products" }, ucp: { manifest_url: "https://acme.com/.well-known/ucp", catalog_url: "https://acme.com/.well-known/ucp-catalog.json" }, live_pages: false } }, { fetch: fetchFromMap(r), clock: fixedClock(NOW), store });
    const mc = out.summary.surfaces.find((s) => s.surface === "merchant_center");
    expect(mc).toMatchObject({ state: "failed", note: "feed answered 404" });
    expect(out.run.mismatches.filter((m) => m.surface === "merchant_center")).toEqual([]);
    expect(out.summary.surfaces.find((s) => s.surface === "ucp")).toMatchObject({ state: "read" });
    expect(out.run.mismatches.filter((m) => m.surface === "ucp")).toEqual([]);
    expect(out.summary.surfaces.find((s) => s.surface === "live_page")?.state).toBe("absent");
    expect(out.summary.pages.checked).toBe(5);
    expect(out.run.indexability.pages.every((p) => p.reasons.includes("not_fetched") || p.reasons.includes("noindex"))).toBe(true);
  });
});
