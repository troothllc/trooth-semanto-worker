// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// SHA-256 through WebCrypto. Every digest Semanto prints is "sha256:" followed
// by 64 lowercase hex characters, in full, never shortened.

import { toHex, utf8, fromHex } from "./encoding";

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256(data));
}

/** The printed form: "sha256:<64 hex>". */
export async function digest(data: Uint8Array | string): Promise<string> {
  return `sha256:${await sha256Hex(data)}`;
}

export function isDigest(v: unknown): v is string {
  return typeof v === "string" && DIGEST_RE.test(v);
}

export function digestBytes(d: string): Uint8Array {
  if (!isDigest(d)) throw new Error(`digestBytes: expected "sha256:<64 hex>", got ${JSON.stringify(d)}`);
  return fromHex(d.slice(7));
}
