// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Feed parity. Every feed a merchant publishes is generated from the same
// signed product records and signed offers, so a price in Merchant Center, in
// an OpenAI ACP product feed and in a Google UCP catalog is the same price
// with the same as_of. The parity check reads any of those feeds back and
// lists every field that differs from the signed record, in the shape the
// monitor uses: { key, signed_value, feed_value, kind }.
//
// Shapes followed:
//   Google Merchant Center product data specification (2026): TSV attribute
//   names (id, title, description, link, image_link, price "12.34 USD",
//   availability, gtin, brand, mpn, item_group_id, color, size,
//   consumer_notice, native_commerce, merchant_item_id) and the Content API
//   for Shopping v2.1 product resource (camelCase, price as value+currency).
//   OpenAI Agentic Commerce Protocol product feed specification (2026): a
//   JSON array of items with price and currency apart, inventory_quantity,
//   condition, shipping and return_policy.
//   Google Universal Commerce Protocol (UCP, January 2026): the discovery
//   manifest at /.well-known/ucp listing services, capabilities and payment
//   handlers, with a Semanto extension that points at the signed catalog.

import { canonicalize } from "../core/canonical";
import { digest } from "../core/hash";
import { formatMinor, type Offer, type Availability } from "./offers";
import type { ProductRecord, ConsumerNoticeType } from "./product-record";

// ---------------------------------------------------------------- inputs

export interface CheckoutEndpoints {
  /** The merchant's own checkout service. Absent values are published as null, never invented. */
  base_url?: string;
  create_session?: string;
  get_session?: string;
  update_session?: string;
  complete_session?: string;
  cancel_session?: string;
}

export interface FeedCompany {
  trooth_id: string;
  domain: string;
  /** Where the signed catalog is served, for example https://api.trooth.co/public/semanto/acme-inc */
  public_base: string;
  /** Where the company's JWK Set is served. */
  jwks_url?: string;
  content_language?: string;
  target_country?: string;
  /** Whether the merchant takes orders through agent checkout. Published as "yes" or "no", default "no". */
  native_commerce?: boolean;
  checkout?: CheckoutEndpoints;
  payment_handlers?: unknown[];
}

export interface FeedSource {
  company: FeedCompany;
  records: ProductRecord[];
  offers: Offer[];
}

/** A record joined with its newest offer and the record's hash. */
export interface FeedLine {
  record: ProductRecord;
  offer: Offer;
  record_hash: string;
  signed_record_url: string;
}

export interface Skipped {
  sku: string;
  reason: "no_offer";
}

export const FEED_KINDS = ["merchant-center", "acp", "ucp"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

// ---------------------------------------------------------------- join

export async function recordHash(record: ProductRecord): Promise<string> {
  return digest(canonicalize(record));
}

export function signedRecordUrl(company: FeedCompany, record: ProductRecord): string {
  return `${company.public_base.replace(/\/$/, "")}/products/${record.id}`;
}

function offerKey(sku: string, variant_id: string | undefined): string {
  return `${sku}\u0000${variant_id ?? ""}`;
}

/** Newest offer per sku and variant; a record with no offer is skipped and said so. */
export async function joinLines(source: FeedSource): Promise<{ lines: FeedLine[]; skipped: Skipped[] }> {
  const newest = new Map<string, Offer>();
  for (const o of source.offers) {
    for (const key of [offerKey(o.sku, o.variant_id), offerKey(o.sku, undefined)]) {
      const prev = newest.get(key);
      if (!prev || Date.parse(o.as_of) > Date.parse(prev.as_of)) newest.set(key, o);
    }
  }
  const lines: FeedLine[] = [];
  const skipped: Skipped[] = [];
  const sorted = source.records.slice().sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  for (const record of sorted) {
    const offer = newest.get(offerKey(record.sku, record.variant_id)) ?? newest.get(offerKey(record.sku, undefined));
    if (!offer) {
      skipped.push({ sku: record.sku, reason: "no_offer" });
      continue;
    }
    lines.push({ record, offer, record_hash: await recordHash(record), signed_record_url: signedRecordUrl(source.company, record) });
  }
  return { lines, skipped };
}

// ---------------------------------------------------------------- shared value rules

/** Merchant Center and ACP know four availability words; "discontinued" is published as out of stock. */
export function feedAvailability(a: Availability): "in_stock" | "out_of_stock" | "preorder" | "backorder" {
  return a === "discontinued" ? "out_of_stock" : a;
}

export function consumerNoticeText(record: ProductRecord): { notice_type: ConsumerNoticeType; notice_text: string } | null {
  const n = record.regulatory.consumer_notice;
  if (!n) return null;
  return { notice_type: record.regulatory.consumer_notice_type ?? "legal_disclaimer", notice_text: n };
}

// ---------------------------------------------------------------- Google Merchant Center

export interface MerchantItem {
  id: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  /** "12.34 USD" */
  price: string;
  availability: "in_stock" | "out_of_stock" | "preorder" | "backorder";
  gtin: string;
  brand: string;
  mpn: string;
  item_group_id: string;
  color: string;
  size: string;
  /** "prop_65:text" or empty. */
  consumer_notice: string;
  native_commerce: "yes" | "no";
  merchant_item_id: string;
  condition: "new";
}

export const MERCHANT_COLUMNS: (keyof MerchantItem)[] = ["id", "title", "description", "link", "image_link", "price", "availability", "gtin", "brand", "mpn", "item_group_id", "color", "size", "consumer_notice", "native_commerce", "merchant_item_id", "condition"];

export function merchantItem(line: FeedLine, company: FeedCompany): MerchantItem {
  const r = line.record;
  const n = consumerNoticeText(r);
  return {
    id: r.sku,
    title: r.name,
    description: r.description,
    link: r.url,
    image_link: r.media[0]?.url ?? "",
    price: `${formatMinor(line.offer.price)} ${line.offer.price.currency}`,
    availability: feedAvailability(line.offer.availability),
    gtin: r.gtin ?? "",
    brand: r.brand,
    mpn: r.mpn ?? "",
    item_group_id: r.parent_product_id ?? "",
    color: r.variant_axes.color ?? "",
    size: r.variant_axes.size ?? "",
    consumer_notice: n ? `${n.notice_type}:${n.notice_text}` : "",
    native_commerce: company.native_commerce ? "yes" : "no",
    merchant_item_id: r.sku,
    condition: "new",
  };
}

const tsvCell = (v: string): string => v.replace(/[\t\r\n]+/g, " ");

export function merchantCenterTsv(lines: FeedLine[], company: FeedCompany): string {
  const rows = [MERCHANT_COLUMNS.join("\t")];
  for (const line of lines) {
    const item = merchantItem(line, company);
    rows.push(MERCHANT_COLUMNS.map((c) => tsvCell(String(item[c]))).join("\t"));
  }
  return rows.join("\n") + "\n";
}

export function parseMerchantCenterTsv(tsv: string): Record<string, string>[] {
  const rows = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (rows.length === 0) return [];
  const header = rows[0]!.split("\t");
  return rows.slice(1).map((row) => {
    const cells = row.split("\t");
    const out: Record<string, string> = {};
    header.forEach((h, i) => { out[h] = cells[i] ?? ""; });
    return out;
  });
}

/** The Content API for Shopping v2.1 product resource, from the same item. */
export interface ContentApiProduct {
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  price: { value: string; currency: string };
  availability: "in stock" | "out of stock" | "preorder" | "backorder";
  gtin?: string;
  brand: string;
  mpn?: string;
  itemGroupId?: string;
  color?: string;
  sizes?: string[];
  condition: "new";
  contentLanguage: string;
  targetCountry: string;
  channel: "online";
  consumerNotices?: { noticeType: string; noticeText: string }[];
  customAttributes: { name: string; value: string }[];
}

export function contentApiProduct(item: MerchantItem, company: FeedCompany): ContentApiProduct {
  const [value, currency] = item.price.split(" ") as [string, string];
  const out: ContentApiProduct = {
    offerId: item.id,
    title: item.title,
    description: item.description,
    link: item.link,
    imageLink: item.image_link,
    price: { value, currency },
    availability: item.availability.replace("_", " ") as ContentApiProduct["availability"],
    brand: item.brand,
    condition: "new",
    contentLanguage: company.content_language ?? "en",
    targetCountry: company.target_country ?? "US",
    channel: "online",
    customAttributes: [
      { name: "native_commerce", value: item.native_commerce },
      { name: "merchant_item_id", value: item.merchant_item_id },
    ],
  };
  if (item.gtin) out.gtin = item.gtin;
  if (item.mpn) out.mpn = item.mpn;
  if (item.item_group_id) out.itemGroupId = item.item_group_id;
  if (item.color) out.color = item.color;
  if (item.size) out.sizes = [item.size];
  if (item.consumer_notice) {
    const i = item.consumer_notice.indexOf(":");
    out.consumerNotices = [{ noticeType: item.consumer_notice.slice(0, i), noticeText: item.consumer_notice.slice(i + 1) }];
  }
  return out;
}

export function merchantCenterJson(lines: FeedLine[], company: FeedCompany): MerchantItem[] {
  return lines.map((l) => merchantItem(l, company));
}

export function merchantCenterContentApi(lines: FeedLine[], company: FeedCompany): ContentApiProduct[] {
  return lines.map((l) => contentApiProduct(merchantItem(l, company), company));
}

// ---------------------------------------------------------------- OpenAI ACP product feed

export interface AcpShipping {
  country: string;
  price: string;
  currency: string;
  min_days: number;
  max_days: number;
}

export interface AcpItem {
  id: string;
  title: string;
  description: string;
  link: string;
  /** Decimal string in the currency's minor exponent, "12.34". */
  price: string;
  currency: string;
  availability: "in_stock" | "out_of_stock" | "preorder" | "backorder";
  inventory_quantity?: number;
  gtin?: string;
  brand: string;
  mpn?: string;
  item_group_id?: string;
  image_link: string;
  condition: "new";
  shipping?: AcpShipping[];
  return_policy?: string;
  seller_name: string;
  /** Where the signed record is and what it hashes to, so a reader can check this line against it. */
  provenance: { signed_record_url: string; record_hash: string; as_of: string; not_after: string };
}

export function acpItem(line: FeedLine, company: FeedCompany): AcpItem {
  const r = line.record;
  const o = line.offer;
  const item: AcpItem = {
    id: r.sku,
    title: r.name,
    description: r.description,
    link: r.url,
    price: formatMinor(o.price),
    currency: o.price.currency,
    availability: feedAvailability(o.availability),
    brand: r.brand,
    image_link: r.media[0]?.url ?? "",
    condition: "new",
    seller_name: company.domain,
    provenance: { signed_record_url: line.signed_record_url, record_hash: line.record_hash, as_of: o.as_of, not_after: o.not_after },
  };
  if (o.inventory_quantity !== undefined) item.inventory_quantity = o.inventory_quantity;
  if (r.gtin) item.gtin = r.gtin;
  if (r.mpn) item.mpn = r.mpn;
  if (r.parent_product_id) item.item_group_id = r.parent_product_id;
  if (o.shipping && o.shipping.length) item.shipping = o.shipping.map((s) => ({ country: s.country, price: formatMinor({ amount: s.amount, currency: s.currency }), currency: s.currency, min_days: s.days_min, max_days: s.days_max }));
  if (o.return_policy_url) item.return_policy = o.return_policy_url;
  return item;
}

export function acpFeed(lines: FeedLine[], company: FeedCompany): AcpItem[] {
  return lines.map((l) => acpItem(l, company));
}

// ---------------------------------------------------------------- Google UCP

export const UCP_VERSION = "2026-01-11";

export interface UcpManifest {
  ucp: {
    version: string;
    services: Record<string, { version: string; spec: string; rest: { schema: string; endpoint: string | null } }>;
    capabilities: { name: string; version: string; spec: string; schema: string; endpoints?: Record<string, string | null> }[];
    payment_handlers: unknown[];
  };
  /** The Semanto extension: where the signed catalog, offers and keys are. */
  "co.trooth.semanto": {
    version: 1;
    signed_catalog: string;
    products: string;
    offers: string;
    merchant_trooth_id: string;
    keys: string | null;
  };
}

export function ucpManifest(company: FeedCompany): UcpManifest {
  const base = company.public_base.replace(/\/$/, "");
  const c = company.checkout ?? {};
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": {
          version: UCP_VERSION,
          spec: "https://ucp.dev/specification/overview",
          rest: { schema: "https://ucp.dev/services/shopping/rest.openapi.json", endpoint: c.base_url ?? null },
        },
      },
      capabilities: [
        { name: "dev.ucp.shopping.catalog", version: UCP_VERSION, spec: "https://ucp.dev/specification/catalog", schema: "https://ucp.dev/schemas/shopping/catalog.json", endpoints: { catalog: `${base}/feeds/ucp` } },
        { name: "dev.ucp.shopping.product_discovery", version: UCP_VERSION, spec: "https://ucp.dev/specification/product-discovery", schema: "https://ucp.dev/schemas/shopping/product_discovery.json", endpoints: { products: `${base}/products`, offers: `${base}/offers` } },
        {
          name: "dev.ucp.shopping.checkout",
          version: UCP_VERSION,
          spec: "https://ucp.dev/specification/checkout",
          schema: "https://ucp.dev/schemas/shopping/checkout.json",
          endpoints: {
            create_session: c.create_session ?? null,
            get_session: c.get_session ?? null,
            update_session: c.update_session ?? null,
            complete_session: c.complete_session ?? null,
            cancel_session: c.cancel_session ?? null,
          },
        },
      ],
      payment_handlers: company.payment_handlers ?? [],
    },
    "co.trooth.semanto": {
      version: 1,
      signed_catalog: `${base}/feeds/ucp`,
      products: `${base}/products`,
      offers: `${base}/offers`,
      merchant_trooth_id: company.trooth_id,
      keys: company.jwks_url ?? null,
    },
  };
}

export interface UcpProduct {
  id: string;
  title: string;
  description: string;
  url: string;
  image_url: string;
  price: { amount: number; currency: string };
  availability: Availability;
  inventory_quantity?: number;
  gtin?: string;
  brand: string;
  mpn?: string;
  item_group_id?: string;
  variant: { size?: string; color?: string; formulation?: string; edition?: string };
  consumer_notice?: { notice_type: ConsumerNoticeType; notice_text: string };
  as_of: string;
  not_after: string;
  semanto: { record_id: string; record_hash: string; signed_record_url: string; offer_id: string };
}

export interface UcpCatalog {
  object: "ucp.catalog";
  ucp_version: string;
  merchant: { domain: string; trooth_id: string };
  generated_at: string;
  products: UcpProduct[];
}

export function ucpProduct(line: FeedLine): UcpProduct {
  const r = line.record;
  const o = line.offer;
  const p: UcpProduct = {
    id: r.sku,
    title: r.name,
    description: r.description,
    url: r.url,
    image_url: r.media[0]?.url ?? "",
    price: { amount: o.price.amount, currency: o.price.currency },
    availability: o.availability,
    brand: r.brand,
    variant: Object.assign({}, r.variant_axes),
    as_of: o.as_of,
    not_after: o.not_after,
    semanto: { record_id: r.id, record_hash: line.record_hash, signed_record_url: line.signed_record_url, offer_id: o.id },
  };
  if (o.inventory_quantity !== undefined) p.inventory_quantity = o.inventory_quantity;
  if (r.gtin) p.gtin = r.gtin;
  if (r.mpn) p.mpn = r.mpn;
  if (r.parent_product_id) p.item_group_id = r.parent_product_id;
  const n = consumerNoticeText(r);
  if (n) p.consumer_notice = n;
  return p;
}

export function ucpCatalog(lines: FeedLine[], company: FeedCompany, generated_at: Date): UcpCatalog {
  return { object: "ucp.catalog", ucp_version: UCP_VERSION, merchant: { domain: company.domain, trooth_id: company.trooth_id }, generated_at: generated_at.toISOString(), products: lines.map(ucpProduct) };
}

// ---------------------------------------------------------------- all feeds from one source

export interface GeneratedFeeds {
  lines: FeedLine[];
  skipped: Skipped[];
  merchant_center: { tsv: string; json: MerchantItem[]; content_api: ContentApiProduct[] };
  acp: AcpItem[];
  ucp: { manifest: UcpManifest; catalog: UcpCatalog };
}

export async function generateFeeds(source: FeedSource, now: Date): Promise<GeneratedFeeds> {
  const { lines, skipped } = await joinLines(source);
  return {
    lines,
    skipped,
    merchant_center: { tsv: merchantCenterTsv(lines, source.company), json: merchantCenterJson(lines, source.company), content_api: merchantCenterContentApi(lines, source.company) },
    acp: acpFeed(lines, source.company),
    ucp: { manifest: ucpManifest(source.company), catalog: ucpCatalog(lines, source.company, now) },
  };
}

// ---------------------------------------------------------------- parity

export type DriftKind = "price" | "availability" | "identity" | "text" | "link" | "variant" | "regulatory" | "terms" | "provenance" | "other" | "missing" | "extra";

/** One field that differs between the signed record and a published feed. The monitor uses this same shape. */
export interface Drift {
  /** "<feed>:<item id>.<field>" */
  key: string;
  signed_value: unknown;
  feed_value: unknown;
  kind: DriftKind;
}

const KIND_BY_FIELD: Record<string, DriftKind> = {
  price: "price",
  currency: "price",
  availability: "availability",
  inventory_quantity: "availability",
  id: "identity",
  gtin: "identity",
  brand: "identity",
  mpn: "identity",
  item_group_id: "identity",
  merchant_item_id: "identity",
  title: "text",
  description: "text",
  link: "link",
  url: "link",
  image_link: "link",
  image_url: "link",
  color: "variant",
  size: "variant",
  variant: "variant",
  consumer_notice: "regulatory",
  shipping: "terms",
  return_policy: "terms",
  condition: "terms",
  native_commerce: "terms",
  provenance: "provenance",
  semanto: "provenance",
  as_of: "provenance",
  not_after: "provenance",
};

function kindOf(field: string): DriftKind {
  return KIND_BY_FIELD[field] ?? "other";
}

function itemsOf(kind: FeedKind, feed: string | unknown): { items: Record<string, unknown>[]; idField: string } {
  if (kind === "merchant-center") {
    if (typeof feed === "string") {
      const t = feed.trimStart();
      if (t.startsWith("[")) return { items: JSON.parse(feed) as Record<string, unknown>[], idField: "id" };
      return { items: parseMerchantCenterTsv(feed), idField: "id" };
    }
    return { items: feed as Record<string, unknown>[], idField: "id" };
  }
  if (kind === "acp") {
    const arr = typeof feed === "string" ? (JSON.parse(feed) as unknown) : feed;
    return { items: arr as Record<string, unknown>[], idField: "id" };
  }
  const cat = (typeof feed === "string" ? JSON.parse(feed) : feed) as { products?: Record<string, unknown>[] };
  return { items: cat.products ?? [], idField: "id" };
}

function expectedItems(kind: FeedKind, lines: FeedLine[], company: FeedCompany, isTsv: boolean): Record<string, unknown>[] {
  if (kind === "merchant-center") {
    const items = merchantCenterJson(lines, company) as unknown as Record<string, unknown>[];
    return isTsv ? items.map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, tsvCell(String(v))]))) : items;
  }
  if (kind === "acp") return acpFeed(lines, company) as unknown as Record<string, unknown>[];
  return lines.map(ucpProduct) as unknown as Record<string, unknown>[];
}

/**
 * Read a published feed back and report every field that differs from what
 * the signed records and offers say. Timestamps of the catalog envelope are
 * not compared; every product field is.
 */
export async function parityCheck(source: FeedSource, kind: FeedKind, feed: string | unknown): Promise<Drift[]> {
  const { lines } = await joinLines(source);
  const isTsv = kind === "merchant-center" && typeof feed === "string" && !feed.trimStart().startsWith("[");
  const expected = expectedItems(kind, lines, source.company, isTsv);
  const { items: actual, idField } = itemsOf(kind, feed);
  const drifts: Drift[] = [];
  const byId = (arr: Record<string, unknown>[]) => new Map(arr.map((it) => [String(it[idField] ?? ""), it]));
  const exp = byId(expected);
  const act = byId(actual);
  for (const [id, e] of exp) {
    const a = act.get(id);
    if (!a) {
      drifts.push({ key: `${kind}:${id}`, signed_value: e, feed_value: null, kind: "missing" });
      continue;
    }
    const fields = new Set(Object.keys(e).concat(Object.keys(a)));
    for (const f of fields) {
      const ev = e[f];
      const av = a[f];
      const same = canonicalize(ev === undefined ? null : ev) === canonicalize(av === undefined ? null : av);
      if (!same && !(isTsv && (ev === "" || ev === undefined) && (av === "" || av === undefined))) {
        drifts.push({ key: `${kind}:${id}.${f}`, signed_value: ev === undefined ? null : ev, feed_value: av === undefined ? null : av, kind: kindOf(f) });
      }
    }
  }
  for (const [id, a] of act) {
    if (!exp.has(id)) drifts.push({ key: `${kind}:${id}`, signed_value: null, feed_value: a, kind: "extra" });
  }
  return drifts;
}
