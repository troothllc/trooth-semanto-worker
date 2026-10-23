// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Secrets at rest: AES-256-GCM through WebCrypto, a fresh 12-byte IV per value
// and a context string as additional data, so a sealed value written for one
// purpose (a Shopify session, a shop's private connector key, a poll token)
// cannot be read back as another. The same construction as the Semanto
// Worker's src/db/key-seal.ts. The key is APP_SEAL_KEY: 32 random bytes,
// base64, set as a Cloudflare secret.

export type SealContext = "shopify-session" | "connector-key" | "poll-token";

const enc = new TextEncoder();
const dec = new TextDecoder();

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(sealKey: string): Promise<CryptoKey> {
  let k = keyCache.get(sealKey);
  if (!k) {
    const raw = fromB64(sealKey);
    if (raw.length !== 32) throw new Error("APP_SEAL_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).");
    k = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(sealKey, k);
  }
  return k;
}

/** Seal a string: "v1." + base64(iv) + "." + base64(ciphertext and tag). */
export async function seal(plain: string, context: SealContext, sealKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await importKey(sealKey), enc.encode(plain)));
  return `v1.${toB64(iv)}.${toB64(ct)}`;
}

/** Open a sealed string; throws when the value, the key or the context does not match. */
export async function open(sealed: string, context: SealContext, sealKey: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("not a sealed value");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(context) }, await importKey(sealKey), fromB64(ct));
  return dec.decode(pt);
}
