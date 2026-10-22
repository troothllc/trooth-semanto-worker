// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// llms.txt, llms-full.txt and sitemap.md, in the llmstxt.org shape (Jeremy
// Howard's proposal, September 2024): an H1 with the site name, a blockquote
// summary, H2 sections of markdown links each with a one-line description.
// A Trooth section points at the signed file and the Network copy.
//
// Google has said publicly that Google Search does not use llms.txt (Google
// Search Central staff, 2025). These files are for the other readers that
// do: agents and tools that fetch a plain index before they fetch pages. The
// signed Semanto file, the per-page markdown and the JSON-LD write-back are
// what Google-facing surfaces read; nothing here replaces them.

import type { PageEntry } from "../core/semanto";
import { parseFrontMatter } from "./extract";
import { pathOf } from "./url";

export interface LlmsPage {
  entry: PageEntry;
  /** One line about the page: the first paragraph of its body, cut to a sentence. */
  description: string;
}

export interface LlmsInput {
  siteName: string;
  domain: string;
  /** One or two plain sentences about the site. Taken from the homepage when not given. */
  summary: string;
  pages: LlmsPage[];
  troothId: string;
  /** The Network copy, for example https://trooth.co/network/company/acme. */
  networkUrl: string;
  /** Where the signed file is served on the company's domain. Default /.well-known/trooth.semanto. */
  semantoUrl?: string;
  /** Where the Trooth-hosted copy of the file is served. */
  publicSemantoUrl?: string;
}

const SECTION_TITLES: Record<string, string> = {
  "": "Main pages", about: "About", blog: "Blog", docs: "Docs", help: "Help", support: "Support", pricing: "Pricing", products: "Products", product: "Products",
  security: "Security", privacy: "Privacy", legal: "Legal", terms: "Legal", careers: "Careers", contact: "Contact", news: "News", press: "Press", faq: "FAQ",
};

function sectionOf(url: string): string {
  const segs = pathOf(url).split("/").filter(Boolean);
  if (segs.length <= 1) return "";
  return segs[0]!.toLowerCase();
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function sanitizeLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

/** The first sentence of the first paragraph, for a one-line description. Empty when the page has no prose. */
export function describePage(markdown: string): string {
  const parsed = parseFrontMatter(markdown);
  const body = parsed ? parsed.body : markdown;
  for (const block of body.split("\n\n")) {
    const b = block.trim();
    if (!b || /^#{1,6} /.test(b) || /^[-*] |^\d+\. |^\||^```|^>|^!\[/.test(b)) continue;
    const plain = b.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\n/g, " ");
    const sentence = plain.split(/(?<=[.!?])\s+/)[0] ?? plain;
    const out = sentence.trim();
    if (out.length > 200) return `${out.slice(0, 197).replace(/\s+\S*$/, "")}.`;
    return out;
  }
  return "";
}

export function buildLlmsTxt(input: LlmsInput): string {
  const lines: string[] = [];
  lines.push(`# ${sanitizeLine(input.siteName)}`);
  lines.push("");
  lines.push(`> ${sanitizeLine(input.summary) || `The public website of ${sanitizeLine(input.siteName)}, every page word for word.`}`);
  lines.push("");
  lines.push("This file lists the pages of this site for readers that fetch a plain index first. Each page is also served as markdown at its own url with Accept: text/markdown.");
  lines.push("");
  const sections = new Map<string, LlmsPage[]>();
  for (const p of input.pages) {
    if (p.entry.part && p.entry.part.n !== 1) continue;
    const s = sectionOf(p.entry.url);
    const list = sections.get(s) ?? [];
    list.push(p);
    sections.set(s, list);
  }
  const ordered = [...sections.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const s of ordered) {
    const title = SECTION_TITLES[s] ?? titleCase(s);
    lines.push(`## ${title}`);
    lines.push("");
    for (const p of sections.get(s)!) {
      const desc = sanitizeLine(p.description);
      lines.push(`- [${sanitizeLine(p.entry.title) || p.entry.url}](${p.entry.url})${desc ? `: ${desc}` : ""}`);
    }
    lines.push("");
  }
  const semantoUrl = input.semantoUrl ?? `https://${input.domain}/.well-known/trooth.semanto`;
  lines.push("## Trooth");
  lines.push("");
  lines.push(`- [Signed Semanto file](${semantoUrl}): this whole site in one file, signed by the company and witnessed by Trooth; anyone can check it offline`);
  lines.push(`- [Network record](${input.networkUrl}): the public copy on the Trooth Network, with each fact labeled by who said it and when`);
  if (input.publicSemantoUrl) lines.push(`- [Trooth-hosted copy](${input.publicSemantoUrl}): the same bytes served by Trooth`);
  lines.push(`- [llms-full.txt](https://${input.domain}/llms-full.txt): every page's markdown in one file`);
  lines.push(`- [sitemap.md](https://${input.domain}/sitemap.md): the page list as a markdown outline`);
  lines.push("");
  return lines.join("\n");
}

export interface FullPage {
  entry: PageEntry;
  markdown: string;
}

/** Every page in manifest order, separated so a reader can find page boundaries. */
export function buildLlmsFull(siteName: string, pages: FullPage[]): string {
  const parts: string[] = [`# ${sanitizeLine(siteName)}: every page`, ""];
  for (const p of pages) {
    parts.push(`<!-- page: ${p.entry.url}${p.entry.part ? ` part ${p.entry.part.n} of ${p.entry.part.of}` : ""} id: ${p.entry.id} -->`);
    parts.push("");
    parts.push(p.markdown.replace(/\n+$/, ""));
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

interface TreeNode {
  name: string;
  page?: PageEntry;
  children: Map<string, TreeNode>;
}

/** Titled links as a hierarchy by path, two spaces per level. */
export function buildSitemapMd(siteName: string, pages: PageEntry[]): string {
  const root: TreeNode = { name: "", children: new Map() };
  for (const p of pages) {
    if (p.part && p.part.n !== 1) continue;
    const segs = pathOf(p.url).split("/").filter(Boolean);
    let node = root;
    for (const s of segs) {
      let child = node.children.get(s);
      if (!child) {
        child = { name: s, children: new Map() };
        node.children.set(s, child);
      }
      node = child;
    }
    if (!node.page) node.page = p;
  }
  const lines: string[] = [`# ${sanitizeLine(siteName)}: sitemap`, ""];
  const emit = (node: TreeNode, depth: number) => {
    const keys = [...node.children.keys()].sort();
    for (const k of keys) {
      const c = node.children.get(k)!;
      const label = c.page ? `[${sanitizeLine(c.page.title) || c.page.url}](${c.page.url})` : titleCase(c.name);
      lines.push(`${"  ".repeat(depth)}- ${label}`);
      emit(c, depth + 1);
    }
  };
  if (root.page) lines.push(`- [${sanitizeLine(root.page.title) || root.page.url}](${root.page.url})`);
  emit(root, root.page ? 1 : 0);
  lines.push("");
  return lines.join("\n");
}
