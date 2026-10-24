// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Write-back connectors: one change in the signed record produces every
// payload the surfaces take, so the truth is written once and copied
// everywhere.
//
//   Merchant Center   Content API for Shopping v2.1 products.insert bodies and
//                     a supplemental feed (TSV) with the UCP attributes Google
//                     documents for Merchant Center (native_commerce,
//                     merchant_item_id, consumer_notice; UCP guidance, 2026)
//   Business Profile  Business Information API v1 locations.patch with an
//                     updateMask (title, phoneNumbers.primaryPhone,
//                     storefrontAddress, regularHours, websiteUri)
//   Site JSON-LD      a diff of what the page carries now against what the
//                     signed facts generate (the compiler's jsonld module
//                     produces the block; this module accepts it as input)
//   ACP feed          the OpenAI Agentic Commerce Protocol product feed
//   UCP catalog       a catalog file in the UCP item shape
//
// Each connector returns the payload plus a dry-run description. Sending needs
// the customer's OAuth token through the token port; without it nothing is
// sent and the payload is returned for the customer to paste or upload.

import { canonicalize } from "../core/canonical";
import type { Fact } from "../core/semanto";
import type { FetchPort, TokenPort, WritebackConnector } from "./ports";
import { DAYS, normalizeHours, normalizePhone, type Day } from "./normalize";
import { noticeOf, productKey, signedFacts } from "./surfaces";
import type { Offer, Product, SignedRecord } from "./types";

export type ConnectorName = WritebackConnector | "site_jsonld" | "acp_feed" | "ucp_catalog";

export interface WritebackPayload {
  connector: ConnectorName;
  /** HTTP for the Google APIs; "file" for feeds the customer hosts or uploads. */
  transport: "http" | "file";
  method: "POST" | "PATCH" | "PUT" | "GET" | null;
  url: string | null;
  content_type: string;
  body: string;
  /** Plain words for the dry run: what would be sent, where, and what it changes. */
  dry_run: string;
  /** What the send needs that the monitor cannot supply. */
  needs: "oauth_token" | "file_upload" | "site_deploy";
  /** The signed values this payload carries, for tests and the dashboard. */
  carries: Record<string, unknown>;
}

const MC_BASE = "https://shoppingcontent.googleapis.com/content/v2.1";
const GBP_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

export interface MerchantCenterTarget {
  merchantId: string;
  contentLanguage: string;
  targetCountry: string;
  channel?: "online" | "local";
  /** The Merchant API data source the send inserts into (accounts/{id}/dataSources/{id}); sending needs it, the preview does not. */
  dataSource?: string;
}

interface SignedProductView {
  product: Product;
  key: string;
  price: { amount: string; currency: string } | null;
  availability: string | null;
}

function productViews(record: SignedRecord, at: string): SignedProductView[] {
  const facts = signedFacts(record, at);
  const out: SignedProductView[] = [];
  for (const p of record.products) {
    const key = productKey(p);
    if (!key) continue;
    const priceFact = facts.find((f) => f.key === `product.${key}.price`);
    const availFact = facts.find((f) => f.key === `product.${key}.availability`);
    const price = priceFact && typeof priceFact.value === "object" && !Array.isArray(priceFact.value) ? priceFact.value : null;
    out.push({ product: p, key, price, availability: availFact && typeof availFact.value === "string" ? availFact.value : null });
  }
  return out;
}

function mcAvailability(v: string | null): string {
  switch ((v ?? "").toLowerCase().replace(/[^a-z]/g, "")) {
    case "instock":
      return "in_stock";
    case "outofstock":
      return "out_of_stock";
    case "preorder":
      return "preorder";
    case "backorder":
      return "backorder";
    case "":
      return "in_stock";
    default:
      return (v ?? "in_stock").toLowerCase().replace(/\s+/g, "_");
  }
}

// ------------------------------------------------------ Merchant Center

/** products.insert bodies, one per signed product, in the Content API v2.1 shape with the UCP attributes. */
export function merchantCenterPayload(record: SignedRecord, target: MerchantCenterTarget, at: string): WritebackPayload {
  const views = productViews(record, at);
  const channel = target.channel ?? "online";
  const bodies = views.map((v) => {
    const p = v.product;
    const notice = noticeOf(p.consumer_notice);
    const body: Record<string, unknown> = {
      offerId: v.key,
      title: p.name,
      link: p.url,
      contentLanguage: target.contentLanguage,
      targetCountry: target.targetCountry,
      channel,
      availability: mcAvailability(v.availability),
      customAttributes: [
        { name: "native_commerce", value: "true" },
        { name: "merchant_item_id", value: p.product_id },
        { name: "semanto_record", value: `https://trooth.co/network/company/${record.trooth_id}` },
      ],
    };
    if (v.price) body.price = { value: v.price.amount, currency: v.price.currency };
    if (p.gtin) body.gtin = p.gtin;
    if (p.brand) body.brand = p.brand;
    if (p.description) body.description = p.description;
    if (p.variant_id) body.itemGroupId = p.product_id;
    if (notice) body.consumerNotices = [{ noticeType: (notice.type ?? "legal_disclaimer").toUpperCase(), noticeMessage: notice.message }];
    return body;
  });
  const carries: Record<string, unknown> = {};
  for (const v of views) carries[v.key] = { price: v.price, availability: mcAvailability(v.availability), consumer_notice: noticeOf(v.product.consumer_notice)?.message ?? null };
  return {
    connector: "merchant_center",
    transport: "http",
    method: "POST",
    url: `${MC_BASE}/${encodeURIComponent(target.merchantId)}/products`,
    content_type: "application/json",
    body: JSON.stringify({ products: bodies }, null, 2),
    dry_run: `Would send ${bodies.length} product${bodies.length === 1 ? "" : "s"} to Merchant Center account ${target.merchantId} (products.insert, ${channel}:${target.contentLanguage}:${target.targetCountry}). Each carries the signed price, stock, GTIN and consumer notice. Needs the customer's Google OAuth token with the content scope.`,
    needs: "oauth_token",
    carries,
  };
}

/** A supplemental feed (TSV) with the same values, for customers who upload feeds rather than call the API. */
export function merchantCenterSupplementalFeed(record: SignedRecord, at: string): WritebackPayload {
  const views = productViews(record, at);
  const header = ["id", "title", "link", "price", "availability", "gtin", "brand", "consumer_notice", "native_commerce", "merchant_item_id"];
  const rows = views.map((v) => {
    const notice = noticeOf(v.product.consumer_notice);
    return [
      v.key,
      v.product.name,
      v.product.url,
      v.price ? `${v.price.amount} ${v.price.currency}` : "",
      mcAvailability(v.availability),
      v.product.gtin ?? "",
      v.product.brand ?? "",
      notice ? `${notice.type ?? "legal_disclaimer"}:${notice.message}` : "",
      "true",
      v.product.product_id,
    ]
      .map((c) => String(c).replace(/[\t\r\n]+/g, " "))
      .join("\t");
  });
  return {
    connector: "merchant_center",
    transport: "file",
    method: null,
    url: null,
    content_type: "text/tab-separated-values",
    body: [header.join("\t")].concat(rows).join("\n") + "\n",
    dry_run: `Would write a supplemental feed with ${rows.length} row${rows.length === 1 ? "" : "s"} for upload to Merchant Center.`,
    needs: "file_upload",
    carries: { rows: rows.length },
  };
}

// ----------------------------------------------------- Business Profile

const GBP_DAY: Record<Day, string> = { monday: "MONDAY", tuesday: "TUESDAY", wednesday: "WEDNESDAY", thursday: "THURSDAY", friday: "FRIDAY", saturday: "SATURDAY", sunday: "SUNDAY" };

function factValue(facts: Fact[], key: string): string | null {
  const f = facts.find((x) => x.key === key && typeof x.value === "string" && x.value !== "not_published" && x.value !== "not_read");
  return f ? (f.value as string) : null;
}

function timeOf(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(":");
  return { hours: Number(h ?? 0), minutes: Number(m ?? 0) };
}

export interface StorefrontAddress {
  regionCode: string;
  postalCode?: string;
  administrativeArea?: string;
  locality?: string;
  addressLines: string[];
}

/** A single-line address into the structured storefrontAddress: "street, city, ST 12345, US". The customer can override it. */
export function splitAddress(line: string): StorefrontAddress {
  const parts = line.split(",").map((s) => s.trim()).filter(Boolean);
  const out: StorefrontAddress = { regionCode: "US", addressLines: [] };
  if (!parts.length) return out;
  const last = parts[parts.length - 1] ?? "";
  if (/^[A-Z]{2}$/.test(last) || /^(usa|united states)$/i.test(last)) {
    out.regionCode = /^[A-Z]{2}$/.test(last) ? last : "US";
    parts.pop();
  }
  if (!parts.length) return out;
  const tokens = (parts.pop() ?? "").split(/\s+/).filter(Boolean);
  const lastTok = tokens[tokens.length - 1] ?? "";
  const twoTok = tokens.slice(-2).join(" ");
  if (/^\d{5}(?:-\d{4})?$/.test(lastTok)) {
    out.postalCode = lastTok;
    tokens.pop();
  } else if (/^([A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}|[A-Z]\d[A-Z] \d[A-Z]\d)$/.test(twoTok)) {
    out.postalCode = twoTok;
    tokens.pop();
    tokens.pop();
  }
  const stateTok = tokens[tokens.length - 1] ?? "";
  if (/^[A-Z]{2}$/.test(stateTok)) {
    out.administrativeArea = stateTok;
    tokens.pop();
  }
  const city = tokens.join(" ");
  if (city) out.locality = city;
  else if (parts.length > 1) out.locality = parts.pop();
  out.addressLines = parts;
  return out;
}

/** locations.patch body with an updateMask built from the facts that are present. */
export function businessProfilePayload(record: SignedRecord, locationName: string, overrides: { address?: StorefrontAddress } = {}): WritebackPayload {
  const facts = record.facts;
  const mask: string[] = [];
  const body: Record<string, unknown> = {};
  const carries: Record<string, unknown> = {};
  const name = factValue(facts, "identity.trade_name") ?? factValue(facts, "identity.legal_name");
  if (name) {
    body.title = name;
    mask.push("title");
    carries.title = name;
  }
  const phone = factValue(facts, "contact.phone");
  if (phone) {
    const e164 = normalizePhone(phone) ?? phone;
    body.phoneNumbers = { primaryPhone: e164 };
    mask.push("phoneNumbers.primaryPhone");
    carries.phone = e164;
  }
  const address = factValue(facts, "contact.address");
  if (overrides.address || address) {
    body.storefrontAddress = overrides.address ?? splitAddress(address ?? "");
    mask.push("storefrontAddress");
    carries.address = body.storefrontAddress;
  }
  const website = factValue(facts, "contact.website") ?? `https://${record.domain}/`;
  body.websiteUri = website;
  mask.push("websiteUri");
  carries.website = website;
  const periods: Record<string, unknown>[] = [];
  let anyHours = false;
  for (const d of DAYS) {
    const raw = facts.find((x) => x.key === `hours.${d}`);
    if (!raw || raw.value === undefined) continue;
    anyHours = true;
    const norm = normalizeHours(raw.value as string | string[]);
    if (!norm || norm === "closed") continue;
    for (const span of norm.split(", ")) {
      const [open, close] = span.split("-");
      if (!open || !close) continue;
      periods.push({ openDay: GBP_DAY[d], openTime: timeOf(open), closeDay: GBP_DAY[d], closeTime: timeOf(close) });
    }
  }
  if (anyHours) {
    body.regularHours = { periods };
    mask.push("regularHours");
    carries.hours = periods;
  }
  const url = `${GBP_BASE}/${locationName.replace(/^\/+/, "")}?updateMask=${encodeURIComponent(mask.join(","))}`;
  return {
    connector: "business_profile",
    transport: "http",
    method: "PATCH",
    url,
    content_type: "application/json",
    body: JSON.stringify(body, null, 2),
    dry_run: `Would update ${locationName} on Google Business Profile: ${mask.join(", ")}. Needs the customer's Google OAuth token with the business.manage scope.`,
    needs: "oauth_token",
    carries: Object.assign({ updateMask: mask }, carries),
  };
}

// ------------------------------------------------------------ JSON-LD

export interface JsonLdDiff {
  /** Is the generated block (by @id) on the page now? */
  present: boolean;
  /** Paths that differ between the page's block with that @id and the generated one; every path when absent. */
  differing_paths: string[];
  /** Other JSON-LD blocks on the page that carry the same @type and may conflict. */
  conflicting_types: string[];
}

function flatten(v: unknown, prefix: string, into: Map<string, string>): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, into));
    return;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) flatten((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, into);
    return;
  }
  into.set(prefix, canonicalize(v));
}

/** A path with list positions of single-item lists dropped, so [x] and x compare as one. */
function loosePath(path: string): string {
  return path.replace(/\[0\]/g, "");
}

function sameValue(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const bare = (x: string) => x.replace(/^"|"$/g, "").replace(/^(https?:\/\/[^/?#]+)\/$/i, "$1");
  return bare(a) === bare(b);
}

function findById(blocks: unknown[], id: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const visit = (v: unknown) => {
    if (found) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["@id"] === id) {
        found = o;
        return;
      }
      for (const k of Object.keys(o)) visit(o[k]);
    }
  };
  for (const b of blocks) visit(b);
  return found;
}

export function jsonLdDiff(currentBlocks: unknown[], generated: Record<string, unknown>): JsonLdDiff {
  const id = typeof generated["@id"] === "string" ? generated["@id"] : null;
  const want = new Map<string, string>();
  flatten(generated, "", want);
  const existing = id ? findById(currentBlocks, id) : null;
  const differing: string[] = [];
  if (!existing) {
    for (const k of want.keys()) differing.push(k);
  } else {
    // Nodes that share an @id merge, so what counts is whether the page already says each value the record says. A
    // property only the page has stays on the page and is not a difference (2026-10-23: counting those would have told
    // trooth.co to drop its description, alternate names and site search). The same value in another JSON-LD form is
    // the same value: an IRI and {"@id": IRI}, one object and a list of one, a bare origin with or without its slash.
    const have = new Map<string, string>();
    flatten(existing, "", have);
    const haveLoose = new Map<string, string>();
    for (const [k, v] of have) haveLoose.set(loosePath(k), v);
    for (const [k, v] of want) {
      const lk = loosePath(k);
      const h = have.get(k) ?? haveLoose.get(lk);
      const hid = have.get(`${k}.@id`) ?? haveLoose.get(`${lk}.@id`);
      if (!sameValue(v, h) && !sameValue(v, hid)) differing.push(k);
    }
  }
  const type = String(generated["@type"] ?? "");
  const conflicting: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o !== existing && String(o["@type"] ?? "") === type && type) conflicting.push(typeof o["@id"] === "string" ? o["@id"] : `${type} without @id`);
      for (const k of Object.keys(o)) if (k === "@graph") visit(o[k]);
    }
  };
  for (const b of currentBlocks) visit(b);
  return { present: Boolean(existing), differing_paths: differing.sort(), conflicting_types: conflicting };
}

/** Every node with an @type on the page, top level or inside an @graph. */
function pageNodes(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["@type"] !== undefined) out.push(o);
      if (Array.isArray(o["@graph"])) visit(o["@graph"]);
    }
  };
  blocks.forEach(visit);
  return out;
}

const typeOf = (o: Record<string, unknown>) => (Array.isArray(o["@type"]) ? (o["@type"] as unknown[]).map(String).sort().join(",") : String(o["@type"] ?? ""));

/**
 * ONE ENTITY, NOT TWO (2026-10-23, read on trooth.co). The compiler names its
 * nodes {site}#organization and {site}#website; a site that already describes
 * itself usually uses its own @id ("#org" on trooth.co). Matching by @id alone
 * reported "no block with this @id; add the whole block", and following that
 * would have put a second Organization for the same company on the page,
 * which search engines and AI readers take as two entities. A generated node
 * now takes the page's @id when the page has no node with the generated @id
 * and exactly one node of the same @type, and every reference to the old @id
 * in the block follows it. With none, or more than one, of that type, the
 * generated @id is kept and the page is left to say which one it means.
 */
export function alignToPage(currentBlocks: unknown[], generated: Record<string, unknown>): { generated: Record<string, unknown>; adopted: { from: string; to: string }[] } {
  const nodes = pageNodes(currentBlocks);
  const ids = new Set(nodes.map((n) => n["@id"]).filter((x): x is string => typeof x === "string"));
  const graph = Array.isArray(generated["@graph"]) ? (generated["@graph"] as Record<string, unknown>[]) : [generated];
  const renames = new Map<string, string>();
  for (const g of graph) {
    const id = typeof g["@id"] === "string" ? g["@id"] : null;
    if (!id || ids.has(id)) continue;
    const same = nodes.filter((n) => typeOf(n) === typeOf(g) && typeof n["@id"] === "string");
    if (same.length === 1) renames.set(id, same[0]!["@id"] as string);
  }
  if (!renames.size) return { generated, adopted: [] };
  const rewrite = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = k === "@id" && typeof x === "string" && renames.has(x) ? renames.get(x) : rewrite(x);
      return o;
    }
    return v;
  };
  return { generated: rewrite(generated) as Record<string, unknown>, adopted: [...renames].map(([from, to]) => ({ from, to })) };
}

/** jsonLdDiff for a generated @graph: each node by its @id, paths prefixed with the node's @type. */
export function jsonLdGraphDiff(currentBlocks: unknown[], generated: Record<string, unknown>): JsonLdDiff {
  if (!Array.isArray(generated["@graph"])) return jsonLdDiff(currentBlocks, generated);
  let present = true;
  const differing: string[] = [];
  const conflicting: string[] = [];
  for (const node of generated["@graph"] as Record<string, unknown>[]) {
    const d = jsonLdDiff(currentBlocks, node);
    present = present && d.present;
    const label = typeOf(node) || "node";
    for (const p of d.differing_paths) if (p !== "@type") differing.push(`${label}.${p}`);
    conflicting.push(...d.conflicting_types);
  }
  return { present, differing_paths: differing.sort(), conflicting_types: [...new Set(conflicting)] };
}

export function siteJsonLdPayload(pageUrl: string, currentBlocks: unknown[], generatedIn: Record<string, unknown>): WritebackPayload & { diff: JsonLdDiff; adopted: { from: string; to: string }[] } {
  const { generated, adopted } = alignToPage(currentBlocks, generatedIn);
  const diff = jsonLdGraphDiff(currentBlocks, generated);
  const script = `<script type="application/ld+json">\n${JSON.stringify(generated, null, 2)}\n</script>`;
  const kept = adopted.length ? ` It uses the page's own @id (${adopted.map((a) => a.to).join(", ")}), so it updates what the page already describes instead of adding a second entity.` : "";
  const what = !diff.present
    ? "The page has no block with this @id; add the whole block."
    : diff.differing_paths.length
      ? `${diff.differing_paths.length} value(s) differ: ${diff.differing_paths.slice(0, 8).join(", ")}.`
      : "The page already carries this block unchanged.";
  return Object.assign(
    {
      connector: "site_jsonld" as const,
      transport: "file" as const,
      method: null,
      url: pageUrl,
      content_type: "text/html",
      body: script,
      dry_run: `Would place one JSON-LD block in the head of ${pageUrl}. ${what}${kept}`,
      needs: "site_deploy" as const,
      carries: { "@id": generated["@id"] ?? null, "@type": generated["@type"] ?? null },
    },
    { diff, adopted },
  );
}

// ------------------------------------------------------------- ACP, UCP

export function acpFeedPayload(record: SignedRecord, at: string, opts: { sellerName?: string; enableCheckout?: boolean } = {}): WritebackPayload {
  const views = productViews(record, at);
  const lines = views.map((v) => {
    const p = v.product;
    const item: Record<string, unknown> = {
      id: v.key,
      title: p.name,
      description: p.description ?? p.name,
      link: p.url,
      availability: mcAvailability(v.availability),
      enable_search: true,
      enable_checkout: opts.enableCheckout ?? false,
      seller_name: opts.sellerName ?? record.org,
      seller_url: `https://${record.domain}/`,
    };
    if (v.price) item.price = `${v.price.amount} ${v.price.currency}`;
    if (p.gtin) item.gtin = p.gtin;
    if (p.brand) item.brand = p.brand;
    if (p.variant_id) item.item_group_id = p.product_id;
    return JSON.stringify(item);
  });
  return {
    connector: "acp_feed",
    transport: "file",
    method: null,
    url: `https://${record.domain}/.well-known/acp-products.jsonl`,
    content_type: "application/x-ndjson",
    body: lines.join("\n") + (lines.length ? "\n" : ""),
    dry_run: `Would write an ACP product feed with ${lines.length} item${lines.length === 1 ? "" : "s"} for the OpenAI product feed intake.`,
    needs: "file_upload",
    carries: { items: lines.length },
  };
}

export function ucpCatalogPayload(record: SignedRecord, at: string): WritebackPayload {
  const views = productViews(record, at);
  const items = views.map((v) => {
    const p = v.product;
    const notice = noticeOf(p.consumer_notice);
    const item: Record<string, unknown> = {
      id: v.key,
      merchant_item_id: p.product_id,
      native_commerce: true,
      title: p.name,
      link: p.url,
      availability: mcAvailability(v.availability),
    };
    if (v.price) item.price = { amount: v.price.amount, currency: v.price.currency };
    if (p.gtin) item.gtin = p.gtin;
    if (p.brand) item.brand = p.brand;
    if (p.variant_id) item.variant_id = p.variant_id;
    if (notice) item.consumer_notice = { type: notice.type ?? "legal_disclaimer", message: notice.message };
    return item;
  });
  return {
    connector: "ucp_catalog",
    transport: "file",
    method: null,
    url: `https://${record.domain}/.well-known/ucp-catalog.json`,
    content_type: "application/json",
    body: JSON.stringify({ ucp: { version: "2026-01-11" }, merchant: { name: record.org, domain: record.domain, semanto: `https://trooth.co/network/company/${record.trooth_id}` }, items }, null, 2),
    dry_run: `Would write a UCP catalog file with ${items.length} item${items.length === 1 ? "" : "s"}, each with merchant_item_id, native_commerce and the signed consumer notice.`,
    needs: "file_upload",
    carries: { items: items.length },
  };
}

// ------------------------------------------------- Merchant API (sending)

/** Merchant API v1 (merchantapi.googleapis.com), the Content API for Shopping's successor. */
export const MERCHANT_API_BASE = "https://merchantapi.googleapis.com/products/v1";

const MERCHANT_AVAILABILITY: Record<string, string> = { in_stock: "IN_STOCK", out_of_stock: "OUT_OF_STOCK", preorder: "PREORDER", backorder: "BACKORDER" };

/** "19.99" to "19990000": a decimal amount to micros as a string, without floating point. */
export function amountMicros(amount: string): string | null {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  const micros = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  return micros.toString();
}

export interface MerchantProductInput {
  offerId: string;
  /** The ProductInput body for accounts.productInputs.insert (Merchant API v1, Products sub-API). */
  body: Record<string, unknown>;
  image_links: string[];
  carries: Record<string, unknown>;
  summary: string;
}

/**
 * One ProductInput per signed product, in the Merchant API v1 shape Google
 * documents for accounts.productInputs.insert: offerId, contentLanguage,
 * feedLabel, productAttributes (title, description, link, imageLink,
 * availability, price in amountMicros and currencyCode, gtins, brand,
 * itemGroupId) and customAttributes. An insert with the same offerId,
 * contentLanguage and data source replaces the earlier input, so a resend is
 * safe.
 */
export function merchantProductInputs(record: SignedRecord, target: MerchantCenterTarget, at: string): MerchantProductInput[] {
  return productViews(record, at).map((v) => {
    const p = v.product;
    const notice = noticeOf(p.consumer_notice);
    const attrs: Record<string, unknown> = { title: p.name, link: p.url, availability: MERCHANT_AVAILABILITY[mcAvailability(v.availability)] ?? "IN_STOCK" };
    if (p.description) attrs.description = p.description;
    if (p.image_url) attrs.imageLink = p.image_url;
    const micros = v.price ? amountMicros(v.price.amount) : null;
    if (v.price && micros) attrs.price = { amountMicros: micros, currencyCode: v.price.currency };
    if (p.gtin) attrs.gtins = [p.gtin];
    if (p.brand) attrs.brand = p.brand;
    if (p.variant_id) attrs.itemGroupId = p.product_id;
    const custom = [
      { name: "native_commerce", value: "true" },
      { name: "merchant_item_id", value: p.product_id },
      { name: "semanto_record", value: `https://trooth.co/network/company/${record.trooth_id}` },
      ...(notice ? [{ name: "consumer_notice", value: `${notice.type ?? "legal_disclaimer"}:${notice.message}` }] : []),
    ];
    return {
      offerId: v.key,
      body: { offerId: v.key, contentLanguage: target.contentLanguage, feedLabel: target.targetCountry, productAttributes: attrs, customAttributes: custom },
      image_links: p.image_url ? [p.image_url] : [],
      carries: { price: v.price, availability: attrs.availability, gtin: p.gtin ?? null },
      summary: `${p.name}: ${v.price ? `${v.price.amount} ${v.price.currency}, ` : ""}${String(attrs.availability).toLowerCase().replace(/_/g, " ")}`,
    };
  });
}

/** The insert address for one account and data source. */
export function merchantInsertUrl(target: MerchantCenterTarget): string | null {
  if (!target.dataSource) return null;
  return `${MERCHANT_API_BASE}/accounts/${encodeURIComponent(target.merchantId)}/productInputs:insert?dataSource=${encodeURIComponent(target.dataSource)}`;
}

// ------------------------------------------------------------ all at once

export interface WritebackContext {
  merchantCenter?: MerchantCenterTarget;
  businessProfileLocation?: string;
  /** Per page: the JSON-LD the page carries now and the block the compiler generated for it. */
  pages?: { url: string; current: unknown[]; generated: Record<string, unknown> }[];
  at: string;
}

/** One change in the signed record produces every payload. Connectors without a target are left out and named. */
export function allPayloads(record: SignedRecord, ctx: WritebackContext): { payloads: WritebackPayload[]; skipped: { connector: ConnectorName; why: string }[] } {
  const payloads: WritebackPayload[] = [];
  const skipped: { connector: ConnectorName; why: string }[] = [];
  const hasProducts = record.products.length > 0;
  if (ctx.merchantCenter && hasProducts) {
    payloads.push(merchantCenterPayload(record, ctx.merchantCenter, ctx.at));
    payloads.push(merchantCenterSupplementalFeed(record, ctx.at));
  } else skipped.push({ connector: "merchant_center", why: hasProducts ? "no Merchant Center account connected" : "no products in the record" });
  if (ctx.businessProfileLocation) payloads.push(businessProfilePayload(record, ctx.businessProfileLocation));
  else skipped.push({ connector: "business_profile", why: "no Business Profile location connected" });
  for (const p of ctx.pages ?? []) payloads.push(siteJsonLdPayload(p.url, p.current, p.generated));
  if (!(ctx.pages ?? []).length) skipped.push({ connector: "site_jsonld", why: "no generated JSON-LD given" });
  if (hasProducts) {
    payloads.push(acpFeedPayload(record, ctx.at));
    payloads.push(ucpCatalogPayload(record, ctx.at));
  } else {
    skipped.push({ connector: "acp_feed", why: "no products in the record" });
    skipped.push({ connector: "ucp_catalog", why: "no products in the record" });
  }
  return { payloads, skipped };
}

export type SendResult = { sent: true; status: number; body: string } | { sent: false; reason: "no_token" | "not_http" | "no_sender" | "failed"; detail: string };

/** Send an HTTP payload with the customer's token. Nothing is sent without one. */
export async function sendPayload(payload: WritebackPayload, ports: { fetch: FetchPort; tokens?: TokenPort }): Promise<SendResult> {
  if (payload.transport !== "http" || !payload.url || !payload.method) return { sent: false, reason: "not_http", detail: "this payload is a file; upload it or publish it on the site" };
  if (!ports.fetch.send) return { sent: false, reason: "no_sender", detail: "the fetch port cannot send" };
  const connector = payload.connector as WritebackConnector;
  const token = ports.tokens ? await ports.tokens.token(connector) : null;
  if (!token) return { sent: false, reason: "no_token", detail: `the customer has not connected ${connector === "merchant_center" ? "Merchant Center" : "Business Profile"}; nothing was sent` };
  try {
    const res = await ports.fetch.send(payload.url, { method: payload.method, headers: { authorization: `Bearer ${token}`, "content-type": payload.content_type }, body: payload.body });
    return { sent: true, status: res.status, body: res.body };
  } catch (e) {
    return { sent: false, reason: "failed", detail: e instanceof Error ? e.message : "unknown error" };
  }
}

export type { Offer, Product };
