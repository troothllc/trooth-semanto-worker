// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Third-party time for a tree head. Two anchors, so a tree head's time holds
// without Trooth:
//
//   1. RFC 3161 Time-Stamp Protocol. A TimeStampReq over the tree head's root
//      hash (SHA-256 message imprint, certReq true, a random nonce), DER
//      encoded here by hand so the module has no dependency, is sent to a TSA
//      (Env.TSA_URL) as application/timestamp-query. The TimeStampResp is
//      parsed back to its TSTInfo: genTime, the message imprint, the nonce,
//      the policy and the serial number. The imprint must match what was
//      asked for or the token is refused. The CMS signature over TSTInfo is
//      NOT checked here (it needs the TSA's X.509 chain); the result says so
//      in `signature_checked: false` and the token bytes are kept so a later
//      check can be made with openssl ts -verify.
//   2. A cosignature from a second log or witness, in the form Sigsum and the
//      transparency.dev witness protocol use: a signature over the checkpoint
//      body. prepareCosignatureLeaf builds the record an outside log can
//      countersign; acceptCosignature checks what came back.
//
// DER follows ITU-T X.690; the ASN.1 follows RFC 3161 section 2.4 and RFC 5652
// (CMS) for the token envelope.

import { concat, toBase64, toHex, utf8 } from "@/core/encoding";
import { digest, digestBytes, isDigest } from "@/core/hash";
import { canonicalize } from "@/core/canonical";
import { importPublic, verify as rawVerify, type PublicJwk } from "@/core/keys";
import { checkpointBody, LOG_ORIGIN, noteKeyHash, treeHeadId, type TreeHead } from "./log";
import type { FetchPort } from "./ports";

// ---------------------------------------------------------------- DER encoding

const T_BOOLEAN = 0x01;
const T_INTEGER = 0x02;
const T_OCTET_STRING = 0x04;
const T_NULL = 0x05;
const T_OID = 0x06;
const T_GENERALIZED_TIME = 0x18;
const T_SEQUENCE = 0x30;
const T_SET = 0x31;
const T_CONTEXT_0 = 0xa0;

export function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function derTlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(content.length), content);
}

export const derSequence = (...items: Uint8Array[]): Uint8Array => derTlv(T_SEQUENCE, concat(...items));
export const derSet = (...items: Uint8Array[]): Uint8Array => derTlv(T_SET, concat(...items));
export const derOctetString = (b: Uint8Array): Uint8Array => derTlv(T_OCTET_STRING, b);
export const derNull = (): Uint8Array => new Uint8Array([T_NULL, 0x00]);
export const derBoolean = (v: boolean): Uint8Array => new Uint8Array([T_BOOLEAN, 0x01, v ? 0xff : 0x00]);
export const derExplicit0 = (inner: Uint8Array): Uint8Array => derTlv(T_CONTEXT_0, inner);

/** An INTEGER from unsigned big-endian bytes (a leading 0x00 is added when the top bit is set). */
export function derIntegerBytes(unsigned: Uint8Array): Uint8Array {
  let i = 0;
  while (i < unsigned.length - 1 && unsigned[i] === 0) i++;
  const trimmed = unsigned.slice(i);
  const body = trimmed.length === 0 ? new Uint8Array([0]) : (trimmed[0]! & 0x80) !== 0 ? concat(new Uint8Array([0]), trimmed) : trimmed;
  return derTlv(T_INTEGER, body);
}

export function derInteger(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error("derInteger: non-negative integers only");
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return derIntegerBytes(new Uint8Array(bytes));
}

export function derOid(oid: string): Uint8Array {
  const parts = oid.split(".").map((x) => Number(x));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error("derOid: malformed oid");
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const enc: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      enc.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...enc);
  }
  return derTlv(T_OID, new Uint8Array(out));
}

/** YYYYMMDDHHMMSSZ, the GeneralizedTime form RFC 3161 requires (UTC, seconds, optional fractions). */
export function derGeneralizedTime(d: Date): Uint8Array {
  const s = d.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z");
  return derTlv(T_GENERALIZED_TIME, utf8(s));
}

// ---------------------------------------------------------------- DER decoding

export interface DerNode {
  tag: number;
  /** Byte offset of the tag in the parent buffer. */
  start: number;
  /** Content bytes. */
  content: Uint8Array;
  /** Whole TLV bytes. */
  raw: Uint8Array;
  /** Byte offset just after this TLV. */
  end: number;
}

export function derRead(buf: Uint8Array, offset = 0): DerNode {
  if (offset >= buf.length) throw new Error("derRead: past the end");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("derRead: multi-byte tags are not used here");
  let i = offset + 1;
  if (i >= buf.length) throw new Error("derRead: truncated length");
  let len = buf[i]!;
  i++;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("derRead: indefinite or oversized length");
    len = 0;
    for (let k = 0; k < n; k++) {
      if (i >= buf.length) throw new Error("derRead: truncated length");
      len = len * 256 + buf[i]!;
      i++;
    }
  }
  if (i + len > buf.length) throw new Error("derRead: content runs past the end");
  return { tag, start: offset, content: buf.slice(i, i + len), raw: buf.slice(offset, i + len), end: i + len };
}

/** The children of a constructed node, in order. */
export function derChildren(node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let off = 0;
  while (off < node.content.length) {
    const c = derRead(node.content, off);
    out.push(c);
    off = c.end;
  }
  return out;
}

export function derOidToString(content: Uint8Array): string {
  if (content.length === 0) throw new Error("derOidToString: empty");
  const first = content[0]!;
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < content.length; i++) {
    v = v * 128 + (content[i]! & 0x7f);
    if ((content[i]! & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

export function derIntegerToNumber(content: Uint8Array): number {
  let v = 0;
  for (const b of content) v = v * 256 + b;
  return v;
}

export function parseGeneralizedTime(content: Uint8Array): string {
  const s = new TextDecoder().decode(content);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error(`parseGeneralizedTime: not a UTC GeneralizedTime: ${s}`);
  const frac = m[7] ? `.${m[7].slice(0, 3).padEnd(3, "0")}` : ".000";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}Z`;
}

// ---------------------------------------------------------------- RFC 3161 request

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
export const TSQ_MEDIA = "application/timestamp-query";
export const TSR_MEDIA = "application/timestamp-reply";

export interface TimeStampRequest {
  /** DER bytes of the TimeStampReq. */
  der: Uint8Array;
  /** The nonce as hex, kept to match the response. */
  nonce_hex: string;
  /** The hashed message, "sha256:" plus 64 hex. */
  imprint: string;
}

export function messageImprintDer(hash: Uint8Array): Uint8Array {
  return derSequence(derSequence(derOid(OID_SHA256), derNull()), derOctetString(hash));
}

/**
 * TimeStampReq ::= SEQUENCE { version INTEGER (1), messageImprint, nonce INTEGER, certReq BOOLEAN TRUE }.
 * The hash is the tree head root digest; a nonce of 8 random bytes ties the answer to this request.
 */
export function buildTimeStampRequest(rootHash: string, nonce?: Uint8Array): TimeStampRequest {
  if (!isDigest(rootHash)) throw new Error("buildTimeStampRequest: root hash must be a digest");
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(8));
  const der = derSequence(derInteger(1), messageImprintDer(digestBytes(rootHash)), derIntegerBytes(n), derBoolean(true));
  return { der, nonce_hex: toHex(n), imprint: rootHash };
}

export interface DecodedRequest {
  version: number;
  hash_oid: string;
  imprint: string;
  nonce_hex: string | null;
  cert_req: boolean;
}

/** Decode a TimeStampReq back, for tests and for showing what was sent. */
export function decodeTimeStampRequest(der: Uint8Array): DecodedRequest {
  const top = derRead(der);
  if (top.tag !== T_SEQUENCE) throw new Error("decodeTimeStampRequest: not a SEQUENCE");
  const [version, imprint, ...rest] = derChildren(top);
  if (!version || version.tag !== T_INTEGER) throw new Error("decodeTimeStampRequest: version missing");
  if (!imprint || imprint.tag !== T_SEQUENCE) throw new Error("decodeTimeStampRequest: messageImprint missing");
  const mi = readImprint(imprint);
  let nonce_hex: string | null = null;
  let cert_req = false;
  for (const r of rest) {
    if (r.tag === T_INTEGER) nonce_hex = toHex(stripLeadingZero(r.content));
    else if (r.tag === T_BOOLEAN) cert_req = r.content[0] !== 0;
  }
  return { version: derIntegerToNumber(version.content), hash_oid: mi.oid, imprint: mi.imprint, nonce_hex, cert_req };
}

const normalizeHex = (h: string): string => h.toLowerCase().replace(/^0+(?=.)/, "");

function stripLeadingZero(b: Uint8Array): Uint8Array {
  return b.length > 1 && b[0] === 0 && (b[1]! & 0x80) !== 0 ? b.slice(1) : b;
}

function readImprint(node: DerNode): { oid: string; imprint: string } {
  const [alg, hashed] = derChildren(node);
  if (!alg || alg.tag !== T_SEQUENCE || !hashed || hashed.tag !== T_OCTET_STRING) throw new Error("messageImprint: malformed");
  const [oidNode] = derChildren(alg);
  if (!oidNode || oidNode.tag !== T_OID) throw new Error("messageImprint: no algorithm oid");
  const oid = derOidToString(oidNode.content);
  if (oid !== OID_SHA256) throw new Error(`messageImprint: hash algorithm ${oid} is not SHA-256`);
  if (hashed.content.length !== 32) throw new Error("messageImprint: SHA-256 imprint must be 32 bytes");
  return { oid, imprint: `sha256:${toHex(hashed.content)}` };
}

// ---------------------------------------------------------------- RFC 3161 response

export type TsaStatus = "granted" | "grantedWithMods" | "rejection" | "waiting" | "revocationWarning" | "revocationNotification";
const STATUS_WORDS: TsaStatus[] = ["granted", "grantedWithMods", "rejection", "waiting", "revocationWarning", "revocationNotification"];

export interface TimeStampToken {
  status: TsaStatus;
  /** ISO 8601 UTC from TSTInfo.genTime. */
  gen_time: string;
  imprint: string;
  nonce_hex: string | null;
  policy: string;
  serial_hex: string;
  /** The whole TimeStampToken (CMS ContentInfo) DER, kept for a later signature check. */
  token: Uint8Array;
  /** Always false here: the CMS signature needs the TSA certificate chain. */
  signature_checked: false;
}

export type TimeStampParse = { ok: true; token: TimeStampToken } | { ok: false; reason: string; status?: TsaStatus };

/** Parse a TimeStampResp and refuse it unless the imprint (and nonce, when given) match the request. */
export function parseTimeStampResponse(der: Uint8Array, expected: { imprint: string; nonce_hex?: string }): TimeStampParse {
  try {
    const top = derRead(der);
    if (top.tag !== T_SEQUENCE) return { ok: false, reason: "response is not a SEQUENCE" };
    const [statusInfo, tokenNode] = derChildren(top);
    if (!statusInfo || statusInfo.tag !== T_SEQUENCE) return { ok: false, reason: "no PKIStatusInfo" };
    const [statusInt] = derChildren(statusInfo);
    if (!statusInt || statusInt.tag !== T_INTEGER) return { ok: false, reason: "no status" };
    const status = STATUS_WORDS[derIntegerToNumber(statusInt.content)];
    if (!status) return { ok: false, reason: "unknown status" };
    if (status !== "granted" && status !== "grantedWithMods") return { ok: false, reason: `the authority answered ${status}`, status };
    if (!tokenNode || tokenNode.tag !== T_SEQUENCE) return { ok: false, reason: "granted but no token", status };
    // ContentInfo { contentType, [0] EXPLICIT SignedData }
    const [ctype, wrapped] = derChildren(tokenNode);
    if (!ctype || ctype.tag !== T_OID || derOidToString(ctype.content) !== OID_SIGNED_DATA) return { ok: false, reason: "token is not CMS SignedData", status };
    if (!wrapped || wrapped.tag !== T_CONTEXT_0) return { ok: false, reason: "token content missing", status };
    const [signedData] = derChildren(wrapped);
    if (!signedData || signedData.tag !== T_SEQUENCE) return { ok: false, reason: "SignedData malformed", status };
    // SignedData { version, digestAlgorithms SET, encapContentInfo SEQUENCE, and the rest }
    const sdChildren = derChildren(signedData);
    const encap = sdChildren.find((c, i) => i >= 2 && c.tag === T_SEQUENCE);
    if (!encap) return { ok: false, reason: "no EncapsulatedContentInfo", status };
    const [eType, eContent] = derChildren(encap);
    if (!eType || eType.tag !== T_OID || derOidToString(eType.content) !== OID_TST_INFO) return { ok: false, reason: "token content is not TSTInfo", status };
    if (!eContent || eContent.tag !== T_CONTEXT_0) return { ok: false, reason: "TSTInfo is detached", status };
    const [octets] = derChildren(eContent);
    if (!octets || octets.tag !== T_OCTET_STRING) return { ok: false, reason: "TSTInfo is not an OCTET STRING", status };
    const tst = derRead(octets.content);
    if (tst.tag !== T_SEQUENCE) return { ok: false, reason: "TSTInfo malformed", status };
    const [v, policy, imprint, serial, genTime, ...rest] = derChildren(tst);
    if (!v || !policy || policy.tag !== T_OID || !imprint || !serial || serial.tag !== T_INTEGER || !genTime || genTime.tag !== T_GENERALIZED_TIME) return { ok: false, reason: "TSTInfo fields missing", status };
    const mi = readImprint(imprint);
    if (mi.imprint !== expected.imprint) return { ok: false, reason: "the message imprint in the token is not the hash that was sent", status };
    let nonce_hex: string | null = null;
    for (const r of rest) if (r.tag === T_INTEGER) nonce_hex = toHex(stripLeadingZero(r.content));
    if (expected.nonce_hex !== undefined && (nonce_hex === null || normalizeHex(nonce_hex) !== normalizeHex(expected.nonce_hex))) return { ok: false, reason: "the nonce in the token is not the one that was sent", status };
    return {
      ok: true,
      token: {
        status,
        gen_time: parseGeneralizedTime(genTime.content),
        imprint: mi.imprint,
        nonce_hex,
        policy: derOidToString(policy.content),
        serial_hex: toHex(serial.content),
        token: tokenNode.raw,
        signature_checked: false,
      },
    };
  } catch (e) {
    return { ok: false, reason: `could not parse the response: ${(e as Error).message}` };
  }
}

/** Build a TimeStampResp for tests and fixtures: status granted, a TSTInfo over the imprint. Not a real token; no signature. */
export function buildTestTimeStampResponse(opts: { imprint: string; nonce?: Uint8Array; genTime: Date; policy?: string; serial?: number; status?: number }): Uint8Array {
  const statusInfo = derSequence(derInteger(opts.status ?? 0));
  if (opts.status !== undefined && opts.status !== 0 && opts.status !== 1) return derSequence(statusInfo);
  const tstInfo = derSequence(
    derInteger(1),
    derOid(opts.policy ?? "1.3.6.1.4.1.0.0"),
    messageImprintDer(digestBytes(opts.imprint)),
    derInteger(opts.serial ?? 1),
    derGeneralizedTime(opts.genTime),
    ...(opts.nonce ? [derIntegerBytes(opts.nonce)] : []),
  );
  const encap = derSequence(derOid(OID_TST_INFO), derExplicit0(derOctetString(tstInfo)));
  const signedData = derSequence(derInteger(3), derSet(derSequence(derOid(OID_SHA256), derNull())), encap, derSet());
  const token = derSequence(derOid(OID_SIGNED_DATA), derExplicit0(signedData));
  return derSequence(statusInfo, token);
}

// ---------------------------------------------------------------- the round trip

export interface TimestampResult {
  ok: boolean;
  reason?: string;
  request: TimeStampRequest;
  token?: TimeStampToken;
  /** Where a stored token would live: semanto/log/tsa/<tree size>.tsr */
  token_key: string;
}

export const tsaTokenKey = (treeSize: number): string => `semanto/log/tsa/${treeSize}.tsr`;

/** Ask a TSA for a time on a tree head's root hash. */
export async function timestampTreeHead(head: TreeHead, tsaUrl: string, port: FetchPort, nonce?: Uint8Array): Promise<TimestampResult> {
  const request = buildTimeStampRequest(head.root_hash, nonce);
  const token_key = tsaTokenKey(head.tree_size);
  let res: Awaited<ReturnType<FetchPort["fetch"]>>;
  try {
    res = await port.fetch(tsaUrl, { method: "POST", headers: { "content-type": TSQ_MEDIA, accept: TSR_MEDIA }, body: request.der });
  } catch (e) {
    return { ok: false, reason: `the time-stamp authority could not be reached: ${(e as Error).message}`, request, token_key };
  }
  if (res.status !== 200) return { ok: false, reason: `the time-stamp authority answered HTTP ${res.status}`, request, token_key };
  const parsed = parseTimeStampResponse(res.body, { imprint: request.imprint, nonce_hex: request.nonce_hex });
  if (!parsed.ok) return { ok: false, reason: parsed.reason, request, token_key };
  return { ok: true, request, token: parsed.token, token_key };
}

// ---------------------------------------------------------------- alternate anchor: a cosignature from another log

/** A record an outside log can take as a leaf and countersign. Plain fields, canonical JSON, one digest. */
export interface CosignatureLeaf {
  kind: "witness_cosignature";
  origin: typeof LOG_ORIGIN;
  tree_size: number;
  root_hash: string;
  /** smt_ id of the tree head. */
  tree_head_id: string;
  /** The exact checkpoint body a cosigner signs. */
  checkpoint_body: string;
  signed_at: string;
}

export async function prepareCosignatureLeaf(head: TreeHead): Promise<{ leaf: CosignatureLeaf; bytes: Uint8Array; hash: string; body_base64: string }> {
  const checkpoint_body = checkpointBody({ origin: LOG_ORIGIN, tree_size: head.tree_size, root_hash: head.root_hash });
  const leaf: CosignatureLeaf = {
    kind: "witness_cosignature",
    origin: LOG_ORIGIN,
    tree_size: head.tree_size,
    root_hash: head.root_hash,
    tree_head_id: await treeHeadId(head),
    checkpoint_body,
    signed_at: head.signed_at,
  };
  const bytes = utf8(canonicalize(leaf));
  return { leaf, bytes, hash: await digest(bytes), body_base64: toBase64(utf8(checkpoint_body)) };
}

/**
 * A cosignature in the transparency.dev witness form: Ed25519 over
 * "cosignature/v1\ntime <unix seconds>\n" followed by the checkpoint body.
 * (c2sp.org/tlog-cosignature.) Returns the signature line to append to the
 * checkpoint when it verifies.
 */
export function cosignatureMessage(body: string, unixSeconds: number): Uint8Array {
  return utf8(`cosignature/v1\ntime ${unixSeconds}\n${body}`);
}

export async function acceptCosignature(
  body: string,
  cosigner: { name: string; key: PublicJwk },
  signature: Uint8Array,
  unixSeconds: number,
): Promise<{ ok: true; line: string } | { ok: false; reason: string }> {
  const ok = await rawVerify(await importPublic(cosigner.key), signature, cosignatureMessage(body, unixSeconds));
  if (!ok) return { ok: false, reason: `the cosignature by ${cosigner.name} does not verify over this checkpoint` };
  const kh = await noteKeyHash(cosigner.name, cosigner.key);
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(unixSeconds));
  return { ok: true, line: `— ${cosigner.name} ${toBase64(concat(kh, ts, signature))}` };
}
