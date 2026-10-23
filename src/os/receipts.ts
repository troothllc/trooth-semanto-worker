// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Read receipts for the dashboard table and its CSV (contract section 1c):
// filters by date range (at most 92 days, the quarter Google Search Console's
// performance report and Cloudflare's analytics both default their wider
// views to), agent (operator name), path prefix and status (signed_agent or
// unsigned), an opaque cursor and a page size of 1 to 200. Rows are per day,
// agent and path. An agent is named only behind a proven Web Bot Auth key
// (src/readers/webbotauth.ts directoryDisplayName); every other read is one
// "unproven reader". The CSV has a fixed header and every cell that starts
// with = + - @ (or a tab or carriage return) is prefixed with a single quote,
// the OWASP guard against CSV injection.

import type { ReceiptRow } from "../readers/ports";
import { directoryDisplayName } from "../readers/webbotauth";
import type { WorkspaceResult } from "../serve/ports";
import { decodeCursor, encodeCursor, ok, problem } from "./common";
import type { OsService } from "./service";

export const MAX_RANGE_DAYS = 92;
export const WHOLE_FILE_PATH = "(whole file)";
export const RECEIPT_CSV_HEADER = ["day", "agent", "operator", "path", "reads", "signed", "last_at"] as const;

export interface ReceiptQuery {
  from: string;
  to: string;
  agent?: string;
  path?: string;
  status?: "signed_agent" | "unsigned";
  offset: number;
  limit: number;
}

export interface ReceiptTableRow {
  day: string;
  agent: string;
  operator: string | null;
  path: string;
  reads: number;
  signed: boolean;
  last_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

/** Read and check the query; a sentence for the first problem. */
export function parseReceiptQuery(q: Record<string, string>, now: Date, opts: { paged: boolean }): ReceiptQuery | { error: string } {
  const today = now.toISOString().slice(0, 10);
  const to = q.to ?? today;
  const from = q.from ?? new Date(dayMs(to) - 6 * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(from) || Number.isNaN(dayMs(from))) return { error: "from is a day, YYYY-MM-DD." };
  if (!DAY.test(to) || Number.isNaN(dayMs(to))) return { error: "to is a day, YYYY-MM-DD." };
  if (dayMs(from) > dayMs(to)) return { error: "from must be on or before to." };
  if ((dayMs(to) - dayMs(from)) / 86_400_000 > MAX_RANGE_DAYS) return { error: `Ask for at most ${MAX_RANGE_DAYS} days at a time.` };
  if (q.status !== undefined && q.status !== "signed_agent" && q.status !== "unsigned") return { error: "status is signed_agent or unsigned." };
  if (q.agent !== undefined && (q.agent.length === 0 || q.agent.length > 200)) return { error: "agent is an operator name of at most 200 characters." };
  if (q.path !== undefined && (q.path.length === 0 || q.path.length > 2000)) return { error: "path is a path prefix of at most 2000 characters." };
  let limit = 50;
  if (q.limit !== undefined) {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 200) return { error: "limit is a whole number from 1 to 200." };
    limit = Number(q.limit);
  }
  const offset = opts.paged ? decodeCursor(q.cursor) : 0;
  if (offset === null) return { error: "cursor is not one this server gave. Start again without a cursor." };
  return { from, to, ...(q.agent ? { agent: q.agent } : {}), ...(q.path ? { path: q.path } : {}), ...(q.status ? { status: q.status } : {}), offset, limit: opts.paged ? limit : Number.MAX_SAFE_INTEGER };
}

function operatorOf(r: ReceiptRow): string | null {
  if (r.proof !== "web_bot_auth" || !r.agent_key_url) return null;
  try {
    return new URL(r.agent_key_url).host;
  } catch {
    return null;
  }
}

/** Group receipts per day, agent and path, newest day first, most reads first. Pure. */
export function receiptTable(rows: ReceiptRow[], pathOf: (r: ReceiptRow) => string): { rows: ReceiptTableRow[]; agents: string[] } {
  const groups = new Map<string, ReceiptTableRow>();
  const agents = new Set<string>();
  for (const r of rows) {
    const signed = r.proof === "web_bot_auth" && r.agent_key_url !== null;
    const agent = directoryDisplayName(signed ? r.agent_key_url : null, signed ? "web_bot_auth" : "none");
    agents.add(agent);
    const day = r.read_at.slice(0, 10);
    const path = pathOf(r);
    const key = `${day}\n${agent}\n${path}`;
    const g = groups.get(key) ?? { day, agent, operator: signed ? operatorOf(r) : null, path, reads: 0, signed, last_at: r.read_at };
    g.reads += r.count ?? 1;
    if (r.read_at > g.last_at) g.last_at = r.read_at;
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || b.reads - a.reads || a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));
  return { rows: sorted, agents: [...agents].sort() };
}

/** The filters past the date range. */
export function filterRows(rows: ReceiptTableRow[], q: ReceiptQuery): ReceiptTableRow[] {
  const a = q.agent?.toLowerCase();
  return rows.filter((r) => (!a || r.agent.toLowerCase() === a || (r.operator ?? "").toLowerCase() === a) && (!q.path || r.path.startsWith(q.path)) && (!q.status || (q.status === "signed_agent" ? r.signed : !r.signed)));
}

/** A CSV cell: quoted when needed, and prefixed with ' when it starts with = + - @ (OWASP CSV injection). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function receiptTableCsv(rows: ReceiptTableRow[]): string {
  const lines = [RECEIPT_CSV_HEADER.join(",")];
  for (const r of rows) lines.push([r.day, r.agent, r.operator, r.path, r.reads, r.signed ? "true" : "false", r.last_at].map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** The page path for each receipt, from the version it read; the whole-file reads have none. */
async function pathResolver(s: OsService, trooth_id: string, rows: ReceiptRow[]): Promise<(r: ReceiptRow) => string> {
  const byVersion = new Map<number, Map<string, string>>();
  for (const v of new Set(rows.filter((r) => r.page_id && r.version !== null).map((r) => r.version as number))) {
    const file = await s.p.d.store.getFile(trooth_id, v);
    const m = new Map<string, string>();
    for (const p of file?.header.pages_manifest ?? []) {
      try {
        m.set(p.id, new URL(p.url).pathname);
      } catch {
        m.set(p.id, p.url);
      }
    }
    byVersion.set(v, m);
  }
  return (r) => (r.page_id ? (r.version !== null ? byVersion.get(r.version)?.get(r.page_id) : undefined) ?? r.page_id : WHOLE_FILE_PATH);
}

async function load(s: OsService, trooth_id: string, q: ReceiptQuery): Promise<{ all: ReceiptTableRow[]; agents: string[] } | WorkspaceResult> {
  const store = s.p.d.receiptStore;
  if (!store) return problem("conflict", "Read receipts are not kept in this deployment.");
  const rows = await store.list(trooth_id, `${q.from}T00:00:00.000Z`, new Date(dayMs(q.to) + 86_400_000).toISOString());
  const table = receiptTable(rows, await pathResolver(s, trooth_id, rows));
  return { all: table.rows, agents: table.agents };
}

/** GET /os/semanto/{id}/receipts. */
export async function receiptsRead(s: OsService, trooth_id: string, query: Record<string, string>): Promise<WorkspaceResult> {
  const q = parseReceiptQuery(query, s.now(), { paged: true });
  if ("error" in q) return problem("invalid_request", q.error);
  const loaded = await load(s, trooth_id, q);
  if (!("all" in loaded)) return loaded;
  const filtered = filterRows(loaded.all, q);
  const page = filtered.slice(q.offset, q.offset + q.limit);
  const next = q.offset + q.limit < filtered.length ? encodeCursor(q.offset + q.limit) : null;
  return ok(200, {
    object: "semanto.receipts",
    trooth_id,
    from: q.from,
    to: q.to,
    rows: page,
    // Agents are the readers proven by a signature; every unsigned read is one "unproven reader", not an agent (QA-08).
    totals: { reads: filtered.reduce((n, r) => n + r.reads, 0), agents: new Set(filtered.filter((r) => r.signed).map((r) => r.agent)).size, paths: new Set(filtered.map((r) => r.path)).size },
    agents: loaded.agents,
    next_cursor: next,
  });
}

/** GET /os/semanto/{id}/receipts.csv: the same filters, every row, the fixed header. */
export async function receiptsCsvRead(s: OsService, trooth_id: string, query: Record<string, string>): Promise<WorkspaceResult> {
  const q = parseReceiptQuery(query, s.now(), { paged: false });
  if ("error" in q) return problem("invalid_request", q.error);
  const loaded = await load(s, trooth_id, q);
  if (!("all" in loaded)) return loaded;
  return { status: 200, raw: { contentType: "text/csv", text: receiptTableCsv(filterRows(loaded.all, q)) }, headers: { "Content-Disposition": `attachment; filename="semanto-receipts-${trooth_id}-${q.from}-to-${q.to}.csv"` } };
}
