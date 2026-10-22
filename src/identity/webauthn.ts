// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Passkeys for releasing a hosted company key. A person registers a passkey
// once (W3C Web Authentication Level 3, section 7.1, "Registering a New
// Credential") and then completes a fresh assertion for every version they
// approve (section 7.2, "Verifying an Authentication Assertion"). Trooth
// releases the hosted key and signs only after the assertion checks out for
// the exact version and root hash being signed.
//
// This module is pure: it builds the options the browser passes to
// navigator.credentials.create and get (PublicKeyCredentialCreationOptions
// and PublicKeyCredentialRequestOptions, in their JSON form with base64url
// buffers, section 5.1.8 and 5.5), and checks what the browser sends back.
// Storage of users, credentials and single-use challenges is behind the
// pipeline's store (src/pipeline-store.ts, D1 in src/db/d1.ts).
//
// Accepted algorithms (COSE, RFC 9053 and RFC 8812): ES256 (-7, ECDSA P-256
// with SHA-256), EdDSA (-8, Ed25519) and RS256 (-257, RSASSA-PKCS1-v1_5 with
// SHA-256). Attestation: "none" is asked for; fmt "none" is accepted, fmt
// "packed" only as self attestation (no certificate chain, signature by the
// credential key itself, section 8.2), every other format is refused.
// WebCrypto only, no dependencies. CBOR is decoded by ./cbor.ts.

import { bytesEqual, concat, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../core/encoding";
import { sha256 } from "../core/hash";
import { decodeCbor, decodeCborItem, isCborMap, CborError, type CborMap, type CborValue } from "./cbor";

// ---------------------------------------------------------------- configuration

export const COSE_ALG = { ES256: -7, EdDSA: -8, RS256: -257 } as const;
export type CoseAlg = (typeof COSE_ALG)[keyof typeof COSE_ALG];
const ACCEPTED_ALGS: readonly number[] = [COSE_ALG.ES256, COSE_ALG.EdDSA, COSE_ALG.RS256];

/** A challenge lives five minutes and is used once. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** What the browser is told to wait, the same five minutes. */
export const CEREMONY_TIMEOUT_MS = CHALLENGE_TTL_MS;
export const DEFAULT_RP_ID = "trooth.co";
export const RP_NAME = "Trooth";
export const PRODUCTION_ORIGINS = ["https://trooth.co", "https://www.trooth.co"] as const;
export const DEVELOPMENT_ORIGIN = "http://localhost";
/** Section 5.8.3 of Level 3: a credential id is at most 1023 bytes. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

export interface WebAuthnConfig {
  rp_id: string;
  rp_name: string;
  /** Exact origins clientDataJSON may name. */
  origins: string[];
}

/**
 * The relying party: rp id from configuration (default trooth.co), and the
 * two trooth.co origins. http://localhost (any port) is accepted only when
 * the deployment is development.
 */
export function webauthnConfig(opts: { rp_id?: string | null; development?: boolean } = {}): WebAuthnConfig {
  return { rp_id: opts.rp_id || DEFAULT_RP_ID, rp_name: RP_NAME, origins: [...PRODUCTION_ORIGINS, ...(opts.development ? [DEVELOPMENT_ORIGIN] : [])] };
}

export function originAllowed(origin: string, config: WebAuthnConfig): boolean {
  if (config.origins.includes(origin)) return true;
  // Development only: http://localhost on any port.
  if (config.origins.includes(DEVELOPMENT_ORIGIN) && /^http:\/\/localhost(:\d{1,5})?$/.test(origin)) return true;
  return false;
}

// ---------------------------------------------------------------- stored shapes

export type PasskeyJwk = { kty: "EC"; crv: "P-256"; x: string; y: string } | { kty: "OKP"; crv: "Ed25519"; x: string } | { kty: "RSA"; n: string; e: string };

/** One registered passkey (semanto_passkeys). */
export interface StoredPasskey {
  /** base64url of the credential id. */
  credential_id: string;
  user_id: string;
  /** The company the person was in when they added it. A passkey belongs to the person, not the company. */
  trooth_id: string;
  public_jwk: PasskeyJwk;
  alg: CoseAlg;
  sign_count: number;
  transports: string[];
  backup_eligible: boolean;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** The WebAuthn user for a workspace user (semanto_passkey_users): a random 32-byte handle, never the user id itself. */
export interface PasskeyUser {
  user_id: string;
  /** base64url of 32 random bytes. */
  handle: string;
  created_at: string;
}

/** A single-use challenge (semanto_webauthn_challenges). A get challenge is bound to one version and root hash. */
export interface PasskeyChallenge {
  /** base64url of 32 random bytes. */
  challenge: string;
  kind: "create" | "get";
  trooth_id: string;
  user_id: string;
  version: number | null;
  root_hash: string | null;
  created_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------- options

export interface CredentialDescriptorJSON {
  type: "public-key";
  id: string;
  transports?: string[];
}

export interface CreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: CoseAlg }[];
  timeout: number;
  excludeCredentials: CredentialDescriptorJSON[];
  authenticatorSelection: { residentKey: "preferred"; requireResidentKey: false; userVerification: "required" };
  attestation: "none";
}

export interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  allowCredentials: CredentialDescriptorJSON[];
  userVerification: "required";
  timeout: number;
}

const descriptor = (p: StoredPasskey): CredentialDescriptorJSON => ({ type: "public-key", id: p.credential_id, ...(p.transports.length ? { transports: p.transports } : {}) });

/** PublicKeyCredentialCreationOptions (JSON form) for adding a passkey. */
export function creationOptions(o: { config: WebAuthnConfig; user: PasskeyUser; name: string; challenge: string; existing: StoredPasskey[] }): CreationOptionsJSON {
  const name = o.name.trim() || "Trooth user";
  return {
    rp: { id: o.config.rp_id, name: o.config.rp_name },
    user: { id: o.user.handle, name, displayName: name },
    challenge: o.challenge,
    pubKeyCredParams: [
      { type: "public-key", alg: COSE_ALG.ES256 },
      { type: "public-key", alg: COSE_ALG.EdDSA },
      { type: "public-key", alg: COSE_ALG.RS256 },
    ],
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: o.existing.map(descriptor),
    authenticatorSelection: { residentKey: "preferred", requireResidentKey: false, userVerification: "required" },
    attestation: "none",
  };
}

/** PublicKeyCredentialRequestOptions (JSON form) for approving one version. */
export function requestOptions(o: { config: WebAuthnConfig; challenge: string; passkeys: StoredPasskey[] }): RequestOptionsJSON {
  return { challenge: o.challenge, rpId: o.config.rp_id, allowCredentials: o.passkeys.map(descriptor), userVerification: "required", timeout: CEREMONY_TIMEOUT_MS };
}

/** 32 random bytes as base64url. */
export function randomChallenge(random: (n: number) => Uint8Array): string {
  return toBase64Url(random(32));
}

// ---------------------------------------------------------------- what the browser sends

/** PublicKeyCredential.toJSON() for create, or the same fields flat. */
export interface RegistrationInput {
  id: string;
  rawId?: string;
  type?: string;
  clientDataJSON: string;
  attestationObject: string;
  transports: string[];
}

/** PublicKeyCredential.toJSON() for get, or the same fields flat (web/semanto/setup/browser.ts PasskeyAssertion). */
export interface AssertionInput {
  id: string;
  rawId?: string;
  type?: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const b64urlString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && /^[A-Za-z0-9_-]+={0,2}$/.test(v);

/** Read a registration from a request body: { credential } or the credential itself, nested response or flat. */
export function readRegistration(body: unknown): RegistrationInput | null {
  const c = isRecord(body) && isRecord(body.credential) ? body.credential : body;
  if (!isRecord(c)) return null;
  const r = isRecord(c.response) ? c.response : c;
  const id = c.id ?? c.rawId;
  if (!b64urlString(id) || !b64urlString(r.clientDataJSON) || !b64urlString(r.attestationObject)) return null;
  if (c.type !== undefined && c.type !== "public-key") return null;
  const transports = Array.isArray(r.transports) ? r.transports.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,32}$/.test(t)).slice(0, 8) : [];
  return { id, ...(b64urlString(c.rawId) ? { rawId: c.rawId } : {}), clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, transports };
}

/** Read an assertion from a request body's assertion member, nested response or flat. */
export function readAssertion(v: unknown): AssertionInput | null {
  if (!isRecord(v)) return null;
  const r = isRecord(v.response) ? v.response : v;
  const id = v.id ?? v.rawId;
  if (!b64urlString(id) || !b64urlString(r.clientDataJSON) || !b64urlString(r.authenticatorData) || !b64urlString(r.signature)) return null;
  if (v.type !== undefined && v.type !== "public-key") return null;
  const userHandle = b64urlString(r.userHandle) ? r.userHandle : null;
  return { id, ...(b64urlString(v.rawId) ? { rawId: v.rawId } : {}), clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle };
}

// ---------------------------------------------------------------- checks

export type WebAuthnFailureCode =
  | "malformed"
  | "type"
  | "challenge"
  | "origin"
  | "cross_origin"
  | "rp_id"
  | "user_present"
  | "user_verified"
  | "flags"
  | "attested_data"
  | "algorithm"
  | "attestation"
  | "credential"
  | "signature"
  | "counter";

export interface WebAuthnFailure {
  ok: false;
  code: WebAuthnFailureCode;
  reason: string;
}

const fail = (code: WebAuthnFailureCode, reason: string): WebAuthnFailure => ({ ok: false, code, reason });

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
  topOrigin?: string;
}

/** Steps 5 and 6 of 7.1 (and 7.2): clientDataJSON is UTF-8 JSON with type, challenge and origin. */
export function readClientData(clientDataJSON: string): ClientData | null {
  try {
    const v = JSON.parse(fromUtf8(fromBase64Url(clientDataJSON))) as unknown;
    if (!isRecord(v) || typeof v.type !== "string" || typeof v.challenge !== "string" || typeof v.origin !== "string") return null;
    return { type: v.type, challenge: v.challenge, origin: v.origin, ...(typeof v.crossOrigin === "boolean" ? { crossOrigin: v.crossOrigin } : {}), ...(typeof v.topOrigin === "string" ? { topOrigin: v.topOrigin } : {}) };
  } catch {
    return null;
  }
}

function checkClientData(c: ClientData, want: { type: "webauthn.create" | "webauthn.get"; challenge: string; config: WebAuthnConfig }): WebAuthnFailure | null {
  if (c.type !== want.type) return fail("type", `the browser answered ${JSON.stringify(c.type)} where ${want.type} was expected`);
  // The challenge is compared as base64url text; both sides drop padding.
  if (c.challenge.replace(/=+$/, "") !== want.challenge.replace(/=+$/, "")) return fail("challenge", "the passkey answered a different challenge");
  if (!originAllowed(c.origin, want.config)) return fail("origin", `the passkey step ran on ${c.origin}, which is not a Trooth address`);
  if (c.crossOrigin === true) return fail("cross_origin", "the passkey step ran inside a frame from another site");
  return null;
}

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  attested: { aaguid: Uint8Array; credentialId: Uint8Array; publicKey: CborMap } | null;
}

/** Section 6.1: rpIdHash (32), flags (1), signCount (4, big-endian), attested credential data, extensions. */
export function parseAuthenticatorData(b: Uint8Array): AuthenticatorData {
  if (b.length < 37) throw new CborError("authenticator data is shorter than 37 bytes");
  const rpIdHash = b.slice(0, 32);
  const flags = b[32]!;
  const signCount = ((b[33]! << 24) >>> 0) + (b[34]! << 16) + (b[35]! << 8) + b[36]!;
  let pos = 37;
  let attested: AuthenticatorData["attested"] = null;
  if (flags & FLAG.AT) {
    if (b.length < pos + 18) throw new CborError("attested credential data is cut short");
    const aaguid = b.slice(pos, pos + 16);
    const idLen = (b[pos + 16]! << 8) | b[pos + 17]!;
    pos += 18;
    if (idLen > MAX_CREDENTIAL_ID_BYTES) throw new CborError("the credential id is longer than 1023 bytes");
    if (b.length < pos + idLen) throw new CborError("the credential id is cut short");
    const credentialId = b.slice(pos, pos + idLen);
    pos += idLen;
    const { value, end } = decodeCborItem(b, pos);
    if (!isCborMap(value)) throw new CborError("the credential public key is not a COSE key map");
    pos = end;
    attested = { aaguid, credentialId, publicKey: value };
  }
  if (flags & FLAG.ED) {
    const { value, end } = decodeCborItem(b, pos);
    if (!isCborMap(value)) throw new CborError("the authenticator extensions are not a map");
    pos = end;
  }
  if (pos !== b.length) throw new CborError("authenticator data has bytes left over");
  return { rpIdHash, flags, signCount, attested };
}

async function checkAuthData(ad: AuthenticatorData, config: WebAuthnConfig): Promise<WebAuthnFailure | null> {
  if (!bytesEqual(ad.rpIdHash, await sha256(config.rp_id))) return fail("rp_id", `the passkey belongs to another site, not ${config.rp_id}`);
  if (!(ad.flags & FLAG.UP)) return fail("user_present", "the device did not report that a person was present");
  if (!(ad.flags & FLAG.UV)) return fail("user_verified", "the device did not report that it checked who you are (fingerprint, face or PIN)");
  if (ad.flags & FLAG.BS && !(ad.flags & FLAG.BE)) return fail("flags", "the device reported a backup state that cannot happen");
  return null;
}

// ---------------------------------------------------------------- COSE keys

const coseBytes = (m: CborMap, k: number): Uint8Array | null => {
  const v = m.get(k);
  return v instanceof Uint8Array ? v : null;
};

/** RFC 9053 section 7: kty 2 (EC2, crv 1 P-256), kty 1 (OKP, crv 6 Ed25519), kty 3 (RSA, RFC 8230). Answers the JWK and alg. */
export function coseToJwk(m: CborMap): { jwk: PasskeyJwk; alg: CoseAlg } | WebAuthnFailure {
  const kty = m.get(1);
  const alg = m.get(3);
  if (typeof alg !== "number" || !ACCEPTED_ALGS.includes(alg)) return fail("algorithm", "the passkey uses an algorithm Trooth does not accept (ES256, EdDSA or RS256)");
  if (alg === COSE_ALG.ES256) {
    const x = coseBytes(m, -2);
    const y = coseBytes(m, -3);
    if (kty !== 2 || m.get(-1) !== 1 || !x || !y || x.length !== 32 || y.length !== 32) return fail("algorithm", "the ES256 public key is not a P-256 key");
    return { jwk: { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) }, alg };
  }
  if (alg === COSE_ALG.EdDSA) {
    const x = coseBytes(m, -2);
    if (kty !== 1 || m.get(-1) !== 6 || !x || x.length !== 32) return fail("algorithm", "the EdDSA public key is not an Ed25519 key");
    return { jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(x) }, alg };
  }
  const n = coseBytes(m, -1);
  const e = coseBytes(m, -2);
  if (kty !== 3 || !n || !e) return fail("algorithm", "the RS256 public key is not an RSA key");
  const nBits = (n.length - (n[0] === 0 ? 1 : 0)) * 8;
  if (nBits < 2048) return fail("algorithm", "the RSA key is shorter than 2048 bits");
  return { jwk: { kty: "RSA", n: toBase64Url(n[0] === 0 ? n.slice(1) : n), e: toBase64Url(e) }, alg: COSE_ALG.RS256 };
}

/** An ECDSA signature in ASN.1 DER (SEQUENCE of two INTEGERs) to raw r || s, 32 bytes each, for WebCrypto. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array | null {
  let p = 0;
  const len = (): number | null => {
    if (p >= der.length) return null;
    const first = der[p++]!;
    if (first < 0x80) return first;
    const n = first & 0x7f;
    if (n < 1 || n > 2 || p + n > der.length) return null;
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 8) | der[p++]!;
    return v;
  };
  const int = (): Uint8Array | null => {
    if (der[p++] !== 0x02) return null;
    const l = len();
    if (l === null || l < 1 || p + l > der.length) return null;
    let v = der.subarray(p, p + l);
    p += l;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  if (der[p++] !== 0x30) return null;
  const seqLen = len();
  if (seqLen === null || p + seqLen !== der.length) return null;
  const r = int();
  const s = int();
  if (!r || !s || p !== der.length) return null;
  return concat(r, s);
}

/** Check a WebAuthn signature with the stored key: ES256 (DER to raw), EdDSA, RS256. */
export async function checkSignature(jwk: PasskeyJwk, alg: CoseAlg, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (alg === COSE_ALG.ES256 && jwk.kty === "EC") {
      const raw = derToRaw(signature);
      if (!raw) return false;
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, data as BufferSource);
    }
    if (alg === COSE_ALG.EdDSA && jwk.kty === "OKP") {
      if (signature.length !== 64) return false;
      const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, ext: true }, { name: "Ed25519" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, data as BufferSource);
    }
    if (alg === COSE_ALG.RS256 && jwk.kty === "RSA") {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature as BufferSource, data as BufferSource);
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 7.1 registration

export interface RegisteredPasskey {
  credential_id: string;
  public_jwk: PasskeyJwk;
  alg: CoseAlg;
  sign_count: number;
  transports: string[];
  backup_eligible: boolean;
  backed_up: boolean;
  fmt: "none" | "packed";
}

/**
 * Section 7.1, steps 5 to 26, for attestation "none": clientDataJSON (type
 * webauthn.create, the challenge, an allowed origin), the attestationObject
 * (fmt none, or packed self attestation), authenticatorData (rpIdHash, UP,
 * UV, attested credential data), the algorithm, and the credential id the
 * browser named. The caller has already consumed the challenge.
 */
export async function verifyRegistration(o: { input: RegistrationInput; challenge: string; config: WebAuthnConfig }): Promise<{ ok: true; passkey: RegisteredPasskey } | WebAuthnFailure> {
  const c = readClientData(o.input.clientDataJSON);
  if (!c) return fail("malformed", "the browser's client data could not be read");
  const bad = checkClientData(c, { type: "webauthn.create", challenge: o.challenge, config: o.config });
  if (bad) return bad;
  const clientDataHash = await sha256(fromBase64Url(o.input.clientDataJSON));

  let att: CborValue;
  try {
    att = decodeCbor(fromBase64Url(o.input.attestationObject));
  } catch {
    return fail("malformed", "the attestation object is not valid CBOR");
  }
  if (!isCborMap(att)) return fail("malformed", "the attestation object is not a map");
  const fmt = att.get("fmt");
  const authDataBytes = att.get("authData");
  const attStmt = att.get("attStmt");
  if (typeof fmt !== "string" || !(authDataBytes instanceof Uint8Array) || !isCborMap(attStmt)) return fail("malformed", "the attestation object lacks fmt, authData or attStmt");

  let ad: AuthenticatorData;
  try {
    ad = parseAuthenticatorData(authDataBytes);
  } catch {
    return fail("malformed", "the authenticator data could not be read");
  }
  const flagsBad = await checkAuthData(ad, o.config);
  if (flagsBad) return flagsBad;
  if (!ad.attested) return fail("attested_data", "the device sent no credential to register");
  const key = coseToJwk(ad.attested.publicKey);
  if ("ok" in key) return key;

  if (fmt === "none") {
    if (attStmt.size !== 0) return fail("attestation", "an attestation of format none must carry an empty statement");
  } else if (fmt === "packed") {
    if (attStmt.has("x5c") || attStmt.has("ecdaaKeyId")) return fail("attestation", "this passkey sends a maker certificate. Trooth accepts passkeys without one; use your device's built-in passkey or a password manager");
    const salg = attStmt.get("alg");
    const sig = attStmt.get("sig");
    if (salg !== key.alg || !(sig instanceof Uint8Array)) return fail("attestation", "the packed self attestation names another algorithm or has no signature");
    if (!(await checkSignature(key.jwk, key.alg, sig, concat(authDataBytes, clientDataHash)))) return fail("attestation", "the packed self attestation signature does not check out");
  } else {
    return fail("attestation", `this passkey uses the ${fmt} format, which Trooth does not accept. Use your device's built-in passkey or a password manager`);
  }

  const credential_id = toBase64Url(ad.attested.credentialId);
  const named = o.input.id.replace(/=+$/, "");
  if (named !== credential_id || (o.input.rawId !== undefined && o.input.rawId.replace(/=+$/, "") !== credential_id)) return fail("credential", "the credential id the browser named is not the one the device created");

  return {
    ok: true,
    passkey: {
      credential_id,
      public_jwk: key.jwk,
      alg: key.alg,
      sign_count: ad.signCount,
      transports: o.input.transports,
      backup_eligible: Boolean(ad.flags & FLAG.BE),
      backed_up: Boolean(ad.flags & FLAG.BS),
      fmt,
    },
  };
}

// ---------------------------------------------------------------- 7.2 authentication

/**
 * Section 7.2, steps 5 to 24: the credential is the stored one and the user
 * handle (when sent) is the person's; clientDataJSON (type webauthn.get, the
 * challenge, an allowed origin); authenticatorData (rpIdHash, UP, UV); the
 * signature over authenticatorData || SHA-256(clientDataJSON) with the stored
 * key; and the signature counter, which must grow whenever either count is
 * not zero (a count that does not grow may mean a cloned authenticator).
 */
export async function verifyAssertion(o: { input: AssertionInput; challenge: string; config: WebAuthnConfig; passkey: StoredPasskey; user: PasskeyUser }): Promise<{ ok: true; sign_count: number; backed_up: boolean } | WebAuthnFailure> {
  const named = o.input.id.replace(/=+$/, "");
  if (named !== o.passkey.credential_id || (o.input.rawId !== undefined && o.input.rawId.replace(/=+$/, "") !== o.passkey.credential_id)) return fail("credential", "the passkey used is not one of yours");
  if (o.input.userHandle !== null && o.input.userHandle.replace(/=+$/, "") !== o.user.handle) return fail("credential", "the passkey used belongs to another person");

  const c = readClientData(o.input.clientDataJSON);
  if (!c) return fail("malformed", "the browser's client data could not be read");
  const bad = checkClientData(c, { type: "webauthn.get", challenge: o.challenge, config: o.config });
  if (bad) return bad;

  let authData: Uint8Array;
  let ad: AuthenticatorData;
  try {
    authData = fromBase64Url(o.input.authenticatorData);
    ad = parseAuthenticatorData(authData);
  } catch {
    return fail("malformed", "the authenticator data could not be read");
  }
  const flagsBad = await checkAuthData(ad, o.config);
  if (flagsBad) return flagsBad;

  const clientDataHash = await sha256(fromBase64Url(o.input.clientDataJSON));
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(o.input.signature);
  } catch {
    return fail("malformed", "the signature could not be read");
  }
  if (!(await checkSignature(o.passkey.public_jwk, o.passkey.alg, signature, concat(authData, clientDataHash)))) return fail("signature", "the passkey signature does not check out");

  if ((ad.signCount !== 0 || o.passkey.sign_count !== 0) && ad.signCount <= o.passkey.sign_count) {
    return fail("counter", "the passkey's counter went backwards or stood still, which can mean the passkey was copied");
  }
  return { ok: true, sign_count: ad.signCount, backed_up: Boolean(ad.flags & FLAG.BS) };
}

/** The SHA-256 of the rp id, for tests and authenticators built by hand. */
export const rpIdHash = (rpId: string): Promise<Uint8Array> => sha256(utf8(rpId));
