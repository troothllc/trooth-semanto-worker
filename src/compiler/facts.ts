// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Fact candidates from one page. Two sources, both the company's own words:
//
//   structured   schema.org JSON-LD (W3C JSON-LD 1.1, in script blocks) and
//                microdata (WHATWG HTML microdata) already on the page, for
//                Organization, LocalBusiness, Product, Offer, FAQPage,
//                Article, ContactPoint, PostalAddress and
//                OpeningHoursSpecification
//   text         patterns over the page's sentences for the legal name,
//                postal addresses, phone numbers, opening hours, the support
//                email, the founding year, and statements that carry a number
//
// Every candidate is a core Fact with provenance "declared" (the company's
// site said it) and evidence { url, witnessed_at, anchor }, where the anchor
// is the exact sentence or the JSON-LD path the value came from. A schema
// mapping { type, property } is attached where one exists, so the JSON-LD
// write-back can put the value back where Google reads it. Nothing is ever
// invented: when a field is absent, no fact is produced. Keys are the shared
// vocabulary of src/core/fact-keys.ts (contact.phone, contact.address,
// hours.<day>, identity.legal_name), so the monitor and the gap report read
// these facts under the same names.

import { factId, type Fact } from "../core/semanto";
import { parseHtml, walk, textOf, type ElementNode } from "./html";
import { sentencesOf } from "./extract";

export interface FactsInput {
  url: string;
  witnessed_at: string;
  html: string;
  /** The page's markdown body after chrome removal; text patterns run over it. */
  body: string;
}

export type FactCandidate = Omit<Fact, "id">;

const PLACEHOLDERS = new Set(["", "n/a", "na", "none", "null", "undefined", "unknown", "tbd", "todo", "-", "lorem ipsum", "[object object]"]);

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s;
}

function cleanList(v: unknown): string[] | null {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out = arr.map(clean).filter((x): x is string => x !== null);
  return out.length ? out : null;
}

// ---------------------------------------------------------------- structured data

interface Node {
  types: string[];
  props: Record<string, unknown>;
  anchor: string;
}

function typesOf(v: unknown): string[] {
  const t = (v as Record<string, unknown>)["@type"] ?? (v as Record<string, unknown>)["type"];
  const arr = Array.isArray(t) ? t : t ? [t] : [];
  return arr.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/, ""));
}

/** Flatten @graph and nested objects into a list of typed nodes with JSON-pointer anchors. */
function flattenJsonLd(value: unknown, anchor: string, out: Node[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJsonLd(v, `${anchor}/${i}`, out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) {
    flattenJsonLd(obj["@graph"], `${anchor}/@graph`, out);
  }
  const types = typesOf(obj);
  if (types.length) out.push({ types, props: obj, anchor });
}

export function jsonLdBlocks(root: ElementNode): { index: number; data: unknown }[] {
  const out: { index: number; data: unknown }[] = [];
  let i = 0;
  walk(root, (el) => {
    if (el.tag !== "script" || !/application\/ld\+json/i.test(el.attrs["type"] ?? "")) return;
    const raw = textOf(el).trim();
    const idx = i++;
    if (!raw) return;
    try {
      out.push({ index: idx, data: JSON.parse(raw) });
    } catch {
      // Malformed JSON-LD is not a fact.
    }
  });
  return out;
}

/** WHATWG microdata to the same node shape as JSON-LD. */
export function microdataNodes(root: ElementNode): Node[] {
  const out: Node[] = [];
  const valueOf = (el: ElementNode): unknown => {
    if ("itemscope" in el.attrs) return scope(el);
    if (el.attrs["content"]) return el.attrs["content"];
    if ((el.tag === "a" || el.tag === "link" || el.tag === "area") && el.attrs["href"]) return el.attrs["href"];
    if ((el.tag === "img" || el.tag === "audio" || el.tag === "video" || el.tag === "source" || el.tag === "iframe" || el.tag === "embed") && el.attrs["src"]) return el.attrs["src"];
    if (el.tag === "time" && el.attrs["datetime"]) return el.attrs["datetime"];
    if (el.tag === "meta") return el.attrs["content"] ?? "";
    if (el.tag === "data" && el.attrs["value"]) return el.attrs["value"];
    return textOf(el).replace(/\s+/g, " ").trim();
  };
  const scope = (el: ElementNode): Record<string, unknown> => {
    const props: Record<string, unknown> = {};
    const types = (el.attrs["itemtype"] ?? "").split(/\s+/).filter(Boolean).map((t) => t.replace(/^https?:\/\/schema\.org\//i, ""));
    if (types.length) props["@type"] = types.length === 1 ? types[0] : types;
    const visit = (n: ElementNode) => {
      for (const c of n.children) {
        if (c.type !== "element") continue;
        const names = (c.attrs["itemprop"] ?? "").split(/\s+/).filter(Boolean);
        if (names.length) {
          const v = valueOf(c);
          for (const name of names) {
            const existing = props[name];
            if (existing === undefined) props[name] = v;
            else if (Array.isArray(existing)) existing.push(v);
            else props[name] = [existing, v];
          }
        }
        if (!("itemscope" in c.attrs)) visit(c);
      }
    };
    visit(el);
    return props;
  };
  walk(root, (el) => {
    if ("itemscope" in el.attrs && !("itemprop" in el.attrs) && el.attrs["itemtype"]) {
      const props = scope(el);
      const anchor = textOf(el).replace(/\s+/g, " ").trim().slice(0, 200) || "microdata";
      flattenNested(props, anchor, out);
      return false;
    }
  });
  return out;
}

function flattenNested(obj: Record<string, unknown>, anchor: string, out: Node[]): void {
  const types = typesOf(obj);
  if (types.length) out.push({ types, props: obj, anchor });
  for (const v of Object.values(obj)) {
    const arr = Array.isArray(v) ? v : [v];
    for (const x of arr) if (typeof x === "object" && x !== null && !Array.isArray(x)) flattenNested(x as Record<string, unknown>, anchor, out);
  }
}

const ORG_TYPES = new Set(["Organization", "Corporation", "LocalBusiness", "Store", "Restaurant", "ProfessionalService", "FinancialService", "MedicalBusiness", "HomeAndConstructionBusiness", "LegalService", "Dentist", "AutoDealer", "EducationalOrganization", "NGO", "GovernmentOrganization", "OnlineBusiness", "OnlineStore", "SoftwareApplication"]);
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "item";
}

function textValue(v: unknown): string | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return clean(o["name"] ?? o["@id"] ?? o["url"] ?? o["text"]);
  }
  if (Array.isArray(v)) return cleanList(v)?.join(", ") ?? null;
  return clean(v);
}

function structuredFacts(nodes: Node[], ctx: { url: string; witnessed_at: string; anchorPrefix: string }): FactCandidate[] {
  const out: FactCandidate[] = [];
  const push = (key: string, statement: string, value: string | string[], anchor: string, schema: { type: string; property: string }) => {
    out.push({ key, statement, value, provenance: "declared", evidence: { url: ctx.url, witnessed_at: ctx.witnessed_at, anchor: `${ctx.anchorPrefix}${anchor}` }, schema });
  };
  const addressFacts = (addr: unknown, anchor: string, prefix: string, orgName: string | null) => {
    if (typeof addr === "string") {
      const v = clean(addr);
      if (v) push(`${prefix}address`, `${orgName ?? "The company"} gives its address as ${v}`, v, `${anchor}/address`, { type: "PostalAddress", property: "address" });
      return;
    }
    if (typeof addr !== "object" || addr === null) return;
    const a = addr as Record<string, unknown>;
    const parts: [string, string, string][] = [
      ["streetAddress", "street_address", "street address"], ["addressLocality", "locality", "city"], ["addressRegion", "region", "region"],
      ["postalCode", "postal_code", "postal code"], ["addressCountry", "country", "country"],
    ];
    for (const [prop, keyPart, label] of parts) {
      const v = textValue(a[prop]);
      if (v) push(`${prefix}address.${keyPart}`, `${orgName ?? "The company"} gives its ${label} as ${v}`, v, `${anchor}/address/${prop}`, { type: "PostalAddress", property: prop });
    }
  };
  const contactFacts = (cp: unknown, anchor: string, orgName: string | null) => {
    const arr = Array.isArray(cp) ? cp : [cp];
    arr.forEach((c, i) => {
      if (typeof c !== "object" || c === null) return;
      const o = c as Record<string, unknown>;
      const kind = clean(o["contactType"]);
      const keyBase = kind ? `contact.${slug(kind)}` : "contact";
      const tel = clean(o["telephone"]);
      const raw = clean(o["email"]);
      // A role address (sales@, support@) is the company's; a person's address is left out, like any name Trooth did not get from the company.
      const email = raw && isRoleEmail(raw) ? raw : null;
      const a = `${anchor}/contactPoint/${i}`;
      if (tel) push(`${keyBase}.telephone`, `${orgName ?? "The company"} lists ${kind ? `${kind} ` : ""}telephone ${tel}`, tel, `${a}/telephone`, { type: "ContactPoint", property: "telephone" });
      if (email) push(`${keyBase}.email`, `${orgName ?? "The company"} lists ${kind ? `${kind} ` : ""}email ${email}`, email, `${a}/email`, { type: "ContactPoint", property: "email" });
      if (kind) push(`${keyBase}.contact_type`, `${orgName ?? "The company"} names a contact point for ${kind}`, kind, `${a}/contactType`, { type: "ContactPoint", property: "contactType" });
    });
  };
  const hoursFacts = (spec: unknown, anchor: string, orgName: string | null) => {
    const arr = Array.isArray(spec) ? spec : [spec];
    arr.forEach((h, i) => {
      if (typeof h !== "object" || h === null) return;
      const o = h as Record<string, unknown>;
      const opens = clean(o["opens"]);
      const closes = clean(o["closes"]);
      const days = cleanList(o["dayOfWeek"])?.map((d) => d.replace(/^https?:\/\/schema\.org\//i, "")) ?? [];
      if (!opens || !closes || !days.length) return;
      for (const day of days) {
        if (!DAYS.includes(day)) continue;
        push(`hours.${day.toLowerCase()}`, `${orgName ?? "The company"} is open ${day} ${opens} to ${closes}`, `${opens}-${closes}`, `${anchor}/openingHoursSpecification/${i}`, { type: "OpeningHoursSpecification", property: "dayOfWeek" });
      }
    });
  };

  nodes.forEach((node) => {
    const p = node.props;
    const a = node.anchor;
    const isOrg = node.types.some((t) => ORG_TYPES.has(t));
    const isLocal = node.types.some((t) => t !== "Organization" && t !== "Corporation" && ORG_TYPES.has(t));
    const name = clean(p["name"]);
    if (isOrg) {
      const schemaType = isLocal ? "LocalBusiness" : "Organization";
      if (name) push("identity.name", `The company's name is ${name}`, name, `${a}/name`, { type: schemaType, property: "name" });
      const legal = clean(p["legalName"]);
      if (legal) push("identity.legal_name", `The company's legal name is ${legal}`, legal, `${a}/legalName`, { type: schemaType, property: "legalName" });
      const url = clean(p["url"]);
      if (url) push("identity.url", `${name ?? "The company"} gives its website as ${url}`, url, `${a}/url`, { type: schemaType, property: "url" });
      const logo = textValue(p["logo"]);
      if (logo) push("identity.logo", `${name ?? "The company"} gives its logo as ${logo}`, logo, `${a}/logo`, { type: schemaType, property: "logo" });
      const sameAs = cleanList(p["sameAs"]);
      if (sameAs) push("identity.same_as", `${name ?? "The company"} lists its other profiles as ${sameAs.join(", ")}`, sameAs, `${a}/sameAs`, { type: schemaType, property: "sameAs" });
      const founded = clean(p["foundingDate"]);
      if (founded) push("identity.founding_date", `${name ?? "The company"} gives its founding date as ${founded}`, founded, `${a}/foundingDate`, { type: schemaType, property: "foundingDate" });
      const tel = clean(p["telephone"]);
      if (tel) push("contact.phone", `${name ?? "The company"} lists telephone ${tel}`, tel, `${a}/telephone`, { type: schemaType, property: "telephone" });
      const email = clean(p["email"]);
      if (email) push("contact.email", `${name ?? "The company"} lists email ${email}`, email, `${a}/email`, { type: schemaType, property: "email" });
      const lei = clean(p["leiCode"]);
      if (lei) push("identity.lei_declared", `${name ?? "The company"} gives its LEI as ${lei}`, lei, `${a}/leiCode`, { type: schemaType, property: "leiCode" });
      const price = clean(p["priceRange"]);
      if (price && isLocal) push("commerce.price_range", `${name ?? "The company"} gives its price range as ${price}`, price, `${a}/priceRange`, { type: "LocalBusiness", property: "priceRange" });
      if (p["address"] !== undefined) addressFacts(p["address"], a, "contact.", name);
      if (p["contactPoint"] !== undefined) contactFacts(p["contactPoint"], a, name);
      if (p["openingHoursSpecification"] !== undefined) hoursFacts(p["openingHoursSpecification"], a, name);
      const hoursText = cleanList(p["openingHours"]);
      if (hoursText) push("hours.text", `${name ?? "The company"} gives its opening hours as ${hoursText.join("; ")}`, hoursText, `${a}/openingHours`, { type: "LocalBusiness", property: "openingHours" });
    }
    if (node.types.includes("Product")) {
      const id = clean(p["sku"]) ?? clean(p["productID"]) ?? name;
      if (id && name) {
        const k = `product.${slug(id)}`;
        push(`${k}.name`, `A product is named ${name}`, name, `${a}/name`, { type: "Product", property: "name" });
        const desc = clean(p["description"]);
        if (desc) push(`${k}.description`, `${name} is described as: ${desc}`, desc, `${a}/description`, { type: "Product", property: "description" });
        const sku = clean(p["sku"]);
        if (sku) push(`${k}.sku`, `${name} has SKU ${sku}`, sku, `${a}/sku`, { type: "Product", property: "sku" });
        for (const g of ["gtin", "gtin8", "gtin12", "gtin13", "gtin14"]) {
          const v = clean(p[g]);
          if (v) push(`${k}.gtin`, `${name} has ${g.toUpperCase()} ${v}`, v, `${a}/${g}`, { type: "Product", property: g });
        }
        const brand = textValue(p["brand"]);
        if (brand) push(`${k}.brand`, `${name} is sold under the brand ${brand}`, brand, `${a}/brand`, { type: "Product", property: "brand" });
        const url = clean(p["url"]);
        if (url) push(`${k}.url`, `${name} has the page ${url}`, url, `${a}/url`, { type: "Product", property: "url" });
        const offers = Array.isArray(p["offers"]) ? p["offers"] : p["offers"] ? [p["offers"]] : [];
        offers.forEach((o, i) => {
          if (typeof o !== "object" || o === null) return;
          const offer = o as Record<string, unknown>;
          const price = clean(offer["price"]);
          const currency = clean(offer["priceCurrency"]);
          if (price) push(`${k}.price`, `${name} is offered at ${price}${currency ? ` ${currency}` : ""}`, currency ? `${price} ${currency}` : price, `${a}/offers/${i}/price`, { type: "Offer", property: "price" });
          const avail = clean(offer["availability"]);
          if (avail) push(`${k}.availability`, `${name} availability is ${avail.replace(/^https?:\/\/schema\.org\//i, "")}`, avail.replace(/^https?:\/\/schema\.org\//i, ""), `${a}/offers/${i}/availability`, { type: "Offer", property: "availability" });
        });
      }
    }
    if (node.types.includes("Offer") && !nodes.some((n) => n.types.includes("Product") && n.anchor !== a && a.startsWith(n.anchor))) {
      const price = clean(p["price"]);
      const currency = clean(p["priceCurrency"]);
      const item = textValue(p["itemOffered"]);
      if (price && item) push(`product.${slug(item)}.price`, `${item} is offered at ${price}${currency ? ` ${currency}` : ""}`, currency ? `${price} ${currency}` : price, `${a}/price`, { type: "Offer", property: "price" });
    }
    if (node.types.includes("FAQPage")) {
      const main = Array.isArray(p["mainEntity"]) ? p["mainEntity"] : p["mainEntity"] ? [p["mainEntity"]] : [];
      main.forEach((q, i) => {
        if (typeof q !== "object" || q === null) return;
        const qo = q as Record<string, unknown>;
        const question = clean(qo["name"]);
        const ans = qo["acceptedAnswer"];
        const answer = typeof ans === "object" && ans !== null ? clean((ans as Record<string, unknown>)["text"]) : clean(ans);
        if (question && answer) push(`faq.${slug(question)}`, `${question} ${answer}`, answer, `${a}/mainEntity/${i}`, { type: "FAQPage", property: "mainEntity" });
      });
    }
    if (node.types.some((t) => t === "Article" || t === "NewsArticle" || t === "BlogPosting")) {
      const headline = clean(p["headline"]) ?? name;
      if (headline) {
        const k = `article.${slug(headline)}`;
        push(`${k}.headline`, `An article is titled ${headline}`, headline, `${a}/headline`, { type: "Article", property: "headline" });
        const published = clean(p["datePublished"]);
        if (published) push(`${k}.date_published`, `${headline} was published ${published}`, published, `${a}/datePublished`, { type: "Article", property: "datePublished" });
        const modified = clean(p["dateModified"]);
        if (modified) push(`${k}.date_modified`, `${headline} was last changed ${modified}`, modified, `${a}/dateModified`, { type: "Article", property: "dateModified" });
        // No author: Trooth publishes a person's name only when the company entered it itself (founder, 2026-10-29).
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- text patterns

const LEGAL_SUFFIX = "(?:Inc\\.?|Incorporated|LLC|L\\.L\\.C\\.|Ltd\\.?|Limited|GmbH|AG|S\\.A\\.|S\\.p\\.A\\.|B\\.V\\.|N\\.V\\.|Pty\\.? Ltd\\.?|PLC|plc|Corp\\.?|Corporation|Co\\.|LLP|LP|S\\.L\\.|SAS|SARL|Oy|AB|A/S|ApS|Pte\\.? Ltd\\.?)";
const LEGAL_NAME_RE = new RegExp(`\\b((?:[A-Z][A-Za-z0-9&'.-]*(?:\\s+(?:of|and|&|the|de|du|von)\\s+)?\\s*){1,6}?${LEGAL_SUFFIX})(?=[\\s,.;:)]|$)`, "g");
const ADDRESS_RE = /\b(\d{1,6}[A-Za-z]?\s+(?:[A-Z][A-Za-z0-9.'-]*\s+){1,5}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?|Place|Pl\.?|Parkway|Pkwy\.?|Square|Sq\.?|Terrace|Highway|Hwy\.?|Circle|Plaza|Broadway)(?:,?\s+(?:Suite|Ste\.?|Unit|Floor|Fl\.?|#)\s*[A-Za-z0-9-]+)?,\s+[A-Z][A-Za-z.' -]+,\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,\s+(?:USA|United States|US))?)/g;
const PHONE_RE = /(?<![\w.])(\+?\d{1,3}[ .-]?)?(\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}(?![\w])/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const DAY = "(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:[a-z]*)\\.?";
const TIME = "\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m)?";
const HOURS_RE = new RegExp(`\\b(${DAY}(?:\\s*(?:-|\\u2013|to|through|thru)\\s*${DAY})?)\\s*[:,]?\\s*(${TIME})\\s*(?:-|\\u2013|to|until)\\s*(${TIME})`, "gi");
const FOUNDED_RE = /\b(?:founded|established|started|incorporated|in business|operating|serving [A-Za-z ]+)\s+(?:in\s+)?((?:18|19|20)\d{2})\b|\b(?:since|est\.?)\s+((?:18|19|20)\d{2})\b/gi;
/** Mailbox names that belong to a function, not a person. */
export const ROLE_MAILBOXES = new Set(["info", "hello", "hi", "contact", "sales", "support", "help", "helpdesk", "service", "customerservice", "customer-service", "care", "press", "media", "pr", "news", "team", "office", "admin", "billing", "accounts", "finance", "invoices", "orders", "shop", "store", "privacy", "dpo", "gdpr", "security", "abuse", "legal", "compliance", "careers", "jobs", "hr", "recruiting", "talent", "partners", "partnerships", "marketing", "events", "enquiries", "inquiries", "general", "reception", "bookings", "reservations", "feedback", "webmaster", "noreply", "no-reply", "investors", "ir"]);

/** True when the address's mailbox is a function (sales@, support+eu@), not a person. */
export function isRoleEmail(address: string): boolean {
  const local = address.trim().toLowerCase().replace(/^mailto:/, "").split("@")[0] ?? "";
  return ROLE_MAILBOXES.has(local.split("+")[0] ?? "");
}

const NUMBER_CLAIM_RE = /(?:[$\u20ac\u00a3\u00a5]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion))?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|\+|k\b|x\b|million|billion|thousand|customers|clients|users|members|countries|cities|locations|offices|employees|people|staff|teams|years|months|weeks|days|hours|minutes|seconds|uptime|reviews|downloads|projects|products|orders|stores|partners|languages|awards|patents|seats|tons|kg|lbs|miles|km|sq ft|square feet|GB|TB|MB|ms))/g;

/**
 * "Since 1970" is a founding year only when the sentence is about the company.
 * Read on trooth.co (2026-10-23): "created is the time of the attempt in
 * milliseconds since 1970" became "The page says the company dates from 1970".
 * A year counted from by a clock (milliseconds, seconds, minutes, hours, days
 * since a date) or named as an epoch, a timestamp or Unix time is a time base,
 * not a company's start, so "since" and "est." are refused there. The words
 * that name a founding outright (founded, established, incorporated) are not
 * affected.
 */
const TIME_UNIT_BEFORE_RE = /\b(?:nano|micro|milli)?seconds?\s+$|\b(?:ms|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|ticks?)\s+$/i;
const TIME_BASE_RE = /\b(?:epoch|unix|posix|timestamps?|utc|gmt|iso\s*8601|rfc\s*3339)\b/i;
export function sinceIsAboutTheCompany(sentence: string, at: number): boolean {
  if (TIME_UNIT_BEFORE_RE.test(sentence.slice(Math.max(0, at - 40), at))) return false;
  if (TIME_BASE_RE.test(sentence)) return false;
  return true;
}

function textFacts(ctx: { url: string; witnessed_at: string; body: string }): FactCandidate[] {
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  const push = (key: string, statement: string, value: string | string[], anchor: string, schema?: { type: string; property: string }) => {
    const sig = `${key}|${Array.isArray(value) ? value.join("|") : value}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ key, statement, value, provenance: "declared", evidence: { url: ctx.url, witnessed_at: ctx.witnessed_at, anchor }, ...(schema ? { schema } : {}) });
  };
  const sentences = sentencesOf(ctx.body);
  const claimed = new Set<number>();
  sentences.forEach((s, idx) => {
    let m: RegExpExecArray | null;
    LEGAL_NAME_RE.lastIndex = 0;
    while ((m = LEGAL_NAME_RE.exec(s)) !== null) {
      const v = m[1]!.replace(/\s+/g, " ").trim();
      if (v.split(/\s+/).length >= 2) push("identity.legal_name", `The page names the legal entity ${v}`, v, s, { type: "Organization", property: "legalName" });
    }
    ADDRESS_RE.lastIndex = 0;
    while ((m = ADDRESS_RE.exec(s)) !== null) {
      push("contact.address", `The page gives the address ${m[1]!}`, m[1]!, s, { type: "PostalAddress", property: "address" });
      claimed.add(idx);
    }
    PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(s)) !== null) {
      const v = m[0].trim();
      const digits = v.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) continue;
      if (/^(?:19|20)\d{2}[ .-]\d{2}[ .-]\d{2}/.test(v)) continue;
      push("contact.phone", `The page lists the phone number ${v}`, v, s, { type: "Organization", property: "telephone" });
      claimed.add(idx);
    }
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(s)) !== null) {
      const v = m[0];
      const local = v.split("@")[0]!.toLowerCase();
      if (/^(support|help|helpdesk|care|customercare|service|contact|hello|info)$/.test(local)) push("contact.support_email", `The page gives ${v} as a contact email`, v, s, { type: "ContactPoint", property: "email" });
      else push("contact.email", `The page lists the email ${v}`, v, s, { type: "Organization", property: "email" });
      claimed.add(idx);
    }
    HOURS_RE.lastIndex = 0;
    while ((m = HOURS_RE.exec(s)) !== null) {
      const v = m[0].replace(/\s+/g, " ").trim();
      push("hours.opening_hours", `The page gives opening hours ${v}`, v, s, { type: "LocalBusiness", property: "openingHours" });
      claimed.add(idx);
    }
    FOUNDED_RE.lastIndex = 0;
    while ((m = FOUNDED_RE.exec(s)) !== null) {
      const year = m[1] ?? m[2];
      if (year && m[2] && !sinceIsAboutTheCompany(s, m.index)) continue;
      if (year) push("identity.founding_date", `The page says the company dates from ${year}`, year, s, { type: "Organization", property: "foundingDate" });
    }
  });
  sentences.forEach((s, idx) => {
    if (claimed.has(idx)) return;
    NUMBER_CLAIM_RE.lastIndex = 0;
    const numbers: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = NUMBER_CLAIM_RE.exec(s)) !== null) numbers.push(m[0].trim());
    if (!numbers.length) return;
    if (/^\d+(?:\.\d+)?\s*[A-Za-z%]*\.?$/.test(s)) return;
    push("statement.with_number", s, numbers, s);
  });
  return out;
}

// ---------------------------------------------------------------- entry point

/** Candidates in page order: JSON-LD first, microdata second, text patterns last. Duplicates by key and value are kept once. */
export function factCandidates(input: FactsInput): FactCandidate[] {
  const root = parseHtml(input.html);
  const nodes: Node[] = [];
  for (const block of jsonLdBlocks(root)) {
    const found: Node[] = [];
    flattenJsonLd(block.data, "", found);
    for (const n of found) nodes.push({ ...n, anchor: `application/ld+json[${block.index}]${n.anchor}` });
  }
  const structured = structuredFacts(nodes, { url: input.url, witnessed_at: input.witnessed_at, anchorPrefix: "" });
  const micro = structuredFacts(microdataNodes(root), { url: input.url, witnessed_at: input.witnessed_at, anchorPrefix: "" });
  const text = textFacts({ url: input.url, witnessed_at: input.witnessed_at, body: input.body });
  const out: FactCandidate[] = [];
  const seen = new Set<string>();
  for (const c of [...structured, ...micro, ...text]) {
    if (c.value === undefined || c.value === "" || (Array.isArray(c.value) && c.value.length === 0)) continue;
    if (!c.evidence.anchor) continue;
    const sig = `${c.key}|${JSON.stringify(c.value)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

export async function extractFacts(input: FactsInput): Promise<Fact[]> {
  const candidates = factCandidates(input);
  return Promise.all(candidates.map(async (c) => ({ id: await factId(c), ...c })));
}
