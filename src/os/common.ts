// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Small pieces every workspace contract module shares: the result helpers
// (the WorkspaceResult shape src/serve/routes.ts signs), the role checks, the
// audit row every write appends (who, role, action, target, before and after
// hashes as sha256 digests of the canonical JSON, request id, time), random
// ids, SHA-256 of single-use tokens, and the queue's retry signal with the
// 30, 120 and 600 second backoff the contract names.

import { canonicalize } from "../core/canonical";
import { digest, sha256Hex } from "../core/hash";
import { toBase64Url, utf8 } from "../core/encoding";
import type { ProblemCode } from "../serve/errors";
import type { WorkspaceAuth, WorkspaceResult, WorkspaceRole } from "../serve/ports";
import type { AuditRow, OsStore } from "./store";

export const iso = (d: Date): string => d.toISOString();
export const ok = (status: number, body: unknown, headers?: Record<string, string>): WorkspaceResult => ({ status, body, ...(headers ? { headers } : {}) });
export const problem = (code: ProblemCode, detail: string): WorkspaceResult => ({ status: 0, problem: { code, detail } });
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Every write in the contract: owner or admin. */
export const mayAdminister = (role: WorkspaceRole): boolean => role === "owner" || role === "admin";
/** Read-only actions that cost work (a DNS lookup, a fetch): owner, admin or member. */
export const mayOperate = (role: WorkspaceRole): boolean => role === "owner" || role === "admin" || role === "member";
export const ADMIN_ONLY = (what: string): WorkspaceResult => problem("forbidden", `Only an owner or admin can ${what}.`);
export const OPERATOR_ONLY = (what: string): WorkspaceResult => problem("forbidden", `A workspace viewer can read but cannot ${what}. Ask an owner, admin or member.`);

/** What a write knows about its request: the id a person quotes to support. */
export interface RequestContext {
  request_id: string;
}

/** The digest of a value's canonical JSON, or null for nothing. */
export async function hashOf(v: unknown): Promise<string | null> {
  if (v === undefined || v === null) return null;
  return digest(canonicalize(v));
}

/** Append one audit row. Secrets never enter it: only the digests of the before and after values do. */
export async function audit(store: OsStore, row: { trooth_id: string; ws: Pick<WorkspaceAuth, "user_id" | "role" | "name"> | { user_id: string; role: AuditRow["role"]; name: string }; action: string; target: string; before?: unknown; after?: unknown; ctx: RequestContext; at: Date }): Promise<void> {
  await store.appendAudit({
    trooth_id: row.trooth_id,
    actor: row.ws.user_id,
    who: row.ws.name,
    role: row.ws.role,
    action: row.action,
    target: row.target,
    before_hash: await hashOf(row.before),
    after_hash: await hashOf(row.after),
    request_id: row.ctx.request_id,
    at: iso(row.at),
  });
}

/** A random id with a prefix: 16 random bytes as base64url. */
export function randomId(prefix: string, random: (n: number) => Uint8Array): string {
  return `${prefix}_${toBase64Url(random(16))}`;
}

/** A secret token for a link or a poll: 32 random bytes as base64url. Only its SHA-256 is kept. */
export function randomToken(random: (n: number) => Uint8Array): string {
  return toBase64Url(random(32));
}

/** The SHA-256 of a token, 64 lowercase hex: what is stored and looked up. */
export function tokenHash(token: string): Promise<string> {
  return sha256Hex(utf8(token));
}

/** Attempts a queue message gets (wrangler.toml max_retries 3, so four in all) before it goes to the dead letter queue. */
export const QUEUE_ATTEMPTS = 4;

/** The queue backoff for a failed send, by the attempt that failed (1, 2, 3): 30, 120, 600 seconds. */
export const BACKOFF_SECONDS = [30, 120, 600] as const;

/** Thrown by a queue job that should run again later; the consumer calls message.retry({ delaySeconds }). */
export class RetryLater extends Error {
  constructor(
    readonly delaySeconds: number,
    message: string,
  ) {
    super(message);
    this.name = "RetryLater";
  }
}

/** The delay for the attempt that just failed (1-based). */
export function backoffFor(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1]!;
}

/** A plain address check: one @, a dot in the domain, no spaces, at most 254 characters (RFC 5321 path limit). */
export function cleanEmail(v: unknown): string | null {
  const s = str(v)?.toLowerCase();
  if (!s || s.length > 254) return null;
  return /^[^\s@<>()",;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s) ? s : null;
}

/** Offset cursors: base64url of the next row's offset. */
export function encodeCursor(offset: number): string {
  return toBase64Url(utf8(JSON.stringify({ o: offset })));
}
export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const o = (JSON.parse(raw) as { o?: unknown }).o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : null;
  } catch {
    return null;
  }
}
