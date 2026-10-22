// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The representations the server derives from a signed version without a
// compiler: a page's JSON-LD (schema.org WebPage carrying the page's full text
// and the facts witnessed on it), the /.well-known/trooth.semanto pointer
// document, and the plain text of a markdown page. Every representation of a
// page carries the same words: the markdown bytes, the JSON-LD `text` and the
// HTML the page was read from say the same sentences (house rule 3).

import { versionId, type Fact, type PageEntry, type SemantoFile } from "../core/semanto";
import type { CompanyRecord, ServeConfig } from "./ports";

/** Plain text of a markdown document: headings, emphasis, links and list marks removed; the words kept. */
export function markdownToText(md: string): string {
  let s = md;
  // Front matter.
  s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  // Fenced code: keep the content.
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1");
  // Images: keep alt text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: keep the text.
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Headings, blockquotes, list markers.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
  // Tables: cell bars.
  s = s.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "");
  s = s.replace(/\|/g, " ");
  // Emphasis and code marks.
  s = s.replace(/(\*\*|__|\*|_|`)/g, "");
  return s.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

/** Plain text of an HTML document: scripts, styles, nav, header, footer and aside dropped; block boundaries become newlines. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|td|th)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Split text into sentences for the same-content test. Short fragments (chrome, labels) are left out. */
export function sentences(text: string, minWords = 4): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.split(" ").length >= minWords);
}

function valueToJson(v: Fact["value"]): unknown {
  return v === undefined ? null : v;
}

/** The JSON-LD of one page. The `text` is the page's full text, so the JSON-LD says what the markdown says. */
export function pageJsonLd(file: SemantoFile, entry: PageEntry, markdown: string, config: ServeConfig): Record<string, unknown> {
  const facts = file.facts.filter((f) => f.evidence.url === entry.url);
  const vid = versionId(file.root_hash);
  return {
    "@context": ["https://schema.org", { trooth: "https://trooth.co/vocab/" }],
    "@type": "WebPage",
    "@id": entry.url,
    url: entry.url,
    name: entry.title,
    ...(entry.lang ? { inLanguage: entry.lang } : {}),
    text: markdownToText(markdown),
    dateCreated: entry.witnessed_at,
    isPartOf: { "@type": "WebSite", url: `https://${file.header.identity.domain}/`, name: file.header.org },
    "trooth:semantoVersion": vid,
    "trooth:pageHash": entry.hash,
    "trooth:pageId": entry.id,
    "trooth:proof": `${config.public_api_base}/${file.header.trooth_id}/pages/${entry.id}/proof`,
    "trooth:facts": facts.map((f) => ({
      "@type": "trooth:Fact",
      "@id": `${config.public_api_base}/${file.header.trooth_id}/facts.jsonld#${f.id}`,
      "trooth:key": f.key,
      description: f.statement,
      value: valueToJson(f.value),
      "trooth:provenance": f.provenance,
      "trooth:witnessedAt": f.evidence.witnessed_at,
      ...(f.evidence.anchor ? { "trooth:anchor": f.evidence.anchor } : {}),
      ...(f.schema ? { "trooth:schema": `${f.schema.type}.${f.schema.property}` } : {}),
    })),
  };
}

/** The facts tier as JSON-LD when the compiler did not store a copy. */
export function factsJsonLd(file: SemantoFile, config: ServeConfig): Record<string, unknown> {
  return {
    "@context": ["https://schema.org", { trooth: "https://trooth.co/vocab/" }],
    "@type": "Organization",
    "@id": `https://${file.header.identity.domain}/#organization`,
    name: file.header.org,
    url: `https://${file.header.identity.domain}/`,
    ...(file.header.identity.legal_name ? { legalName: file.header.identity.legal_name } : {}),
    ...(file.header.identity.lei ? { leiCode: file.header.identity.lei } : {}),
    "trooth:semantoVersion": versionId(file.root_hash),
    "trooth:factsRoot": file.header.facts_root,
    "trooth:facts": file.facts.map((f) => ({
      "@type": "trooth:Fact",
      "@id": `${config.public_api_base}/${file.header.trooth_id}/facts.jsonld#${f.id}`,
      "trooth:key": f.key,
      description: f.statement,
      value: valueToJson(f.value),
      "trooth:provenance": f.provenance,
      "trooth:evidence": { url: f.evidence.url, "trooth:witnessedAt": f.evidence.witnessed_at, ...(f.evidence.anchor ? { "trooth:anchor": f.evidence.anchor } : {}), ...(f.evidence.source ? { "trooth:source": f.evidence.source } : {}) },
    })),
  };
}

/** The /.well-known/trooth.semanto pointer: where the signed file, the keys, the proofs and the log are. */
export function wellKnownSemanto(company: CompanyRecord, file: SemantoFile | null, config: ServeConfig): Record<string, unknown> {
  const base = `${config.public_api_base}/${company.trooth_id}`;
  return {
    object: "trooth.semanto",
    contract: 1,
    trooth_id: company.trooth_id,
    domain: company.domain,
    org: company.org,
    state: file ? file.header.state : "none",
    version: file ? file.header.version : null,
    version_id: file ? versionId(file.root_hash) : null,
    root_hash: file ? file.root_hash : null,
    semanto: base,
    versions: `${base}/versions`,
    facts: `${base}/facts.jsonld`,
    llms: `${base}/llms.txt`,
    llms_full: `${base}/llms-full.txt`,
    sitemap: `${base}/sitemap.md`,
    keys: `${base}/keys`,
    verify: `${config.public_api_base}/verify`,
    ledger: config.ledger_url,
    trust_profile: `${config.network_base}/${company.trooth_id}`,
  };
}

/** A fallback llms.txt, llms-full.txt or sitemap.md built from the manifest when the compiler stored none. */
export function manifestMarkdown(file: SemantoFile, kind: "llms" | "sitemap", pages: Map<string, string>): string {
  const h = file.header;
  const what = h.state === "signed" && file.signature ? "Signed Semanto file" : file.witness ? "Semanto file witnessed by Trooth and not signed by the company" : "Semanto file, not signed yet";
  const lines: string[] = [`# ${h.org}`, "", `> ${what} for ${h.identity.domain}, version ${h.version}.`, ""];
  if (kind === "sitemap") {
    lines.push("## Pages", "");
    for (const p of h.pages_manifest) lines.push(`- [${p.title}](${p.url}) ${p.hash}`);
    return lines.join("\n") + "\n";
  }
  lines.push("## Pages", "");
  for (const p of h.pages_manifest) lines.push(`- [${p.title}](${p.url})`);
  lines.push("");
  for (const p of h.pages_manifest) {
    const md = pages.get(p.id);
    if (md === undefined) continue;
    lines.push(`---`, "", `<!-- ${p.url} ${p.hash} -->`, "", md.trimEnd(), "");
  }
  return lines.join("\n") + "\n";
}
