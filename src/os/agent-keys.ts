// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// AGENT KEYS: a company's own credential for an AI agent to run Semanto, through the MCP server
// (src/mcp/server.ts) or the /os API, as a Vercel access token or a Cloudflare API token does for theirs.
//
//   secret     tsk_ followed by 43 base64url characters (32 random bytes). Shown once, when a person
//              creates it; only its SHA-256 is kept (semanto_agent_keys.secret_sha256).
//   scope      read: the agent acts as a workspace viewer. write: the agent acts as an admin.
//   never      an agent key cannot create, list or revoke agent keys, sign, erase or turn two-officer
//              signing off: those ask a person (signing asks a passkey, src/identity/webauthn.ts), so an
//              agent always hands them back with a link (human_action_required).
//
// The key's user_id is "agent:<kid>", so the audit trail ("Recent changes") names which key acted.

import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { audit, iso, ok, problem, str, type RequestContext } from "./common";
import type { OsStore } from "./store";

export const AGENT_KEY_PREFIX = "tsk_";
const SECRET_RE = /^tsk_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 60;
const KEYS_PER_COMPANY = 20;

export interface AgentKeyRow {
  kid: string;
  trooth_id: string;
  name: string;
  scope: "read" | "write";
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AgentKeyStore {
  insert(row: AgentKeyRow & { secret_sha256: string }): Promise<void>;
  list(trooth_id: string): Promise<AgentKeyRow[]>;
  byHash(secret_sha256: string): Promise<AgentKeyRow | null>;
  revoke(trooth_id: string, kid: string, at: string): Promise<boolean>;
  touch(kid: string, at: string): Promise<void>;
}

const COLS = "kid, trooth_id, name, scope, created_by, created_at, expires_at, last_used_at, revoked_at";

export class D1AgentKeys implements AgentKeyStore {
  constructor(private readonly db: D1Database) {}
  async insert(r: AgentKeyRow & { secret_sha256: string }): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_agent_keys (${COLS}, secret_sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8)`)
      .bind(r.kid, r.trooth_id, r.name, r.scope, r.created_by, r.created_at, r.expires_at, r.secret_sha256)
      .run();
  }
  async list(trooth_id: string): Promise<AgentKeyRow[]> {
    const res = await this.db.prepare(`SELECT ${COLS} FROM semanto_agent_keys WHERE trooth_id = ?1 ORDER BY created_at DESC`).bind(trooth_id).all<AgentKeyRow>();
    return res.results ?? [];
  }
  async byHash(secret_sha256: string): Promise<AgentKeyRow | null> {
    return (await this.db.prepare(`SELECT ${COLS} FROM semanto_agent_keys WHERE secret_sha256 = ?1`).bind(secret_sha256).first<AgentKeyRow>()) ?? null;
  }
  async revoke(trooth_id: string, kid: string, at: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE semanto_agent_keys SET revoked_at = ?3 WHERE trooth_id = ?1 AND kid = ?2 AND revoked_at IS NULL").bind(trooth_id, kid, at).run();
    return (r.meta?.changes ?? 0) > 0;
  }
  async touch(kid: string, at: string): Promise<void> {
    // At most one write an hour per key: last_used_at is for people deciding what to revoke, not an access log.
    await this.db.prepare("UPDATE semanto_agent_keys SET last_used_at = ?2 WHERE kid = ?1 AND (last_used_at IS NULL OR last_used_at < ?3)").bind(kid, at, new Date(Date.parse(at) - 3600_000).toISOString()).run();
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** True when the request names an agent key. */
export const bearerAgentKey = (req: Request): string | null => {
  const m = /^Bearer\s+(tsk_\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return m ? m[1]! : null;
};

/** The workspace an agent key acts in, or null. A key that is malformed, unknown, revoked or expired is refused alike. */
export async function authorizeAgentKey(store: AgentKeyStore, secret: string, now: Date): Promise<WorkspaceAuth | null> {
  if (!SECRET_RE.test(secret)) return null;
  const row = await store.byHash(await sha256Hex(secret));
  if (!row || row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return null;
  await store.touch(row.kid, iso(now)).catch(() => undefined);
  return { trooth_id: row.trooth_id, role: row.scope === "write" ? "admin" : "viewer", user_id: `agent:${row.kid}`, name: `Agent key ${row.name}` };
}

export const isAgent = (ws: Pick<WorkspaceAuth, "user_id">): boolean => ws.user_id.startsWith("agent:");

const PEOPLE_ONLY = problem("forbidden", "Agent keys are made and revoked by a person, in Semanto settings on trooth.co. An agent key cannot manage agent keys.");

const view = (r: AgentKeyRow) => ({ object: "semanto.agent_key", kid: r.kid, name: r.name, scope: r.scope, created_by: r.created_by, created_at: r.created_at, expires_at: r.expires_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at, status: r.revoked_at ? "revoked" : r.expires_at && Date.parse(r.expires_at) <= Date.now() ? "expired" : "active" });

export async function listAgentKeys(store: AgentKeyStore, ws: WorkspaceAuth, trooth_id: string): Promise<WorkspaceResult> {
  if (isAgent(ws)) return PEOPLE_ONLY;
  return ok(200, { object: "list", data: (await store.list(trooth_id)).map(view) });
}

/** POST agent-keys { name, scope: "read" | "write", expires_in_days?: 1..365 }. The secret is in this answer and nowhere else, ever. */
export async function createAgentKey(store: AgentKeyStore, os: { store: OsStore; now(): Date }, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (isAgent(ws)) return PEOPLE_ONLY;
  if (ws.role !== "owner" && ws.role !== "admin") return problem("forbidden", "Only an owner or admin can make an agent key.");
  const name = str(body.name);
  if (!name || name.length > NAME_MAX) return problem("invalid_request", `Name the key in 1 to ${NAME_MAX} characters, for example the agent that will use it.`);
  const scope = body.scope === "read" || body.scope === "write" ? body.scope : null;
  if (!scope) return problem("invalid_request", 'scope is "read" (the agent can look) or "write" (the agent can also change settings and run setup).');
  const days = body.expires_in_days === undefined || body.expires_in_days === null ? null : Number(body.expires_in_days);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return problem("invalid_request", "expires_in_days is a whole number from 1 to 365, or left out for a key that lasts until it is revoked.");
  const active = (await store.list(trooth_id)).filter((r) => !r.revoked_at);
  if (active.length >= KEYS_PER_COMPANY) return problem("conflict", `A company has at most ${KEYS_PER_COMPANY} active agent keys. Revoke one first.`);
  const now = os.now();
  const secret = AGENT_KEY_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const kid = "ak_" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const row: AgentKeyRow = { kid, trooth_id, name, scope, created_by: ws.user_id, created_at: iso(now), expires_at: days ? iso(new Date(now.getTime() + days * 86400_000)) : null, last_used_at: null, revoked_at: null };
  await store.insert({ ...row, secret_sha256: await sha256Hex(secret) });
  await audit(os.store, { trooth_id, ws, action: "agent_keys.create", target: kid, after: { name, scope, expires_at: row.expires_at }, ctx, at: now });
  return ok(201, { ...view(row), secret, secret_shown_once: true, mcp_url: "https://api.trooth.co/os/semanto/mcp" });
}

export async function revokeAgentKey(store: AgentKeyStore, os: { store: OsStore; now(): Date }, ws: WorkspaceAuth, trooth_id: string, kid: string, ctx: RequestContext): Promise<WorkspaceResult> {
  if (isAgent(ws)) return PEOPLE_ONLY;
  if (ws.role !== "owner" && ws.role !== "admin") return problem("forbidden", "Only an owner or admin can revoke an agent key.");
  const now = os.now();
  if (!(await store.revoke(trooth_id, kid, iso(now)))) return problem("semanto_not_found", "No active agent key with this id.");
  await audit(os.store, { trooth_id, ws, action: "agent_keys.revoke", target: kid, ctx, at: now });
  return ok(200, { object: "semanto.agent_key", kid, status: "revoked", revoked_at: iso(now) });
}


