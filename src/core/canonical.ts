// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// JSON Canonicalization Scheme, RFC 8785. Two parties who hold the same JSON
// value produce the same bytes, so a hash or a signature over a Semanto object
// is the same everywhere: in the Worker, in a browser, in the Python and Go
// verifiers. Numbers follow ECMAScript Number.prototype.toString, which is what
// RFC 8785 specifies; Semanto itself never signs non-integer numbers.

export function canonicalize(value: unknown): string {
  return ser(value);
}

function ser(v: unknown): string {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonicalize: non-finite number");
    return Object.is(v, -0) ? "0" : String(v);
  }
  if (typeof v === "string") return str(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map((x) => ser(x === undefined ? null : x)).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort((a, b) => cmpUtf16(a, b));
    return `{${keys.map((k) => `${str(k)}:${ser(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalize: cannot serialize ${typeof v}`);
}

// RFC 8785 sorts property names by their UTF-16 code units.
function cmpUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function str(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, "0")}` : s[i];
    }
  }
  return out + '"';
}
