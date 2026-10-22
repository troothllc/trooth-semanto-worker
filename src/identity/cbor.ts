// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A small CBOR decoder (RFC 8949), only as much as WebAuthn needs: the
// attestationObject, the attested credential public key in COSE form
// (RFC 9052 and RFC 9053 key parameters) and the authenticator extensions.
// CTAP2 authenticators send the CTAP2 canonical form (FIDO CTAP 2.1 section
// 8, "Message Encoding"): definite lengths only, so indefinite lengths, tags
// and floats are refused. Integers stay inside the safe integer range of
// JavaScript. Nesting and lengths are bounded so a hostile input cannot make
// the Worker loop or allocate without end. No dependencies.

export type CborValue = number | Uint8Array | string | boolean | null | undefined | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

/** Decode one item at `offset`. Answers the value and the offset just past it. */
export function decodeCborItem(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const r = new Reader(bytes, offset);
  const value = r.item(0);
  return { value, end: r.pos };
}

/** Decode exactly one item that fills the whole input. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCborItem(bytes, 0);
  if (end !== bytes.length) throw new CborError("extra bytes after the CBOR item");
  return value;
}

export function isCborMap(v: CborValue): v is CborMap {
  return v instanceof Map;
}

class Reader {
  constructor(
    private readonly b: Uint8Array,
    public pos: number,
  ) {}

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.b.length) throw new CborError("the CBOR item runs past the end of the input");
  }

  private byte(): number {
    this.need(1);
    return this.b[this.pos++]!;
  }

  /** The argument of a head: the value of the additional information. */
  private argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) {
      this.need(2);
      const v = (this.b[this.pos]! << 8) | this.b[this.pos + 1]!;
      this.pos += 2;
      return v;
    }
    if (info === 26) {
      this.need(4);
      const v = ((this.b[this.pos]! << 24) >>> 0) + (this.b[this.pos + 1]! << 16) + (this.b[this.pos + 2]! << 8) + this.b[this.pos + 3]!;
      this.pos += 4;
      return v;
    }
    if (info === 27) {
      this.need(8);
      const hi = ((this.b[this.pos]! << 24) >>> 0) + (this.b[this.pos + 1]! << 16) + (this.b[this.pos + 2]! << 8) + this.b[this.pos + 3]!;
      const lo = ((this.b[this.pos + 4]! << 24) >>> 0) + (this.b[this.pos + 5]! << 16) + (this.b[this.pos + 6]! << 8) + this.b[this.pos + 7]!;
      this.pos += 8;
      const v = hi * 2 ** 32 + lo;
      if (!Number.isSafeInteger(v)) throw new CborError("a CBOR integer is larger than this decoder accepts");
      return v;
    }
    if (info === 31) throw new CborError("indefinite-length CBOR items are not accepted (CTAP2 canonical form)");
    throw new CborError("a reserved CBOR additional information value");
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError("the CBOR item is nested too deeply");
    const head = this.byte();
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return this.argument(info);
      case 1:
        return -1 - this.argument(info);
      case 2: {
        const n = this.argument(info);
        this.need(n);
        const out = this.b.slice(this.pos, this.pos + n);
        this.pos += n;
        return out;
      }
      case 3: {
        const n = this.argument(info);
        this.need(n);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.b.subarray(this.pos, this.pos + n));
        this.pos += n;
        return text;
      }
      case 4: {
        const n = this.argument(info);
        if (n > MAX_ITEMS) throw new CborError("a CBOR array is longer than this decoder accepts");
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(this.item(depth + 1));
        return out;
      }
      case 5: {
        const n = this.argument(info);
        if (n > MAX_ITEMS) throw new CborError("a CBOR map is longer than this decoder accepts");
        const out: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const k = this.item(depth + 1);
          if (typeof k !== "number" && typeof k !== "string") throw new CborError("a CBOR map key is not an integer or a text string");
          if (out.has(k)) throw new CborError("a CBOR map repeats a key");
          out.set(k, this.item(depth + 1));
        }
        return out;
      }
      case 6:
        throw new CborError("CBOR tags are not accepted here");
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new CborError("CBOR floats and other simple values are not accepted here");
      }
    }
  }
}
