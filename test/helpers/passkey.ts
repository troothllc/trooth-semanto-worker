// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test helper: a software authenticator built by hand in Node WebCrypto, so
// the passkey checks (src/identity/webauthn.ts) run against real ES256,
// Ed25519 and RS256 credentials. It writes authenticatorData (W3C WebAuthn
// Level 3, section 6.1), clientDataJSON (section 5.8.1) and an
// attestationObject of format none or packed self attestation (sections 6.5
// and 8.2) with a small CBOR encoder (RFC 8949, CTAP2 canonical form for the
// shapes used here). Every knob a negative test needs (origin, rp id, flags,
// counter, a broken signature) is an option. Not used in production.

import { concat, fromBase64Url, toBase64Url, utf8 } from "@/core/encoding";
import { sha256 } from "@/core/hash";
import type { CreationOptionsJSON, RequestOptionsJSON } from "@/identity/webauthn";

// ---------------------------------------------------------------- CBOR encoder

export type CborIn = number | string | Uint8Array | boolean | null | CborIn[] | Map<number | string, CborIn>;

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  if (n < 0x100000000) return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const hi = Math.floor(n / 2 ** 32);
  const lo = n % 2 ** 32;
  return new Uint8Array([(major << 5) | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff]);
}

export function cborEncode(v: CborIn): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = utf8(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v === false) return new Uint8Array([0xf4]);
  if (v === true) return new Uint8Array([0xf5]);
  if (v === null) return new Uint8Array([0xf6]);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cborEncode));
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cborEncode(k), cborEncode(x));
  return concat(...parts);
}

// ---------------------------------------------------------------- signatures

/** Raw r || s (WebCrypto ECDSA) to ASN.1 DER, as authenticators send ES256. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v: Uint8Array = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export type SoftAlg = "ES256" | "EdDSA" | "RS256";
const COSE: Record<SoftAlg, number> = { ES256: -7, EdDSA: -8, RS256: -257 };

export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

export interface CeremonyOptions {
  origin?: string;
  rpId?: string;
  /** Overrides the flags byte (UP and UV set by default; AT added on create). */
  flags?: number;
  /** The counter this answer carries; by default the authenticator's counter plus one. */
  signCount?: number;
  /** Flip a bit in the signature. */
  badSignature?: boolean;
  /** Answer another challenge than the one in the options. */
  challenge?: string;
  type?: string;
  crossOrigin?: boolean;
}

/** A passkey on a software authenticator. */
export class SoftAuthenticator {
  signCount = 0;
  userHandle: string | null = null;
  private constructor(
    readonly alg: SoftAlg,
    readonly keys: CryptoKeyPair,
    readonly credentialId: Uint8Array,
    /** Counts start here and go up by one per assertion; 0 keeps them at 0, as many platform passkeys do. */
    readonly step: number,
  ) {}

  static async create(alg: SoftAlg = "ES256", opts: { counter?: boolean } = {}): Promise<SoftAuthenticator> {
    const params =
      alg === "ES256"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : alg === "EdDSA"
          ? { name: "Ed25519" }
          : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
    const keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
    return new SoftAuthenticator(alg, keys, crypto.getRandomValues(new Uint8Array(16)), opts.counter === false ? 0 : 1);
  }

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  async coseKey(): Promise<Uint8Array> {
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    if (this.alg === "ES256") return cborEncode(new Map<number, CborIn>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x!)], [-3, fromBase64Url(jwk.y!)]]));
    if (this.alg === "EdDSA") return cborEncode(new Map<number, CborIn>([[1, 1], [3, -8], [-1, 6], [-2, fromBase64Url(jwk.x!)]]));
    return cborEncode(new Map<number, CborIn>([[1, 3], [3, -257], [-1, fromBase64Url(jwk.n!)], [-2, fromBase64Url(jwk.e!)]]));
  }

  async signBytes(data: Uint8Array): Promise<Uint8Array> {
    const algo = this.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : this.alg === "EdDSA" ? { name: "Ed25519" } : { name: "RSASSA-PKCS1-v1_5" };
    const sig = new Uint8Array(await crypto.subtle.sign(algo, this.keys.privateKey, data as BufferSource));
    return this.alg === "ES256" ? rawToDer(sig) : sig;
  }

  private async authData(rpId: string, flags: number, count: number, attested: boolean): Promise<Uint8Array> {
    const parts = [await sha256(rpId), new Uint8Array([flags]), new Uint8Array([(count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff])];
    if (attested) parts.push(new Uint8Array(16), new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]), this.credentialId, await this.coseKey());
    return concat(...parts);
  }

  private clientData(type: string, challenge: string, o: CeremonyOptions): Uint8Array {
    return utf8(JSON.stringify({ type, challenge, origin: o.origin ?? "https://trooth.co", ...(o.crossOrigin !== undefined ? { crossOrigin: o.crossOrigin } : { crossOrigin: false }) }));
  }

  /** navigator.credentials.create, as PublicKeyCredential.toJSON() gives it. */
  async register(publicKey: CreationOptionsJSON, o: CeremonyOptions & { fmt?: "none" | "packed" | "fido-u2f"; packedAlg?: number } = {}): Promise<{ credential: Record<string, unknown> }> {
    this.userHandle = publicKey.user.id;
    const rpId = o.rpId ?? publicKey.rp.id;
    const flags = o.flags ?? FLAGS.UP | FLAGS.UV | FLAGS.AT;
    const count = this.step === 0 ? 0 : (this.signCount = o.signCount ?? 0);
    const authData = await this.authData(rpId, flags, count, true);
    const clientDataJSON = this.clientData(o.type ?? "webauthn.create", o.challenge ?? publicKey.challenge, o);
    const fmt = o.fmt ?? "none";
    let attStmt = new Map<string, CborIn>();
    if (fmt === "packed") attStmt = new Map<string, CborIn>([["alg", o.packedAlg ?? COSE[this.alg]], ["sig", await this.signBytes(concat(authData, await sha256(clientDataJSON)))]]);
    if (fmt === "fido-u2f") attStmt = new Map<string, CborIn>([["sig", new Uint8Array(8)], ["x5c", [new Uint8Array(8)]]]);
    const attestationObject = cborEncode(new Map<string, CborIn>([["fmt", fmt], ["attStmt", attStmt], ["authData", authData]]));
    return {
      credential: {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        response: { clientDataJSON: toBase64Url(clientDataJSON), attestationObject: toBase64Url(attestationObject), transports: ["internal", "hybrid"] },
        clientExtensionResults: {},
      },
    };
  }

  /** navigator.credentials.get, flat (web/semanto/setup/browser.ts PasskeyAssertion). */
  async assert(publicKey: RequestOptionsJSON, o: CeremonyOptions = {}): Promise<{ id: string; rawId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null }> {
    const rpId = o.rpId ?? publicKey.rpId;
    const flags = o.flags ?? FLAGS.UP | FLAGS.UV;
    let count: number;
    if (o.signCount !== undefined) count = o.signCount;
    else if (this.step === 0) count = 0;
    else count = this.signCount + this.step;
    if (o.signCount === undefined && this.step !== 0) this.signCount = count;
    const authData = await this.authData(rpId, flags, count, false);
    const clientDataJSON = this.clientData(o.type ?? "webauthn.get", o.challenge ?? publicKey.challenge, o);
    const sig = await this.signBytes(concat(authData, await sha256(clientDataJSON)));
    if (o.badSignature) sig[sig.length - 1] = sig[sig.length - 1]! ^ 0x01;
    return { id: this.id, rawId: this.id, clientDataJSON: toBase64Url(clientDataJSON), authenticatorData: toBase64Url(authData), signature: toBase64Url(sig), userHandle: this.userHandle };
  }
}

// ---------------------------------------------------------------- the whole flow over the routes

export type Poster = (path: string, body: unknown, token: string) => Response | Promise<Response>;

/** One software passkey per workspace token, made on first use. */
export class PasskeyWallet {
  readonly byToken = new Map<string, SoftAuthenticator>();
  async for(token: string, alg: SoftAlg = "ES256"): Promise<SoftAuthenticator> {
    let a = this.byToken.get(token);
    if (!a) {
      a = await SoftAuthenticator.create(alg);
      this.byToken.set(token, a);
    }
    return a;
  }
}

/** Add a passkey for this token: passkeys/options, create, passkeys. Answers the POST passkeys response. */
export async function addPasskey(post: Poster, trooth_id: string, token: string, auth: SoftAuthenticator, o: Parameters<SoftAuthenticator["register"]>[1] = {}): Promise<Response> {
  const opts = await post(`/${trooth_id}/passkeys/options`, {}, token);
  if (opts.status !== 200) throw new Error(`passkeys/options answered ${opts.status}: ${await opts.text()}`);
  const { publicKey } = (await opts.json()) as { publicKey: CreationOptionsJSON };
  return post(`/${trooth_id}/passkeys`, await auth.register(publicKey, o), token);
}

/**
 * Sign with a passkey, the way the wizard does: sign/options (adding a
 * passkey first when the answer is passkey_missing), the assertion, then
 * sign with it. Answers the POST sign response.
 */
export async function passkeySign(post: Poster, trooth_id: string, token: string, wallet: PasskeyWallet, body: Record<string, unknown> = {}): Promise<Response> {
  const auth = await wallet.for(token);
  let opts = await post(`/${trooth_id}/sign/options`, body, token);
  if (opts.status === 409) {
    const p = (await opts.clone().json()) as { code?: string };
    if (p.code === "passkey_missing") {
      const added = await addPasskey(post, trooth_id, token, auth);
      if (added.status !== 201) throw new Error(`passkeys answered ${added.status}: ${await added.text()}`);
      opts = await post(`/${trooth_id}/sign/options`, body, token);
    }
  }
  if (opts.status !== 200) return opts;
  const o = (await opts.json()) as { version: number; publicKey: RequestOptionsJSON };
  return post(`/${trooth_id}/sign`, { ...body, version: o.version, assertion: await auth.assert(o.publicKey) }, token);
}
