// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A compact JWS made the way a company that keeps its own key makes one (RFC
// 7515, EdDSA over Ed25519), with node:crypto and the private JWK the
// dashboard showed once. Used by the walk for seller lists and recalls.

import { createPrivateKey, sign, generateKeyPairSync, createHash } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v));

export function compactJws(payload, jwk, typ, header = {}) {
  const h = { alg: "EdDSA", kid: jwk.kid, typ, iat: new Date().toISOString(), ...header };
  const input = `${b64u(canonical(h))}.${b64u(canonical(payload))}`;
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, format: "jwk" });
  return `${input}.${b64u(sign(null, Buffer.from(input), key))}`;
}

/** A fresh Ed25519 private JWK with its RFC 7638 kid, held by nobody but the walk. */
export function freshJwk() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" });
  const kid = b64u(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: j.x })).digest());
  return { kty: "OKP", crv: "Ed25519", x: j.x, d: j.d, kid, alg: "EdDSA", use: "sig" };
}

export const TYPES = { sellerList: "https://trooth.co/types/seller-list", recall: "https://trooth.co/types/recall-notice" };
