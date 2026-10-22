// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A small HTML tokenizer and tree builder with no dependencies. It follows
// the parts of the WHATWG HTML Living Standard (section 13, parsing) that
// matter for reading a public page: void elements, raw text elements, the
// implied end tags for p, li, dt, dd, tr, td, th and option, character
// references, and closing everything that is still open at the end of input.
// Malformed input never throws: an unmatched end tag is ignored, an
// unterminated comment runs to the end of the document.

export interface ElementNode {
  type: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: ElementNode | null;
}

export interface TextNode {
  type: "text";
  text: string;
  parent: ElementNode | null;
}

export type HtmlNode = ElementNode | TextNode;

export const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { type: "element", tag: "#document", attrs: {}, children: [], parent: null };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1]!;

  const addText = (s: string) => {
    if (!s) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === "text") last.text += s;
    else parent.children.push({ type: "text", text: s, parent });
  };

  const openIn = (tag: string) => stack.findIndex((e) => e.tag === tag);

  const closeTag = (tag: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i]!.tag === tag) {
        stack.length = i;
        return;
      }
    }
  };

  /** Close an open element of `tag` but only if it is nearer than any element in `stopAt`. */
  const impliedClose = (tags: string[], stopAt: string[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      const t = stack[i]!.tag;
      if (stopAt.includes(t)) return;
      if (tags.includes(t)) {
        stack.length = i;
        return;
      }
    }
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(html.slice(i, lt)));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      addText(html.slice(i + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html.startsWith("</", i)) {
      const m = /^<\/([A-Za-z][^\s/>]*)\s*[^>]*>/.exec(html.slice(i, Math.min(n, i + 200)));
      if (!m) {
        addText("<");
        i += 1;
        continue;
      }
      closeTag(m[1]!.toLowerCase());
      i += m[0].length;
      continue;
    }
    const m = /^<([A-Za-z][^\s/>]*)/.exec(html.slice(i, Math.min(n, i + 200)));
    if (!m) {
      addText("<");
      i += 1;
      continue;
    }
    const tag = m[1]!.toLowerCase();
    let j = i + m[0].length;
    // Attributes run until the closing ">" outside quotes.
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let quote: string | null = null;
    let k = j;
    for (; k < n; k++) {
      const c = html[k]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const attrText = html.slice(j, k);
    if (/\/\s*$/.test(attrText)) selfClosing = true;
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(attrText)) !== null) {
      const name = am[1]!.toLowerCase();
      if (name === "/") continue;
      const value = am[2] ?? am[3] ?? am[4] ?? "";
      if (!(name in attrs)) attrs[name] = decodeEntities(value);
    }
    i = Math.min(n, k + 1);

    // Implied end tags.
    if (CLOSES_P.has(tag) && openIn("p") > 0) impliedClose(["p"], ["td", "th", "body", "html", "#document"]);
    if (tag === "li") impliedClose(["li"], ["ul", "ol", "menu"]);
    if (tag === "dt" || tag === "dd") impliedClose(["dt", "dd"], ["dl"]);
    if (tag === "tr") impliedClose(["tr"], ["table", "thead", "tbody", "tfoot"]);
    if (tag === "td" || tag === "th") impliedClose(["td", "th"], ["tr", "table"]);
    if (tag === "option") impliedClose(["option"], ["select", "datalist"]);
    if (tag === "html" && openIn("html") > 0) {
      i = Math.min(n, k + 1);
      continue;
    }
    if (tag === "body" && openIn("body") > 0) {
      const b = stack[openIn("body")]!;
      for (const [an, av] of Object.entries(attrs)) if (!(an in b.attrs)) b.attrs[an] = av;
      continue;
    }

    const el: ElementNode = { type: "element", tag, attrs, children: [], parent: top() };
    top().children.push(el);
    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;
    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(i);
      const cm = close.exec(rest);
      const raw = cm ? rest.slice(0, cm.index) : rest;
      if (raw) el.children.push({ type: "text", text: tag === "script" || tag === "style" ? raw : decodeEntities(raw), parent: el });
      i = cm ? i + cm.index + cm[0].length : n;
      continue;
    }
    stack.push(el);
  }
  return root;
}

// ------------------------------------------------------------ tree helpers

export function textOf(node: HtmlNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text;
  let s = "";
  for (const c of node.children) s += textOf(c);
  return s;
}

export function walk(node: HtmlNode, fn: (el: ElementNode) => void | false): void {
  if (node.type !== "element") return;
  if (fn(node) === false) return;
  for (const c of node.children) walk(c, fn);
}

export function findAll(node: HtmlNode, tag: string): ElementNode[] {
  const out: ElementNode[] = [];
  walk(node, (el) => {
    if (el.tag === tag) out.push(el);
  });
  return out;
}

export function findFirst(node: HtmlNode, tag: string): ElementNode | null {
  let found: ElementNode | null = null;
  walk(node, (el) => {
    if (found) return false;
    if (el.tag === tag) {
      found = el;
      return false;
    }
  });
  return found;
}

export function hasAncestor(el: ElementNode, tags: Set<string>): boolean {
  for (let p = el.parent; p; p = p.parent) if (tags.has(p.tag)) return true;
  return false;
}

// ------------------------------------------------------- character references

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", laquo: "\u00ab", raquo: "\u00bb", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5",
  cent: "\u00a2", deg: "\u00b0", times: "\u00d7", divide: "\u00f7", frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be",
  sect: "\u00a7", para: "\u00b6", plusmn: "\u00b1", micro: "\u00b5", shy: "", iexcl: "\u00a1", iquest: "\u00bf",
  eacute: "\u00e9", egrave: "\u00e8", ecirc: "\u00ea", agrave: "\u00e0", aacute: "\u00e1", acirc: "\u00e2", auml: "\u00e4",
  ouml: "\u00f6", uuml: "\u00fc", szlig: "\u00df", ccedil: "\u00e7", ntilde: "\u00f1", oacute: "\u00f3", iacute: "\u00ed",
  uacute: "\u00fa", Eacute: "\u00c9", Auml: "\u00c4", Ouml: "\u00d6", Uuml: "\u00dc", larr: "\u2190", rarr: "\u2192",
  uarr: "\u2191", darr: "\u2193", hearts: "\u2665", check: "\u2713", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  zwj: "\u200d", zwnj: "\u200c", lrm: "", rlm: "",
};

export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    const v = NAMED[body];
    return v === undefined ? m : v;
  });
}
