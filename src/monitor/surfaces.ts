// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Readers for every surface Google reads, each returning facts under the same
// dotted keys the signed Semanto record uses, so one comparison serves all:
//
//   live page         the HTML as served, its JSON-LD and microdata (schema.org)
//   semanto           the signed facts, products and offers (the record itself)
//   merchant center   Content API v2.1 products.list shape, or a TSV or RSS 2.0
//                     XML product feed (Merchant Center product data spec, 2026)
//   business profile  Business Information API v1 Location shape
//   ucp               the manifest at /.well-known/ucp and a catalog item
//                     (Universal Commerce Protocol, ucp.dev, January 2026)
//   acp               the OpenAI Agentic Commerce Protocol product feed
//                     (developers.openai.com/commerce, product feed spec)
//
// Keys: identity.legal_name, contact.phone, contact.address, contact.website,
// hours.<day>, product.<key>.{name,price,availability,gtin,url,brand,
// consumer_notice,inventory_quantity}, where <key> is the sku, else the gtin,
// else the product id. Readers only read; nothing here judges.

import type { Fact } from "../core/semanto";
import { digest } from "../core/hash";
import { utf8 } from "../core/encoding";
import type { FetchPort, FetchResult } from "./ports";
import type { ConsumerNotice, LivePageRead, MicrodataItem, Offer, Price, Product, SignedFact, SignedRecord, Surface, SurfaceFact, SurfaceRead, SurfaceValue } from "./types";
import { canonical, firstItem, firstString, jsonLdBlocks, jsonLdIds, jsonLdNodes, metaRobots, microdata, title, visibleText } from "./html";
import { DAYS, dayFromAny, joinAddress, parsePrice, type Day } from "./normalize";

// ------------------------------------------------------------- helpers

export function productKey(p: { sku?: string | null; gtin?: string | null; product_id?: string | null; id?: string | null }): string {
  const k = p.sku || p.gtin || p.product_id || p.id || "";
  return String(k).trim();
}

export function noticeOf(v: unknown): ConsumerNotice | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const m = /^(safety_warning|legal_disclaimer|prop_65)\s*:\s*(.+)$/is.exec(s);
    return m ? { type: m[1]!.toLowerCase(), message: m[2]!.trim() } : { message: s };
  }
  if (Array.isArray(v)) return v.length ? noticeOf(v[0]) : null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const message = o.message ?? o.noticeMessage ?? o.notice_message ?? o.text;
    const type = o.type ?? o.noticeType ?? o.notice_type;
    if (typeof message !== "string" || !message.trim()) return null;
    return type ? { type: String(type).toLowerCase(), message: message.trim() } : { message: message.trim() };
  }
  return null;
}

export function noticeText(n: ConsumerNotice | string | null | undefined): string | null {
  const x = typeof n === "string" ? noticeOf(n) : n ?? null;
  return x ? x.message : null;
}

function fact(surface: Surface, key: string, value: SurfaceValue | null | undefined, url: string, observed_at: string, into: SurfaceFact[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string" && !value.trim()) return;
  if (Array.isArray(value) && !value.length) return;
  into.push({ surface, key, value, url, observed_at });
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return str(v[0]);
  return null;
}

/** Product facts shared by every feed reader. */
function productFacts(surface: Surface, key: string, p: { name?: string | null; price?: Price | null; availability?: string | null; gtin?: string | null; url?: string | null; brand?: string | null; notice?: ConsumerNotice | null; inventory?: number | null }, url: string, observed_at: string, into: SurfaceFact[]): void {
  if (!key) return;
  const k = `product.${key}`;
  fact(surface, `${k}.name`, p.name, url, observed_at, into);
  fact(surface, `${k}.price`, p.price, url, observed_at, into);
  fact(surface, `${k}.availability`, p.availability, url, observed_at, into);
  fact(surface, `${k}.gtin`, p.gtin, url, observed_at, into);
  fact(surface, `${k}.url`, p.url, url, observed_at, into);
  fact(surface, `${k}.brand`, p.brand, url, observed_at, into);
  fact(surface, `${k}.consumer_notice`, p.notice ? p.notice.message : null, url, observed_at, into);
  if (typeof p.inventory === "number") fact(surface, `${k}.inventory_quantity`, p.inventory, url, observed_at, into);
}

function observedAt(res: FetchResult, fallback: string): string {
  const d = res.headers["date"] ?? res.headers["Date"];
  if (d) {
    const t = Date.parse(d);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallback;
}

// --------------------------------------------------------- (b) semanto

/** The signed side, flattened to the same keys. Offers in date at `at` win over the product's own price and availability. */
export function signedFacts(record: SignedRecord, at: string): SignedFact[] {
  const out: SignedFact[] = [];
  for (const f of record.facts) {
    if (f.value === undefined) continue;
    if (f.value === "not_published" || f.value === "not_read") continue;
    out.push({ key: f.key, value: f.value as SurfaceValue, fact_id: f.id, evidence_url: f.evidence.url, witnessed_at: f.evidence.witnessed_at });
  }
  for (const p of record.products) {
    const key = productKey(p);
    if (!key) continue;
    const id = p.record_id ?? `product:${key}`;
    const when = p.witnessed_at ?? record.signed_at;
    const offer = freshOffer(record.offers, p, at);
    const push = (suffix: string, value: SurfaceValue | null | undefined, w = when, fid = id) => {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return;
      out.push({ key: `product.${key}.${suffix}`, value, fact_id: fid, evidence_url: p.url, witnessed_at: w });
    };
    push("name", p.name);
    push("url", p.url);
    push("gtin", p.gtin);
    push("brand", p.brand);
    push("consumer_notice", noticeText(p.consumer_notice));
    if (offer) {
      push("price", offer.price, offer.as_of, offer.offer_id ?? id);
      push("availability", offer.availability ?? p.availability, offer.as_of, offer.offer_id ?? id);
    } else {
      push("price", p.price);
      push("availability", p.availability);
    }
  }
  return out;
}

function freshOffer(offers: Offer[], p: Product, at: string): Offer | null {
  const t = Date.parse(at);
  let best: Offer | null = null;
  for (const o of offers) {
    const matches = (p.sku && o.sku === p.sku) || (p.variant_id && o.variant_id === p.variant_id) || o.sku === productKey(p);
    if (!matches) continue;
    if (Date.parse(o.as_of) > t || Date.parse(o.not_after) <= t) continue;
    if (!best || o.as_of > best.as_of) best = o;
  }
  return best;
}

/** The record as a surface read, so it can be listed with the others. */
export function readSemanto(record: SignedRecord, at: string, url: string): SurfaceRead {
  const facts: SurfaceFact[] = signedFacts(record, at).map((f) => ({ surface: "semanto", key: f.key, value: f.value, url: f.evidence_url, observed_at: f.witnessed_at }));
  return { surface: "semanto", url, observed_at: record.signed_at, facts, notes: [`version ${record.version}, ${record.facts.length} facts, ${record.products.length} products`] };
}

/** Build a SignedRecord from the pieces the runner receives. */
export function signedRecordFrom(input: { trooth_id: string; domain: string; org: string; version: number; signed_at: string; facts: Fact[]; pages: SignedRecord["pages"]; products?: Product[]; offers?: Offer[] }): SignedRecord {
  return {
    trooth_id: input.trooth_id,
    domain: input.domain,
    org: input.org,
    version: input.version,
    signed_at: input.signed_at,
    facts: input.facts,
    pages: input.pages,
    products: input.products ?? [],
    offers: input.offers ?? [],
  };
}

// --------------------------------------------------------- (a) live page

const ORG_TYPES = /organization|localbusiness|store|restaurant|corporation|dentist|physician|attorney|plumber|electrician|hotel|cafe|bakery|bar|hairsalon|autorepair|medical|professionalservice|homeandconstruction|foodestablishment|lodging/i;

function typeNames(t: unknown): string {
  if (Array.isArray(t)) return t.map((x) => String(x)).join(" ");
  return String(t ?? "");
}

function addressText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const lines = [str(o.streetAddress) ?? undefined, str(o.extendedAddress) ?? undefined];
    return joinAddress({ lines, locality: str(o.addressLocality) ?? undefined, region: str(o.addressRegion) ?? undefined, postal: str(o.postalCode) ?? undefined, country: countryText(o.addressCountry) ?? undefined }) || null;
  }
  return null;
}

function countryText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object") return str((v as Record<string, unknown>).name) ?? str((v as Record<string, unknown>).identifier);
  return null;
}

function hoursFromSpec(spec: unknown): Partial<Record<Day, string[]>> {
  const out: Partial<Record<Day, string[]>> = {};
  const list = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const days = Array.isArray(o.dayOfWeek) ? o.dayOfWeek : [o.dayOfWeek];
    const opens = str(o.opens);
    const closes = str(o.closes);
    for (const d of days) {
      const day = dayFromAny(String(d ?? ""));
      if (!day) continue;
      const spans = out[day] ?? [];
      if (opens && closes) spans.push(`${opens}-${closes}`);
      else if (!opens && !closes) spans.push("closed");
      out[day] = spans;
    }
  }
  return out;
}

/** openingHours strings such as "Mo-Fr 09:00-17:00" or "Sa 10:00-14:00". */
function hoursFromStrings(v: unknown): Partial<Record<Day, string[]>> {
  const out: Partial<Record<Day, string[]>> = {};
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  for (const raw of list) {
    const m = /^([A-Za-z]{2}(?:-[A-Za-z]{2})?(?:,\s*[A-Za-z]{2}(?:-[A-Za-z]{2})?)*)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(raw).trim());
    if (!m) continue;
    const span = `${m[2]}-${m[3]}`;
    for (const part of (m[1] ?? "").split(",")) {
      const [a, b] = part.trim().split("-");
      const from = dayFromAny(a ?? "");
      const to = b ? dayFromAny(b) : from;
      if (!from || !to) continue;
      const i = DAYS.indexOf(from);
      const j = DAYS.indexOf(to);
      for (let k = i; k <= (j >= i ? j : i); k++) {
        const day = DAYS[k]!;
        const spans = out[day] ?? [];
        spans.push(span);
        out[day] = spans;
      }
    }
  }
  return out;
}

function orgFactsFromNode(o: Record<string, unknown>, url: string, at: string, into: SurfaceFact[]): void {
  fact("live_page", "identity.legal_name", str(o.legalName) ?? str(o.name), url, at, into);
  fact("live_page", "contact.phone", str(o.telephone), url, at, into);
  fact("live_page", "contact.address", addressText(o.address), url, at, into);
  fact("live_page", "contact.website", str(o.url), url, at, into);
  const spec = o.openingHoursSpecification ? hoursFromSpec(o.openingHoursSpecification) : hoursFromStrings(o.openingHours);
  for (const d of DAYS) {
    const spans = spec[d];
    if (spans && spans.length) fact("live_page", `hours.${d}`, spans.length === 1 ? spans[0]! : spans, url, at, into);
  }
}

function productFactsFromNode(o: Record<string, unknown>, url: string, at: string, into: SurfaceFact[]): void {
  const key = productKey({ sku: str(o.sku), gtin: str(o.gtin13) ?? str(o.gtin) ?? str(o.gtin14) ?? str(o.gtin12) ?? str(o.gtin8), product_id: str(o.productID) ?? str(o["@id"]) });
  const offers = Array.isArray(o.offers) ? o.offers[0] : o.offers;
  const off = offers && typeof offers === "object" ? (offers as Record<string, unknown>) : {};
  const spec = off.priceSpecification && typeof off.priceSpecification === "object" ? (off.priceSpecification as Record<string, unknown>) : null;
  const price = off.price !== undefined ? parsePrice({ amount: off.price, currency: off.priceCurrency ?? "" }) : spec ? parsePrice(spec) : null;
  productFacts(
    "live_page",
    key,
    {
      name: str(o.name),
      price,
      availability: str(off.availability),
      gtin: str(o.gtin13) ?? str(o.gtin) ?? str(o.gtin14) ?? str(o.gtin12) ?? str(o.gtin8),
      url: str(off.url) ?? str(o.url),
      brand: o.brand && typeof o.brand === "object" ? str((o.brand as Record<string, unknown>).name) : str(o.brand),
    },
    url,
    at,
    into,
  );
}

function orgFactsFromMicrodata(it: MicrodataItem, url: string, at: string, into: SurfaceFact[]): void {
  fact("live_page", "identity.legal_name", firstString(it.props.legalName) ?? firstString(it.props.name), url, at, into);
  fact("live_page", "contact.phone", firstString(it.props.telephone), url, at, into);
  const addr = firstItem(it.props.address);
  const addrText = addr
    ? joinAddress({ lines: [firstString(addr.props.streetAddress) ?? undefined], locality: firstString(addr.props.addressLocality) ?? undefined, region: firstString(addr.props.addressRegion) ?? undefined, postal: firstString(addr.props.postalCode) ?? undefined, country: firstString(addr.props.addressCountry) ?? undefined })
    : firstString(it.props.address);
  fact("live_page", "contact.address", addrText, url, at, into);
  fact("live_page", "contact.website", firstString(it.props.url), url, at, into);
  const spec = (it.props.openingHoursSpecification ?? []).filter((x): x is MicrodataItem => typeof x !== "string");
  const byDay = hoursFromSpec(spec.map((s) => ({ dayOfWeek: (s.props.dayOfWeek ?? []).filter((x) => typeof x === "string"), opens: firstString(s.props.opens), closes: firstString(s.props.closes) })));
  for (const d of DAYS) {
    const spans = byDay[d];
    if (spans && spans.length) fact("live_page", `hours.${d}`, spans.length === 1 ? spans[0]! : spans, url, at, into);
  }
}

function productFactsFromMicrodata(it: MicrodataItem, url: string, at: string, into: SurfaceFact[]): void {
  const gtin = firstString(it.props.gtin13) ?? firstString(it.props.gtin) ?? firstString(it.props.gtin14) ?? firstString(it.props.gtin12);
  const key = productKey({ sku: firstString(it.props.sku), gtin, product_id: firstString(it.props.productID) ?? it.id });
  const off = firstItem(it.props.offers);
  const price = off && firstString(off.props.price) !== null ? parsePrice({ amount: firstString(off.props.price), currency: firstString(off.props.priceCurrency) ?? "" }) : null;
  const brand = firstItem(it.props.brand);
  productFacts("live_page", key, { name: firstString(it.props.name), price, availability: off ? firstString(off.props.availability) : null, gtin, url: (off ? firstString(off.props.url) : null) ?? firstString(it.props.url), brand: brand ? firstString(brand.props.name) : firstString(it.props.brand) }, url, at, into);
}

/** Read a fetched page into facts and index signals. Pure: give it the fetch result. */
export async function readLivePageFrom(url: string, res: FetchResult, now: string): Promise<LivePageRead> {
  const at = observedAt(res, now);
  const html = res.body ?? "";
  const facts: SurfaceFact[] = [];
  const notes: string[] = [];
  const { blocks, unparsable } = jsonLdBlocks(html);
  if (unparsable) notes.push(`${unparsable} JSON-LD block(s) did not parse`);
  for (const node of jsonLdNodes(blocks)) {
    const t = typeNames(node["@type"]);
    if (ORG_TYPES.test(t)) orgFactsFromNode(node, url, at, facts);
    if (/product|offer\b/i.test(t) && !/offercatalog/i.test(t)) productFactsFromNode(node, url, at, facts);
  }
  const items = microdata(html);
  const walk = (it: MicrodataItem) => {
    const t = it.type ?? "";
    if (ORG_TYPES.test(t)) orgFactsFromMicrodata(it, url, at, facts);
    if (/\/Product$|\/ProductModel$/i.test(t)) productFactsFromMicrodata(it, url, at, facts);
    for (const k of Object.keys(it.props)) for (const v of it.props[k] ?? []) if (typeof v !== "string") walk(v);
  };
  for (const it of items) walk(it);
  const robots = metaRobots(html);
  const xr = res.headers["x-robots-tag"] ?? null;
  const xrDirectives = xr ? xr.toLowerCase().split(/[,:]/).map((s) => s.trim()) : [];
  const noindex = robots.includes("noindex") || robots.includes("none") || xrDirectives.includes("noindex") || xrDirectives.includes("none");
  const nosnippet = robots.includes("nosnippet") || robots.includes("max-snippet:0") || xrDirectives.includes("nosnippet") || xrDirectives.includes("max-snippet:0");
  if (!blocks.length) notes.push("no JSON-LD block on the page");
  return {
    surface: "live_page",
    url,
    observed_at: at,
    facts,
    notes,
    status: res.status,
    title: title(html),
    text: visibleText(html),
    jsonld: blocks,
    jsonld_ids: jsonLdIds(blocks),
    microdata: items,
    index: { noindex, nosnippet, canonical: canonical(html), x_robots_tag: xr },
    source_hash: await digest(utf8(html)),
  };
}

export async function readLivePage(fetchPort: FetchPort, url: string, now: string): Promise<LivePageRead> {
  let res: FetchResult;
  try {
    res = await fetchPort.get(url, { accept: "text/html" });
  } catch (e) {
    res = { status: 0, headers: {}, body: "" };
    const r = await readLivePageFrom(url, res, now);
    r.notes.push(`fetch failed: ${e instanceof Error ? e.message : "unknown error"}`);
    return r;
  }
  return readLivePageFrom(url, res, now);
}

// ------------------------------------------------- (c) Merchant Center

export type MerchantCenterFormat = "content_api" | "tsv" | "xml";

interface FeedProduct {
  key: string;
  name: string | null;
  url: string | null;
  price: Price | null;
  availability: string | null;
  gtin: string | null;
  brand: string | null;
  notice: ConsumerNotice | null;
  inventory: number | null;
  id: string | null;
}

/** Content API v2.1: { resources: Product[] } from products.list, or a bare array, or { products: [] }. */
export function parseMerchantCenterContentApi(json: unknown): FeedProduct[] {
  const list = Array.isArray(json) ? json : json && typeof json === "object" ? ((json as Record<string, unknown>).resources ?? (json as Record<string, unknown>).products ?? (json as Record<string, unknown>).entries ?? []) : [];
  const out: FeedProduct[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = raw && typeof raw === "object" ? ((raw as Record<string, unknown>).product ?? raw) : null;
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const fullId = str(o.id);
    const offerId = str(o.offerId) ?? (fullId ? fullId.split(":").pop() ?? fullId : null);
    const notices = Array.isArray(o.consumerNotices) ? o.consumerNotices : o.consumerNotice ?? o.consumer_notice;
    out.push({
      key: productKey({ id: offerId }),
      id: offerId,
      name: str(o.title),
      url: str(o.link),
      price: parsePrice(o.price),
      availability: str(o.availability),
      gtin: str(o.gtin),
      brand: str(o.brand),
      notice: noticeOf(notices),
      inventory: typeof o.sellOnGoogleQuantity === "number" ? o.sellOnGoogleQuantity : null,
    });
  }
  return out;
}

/** A tab-separated feed with a header row: id, title, link, price, availability, gtin, brand, consumer_notice. */
export function parseMerchantCenterTsv(text: string): FeedProduct[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = (lines[0] ?? "").split("\t").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const col = (row: string[], name: string): string | null => {
    const i = header.indexOf(name);
    if (i < 0) return null;
    const v = (row[i] ?? "").trim();
    return v || null;
  };
  const out: FeedProduct[] = [];
  for (const line of lines.slice(1)) {
    const row = line.split("\t");
    const id = col(row, "id");
    if (!id) continue;
    out.push({
      key: productKey({ id }),
      id,
      name: col(row, "title"),
      url: col(row, "link"),
      price: parsePrice(col(row, "price")),
      availability: col(row, "availability"),
      gtin: col(row, "gtin"),
      brand: col(row, "brand"),
      notice: noticeOf(col(row, "consumer_notice")),
      inventory: null,
    });
  }
  return out;
}

function xmlText(block: string, tag: string): string | null {
  const re = new RegExp(`<(?:g:)?${tag}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</(?:g:)?${tag}\\s*>`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const v = (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return v ? v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null;
}

/** An RSS 2.0 feed with the g: namespace (Merchant Center XML spec). */
export function parseMerchantCenterXml(text: string): FeedProduct[] {
  const out: FeedProduct[] = [];
  const re = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const block = m[1] ?? "";
    const id = xmlText(block, "id");
    if (!id) continue;
    const noticeBlock = /<g:consumer_notice\b[^>]*>([\s\S]*?)<\/g:consumer_notice\s*>/i.exec(block);
    const notice = noticeBlock ? noticeOf({ type: xmlText(noticeBlock[1] ?? "", "type") ?? undefined, message: xmlText(noticeBlock[1] ?? "", "message") ?? xmlText(block, "consumer_notice") ?? "" }) : noticeOf(xmlText(block, "consumer_notice"));
    out.push({
      key: productKey({ id }),
      id,
      name: xmlText(block, "title"),
      url: xmlText(block, "link"),
      price: parsePrice(xmlText(block, "price")),
      availability: xmlText(block, "availability"),
      gtin: xmlText(block, "gtin"),
      brand: xmlText(block, "brand"),
      notice,
      inventory: null,
    });
  }
  return out;
}

export function merchantCenterRead(products: FeedProduct[], url: string, observed_at: string, format: MerchantCenterFormat): SurfaceRead {
  const facts: SurfaceFact[] = [];
  for (const p of products) productFacts("merchant_center", p.key, p, url, observed_at, facts);
  return { surface: "merchant_center", url, observed_at, facts, notes: [`${products.length} products read from the ${format === "content_api" ? "Content API" : format.toUpperCase() + " feed"}`] };
}

export function detectMerchantCenterFormat(res: FetchResult): MerchantCenterFormat {
  const ct = (res.headers["content-type"] ?? "").toLowerCase();
  const body = res.body.trimStart();
  if (ct.includes("json") || body.startsWith("{") || body.startsWith("[")) return "content_api";
  if (ct.includes("xml") || body.startsWith("<")) return "xml";
  return "tsv";
}

export async function readMerchantCenter(fetchPort: FetchPort, source: { url: string; format?: MerchantCenterFormat; token?: string | null }, now: string): Promise<SurfaceRead> {
  const headers: Record<string, string> = {};
  if (source.token) headers["authorization"] = `Bearer ${source.token}`;
  const res = await fetchPort.get(source.url, headers);
  const at = observedAt(res, now);
  if (res.status !== 200) return { surface: "merchant_center", url: source.url, observed_at: at, facts: [], notes: [`feed answered ${res.status}`] };
  const format = source.format ?? detectMerchantCenterFormat(res);
  let products: FeedProduct[] = [];
  try {
    products = format === "content_api" ? parseMerchantCenterContentApi(JSON.parse(res.body)) : format === "xml" ? parseMerchantCenterXml(res.body) : parseMerchantCenterTsv(res.body);
  } catch (e) {
    return { surface: "merchant_center", url: source.url, observed_at: at, facts: [], notes: [`feed did not parse: ${e instanceof Error ? e.message : "unknown error"}`] };
  }
  return merchantCenterRead(products, source.url, at, format);
}

// ------------------------------------------------ (d) Business Profile

const GBP_DAYS: Record<string, Day> = { MONDAY: "monday", TUESDAY: "tuesday", WEDNESDAY: "wednesday", THURSDAY: "thursday", FRIDAY: "friday", SATURDAY: "saturday", SUNDAY: "sunday" };

function gbpTime(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const h = typeof o.hours === "number" ? o.hours : 0;
  const m = typeof o.minutes === "number" ? o.minutes : 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Business Information API v1 Location: title, phoneNumbers, storefrontAddress, regularHours, websiteUri, categories. */
export function parseBusinessProfile(json: unknown, url: string, observed_at: string): SurfaceRead {
  const facts: SurfaceFact[] = [];
  const notes: string[] = [];
  const loc = json && typeof json === "object" ? ((json as Record<string, unknown>).location ?? json) : null;
  if (!loc || typeof loc !== "object") return { surface: "business_profile", url, observed_at, facts, notes: ["no location object"] };
  const o = loc as Record<string, unknown>;
  const phones = o.phoneNumbers && typeof o.phoneNumbers === "object" ? (o.phoneNumbers as Record<string, unknown>) : {};
  fact("business_profile", "identity.legal_name", str(o.title), url, observed_at, facts);
  fact("business_profile", "contact.phone", str(phones.primaryPhone), url, observed_at, facts);
  const a = o.storefrontAddress && typeof o.storefrontAddress === "object" ? (o.storefrontAddress as Record<string, unknown>) : null;
  if (a) {
    const lines = Array.isArray(a.addressLines) ? a.addressLines.map((x) => String(x)) : [];
    fact("business_profile", "contact.address", joinAddress({ lines, locality: str(a.locality) ?? undefined, region: str(a.administrativeArea) ?? undefined, postal: str(a.postalCode) ?? undefined, country: str(a.regionCode) ?? undefined }), url, observed_at, facts);
  }
  fact("business_profile", "contact.website", str(o.websiteUri), url, observed_at, facts);
  const hours = o.regularHours && typeof o.regularHours === "object" ? (o.regularHours as Record<string, unknown>) : null;
  const periods = hours && Array.isArray(hours.periods) ? hours.periods : [];
  const byDay: Partial<Record<Day, string[]>> = {};
  for (const p of periods) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    const day = GBP_DAYS[String(po.openDay ?? "").toUpperCase()];
    const open = gbpTime(po.openTime);
    const close = gbpTime(po.closeTime);
    if (!day || !open || !close) continue;
    const spans = byDay[day] ?? [];
    spans.push(`${open}-${close}`);
    byDay[day] = spans;
  }
  if (periods.length) {
    for (const d of DAYS) {
      const spans = byDay[d];
      fact("business_profile", `hours.${d}`, spans && spans.length ? (spans.length === 1 ? spans[0]! : spans) : "closed", url, observed_at, facts);
    }
  } else notes.push("no regular hours on the listing");
  const cats = o.categories && typeof o.categories === "object" ? (o.categories as Record<string, unknown>) : null;
  const primary = cats && cats.primaryCategory && typeof cats.primaryCategory === "object" ? (cats.primaryCategory as Record<string, unknown>) : null;
  fact("business_profile", "business.category", primary ? str(primary.displayName) ?? str(primary.name) : null, url, observed_at, facts);
  return { surface: "business_profile", url, observed_at, facts, notes };
}

export async function readBusinessProfile(fetchPort: FetchPort, source: { url: string; token?: string | null }, now: string): Promise<SurfaceRead> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (source.token) headers["authorization"] = `Bearer ${source.token}`;
  const res = await fetchPort.get(source.url, headers);
  const at = observedAt(res, now);
  if (res.status !== 200) return { surface: "business_profile", url: source.url, observed_at: at, facts: [], notes: [`listing answered ${res.status}`] };
  try {
    return parseBusinessProfile(JSON.parse(res.body), source.url, at);
  } catch {
    return { surface: "business_profile", url: source.url, observed_at: at, facts: [], notes: ["listing did not parse as JSON"] };
  }
}

// --------------------------------------------------------------- (e) UCP

/** The manifest at /.well-known/ucp: { ucp: { version, services, capabilities } }. Read as facts under ucp.*. */
export function parseUcpManifest(json: unknown, url: string, observed_at: string): SurfaceRead {
  const facts: SurfaceFact[] = [];
  const notes: string[] = [];
  const root = json && typeof json === "object" ? ((json as Record<string, unknown>).ucp ?? json) : null;
  if (!root || typeof root !== "object") return { surface: "ucp", url, observed_at, facts, notes: ["no ucp object in the manifest"] };
  const o = root as Record<string, unknown>;
  fact("ucp", "ucp.version", str(o.version), url, observed_at, facts);
  const services = o.services && typeof o.services === "object" ? Object.keys(o.services as Record<string, unknown>) : [];
  fact("ucp", "ucp.services", services, url, observed_at, facts);
  const caps = Array.isArray(o.capabilities) ? o.capabilities.map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).name) : str(c))).filter((x): x is string => Boolean(x)) : [];
  fact("ucp", "ucp.capabilities", caps, url, observed_at, facts);
  const endpoints: string[] = [];
  if (o.services && typeof o.services === "object") {
    for (const k of Object.keys(o.services as Record<string, unknown>)) {
      const s = (o.services as Record<string, unknown>)[k];
      if (s && typeof s === "object") {
        const rest = (s as Record<string, unknown>).rest;
        const ep = rest && typeof rest === "object" ? str((rest as Record<string, unknown>).endpoint) : null;
        if (ep) endpoints.push(ep);
      }
    }
  }
  fact("ucp", "ucp.endpoints", endpoints, url, observed_at, facts);
  if (!services.length) notes.push("manifest lists no services");
  return { surface: "ucp", url, observed_at, facts, notes };
}

/** A UCP catalog item: id or merchant_item_id, title, link, price, availability, gtin, brand, native_commerce, consumer_notice. */
export function parseUcpCatalogItem(json: unknown): FeedProduct | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const id = str(o.id) ?? str(o.sku) ?? str(o.merchant_item_id);
  if (!id) return null;
  return {
    key: productKey({ sku: str(o.sku), id }),
    id,
    name: str(o.title) ?? str(o.name),
    url: str(o.link) ?? str(o.url),
    price: parsePrice(o.price),
    availability: str(o.availability),
    gtin: str(o.gtin),
    brand: str(o.brand),
    notice: noticeOf(o.consumer_notice),
    inventory: typeof o.inventory_quantity === "number" ? o.inventory_quantity : null,
  };
}

export function ucpCatalogRead(items: unknown[], url: string, observed_at: string): SurfaceRead {
  const facts: SurfaceFact[] = [];
  let n = 0;
  for (const raw of items) {
    const p = parseUcpCatalogItem(raw);
    if (!p) continue;
    n += 1;
    productFacts("ucp", p.key, p, url, observed_at, facts);
    const o = raw as Record<string, unknown>;
    if (typeof o.native_commerce === "boolean") fact("ucp", `product.${p.key}.native_commerce`, o.native_commerce, url, observed_at, facts);
    if (str(o.merchant_item_id)) fact("ucp", `product.${p.key}.merchant_item_id`, str(o.merchant_item_id), url, observed_at, facts);
  }
  return { surface: "ucp", url, observed_at, facts, notes: [`${n} catalog items read`] };
}

export async function readUcp(fetchPort: FetchPort, source: { manifest_url: string; catalog_url?: string }, now: string): Promise<SurfaceRead> {
  const res = await fetchPort.get(source.manifest_url, { accept: "application/json" });
  const at = observedAt(res, now);
  let manifest: SurfaceRead;
  if (res.status !== 200) manifest = { surface: "ucp", url: source.manifest_url, observed_at: at, facts: [], notes: [`manifest answered ${res.status}`] };
  else {
    try {
      manifest = parseUcpManifest(JSON.parse(res.body), source.manifest_url, at);
    } catch {
      manifest = { surface: "ucp", url: source.manifest_url, observed_at: at, facts: [], notes: ["manifest did not parse as JSON"] };
    }
  }
  if (!source.catalog_url) return manifest;
  const cres = await fetchPort.get(source.catalog_url, { accept: "application/json" });
  if (cres.status !== 200) {
    manifest.notes.push(`catalog answered ${cres.status}`);
    return manifest;
  }
  try {
    const parsed = JSON.parse(cres.body) as unknown;
    const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).items) ? ((parsed as Record<string, unknown>).items as unknown[]) : [parsed];
    const cat = ucpCatalogRead(items, source.catalog_url, observedAt(cres, now));
    return { surface: "ucp", url: source.manifest_url, observed_at: at, facts: manifest.facts.concat(cat.facts), notes: manifest.notes.concat(cat.notes) };
  } catch {
    manifest.notes.push("catalog did not parse as JSON");
    return manifest;
  }
}

// --------------------------------------------------------------- (f) ACP

/** The OpenAI Agentic Commerce product feed: JSON lines or a JSON array of items with id, title, description, link, price, availability, gtin, brand, inventory_quantity. */
export function parseAcpFeed(text: string): FeedProduct[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let items: unknown[] = [];
  if (trimmed.startsWith("[")) items = JSON.parse(trimmed) as unknown[];
  else if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    const one = JSON.parse(trimmed) as Record<string, unknown>;
    items = Array.isArray(one.items) ? one.items : Array.isArray(one.products) ? one.products : [one];
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      items.push(JSON.parse(l));
    }
  }
  const out: FeedProduct[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const id = str(o.id);
    if (!id) continue;
    out.push({
      key: productKey({ sku: str(o.sku), id }),
      id,
      name: str(o.title),
      url: str(o.link),
      price: parsePrice(o.price),
      availability: str(o.availability),
      gtin: str(o.gtin),
      brand: str(o.brand),
      notice: null,
      inventory: typeof o.inventory_quantity === "number" ? o.inventory_quantity : typeof o.inventory_quantity === "string" && /^\d+$/.test(o.inventory_quantity) ? Number(o.inventory_quantity) : null,
    });
  }
  return out;
}

export function acpRead(products: FeedProduct[], url: string, observed_at: string): SurfaceRead {
  const facts: SurfaceFact[] = [];
  for (const p of products) productFacts("acp", p.key, p, url, observed_at, facts);
  return { surface: "acp", url, observed_at, facts, notes: [`${products.length} products read from the ACP feed`] };
}

export async function readAcp(fetchPort: FetchPort, source: { url: string }, now: string): Promise<SurfaceRead> {
  const res = await fetchPort.get(source.url, {});
  const at = observedAt(res, now);
  if (res.status !== 200) return { surface: "acp", url: source.url, observed_at: at, facts: [], notes: [`feed answered ${res.status}`] };
  try {
    return acpRead(parseAcpFeed(res.body), source.url, at);
  } catch (e) {
    return { surface: "acp", url: source.url, observed_at: at, facts: [], notes: [`feed did not parse: ${e instanceof Error ? e.message : "unknown error"}`] };
  }
}

export type { FeedProduct };
