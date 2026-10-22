// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Type declarations for verify.mjs, so TypeScript callers (the repository's
// tests, trooth-web) get typed results. The module itself stays plain
// JavaScript so a browser can load it with no build step.

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Result {
  ok: boolean;
  reason: string | null;
  checks: Check[];
  /** Sentences a reader can weigh that do not fail the check, such as "key revoked after signing on <date>". */
  notes: string[];
}

export interface Jwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  alg?: string;
  use?: string;
  nbf?: string;
  exp?: string;
  revoked_at?: string;
}

export interface Jwks {
  keys: Jwk[];
}

/**
 * Keys by role ({ company, trooth, agent }, the keys.json vector shape) or a
 * plain JWK Set. Company signatures resolve only against `company`; witness
 * statements, tree heads, checkpoints and revocation lists only against
 * `trooth`; Web Bot Auth requests only against `agent`.
 */
export type KeySource = Jwks | Jwk | Jwks[] | { jwks: Jwks } | { company?: unknown; trooth?: unknown; agent?: unknown } | Record<string, unknown> | undefined | null;

export type JwsResult = { ok: true; header: Record<string, string>; payload: unknown; notes: string[] } | { ok: false; reason: string };

export type MessageResult =
  | { ok: true; label: string; keyid: string; params: { created: number; expires?: number; keyid: string; alg?: string; nonce?: string; tag?: string }; components: string[]; notes: string[] }
  | { ok: false; reason: string };

export interface VerifyOptions {
  now?: Date | string | number;
  revocations?: unknown;
  latest?: number | null;
  tag?: string;
  required?: string[];
  maxAgeSeconds?: number;
  skewSeconds?: number;
  /** verifyPageProof: accept a proof with no witness statement ("absent" does not fail). */
  allowUnwitnessed?: boolean;
  /** verifyPageProof: accept a proof with no log entry ("absent" does not fail). */
  allowUnlogged?: boolean;
}

export const JWS_TYPES: Record<string, string>;
export const SEMANTO_RESPONSE_COMPONENTS: string[];
export const SEMANTO_RESPONSE_OPTIONAL_COMPONENTS: string[];
export const SEMANTO_RESPONSE_MUST_COVER_WHEN_PRESENT: string[];
export const TROOTH_LOG_SIGNER_NAME: string;
export const TROOTH_LOG_ORIGIN: string;
export const SEMANTO_RESPONSE_TAG: string;
export const WEB_BOT_AUTH_TAG: string;
export const DIGEST_RE: RegExp;

export function utf8(s: string): Uint8Array;
export function fromUtf8(b: Uint8Array): string;
export function toHex(b: Uint8Array): string;
export function fromHex(h: string): Uint8Array;
export function toBase64(b: Uint8Array): string;
export function fromBase64(s: string): Uint8Array;
export function toBase64Url(b: Uint8Array): string;
export function fromBase64Url(s: string): Uint8Array;
export function concat(...parts: Uint8Array[]): Uint8Array;
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean;
export function canonicalize(v: unknown): string;
export function sha256(data: Uint8Array | string): Promise<Uint8Array>;
export function sha256Hex(data: Uint8Array | string): Promise<string>;
export function digest(data: Uint8Array | string): Promise<string>;
export function isDigest(v: unknown): boolean;
export function digestBytes(d: string): Uint8Array;
export function semantoId(prefix: string, digest: string): string;
export function leafHash(data: Uint8Array): Promise<Uint8Array>;
export function nodeHash(l: Uint8Array, r: Uint8Array): Promise<Uint8Array>;
export function rootFromLeafHashes(leaves: Uint8Array[]): Promise<Uint8Array>;
export function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], root: Uint8Array): Promise<boolean>;
export function verifyConsistencyProof(oldSize: number, newSize: number, oldRoot: Uint8Array, newRoot: Uint8Array, proof: Uint8Array[]): Promise<boolean>;
export function importPublic(jwk: { x: string }): Promise<CryptoKey>;
export function ed25519Verify(jwk: { x: string }, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
export function thumbprint(jwk: { kty: string; crv: string; x: string }): Promise<string>;
export function keyResolver(keys: KeySource): (kid: string) => Jwk | null;
export function hasRoles(keys: KeySource): boolean;
export function roleKeys(keys: KeySource, role: "company" | "trooth" | "agent"): Jwk[];
export function roleResolver(keys: KeySource, role: "company" | "trooth" | "agent"): (kid: string) => Jwk | null;
export function keyValidAt(jwk: Jwk, at: Date): { ok: true } | { ok: false; reason: string };
export function keyValidAtSigning(jwk: Jwk, iatMs: number): { ok: true; notes: string[] } | { ok: false; reason: string };
export function parseDnsKeyRecords(txt: string[]): string[];
export function verifyJws(jws: string, resolveKey: (kid: string) => Jwk | null | Promise<Jwk | null>, opts?: { expectTyp?: string; payload?: unknown; at?: Date }): Promise<JwsResult>;
export function parseSignatureInput(value: string): Record<string, { components: string[]; params: Record<string, unknown>; raw: string }>;
export function parseSignature(value: string): Record<string, Uint8Array>;
export function signatureBase(m: { kind: string; method?: string; url?: string; status?: number; headers: Record<string, string> }, components: string[], rawParams: string): string;
export function verifyContentDigest(header: string | null, body: Uint8Array | string): Promise<boolean>;
export function verifyMessage(m: { kind: "request" | "response"; method?: string; url?: string; status?: number; headers: Record<string, string> }, opts: { resolveKey: (kid: string) => Jwk | null | Promise<Jwk | null>; required?: string[]; tag?: string; now?: number; maxAgeSeconds?: number; skewSeconds?: number; label?: string }): Promise<MessageResult>;
export function pagesRoot(manifest: { hash: string }[]): Promise<string>;
export function factsRoot(facts: { id: string }[]): Promise<string>;
export function tierHash(value: unknown): Promise<string>;
export function rootHash(header: unknown): Promise<string>;
export function versionId(root: string): string;
export function factId(fact: { id?: string }): Promise<string>;
export function stateOf(version: unknown, now?: Date | string, revocations?: unknown, latest?: number | null): string;
export function verifySemanto(file: unknown, pageBytesByUrl?: Record<string, Uint8Array | string> | ((entry: { url: string; id: string }) => Promise<Uint8Array | null> | Uint8Array | null), keys?: KeySource, opts?: VerifyOptions): Promise<Result & { issues: { path: string; message: string }[]; state?: string; version_id?: string | null }>;
export function verifyPageProof(proof: unknown, pageBytes: Uint8Array | string, keys?: KeySource, opts?: VerifyOptions & { header?: unknown }): Promise<Result & { version_id?: string | null }>;
export function verifyResponse(status: number, headers: Record<string, string>, body: Uint8Array | string, keys?: KeySource, opts?: VerifyOptions): Promise<Result & { keyid: string | null; params: Record<string, unknown> | null; signed_by: "company" | "trooth"; version: string | null; page_hash: string | null; signed_page_hash: string | null }>;
export function verifyWebBotAuthRequest(method: string, url: string, headers: Record<string, string>, keys?: KeySource, opts?: VerifyOptions): Promise<MessageResult & { agent?: string }>;
export function verifyTreeHead(treeHead: string | { payload?: unknown; jws?: string; tree_head_jws?: string }, keys?: KeySource, opts?: VerifyOptions): Promise<{ ok: true; kid: string; payload: { tree_size: number; root_hash: string; signed_at?: string }; tree_size: number; root_hash: string; signed_at?: string } | { ok: false; reason: string }>;
export function verifyInclusionInLog(proof: { leaf_hash?: string; leaf?: unknown; index: number; tree_size: number; path?: string[]; inclusion_path?: string[]; root_hash?: string }, rootHashOverride?: string): Promise<boolean>;
export function verifyConsistency(proof: { from: number; to: number; old_root: string; new_root: string; path: string[] }): Promise<boolean>;
export function verifyCheckpoint(text: string, keys?: KeySource, expectedOrigin?: string, expectedName?: string): Promise<{ ok: true; origin: string; name: string; tree_size: number; root_hash: string; kid: string } | { ok: false; reason: string }>;
export function verifyOffer(jws: string, keys?: KeySource, opts?: VerifyOptions): Promise<JwsResult & { offer_id?: string }>;
export function verifyRevocationList(jws: string, keys?: KeySource, opts?: VerifyOptions): Promise<JwsResult>;
export function parseLink(value: string | null | undefined): { url: string; params: Record<string, string> }[];
