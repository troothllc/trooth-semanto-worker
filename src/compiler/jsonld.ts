// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The write-back for Google: schema.org JSON-LD generated from a Semanto
// file's facts, in the shapes Google Search Central documents for structured
// data (Organization, LocalBusiness, Product and Offer, FAQPage, Article,
// WebSite; "Structured data general guidelines", JSON-LD in a script block in
// the page head). Two outputs: a site-wide @graph and a per-page block. Every
// value traces back: the parallel map { jsonld_path: source } names the fact
// id each value came from, or, for the few values that live in the header or
// the products tier instead of a fact, the header path or product id. Nothing
// is written that no fact or record says.

import type { SemantoFile, Fact, PageEntry } from "../core/semanto";
import { pathOf } from "./url";

export interface ProductLike {
  product_id: string;
  variant_id?: string;
  gtin?: string;
  sku?: string;
  name: string;
  brand?: string;
  description?: string;
  price?: { amount: string | number; currency: string };
  availability?: string;
  url: string;
}

export interface JsonLdOptions {
  /** The company's Trooth Network profile url, written as WebSite.sameAs. */
  troothProfileUrl?: string;
  /** Where the markdown of a page is served, for the <link rel="alternate"> tag. Default: the page url with .md. */
  markdownUrlFor?: (pageUrl: string) => string;
}

export interface JsonLdOutput {
  /** { "@context": "https://schema.org", "@graph": [nodes] } */
  graph: Record<string, unknown>;
  /** One JSON-LD object per page url, holding the nodes that page's facts support. */
  perPage: Record<string, Record<string, unknown>>;
  /** jsonld_path -> fact id (or "header:<path>", "page:<smp id>", "product:<product_id>"). */
  trace: Record<string, string>;
  /** Same shape as trace, per page. */
  perPageTrace: Record<string, Record<string, string>>;
}

type Obj = Record<string, unknown>;

class Tracer {
  readonly trace: Record<string, string> = {};
  readonly pagesOf = new Map<Obj, Set<string>>();
  constructor(private readonly facts: Map<string, Fact>) {}

  set(node: Obj, nodePath: string, prop: string, value: unknown, source: string): void {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;
    node[prop] = value;
    this.trace[`${nodePath}.${prop}`] = source;
    const f = this.facts.get(source);
    if (f) this.pages(node).add(f.evidence.url);
  }

  pages(node: Obj): Set<string> {
    let s = this.pagesOf.get(node);
    if (!s) {
      s = new Set();
      this.pagesOf.set(node, s);
    }
    return s;
  }
}

function byKey(facts: Fact[]): Map<string, Fact[]> {
  const m = new Map<string, Fact[]>();
  for (const f of facts) {
    const list = m.get(f.key) ?? [];
    list.push(f);
    m.set(f.key, list);
  }
  return m;
}

function first(m: Map<string, Fact[]>, key: string): Fact | null {
  return m.get(key)?.[0] ?? null;
}

function str(f: Fact | null): string | null {
  if (!f) return null;
  if (typeof f.value === "string") return f.value;
  if (typeof f.value === "number") return String(f.value);
  if (Array.isArray(f.value)) return f.value[0] ?? null;
  return null;
}

function isProductLike(p: unknown): p is ProductLike {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o["product_id"] === "string" && typeof o["name"] === "string" && typeof o["url"] === "string";
}

const AVAILABILITY: Record<string, string> = {
  in_stock: "https://schema.org/InStock", instock: "https://schema.org/InStock", out_of_stock: "https://schema.org/OutOfStock", outofstock: "https://schema.org/OutOfStock",
  preorder: "https://schema.org/PreOrder", pre_order: "https://schema.org/PreOrder", backorder: "https://schema.org/BackOrder", discontinued: "https://schema.org/Discontinued",
  limited: "https://schema.org/LimitedAvailability", sold_out: "https://schema.org/SoldOut",
};

export function generateJsonLd(file: SemantoFile, opts: JsonLdOptions = {}): JsonLdOutput {
  const facts = new Map(file.facts.map((f) => [f.id, f] as const));
  const keys = byKey(file.facts);
  const t = new Tracer(facts);
  const graph: Obj[] = [];
  const domain = file.header.identity.domain;
  const siteUrl = `https://${domain}/`;
  const home = file.header.pages_manifest.find((p) => pathOf(p.url) === "/") ?? null;

  // Organization (or LocalBusiness when hours are declared)
  const hourFacts = [...keys.entries()].filter(([k]) => /^hours\.(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(k)).flatMap(([, v]) => v);
  const isLocal = hourFacts.length > 0 || file.facts.some((f) => f.schema?.type === "LocalBusiness");
  const org: Obj = { "@type": isLocal ? "LocalBusiness" : "Organization", "@id": `${siteUrl}#organization` };
  const orgPath = "@graph[0]";
  const nameFact = first(keys, "identity.name") ?? first(keys, "identity.legal_name");
  t.set(org, orgPath, "name", str(nameFact), nameFact?.id ?? "");
  const legal = first(keys, "identity.legal_name");
  if (legal) t.set(org, orgPath, "legalName", str(legal), legal.id);
  const urlFact = first(keys, "identity.url");
  if (urlFact) t.set(org, orgPath, "url", str(urlFact), urlFact.id);
  else t.set(org, orgPath, "url", siteUrl, "header:identity.domain");
  const logo = first(keys, "identity.logo");
  if (logo) t.set(org, orgPath, "logo", str(logo), logo.id);
  const sameAs = first(keys, "identity.same_as");
  if (sameAs && Array.isArray(sameAs.value)) t.set(org, orgPath, "sameAs", sameAs.value, sameAs.id);
  const founded = first(keys, "identity.founding_date");
  if (founded) t.set(org, orgPath, "foundingDate", str(founded), founded.id);
  if (file.header.identity.lei) t.set(org, orgPath, "leiCode", file.header.identity.lei, "header:identity.lei");
  const tel = first(keys, "contact.telephone");
  if (tel) t.set(org, orgPath, "telephone", str(tel), tel.id);
  const email = first(keys, "contact.email");
  if (email) t.set(org, orgPath, "email", str(email), email.id);

  // address: structured parts first, else the one-line form
  const addrParts: [string, string][] = [["contact.address.street_address", "streetAddress"], ["contact.address.locality", "addressLocality"], ["contact.address.region", "addressRegion"], ["contact.address.postal_code", "postalCode"], ["contact.address.country", "addressCountry"]];
  const address: Obj = { "@type": "PostalAddress" };
  let hasAddress = false;
  for (const [key, prop] of addrParts) {
    const f = first(keys, key);
    if (f) {
      t.set(address, `${orgPath}.address`, prop, str(f), f.id);
      t.pages(org).add(f.evidence.url);
      hasAddress = true;
    }
  }
  if (hasAddress) {
    org["address"] = address;
  } else {
    const line = first(keys, "contact.address");
    if (line) t.set(org, orgPath, "address", str(line), line.id);
  }

  // contact points
  const contactPoints: Obj[] = [];
  const cpKeys = [...keys.keys()].filter((k) => /^contact\.[a-z0-9_]+\.(telephone|email|contact_type)$/.test(k) || k === "contact.support_email");
  const cpGroups = new Map<string, Obj>();
  for (const k of cpKeys.sort()) {
    const f = first(keys, k)!;
    const group = k === "contact.support_email" ? "support" : k.split(".")[1]!;
    let cp = cpGroups.get(group);
    if (!cp) {
      cp = { "@type": "ContactPoint" };
      cpGroups.set(group, cp);
      contactPoints.push(cp);
    }
    const idx = contactPoints.indexOf(cp);
    const prop = k === "contact.support_email" ? "email" : k.endsWith(".telephone") ? "telephone" : k.endsWith(".email") ? "email" : "contactType";
    t.set(cp, `${orgPath}.contactPoint[${idx}]`, prop, str(f), f.id);
    t.pages(org).add(f.evidence.url);
  }
  if (contactPoints.length) org["contactPoint"] = contactPoints;

  // opening hours
  if (hourFacts.length) {
    const specs: Obj[] = [];
    const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    for (const day of dayOrder) {
      const f = first(keys, `hours.${day}`);
      if (!f || typeof f.value !== "string") continue;
      const [opens, closes] = f.value.split("-");
      if (!opens || !closes) continue;
      const spec: Obj = { "@type": "OpeningHoursSpecification" };
      const p = `${orgPath}.openingHoursSpecification[${specs.length}]`;
      t.set(spec, p, "dayOfWeek", day[0]!.toUpperCase() + day.slice(1), f.id);
      t.set(spec, p, "opens", opens, f.id);
      t.set(spec, p, "closes", closes, f.id);
      specs.push(spec);
      t.pages(org).add(f.evidence.url);
    }
    if (specs.length) org["openingHoursSpecification"] = specs;
  }
  if (home) t.pages(org).add(home.url);
  graph.push(org);

  // WebSite with the Trooth profile as sameAs
  const site: Obj = { "@type": "WebSite", "@id": `${siteUrl}#website` };
  const sitePath = `@graph[${graph.length}]`;
  t.set(site, sitePath, "url", siteUrl, "header:identity.domain");
  if (org["name"]) t.set(site, sitePath, "name", org["name"], t.trace[`${orgPath}.name`]!);
  const profile = opts.troothProfileUrl ?? file.header.profile;
  if (profile) t.set(site, sitePath, "sameAs", [profile], "header:profile");
  site["publisher"] = { "@id": org["@id"] };
  if (home) t.pages(site).add(home.url);
  graph.push(site);

  // Products and offers from the products tier
  file.products.forEach((p) => {
    if (!isProductLike(p)) return;
    const node: Obj = { "@type": "Product" };
    const path = `@graph[${graph.length}]`;
    const src = `product:${p.product_id}`;
    t.set(node, path, "name", p.name, src);
    t.set(node, path, "url", p.url, src);
    t.set(node, path, "sku", p.sku, src);
    t.set(node, path, "gtin", p.gtin, src);
    t.set(node, path, "description", p.description, src);
    if (p.brand) t.set(node, path, "brand", { "@type": "Brand", name: p.brand }, src);
    if (p.price && p.price.currency && p.price.amount !== undefined && p.price.amount !== "") {
      const offer: Obj = { "@type": "Offer" };
      t.set(offer, `${path}.offers`, "price", String(p.price.amount), src);
      t.set(offer, `${path}.offers`, "priceCurrency", p.price.currency, src);
      t.set(offer, `${path}.offers`, "url", p.url, src);
      if (p.availability) {
        const a = AVAILABILITY[p.availability.toLowerCase().replace(/^https?:\/\/schema\.org\//i, "").replace(/-/g, "_")] ?? (p.availability.startsWith("https://schema.org/") ? p.availability : null);
        if (a) t.set(offer, `${path}.offers`, "availability", a, src);
      }
      node["offers"] = offer;
    }
    t.pages(node).add(p.url);
    graph.push(node);
  });

  // FAQPage from question_map entries answered on the site with a fact behind the answer
  const faqByPage = new Map<string, { q: string; f: Fact }[]>();
  for (const entry of file.question_map) {
    if (!entry.answered_on_site || !entry.fact_ids?.length) continue;
    const f = facts.get(entry.fact_ids[0]!);
    if (!f) continue;
    const page = entry.passages[0]?.url ?? f.evidence.url;
    const list = faqByPage.get(page) ?? [];
    list.push({ q: entry.question, f });
    faqByPage.set(page, list);
  }
  for (const [page, items] of faqByPage) {
    const faq: Obj = { "@type": "FAQPage" };
    const path = `@graph[${graph.length}]`;
    const main: Obj[] = [];
    items.forEach(({ q, f }, i) => {
      const question: Obj = { "@type": "Question" };
      const qp = `${path}.mainEntity[${i}]`;
      t.set(question, qp, "name", q, f.id);
      const answer: Obj = { "@type": "Answer" };
      t.set(answer, `${qp}.acceptedAnswer`, "text", str(f) ?? f.statement, f.id);
      question["acceptedAnswer"] = answer;
      main.push(question);
    });
    faq["mainEntity"] = main;
    t.set(faq, path, "url", page, "page:" + (file.header.pages_manifest.find((p) => p.url === page)?.id ?? page));
    t.pages(faq).add(page);
    graph.push(faq);
  }

  // Articles: blog pages whose facts carry an article headline
  const headlineFacts = file.facts.filter((f) => /^article\..+\.headline$/.test(f.key));
  const articlePages = new Set<string>();
  for (const hf of headlineFacts) {
    if (articlePages.has(hf.evidence.url)) continue;
    articlePages.add(hf.evidence.url);
    const base = hf.key.replace(/\.headline$/, "");
    const node: Obj = { "@type": "Article" };
    const path = `@graph[${graph.length}]`;
    t.set(node, path, "headline", str(hf), hf.id);
    const pub = first(keys, `${base}.date_published`);
    if (pub) t.set(node, path, "datePublished", str(pub), pub.id);
    const mod = first(keys, `${base}.date_modified`);
    if (mod) t.set(node, path, "dateModified", str(mod), mod.id);
    const author = first(keys, `${base}.author`);
    if (author) t.set(node, path, "author", { "@type": "Person", name: str(author) }, author.id);
    const entry: PageEntry | undefined = file.header.pages_manifest.find((p) => p.url === hf.evidence.url);
    t.set(node, path, "mainEntityOfPage", hf.evidence.url, entry ? `page:${entry.id}` : hf.id);
    node["publisher"] = { "@id": org["@id"] };
    t.pages(node).add(hf.evidence.url);
    graph.push(node);
  }

  // Per page: the nodes whose sources sit on that page.
  const perPage: Record<string, Record<string, unknown>> = {};
  const perPageTrace: Record<string, Record<string, string>> = {};
  for (const page of file.header.pages_manifest) {
    const nodes = graph.filter((n) => t.pages(n).has(page.url));
    if (!nodes.length) continue;
    const g: Obj[] = [];
    const tr: Record<string, string> = {};
    nodes.forEach((n, i) => {
      const oldIdx = graph.indexOf(n);
      g.push(n);
      for (const [path, src] of Object.entries(t.trace)) {
        const prefix = `@graph[${oldIdx}]`;
        if (path.startsWith(prefix + ".")) tr[`@graph[${i}]${path.slice(prefix.length)}`] = src;
      }
    });
    perPage[page.url] = { "@context": "https://schema.org", "@graph": g };
    perPageTrace[page.url] = tr;
  }

  return { graph: { "@context": "https://schema.org", "@graph": graph }, perPage, trace: t.trace, perPageTrace };
}

/** The script tag for a page head. "</" is escaped so the JSON can never close the script early. */
export function jsonLdScriptTag(jsonld: unknown): string {
  const json = JSON.stringify(jsonld, null, 2).replace(/<\//g, "<\\/");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/** The link tag that tells a reader where the page's markdown lives. */
export function markdownLinkTag(markdownUrl: string): string {
  return `<link rel="alternate" type="text/markdown" href="${markdownUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
}

export function defaultMarkdownUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  if (u.pathname.endsWith("/")) u.pathname = `${u.pathname}index.md`;
  else if (!/\.md$/.test(u.pathname)) u.pathname = `${u.pathname}.md`;
  return u.href;
}

/** Both head tags for one page. */
export function headTagsFor(pageUrl: string, out: JsonLdOutput, opts: JsonLdOptions = {}): string {
  const block = out.perPage[pageUrl];
  const md = (opts.markdownUrlFor ?? defaultMarkdownUrl)(pageUrl);
  const parts = [markdownLinkTag(md)];
  if (block) parts.push(jsonLdScriptTag(block));
  return parts.join("\n");
}
