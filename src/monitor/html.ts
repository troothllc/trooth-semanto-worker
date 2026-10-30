// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A small HTML reader for the live page surface, with no dependency: the
// JSON-LD blocks (W3C JSON-LD 1.1, schema.org embedding guidance), microdata
// (WHATWG HTML Living Standard, section 5.2) as items with properties, the
// title, the robots meta and canonical link Google documents under "Robots
// meta tag, data-nosnippet, and X-Robots-Tag" and "Consolidate duplicate URLs",
// and the visible text. It is a tolerant scanner, not a browser: good enough
// to find the facts a page states, never used to render anything.

import type { MicrodataItem } from "./types";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (ENTITIES[e] !== undefined) return ENTITIES[e] as string;
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return whole;
  });
}

export function attrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (!name) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Every <script type="application/ld+json"> block, parsed; blocks that do not parse are skipped and counted. */
export function jsonLdBlocks(html: string): { blocks: unknown[]; unparsable: number } {
  const blocks: unknown[] = [];
  let unparsable = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const a = attrs(m[1] ?? "");
    if ((a.type ?? "").toLowerCase().replace(/\s/g, "") !== "application/ld+json") continue;
    const body = (m[2] ?? "").replace(/^\s*<!--/, "").replace(/-->\s*$/, "").replace(/^\s*\/\/<!\[CDATA\[/, "").replace(/\/\/\]\]>\s*$/, "").trim();
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      unparsable += 1;
    }
  }
  return { blocks, unparsable };
}

/** Flatten JSON-LD into its nodes: top-level arrays, @graph members, and the nodes themselves. */
export function jsonLdNodes(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o["@graph"])) {
        for (const x of o["@graph"] as unknown[]) visit(x);
      }
      if (o["@type"] !== undefined) out.push(o);
    }
  };
  for (const b of blocks) visit(b);
  return out;
}

export function jsonLdIds(blocks: unknown[]): string[] {
  const ids: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["@id"] === "string") ids.push(o["@id"]);
      for (const k of Object.keys(o)) visit(o[k]);
    }
  };
  for (const b of blocks) visit(b);
  return ids;
}

export function title(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1] ?? "").replace(/\s+/g, " ").trim() : null;
}

export function metaRobots(html: string): string[] {
  const out: string[] = [];
  const re = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const a = attrs(m[1] ?? "");
    const name = (a.name ?? "").toLowerCase();
    if (name === "robots" || name === "googlebot") {
      for (const d of (a.content ?? "").split(",")) {
        const t = d.trim().toLowerCase();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

export function canonical(html: string): string | null {
  const re = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const a = attrs(m[1] ?? "");
    if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && a.href) return a.href.trim();
  }
  return null;
}

/** True for an element people cannot see: the hidden attribute, aria-hidden="true", or display:none or visibility:hidden inline. */
function hiddenByAttrs(raw: string): boolean {
  const a = attrs(raw);
  if ("hidden" in a) return true;
  if ((a["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = (a.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** The HTML with every hidden element and its contents removed (nested elements of the same name are counted). */
export function withoutHidden(html: string): string {
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let out = "";
  let last = 0;
  let hiddenTag: string | null = null;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const selfClosing = /\/\s*$/.test(m[3] ?? "") || VOID.has(tag);
    if (hiddenTag === null) {
      if (!closing && !selfClosing && hiddenByAttrs(m[3] ?? "")) {
        out += html.slice(last, m.index);
        hiddenTag = tag;
        depth = 1;
      }
      continue;
    }
    if (tag !== hiddenTag || selfClosing) continue;
    depth += closing ? -1 : 1;
    if (depth === 0) {
      hiddenTag = null;
      last = m.index + m[0].length;
    }
  }
  return hiddenTag === null ? out + html.slice(last) : out;
}

export function visibleText(html: string): string {
  const noScripts = withoutHidden(html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " "));
  return decodeEntities(noScripts.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// -------------------------------------------------------------- microdata

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface Open {
  tag: string;
  item: MicrodataItem | null;
  prop: { names: string[]; target: MicrodataItem | null; text: string[] } | null;
}

function valueAttr(tag: string, a: Record<string, string>): string | null {
  if (a.content !== undefined && tag === "meta") return a.content;
  if (["a", "area", "link"].includes(tag) && a.href !== undefined) return a.href;
  if (["img", "audio", "video", "source", "embed", "iframe", "track"].includes(tag) && a.src !== undefined) return a.src;
  if (tag === "time" && a.datetime !== undefined) return a.datetime;
  if (tag === "data" && a.value !== undefined) return a.value;
  if (tag === "meter" && a.value !== undefined) return a.value;
  if (a.content !== undefined) return a.content;
  return null;
}

/** Top-level microdata items with nested items as property values. */
export function microdata(html: string): MicrodataItem[] {
  const top: MicrodataItem[] = [];
  const stack: Open[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const addText = (t: string) => {
    const txt = decodeEntities(t);
    for (const o of stack) if (o.prop && !o.prop.target) o.prop.text.push(txt);
  };
  const assign = (owner: MicrodataItem | null, names: string[], value: string | MicrodataItem) => {
    if (!owner) return;
    for (const n of names) {
      const list = owner.props[n] ?? [];
      list.push(value);
      owner.props[n] = list;
    }
  };
  const nearestItem = (): MicrodataItem | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const it = stack[i]?.item;
      if (it) return it;
    }
    return null;
  };
  let inSkip: string | null = null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith("<!--")) continue;
    if (m[5] !== undefined) {
      if (!inSkip) addText(m[5]);
      continue;
    }
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    if (inSkip) {
      if (closing && tag === inSkip) inSkip = null;
      continue;
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const o = stack[i];
        if (!o || o.tag !== tag) continue;
        const closed = stack.splice(i);
        for (const c of closed.reverse()) {
          if (c.prop && !c.prop.target) {
            const txt = c.prop.text.join("").replace(/\s+/g, " ").trim();
            const owner = ownerOf(stack, c);
            assign(owner, c.prop.names, txt);
          }
        }
        break;
      }
      continue;
    }
    if (tag === "script" || tag === "style") {
      if (!m[4]) inSkip = tag;
      continue;
    }
    const a = attrs(m[3] ?? "");
    const isScope = a.itemscope !== undefined;
    const propNames = (a.itemprop ?? "").split(/\s+/).filter(Boolean);
    let item: MicrodataItem | null = null;
    if (isScope) {
      item = { type: a.itemtype ? a.itemtype.trim() : null, id: a.itemid ?? null, props: {} };
      if (propNames.length) assign(nearestItem(), propNames, item);
      else top.push(item);
    }
    const selfClosing = VOID.has(tag) || m[4] === "/";
    if (propNames.length && !isScope) {
      const v = valueAttr(tag, a);
      if (v !== null || selfClosing) {
        assign(nearestItem(), propNames, v ?? "");
      } else {
        stack.push({ tag, item, prop: { names: propNames, target: null, text: [] } });
        continue;
      }
    }
    if (!selfClosing) stack.push({ tag, item, prop: null });
  }
  return top;
}

function ownerOf(stack: Open[], _closed: Open): MicrodataItem | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const it = stack[i]?.item;
    if (it) return it;
  }
  return null;
}

export function firstString(v: Array<string | MicrodataItem> | undefined): string | null {
  if (!v) return null;
  for (const x of v) if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

export function firstItem(v: Array<string | MicrodataItem> | undefined): MicrodataItem | null {
  if (!v) return null;
  for (const x of v) if (typeof x !== "string") return x;
  return null;
}
