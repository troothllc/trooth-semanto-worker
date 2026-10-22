// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Read receipts: one record per served representation, saying which version
// and page was read, in which format, when, and by which proven key
// directory if the request carried Web Bot Auth. No raw IP is ever stored or
// shown: the receipt keeps a salted hash whose salt rotates every UTC day, so
// two reads on one day from one address correlate and reads on different days
// do not (the daily-rotating-salt practice of privacy-preserving analytics,
// as Plausible and Fathom document it). A signed daily digest per company
// (JWS typ readReceipt) gives the company a statement it can hand to anyone.
//
// The dashboard names a reader only when proof is web_bot_auth, and then by
// its key directory URL (or the published name for that URL). Everything
// else is "unproven reader".

import { canonicalize } from "@/core/canonical";
import { utf8, concat } from "@/core/encoding";
import { digest, sha256Hex } from "@/core/hash";
import { semantoId } from "@/core/ids";
import { JWS_TYPES, signObject, verifyJws } from "@/core/jws";
import type { PrivateJwk, PublicJwk } from "@/core/keys";
import type { Representation } from "@/core/negotiate";
import type { ReceiptRow, ReceiptStore } from "./ports";
import { directoryDisplayName, proofFromResult, type WebBotAuthResult } from "./webbotauth";

export type Receipt = ReceiptRow;

// ---------------------------------------------------------------- the IP hash

/** The UTC day, YYYY-MM-DD. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The day's salt: SHA-256(secret || day). A new one every UTC midnight; the secret never leaves the Worker. */
export async function ipHashSalt(secret: string, day: string): Promise<Uint8Array> {
  if (!secret || secret.length < 16) throw new Error("ipHashSalt: the secret must be at least 16 characters");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("ipHashSalt: day must be YYYY-MM-DD");
  const hex = await sha256Hex(utf8(`${secret}\n${day}`));
  return utf8(hex);
}

/** The stored value: SHA-256(salt || address), 64 hex. The address itself is dropped. */
export async function hashIp(address: string, secret: string, at: Date): Promise<string> {
  const salt = await ipHashSalt(secret, utcDay(at));
  return sha256Hex(concat(salt, utf8("\n"), utf8(normalizeAddress(address))));
}

/** Lowercase, trimmed; an IPv6 zone id is dropped. */
export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase().replace(/%.*$/, "");
}

// ---------------------------------------------------------------- building a receipt

export interface ServedRead {
  trooth_id: string;
  version: number | null;
  page_id: string | null;
  representation: Representation;
  /** The Web Bot Auth result for the request, or null when the request was unsigned. */
  auth: WebBotAuthResult | null;
  read_at: Date;
  /** The remote address. It is hashed here and never kept. */
  address: string;
}

/** The receipt id is the smd_ id of the canonical receipt without its id. */
export async function receiptId(body: Omit<Receipt, "id">): Promise<string> {
  return semantoId("smd", await digest(canonicalize(body)));
}

export async function makeReceipt(read: ServedRead, secret: string): Promise<Receipt> {
  const proof = read.auth ? proofFromResult(read.auth) : { proof: "none" as const, agent_key_url: null, keyid: null };
  const body: Omit<Receipt, "id"> = {
    trooth_id: read.trooth_id,
    version: read.version,
    page_id: read.page_id,
    representation: read.representation,
    agent_key_url: proof.agent_key_url,
    keyid: proof.keyid,
    proof: proof.proof,
    read_at: read.read_at.toISOString(),
    ip_hash: await hashIp(read.address, secret, read.read_at),
  };
  return { id: await receiptId(body), ...body };
}

export async function recordRead(read: ServedRead, secret: string, store: ReceiptStore): Promise<Receipt> {
  const r = await makeReceipt(read, secret);
  await store.put(r);
  return r;
}

// ---------------------------------------------------------------- the daily digest

export interface DailyDigest {
  trooth_id: string;
  /** YYYY-MM-DD, UTC. */
  day: string;
  total: number;
  proven: number;
  unproven: number;
  by_agent: { agent_key_url: string | null; proof: "web_bot_auth" | "none"; count: number }[];
  by_page: { page_id: string | null; count: number }[];
  by_representation: { representation: string; count: number }[];
  /** smd_ ids in read order, so the digest commits to the receipts it counts. */
  receipt_ids: string[];
}

export const DIGEST_VALIDITY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export function dayBounds(day: string): { from: string; to: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error("dayBounds: day must be YYYY-MM-DD");
  return { from: start.toISOString(), to: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() };
}

export function summarize(troothId: string, day: string, receipts: Receipt[]): DailyDigest {
  const { from, to } = dayBounds(day);
  const rows = receipts.filter((r) => r.trooth_id === troothId && r.read_at >= from && r.read_at < to).sort((a, b) => (a.read_at < b.read_at ? -1 : a.read_at > b.read_at ? 1 : a.id < b.id ? -1 : 1));
  const count = <K extends string | null>(key: (r: Receipt) => K): Map<K, number> => {
    const m = new Map<K, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };
  const agents = new Map<string, { agent_key_url: string | null; proof: "web_bot_auth" | "none"; count: number }>();
  for (const r of rows) {
    const k = r.proof === "web_bot_auth" && r.agent_key_url ? `p:${r.agent_key_url}` : "u";
    const e = agents.get(k) ?? { agent_key_url: r.proof === "web_bot_auth" ? r.agent_key_url : null, proof: r.proof === "web_bot_auth" ? "web_bot_auth" : "none", count: 0 };
    e.count++;
    agents.set(k, e);
  }
  const sortDesc = <T extends { count: number }>(xs: T[]) => xs.sort((a, b) => b.count - a.count);
  return {
    trooth_id: troothId,
    day,
    total: rows.length,
    proven: rows.filter((r) => r.proof === "web_bot_auth").length,
    unproven: rows.filter((r) => r.proof !== "web_bot_auth").length,
    by_agent: sortDesc([...agents.values()]),
    by_page: sortDesc([...count((r) => r.page_id)].map(([page_id, c]) => ({ page_id, count: c }))),
    by_representation: sortDesc([...count((r) => r.representation)].map(([representation, c]) => ({ representation, count: c }))),
    receipt_ids: rows.map((r) => r.id),
  };
}

export async function signDailyDigest(troothId: string, day: string, receipts: Receipt[], key: PrivateJwk, signedAt: Date = new Date()): Promise<{ digest: DailyDigest; jws: string }> {
  const d = summarize(troothId, day, receipts);
  const { from } = dayBounds(day);
  const jws = await signObject(d, key, JWS_TYPES.readReceipt, { iat: signedAt, nbf: new Date(from), exp: new Date(signedAt.getTime() + DIGEST_VALIDITY_MS) });
  return { digest: d, jws: jws.compact };
}

export async function verifyDailyDigest(jws: string, key: PublicJwk, at: Date = new Date()): Promise<{ ok: true; digest: DailyDigest } | { ok: false; reason: string }> {
  const v = await verifyJws(jws, (kid) => (kid === key.kid ? key : null), { expectTyp: JWS_TYPES.readReceipt, at });
  if (!v.ok) return { ok: false, reason: v.reason };
  const d = v.payload as Partial<DailyDigest>;
  if (typeof d.trooth_id !== "string" || typeof d.day !== "string" || !Array.isArray(d.by_agent)) return { ok: false, reason: "malformed" };
  return { ok: true, digest: d as DailyDigest };
}

// ---------------------------------------------------------------- the dashboard view

export interface DashboardRow {
  /** The published name for the directory, its host, or "unproven reader". */
  reader: string;
  agent_key_url: string | null;
  proof: "web_bot_auth" | "none";
  reads: number;
  pages: number;
  last_read_at: string;
}

/** What the company sees. A name appears only behind a proven signature; everything else is one "unproven reader" row. */
export function dashboardRows(receipts: Receipt[], known?: Record<string, string>): DashboardRow[] {
  const rows = new Map<string, DashboardRow & { pageSet: Set<string> }>();
  for (const r of receipts) {
    const proven = r.proof === "web_bot_auth" && r.agent_key_url !== null;
    const key = proven ? `p:${r.agent_key_url}` : "u";
    const e = rows.get(key) ?? {
      reader: directoryDisplayName(proven ? r.agent_key_url : null, proven ? "web_bot_auth" : "none", known),
      agent_key_url: proven ? r.agent_key_url : null,
      proof: proven ? "web_bot_auth" : "none",
      reads: 0,
      pages: 0,
      last_read_at: r.read_at,
      pageSet: new Set<string>(),
    };
    e.reads++;
    if (r.page_id) e.pageSet.add(r.page_id);
    if (r.read_at > e.last_read_at) e.last_read_at = r.read_at;
    rows.set(key, e);
  }
  return [...rows.values()]
    .map(({ pageSet, ...rest }) => ({ ...rest, pages: pageSet.size }))
    .sort((a, b) => b.reads - a.reads);
}

// ---------------------------------------------------------------- CSV export

export const CSV_COLUMNS = ["id", "trooth_id", "version", "page_id", "representation", "agent_key_url", "keyid", "proof", "read_at", "ip_hash"] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // A cell starting with =, +, -, @ is prefixed so a spreadsheet does not run it (OWASP CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV, one row per receipt, CRLF line ends, a header row. The ip_hash column is the salted hash, never an address. */
export function receiptsCsv(receipts: Receipt[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of receipts) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
