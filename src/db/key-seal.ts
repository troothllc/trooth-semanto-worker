// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Hosted private keys at rest. A company's hosted Ed25519 private JWK is
// sealed with AES-256-GCM (NIST SP 800-38D) under a key derived per kid with
// HKDF-SHA-256 (RFC 5869) from the HOSTED_KEY_SEAL_SECRET Worker secret, and
// only the sealed form is written to R2. Without the secret nothing is sealed
// and nothing is opened: the pipeline refuses to store a hosted key rather
// than write it in the clear. WebCrypto only.

import { fromBase64Url, toBase64Url, utf8, fromUtf8 } from "../core/encoding";
import type { PrivateJwk } from "../core/keys";

const SALT = utf8("trooth-semanto-hosted-key-v1");

async function keyFor(secret: string, kid: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("HOSTED_KEY_SEAL_SECRET must be set to at least 32 characters before a hosted key can be stored.");
  const base = await crypto.subtle.importKey("raw", utf8(secret) as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT as BufferSource, info: utf8(kid) as BufferSource }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export interface SealedKey {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
}

export async function sealPrivateJwk(jwk: PrivateJwk, secret: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(secret, jwk.kid);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8(jwk.kid) as BufferSource }, key, utf8(JSON.stringify(jwk)) as BufferSource));
  const sealed: SealedKey = { v: 1, kid: jwk.kid, iv: toBase64Url(iv), ct: toBase64Url(ct) };
  return utf8(JSON.stringify(sealed));
}

/** Open a sealed key; null when the bytes are not a sealed key for this secret. */
export async function openPrivateJwk(bytes: Uint8Array, secret: string | undefined): Promise<PrivateJwk | null> {
  if (!secret) return null;
  try {
    const sealed = JSON.parse(fromUtf8(bytes)) as SealedKey;
    if (sealed.v !== 1 || !sealed.kid) return null;
    const key = await keyFor(secret, sealed.kid);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(sealed.iv) as BufferSource, additionalData: utf8(sealed.kid) as BufferSource }, key, fromBase64Url(sealed.ct) as BufferSource);
    const jwk = JSON.parse(fromUtf8(new Uint8Array(pt))) as PrivateJwk;
    return jwk.d && jwk.kid === sealed.kid ? jwk : null;
  } catch {
    return null;
  }
}
