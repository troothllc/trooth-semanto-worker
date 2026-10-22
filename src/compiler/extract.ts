// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// HTML to markdown, word for word. The page's own words are kept; the site's
// shared chrome is not. Chrome is found two ways: by element role (the HTML
// Living Standard's implicit ARIA roles: nav is navigation, a header or
// footer outside article, aside, main, nav and section is banner or
// contentinfo; plus script, style, noscript, svg, forms, dialogs and cookie
// banners) and by repetition (a block that appears on more than 60 percent of
// the site's pages, over at least three pages, is chrome).
//
// The markdown follows GitHub Flavored Markdown (GFM spec 0.29): ATX headings,
// pipe tables, fenced code, and the common definition-list form. Output is
// byte deterministic: a fixed front matter block, LF line endings, blocks
// separated by one blank line, one trailing newline. The same input bytes
// give the same output bytes on every run and every machine, which is what
// lets a page hash be checked offline.
//
// The index signals Google reads (meta robots and X-Robots-Tag noindex and
// nosnippet, rel=canonical, hreflang; Google Search Central, "Robots meta tag,
// data-nosnippet, and X-Robots-Tag specifications") are returned beside the
// markdown so the manifest can carry them.

import { parseHtml, textOf, walk, hasAncestor, findFirst, type ElementNode, type HtmlNode } from "./html";
import { normalizePageUrl } from "./url";

export const PART_LIMIT_BYTES = 2_000_000;

export interface IndexSignals {
  noindex: boolean;
  nosnippet: boolean;
  canonical: string | null;
  hreflang: { lang: string; url: string }[];
  robots_blocked: boolean;
}

export interface ExtractInput {
  html: string;
  url: string;
  witnessed_at: string;
  source_hash: string;
  /** Response headers, lower-cased, for X-Robots-Tag. */
  headers?: Record<string, string>;
  robotsBlocked?: boolean;
  /** Block keys found to be chrome by repetition (from detectChrome). */
  chrome?: ReadonlySet<string>;
  /** The same as chrome, as blockKey hashes (detectChrome over pageBlockKeys), so a build need not keep every page's text. */
  chromeKeys?: ReadonlySet<string>;
  partLimitBytes?: number;
}

export interface ExtractResult {
  title: string;
  lang: string | null;
  signals: IndexSignals;
  /** The body markdown without front matter, before splitting. */
  body: string;
  /** Complete markdown documents, front matter included; one unless the body was split. */
  parts: string[];
  /** Block keys, for repetition-based chrome detection across pages. */
  blocks: string[];
}

// ---------------------------------------------------------------- skipping

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "math", "iframe", "canvas", "object", "embed", "form", "input", "button",
  "select", "textarea", "label", "option", "optgroup", "datalist", "dialog", "nav", "link", "meta", "head", "title", "map", "area",
  "video", "audio", "source", "track", "base", "menu",
]);
const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "dialog", "alertdialog", "search", "menu", "menubar", "toolbar", "tooltip", "form"]);
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);
const COOKIE_RE = /(cookie|consent|gdpr|ccpa)[-_ ]?(banner|bar|notice|popup|modal|dialog|wall|box|overlay)|cookie[-_ ]?consent|cookieconsent|cc[-_]banner|cookiebanner|cookie[-_ ]?notice|onetrust|cookie-law/i;

function isSkipped(el: ElementNode): boolean {
  if (SKIP_TAGS.has(el.tag)) return true;
  if ((el.tag === "header" || el.tag === "footer") && !hasAncestor(el, SECTIONING)) return true;
  const role = (el.attrs["role"] ?? "").toLowerCase().trim();
  if (role && SKIP_ROLES.has(role)) return true;
  if ("hidden" in el.attrs) return true;
  if ((el.attrs["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = el.attrs["style"] ?? "";
  if (/display\s*:\s*none/i.test(style)) return true;
  const idc = `${el.attrs["id"] ?? ""} ${el.attrs["class"] ?? ""}`;
  if (idc.trim() && COOKIE_RE.test(idc)) return true;
  return false;
}

// ---------------------------------------------------------------- rendering

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "legend", "li", "main", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "#document",
]);

const BR = "\u0000";
/** A space the renderer added around an inline mark; it is dropped next to real whitespace, punctuation or a bracket. */
const PAD = "\u0001";

function collapse(s: string): string {
  const spaced = s.replace(/[\s\u00a0]+/g, " ");
  const padded = spaced.replace(/ ?\u0001+ ?/g, (m, offset: number) => {
    const before = offset > 0 ? spaced[offset - 1] : "";
    const after = spaced[offset + m.length] ?? "";
    if (m.startsWith(" ") || m.endsWith(" ")) return " ";
    if (before === "" || after === "" || before === "(" || before === "[" || before === BR || after === BR) return "";
    if (/[.,;:!?)\]]/.test(after)) return "";
    return " ";
  });
  return padded
    .replace(new RegExp(` ?${BR} ?`, "g"), "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

class Renderer {
  constructor(private readonly base: string) {}

  abs(href: string): string | null {
    try {
      const u = new URL(href.trim(), this.base);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      u.protocol = "https:";
      return u.href;
    } catch {
      return null;
    }
  }

  inlineChildren(el: ElementNode): string {
    let s = "";
    for (const c of el.children) s += this.inlineNode(c);
    return s;
  }

  inlineNode(node: HtmlNode): string {
    if (node.type === "text") return node.text.replace(/\s+/g, " ");
    const el = node;
    if (isSkipped(el)) return "";
    switch (el.tag) {
      case "br":
        return BR;
      case "wbr":
        return "";
      case "img": {
        const alt = (el.attrs["alt"] ?? "").replace(/\s+/g, " ").trim();
        const src = el.attrs["src"] ? this.abs(el.attrs["src"]) : null;
        if (!src) return alt ? `${PAD}${alt}${PAD}` : "";
        return `${PAD}![${alt.replace(/[[\]]/g, "")}](${src})${PAD}`;
      }
      case "a": {
        const inner = collapse(this.inlineChildren(el));
        if (!inner) return "";
        const href = el.attrs["href"] ? this.abs(el.attrs["href"]) : null;
        if (!href) return `${PAD}${inner}${PAD}`;
        return `${PAD}[${inner.replace(/\n/g, " ")}](${href})${PAD}`;
      }
      case "strong":
      case "b": {
        const inner = collapse(this.inlineChildren(el));
        return inner ? `${PAD}**${inner}**${PAD}` : "";
      }
      case "em":
      case "i":
      case "cite":
      case "dfn":
      case "var": {
        const inner = collapse(this.inlineChildren(el));
        return inner ? `${PAD}*${inner}*${PAD}` : "";
      }
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        const inner = textOf(el).replace(/\s+/g, " ").trim();
        if (!inner) return "";
        const fence = inner.includes("`") ? "``" : "`";
        return `${PAD}${fence}${inner}${fence}${PAD}`;
      }
      case "del":
      case "s":
      case "strike": {
        const inner = collapse(this.inlineChildren(el));
        return inner ? `${PAD}~~${inner}~~${PAD}` : "";
      }
      case "q": {
        const inner = collapse(this.inlineChildren(el));
        return inner ? `${PAD}"${inner}"${PAD}` : "";
      }
      default:
        if (BLOCK_TAGS.has(el.tag)) return `${PAD}${this.blocks(el).join("\n")}${PAD}`;
        return this.inlineChildren(el);
    }
  }

  /** Render a container's children to a list of markdown blocks. */
  blocks(container: ElementNode): string[] {
    const out: string[] = [];
    let buf = "";
    const flush = () => {
      const t = collapse(buf);
      if (t) out.push(t);
      buf = "";
    };
    for (const child of container.children) {
      if (child.type === "text") {
        buf += child.text.replace(/\s+/g, " ");
        continue;
      }
      if (isSkipped(child)) continue;
      if (!BLOCK_TAGS.has(child.tag)) {
        buf += this.inlineNode(child);
        continue;
      }
      flush();
      out.push(...this.block(child));
    }
    flush();
    return out;
  }

  block(el: ElementNode): string[] {
    switch (el.tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const text = collapse(this.inlineChildren(el)).replace(/\n/g, " ");
        return text ? [`${"#".repeat(Number(el.tag[1]))} ${text}`] : [];
      }
      case "hr":
        return ["---"];
      case "ul":
      case "ol": {
        const lines = this.list(el);
        return lines.length ? [lines.join("\n")] : [];
      }
      case "table":
        return this.table(el);
      case "blockquote": {
        const inner = this.blocks(el);
        if (!inner.length) return [];
        return [inner.join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")];
      }
      case "pre": {
        const code = findFirst(el, "code");
        const lang = code ? (/(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(code.attrs["class"] ?? "")?.[1] ?? "") : "";
        let raw = textOf(el).replace(/\r\n?/g, "\n");
        if (raw.startsWith("\n")) raw = raw.slice(1);
        raw = raw.replace(/\s+$/, "");
        if (!raw.trim()) return [];
        const fence = raw.includes("```") ? "````" : "```";
        return [`${fence}${lang}\n${raw}\n${fence}`];
      }
      case "dl":
        return this.definitionList(el);
      default:
        return this.blocks(el);
    }
  }

  list(el: ElementNode, depth = 0): string[] {
    const ordered = el.tag === "ol";
    const start = ordered ? Number.parseInt(el.attrs["start"] ?? "1", 10) || 1 : 1;
    const lines: string[] = [];
    let n = start;
    for (const child of el.children) {
      if (child.type !== "element" || isSkipped(child)) continue;
      if (child.tag !== "li") {
        // A list nested directly in a list, or a wrapper: render in place.
        if (child.tag === "ul" || child.tag === "ol") lines.push(...this.list(child, depth + 1).map((l) => `  ${l}`));
        else for (const b of this.block(child)) lines.push(...b.split("\n"));
        continue;
      }
      const marker = ordered ? `${n}.` : "-";
      n++;
      const inner = this.blocks(child);
      if (!inner.length) continue;
      const pad = " ".repeat(marker.length + 1);
      const first = inner[0]!.split("\n");
      lines.push(`${marker} ${first[0]}`);
      for (const l of first.slice(1)) lines.push(`${pad}${l}`);
      for (const b of inner.slice(1)) for (const l of b.split("\n")) lines.push(`${pad}${l}`);
    }
    return lines;
  }

  table(el: ElementNode): string[] {
    const rows: { cells: string[]; header: boolean }[] = [];
    let caption = "";
    const visit = (node: ElementNode, inHead: boolean) => {
      for (const c of node.children) {
        if (c.type !== "element" || isSkipped(c)) continue;
        if (c.tag === "caption") caption = collapse(this.inlineChildren(c)).replace(/\n/g, " ");
        else if (c.tag === "thead") visit(c, true);
        else if (c.tag === "tbody" || c.tag === "tfoot") visit(c, inHead);
        else if (c.tag === "tr") {
          const cells: string[] = [];
          let allTh = true;
          for (const cell of c.children) {
            if (cell.type !== "element" || isSkipped(cell) || (cell.tag !== "td" && cell.tag !== "th")) continue;
            if (cell.tag !== "th") allTh = false;
            const text = collapse(this.blocks(cell).join(" ")).replace(/\n/g, " ").replace(/\|/g, "\\|");
            cells.push(text);
            const span = Number.parseInt(cell.attrs["colspan"] ?? "1", 10) || 1;
            for (let i = 1; i < span; i++) cells.push("");
          }
          if (cells.length) rows.push({ cells, header: inHead || (allTh && cells.length > 0) });
        } else if (c.tag === "table") {
          // A nested table is flattened into this one's rows.
          visit(c, false);
        }
      }
    };
    visit(el, false);
    if (!rows.length) return caption ? [caption] : [];
    const width = Math.max(...rows.map((r) => r.cells.length));
    const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill("")];
    const line = (cells: string[]) => `| ${pad(cells).join(" | ")} |`;
    const out: string[] = [];
    let body = rows;
    let head: string[];
    if (rows[0]!.header) {
      head = rows[0]!.cells;
      body = rows.slice(1);
    } else head = Array<string>(width).fill("");
    out.push(line(head));
    out.push(`| ${Array<string>(width).fill("---").join(" | ")} |`);
    for (const r of body) out.push(line(r.cells));
    const table = out.join("\n");
    return caption ? [caption, table] : [table];
  }

  definitionList(el: ElementNode): string[] {
    const out: string[] = [];
    let group: string[] = [];
    const flush = () => {
      if (group.length) out.push(group.join("\n"));
      group = [];
    };
    for (const c of el.children) {
      if (c.type !== "element" || isSkipped(c)) continue;
      if (c.tag === "dt") {
        if (group.some((l) => l.startsWith(": "))) flush();
        const t = collapse(this.inlineChildren(c)).replace(/\n/g, " ");
        if (t) group.push(t);
      } else if (c.tag === "dd") {
        const blocks = this.blocks(c);
        if (blocks.length) group.push(`: ${blocks.join("\n\n").replace(/\n/g, "\n  ")}`);
      } else if (c.tag === "div") {
        // dl > div > dt + dd is valid HTML.
        out.push(...this.definitionList(c));
      }
    }
    flush();
    return out;
  }
}

// ---------------------------------------------------------------- metadata

function metaRobots(root: ElementNode, headers: Record<string, string> | undefined): { noindex: boolean; nosnippet: boolean } {
  const tokens: string[] = [];
  walk(root, (el) => {
    if (el.tag !== "meta") return;
    const name = (el.attrs["name"] ?? "").toLowerCase();
    if (name === "robots" || name === "googlebot" || name === "googlebot-news") {
      for (const t of (el.attrs["content"] ?? "").toLowerCase().split(/[,\s]+/)) if (t) tokens.push(t);
    }
  });
  const xrt = headers?.["x-robots-tag"];
  if (xrt) {
    for (const part of xrt.split(",")) {
      const t = part.trim().toLowerCase().replace(/^[a-z0-9_-]+\s*:\s*/, "");
      if (t) tokens.push(t);
    }
  }
  return { noindex: tokens.includes("noindex") || tokens.includes("none"), nosnippet: tokens.includes("nosnippet") };
}

function links(root: ElementNode, url: string): { canonical: string | null; hreflang: { lang: string; url: string }[] } {
  let canonical: string | null = null;
  const hreflang: { lang: string; url: string }[] = [];
  walk(root, (el) => {
    if (el.tag !== "link") return;
    const rel = (el.attrs["rel"] ?? "").toLowerCase();
    const href = el.attrs["href"];
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, url).href;
    } catch {
      return;
    }
    if (/(^|\s)canonical(\s|$)/.test(rel) && canonical === null) canonical = abs;
    if (/(^|\s)alternate(\s|$)/.test(rel) && el.attrs["hreflang"]) hreflang.push({ lang: el.attrs["hreflang"], url: abs });
  });
  return { canonical, hreflang };
}

export function pageTitle(root: ElementNode, url: string): string {
  const t = findFirst(root, "title");
  const titleText = t ? collapse(textOf(t)).replace(/\n/g, " ") : "";
  if (titleText) return titleText;
  const h1 = findFirst(root, "h1");
  const h1Text = h1 ? collapse(textOf(h1)).replace(/\n/g, " ") : "";
  return h1Text || url;
}

// ---------------------------------------------------------------- front matter

export interface FrontMatter {
  title: string;
  url: string;
  lang: string | null;
  witnessed_at: string;
  source_hash: string;
  part?: { n: number; of: number };
}

export function frontMatter(fm: FrontMatter): string {
  const lines = ["---", `title: ${JSON.stringify(fm.title)}`, `url: ${fm.url}`, `lang: ${fm.lang ? fm.lang : '""'}`, `witnessed_at: ${fm.witnessed_at}`, `source_hash: ${fm.source_hash}`];
  if (fm.part) lines.push(`part: ${fm.part.n} of ${fm.part.of}`);
  lines.push("---");
  return lines.join("\n");
}

export function parseFrontMatter(markdown: string): { fields: Record<string, string>; body: string } | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        // keep as written
      }
    }
    fields[k] = v;
  }
  return { fields, body: markdown.slice(end + 5).replace(/^\n/, "") };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Split body blocks into parts under the limit. Blocks are grouped into
 * sections (a heading and what follows it); sections are packed whole, so a
 * part always begins at a heading except the first. A section that is on its
 * own above the limit is split at block boundaries, since a block is the
 * smallest unit that still reads as the page.
 */
export function splitBlocks(blocks: string[], limit: number): string[][] {
  const size = (list: string[]) => list.reduce((a, b) => a + utf8Length(b) + 2, 0);
  if (size(blocks) <= limit) return [blocks];
  const sections: string[][] = [];
  for (const b of blocks) {
    if (/^#{1,6} /.test(b) || sections.length === 0) sections.push([b]);
    else sections[sections.length - 1]!.push(b);
  }
  const parts: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) parts.push(current);
    current = [];
  };
  for (const section of sections) {
    if (current.length && size(current) + size(section) > limit) flush();
    if (size(section) <= limit) {
      current.push(...section);
      continue;
    }
    for (const b of section) {
      if (current.length && size(current) + utf8Length(b) + 2 > limit) flush();
      current.push(b);
    }
  }
  flush();
  return parts;
}

// ---------------------------------------------------------------- the entry points

function bodyOf(root: ElementNode): ElementNode {
  return findFirst(root, "body") ?? root;
}

/** The block keys of a page before chrome removal, for the repetition pass. */
export function pageBlocks(html: string, url: string): string[] {
  const root = parseHtml(html);
  return new Renderer(url).blocks(bodyOf(root));
}

/**
 * A short, stable key for one block: its length and a 53-bit hash (cyrb53,
 * two 32-bit multiply-xor lanes). A build keeps these keys per page instead of
 * the page text, so chrome detection over 500 pages needs a few kilobytes.
 */
export function blockKey(b: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < b.length; i++) {
    const ch = b.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${b.length.toString(36)}.${n.toString(36)}`;
}

/** The block keys of a page, for chrome detection without keeping the page. */
export function pageBlockKeys(html: string, url: string): string[] {
  return pageBlocks(html, url).map(blockKey);
}

/**
 * Blocks present on more than `threshold` of the pages are chrome. Fewer than
 * `minPages` pages give no repetition signal at all, so nothing is removed.
 */
export function detectChrome(pages: string[][], threshold = 0.6, minPages = 3): Set<string> {
  const chrome = new Set<string>();
  if (pages.length < minPages) return chrome;
  const counts = new Map<string, number>();
  for (const blocks of pages) for (const b of new Set(blocks)) counts.set(b, (counts.get(b) ?? 0) + 1);
  for (const [b, c] of counts) if (c / pages.length > threshold) chrome.add(b);
  return chrome;
}

export function extract(input: ExtractInput): ExtractResult {
  const root = parseHtml(input.html);
  const htmlEl = findFirst(root, "html");
  const lang = (htmlEl?.attrs["lang"] ?? "").trim() || null;
  const title = pageTitle(root, input.url);
  const robots = metaRobots(root, input.headers);
  const { canonical, hreflang } = links(root, input.url);
  const signals: IndexSignals = { ...robots, canonical, hreflang, robots_blocked: Boolean(input.robotsBlocked) };

  const allBlocks = new Renderer(input.url).blocks(bodyOf(root));
  const kept = allBlocks.filter((b) => !(input.chrome && input.chrome.has(b)) && !(input.chromeKeys && input.chromeKeys.has(blockKey(b))));
  const body = kept.join("\n\n");

  const limit = input.partLimitBytes ?? PART_LIMIT_BYTES;
  const fm = { title, url: normalizePageUrl(input.url) ?? input.url, lang, witnessed_at: input.witnessed_at, source_hash: input.source_hash };
  const groups = splitBlocks(kept, limit);
  const parts = groups.map((g, i) => {
    const head = frontMatter(groups.length > 1 ? { ...fm, part: { n: i + 1, of: groups.length } } : fm);
    const text = g.join("\n\n");
    return text ? `${head}\n\n${text}\n` : `${head}\n`;
  });
  return { title, lang, signals, body, parts, blocks: allBlocks };
}

/** Plain sentences of a markdown body, for anchors: links and marks unwrapped, one sentence per entry. */
export function sentencesOf(body: string): string[] {
  const out: string[] = [];
  const plainLines = body
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^#{1,6} /, "")
        .replace(/^>\s?/, "")
        .replace(/^(\s*)(?:[-*]|\d+\.) /, "$1")
        .replace(/^: /, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\|\s*(?:---\s*\|\s*)+$/, "")
        .replace(/^\|(.*)\|$/, (_m, inner: string) => inner.split(/\s(?<!\\)\|\s/).map((c) => c.replace(/\\\|/g, "|").trim()).join(" | "))
        .trim(),
    )
    .filter(Boolean);
  for (const line of plainLines) {
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}
