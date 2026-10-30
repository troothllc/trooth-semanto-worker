// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The storage port for the workspace contract of 23 October 2026
// (docs/program/CONTRACT-2026-10-23.md, docs/spec/os-api.md): the audit
// trail, staged key rotations, connector key rows with their last signed
// request, the public connect sessions, the Google connection and its OAuth
// states, alert addresses, write-back runs and items, seller lists, recall
// events for worker-f and C2PA credentials. This file holds the interface and
// the in-memory implementation the tests use; the D1 and R2 implementation is
// D1OsStore in src/db/os-d1.ts (the only place its SQL lives). Ports and
// adapters, as everywhere in this Worker. Every single-use value (an OAuth
// state, an alert token, a connect decision) is taken with one conditional
// write, so two requests can never both use it.

import type { PublicJwk } from "../core/keys";
import type { WorkspaceRole } from "../serve/ports";
import type { MemoryConnector, MemoryPipelineStore } from "../pipeline-store";

export interface AuditRow {
  trooth_id: string;
  /** The workspace user id, or "connector:<kid>" for a signed app request. */
  actor: string;
  /** What the screen shows as who: the person's name or address, or "connector:<kid>". */
  who: string;
  /** A workspace role; "connector" for an app's signed request; "public" for a link opened from an email. */
  role: WorkspaceRole | "connector" | "public";
  action: string;
  target: string;
  before_hash: string | null;
  after_hash: string | null;
  request_id: string;
  at: string;
}

export type RotationState = "started" | "confirmed" | "cancelled";

export interface RotationRow {
  rotation_id: string;
  trooth_id: string;
  next_kid: string;
  current_kid: string | null;
  custody: "hosted" | "customer";
  state: RotationState;
  overlap_until: string | null;
  started_by: string;
  started_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
}

export type ConnectorResult = "ok" | "signature_failed";

export interface ConnectorRow {
  kid: string;
  trooth_id: string;
  public_jwk: PublicJwk;
  source: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
  last_request_at: string | null;
  last_result: ConnectorResult | null;
  last_ok_at: string | null;
}

export interface ConnectSession {
  session_id: string;
  poll_token_hash: string;
  app: string;
  account: string;
  public_jwk: PublicJwk;
  kid: string;
  return_url: string | null;
  /** withdrawn: the app took the request back (uninstalled or disconnected) before anyone decided (QA-16). */
  state: "pending" | "approved" | "denied" | "withdrawn";
  trooth_id: string | null;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export type GoogleProduct = "merchant" | "business";

export interface GoogleState {
  state_hash: string;
  trooth_id: string;
  user_id: string;
  who: string;
  role: WorkspaceRole;
  code_verifier: string;
  products: GoogleProduct[];
  created_at: string;
  expires_at: string;
}

export interface GoogleConnection {
  trooth_id: string;
  state: "connected" | "needs_reconnect";
  account_email: string | null;
  products: GoogleProduct[];
  /** The scopes Google granted, as the token answer listed them. */
  scopes: string[];
  /** The refresh token sealed with AES-256-GCM (src/db/key-seal.ts, context google-refresh). */
  sealed_refresh_token: string;
  merchant_accounts: { id: string; name: string }[];
  business_locations: { name: string; title: string }[];
  connected_at: string;
  connected_by: string;
  last_refresh_at: string | null;
  last_error: string | null;
  /** When the one needs_reconnect alert went out; null until then. */
  alerted_at: string | null;
}

export interface AlertAddress {
  trooth_id: string;
  address: string;
  state: "pending" | "confirmed";
  token_hash: string | null;
  token_expires_at: string | null;
  added_at: string;
  confirmed_at: string | null;
  last_sent_at: string | null;
}

export type WritebackConnectorName = "merchant_center" | "business_profile";
export type WritebackItemState = "queued" | "sending" | "sent" | "failed" | "retrying";

export interface WritebackRequest {
  method: "POST" | "PATCH";
  url: string;
  /** The body shown in the preview. */
  body: string;
  /** Merchant Center: one productInputs.insert body per product, sent one by one to url. Absent: body is sent as is. */
  batch?: string[];
  /** Image links the request carries; each gets a credential job once sent. */
  image_links: string[];
}

export interface WritebackRun {
  run_id: string;
  trooth_id: string;
  idempotency_key: string;
  created_by: string;
  created_at: string;
}

export interface WritebackItem {
  run_id: string;
  item_id: string;
  trooth_id: string;
  connector: WritebackConnectorName;
  target: string;
  summary: string;
  request: WritebackRequest;
  state: WritebackItemState;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  updated_at: string;
}

export interface SellerListRow {
  trooth_id: string;
  version: number;
  jws: string;
  kid: string;
  issued_at: string;
  payload: unknown;
  custody: "hosted" | "customer";
  submitted_by: string;
  submitted_at: string;
}

export interface RecallEventRow {
  event_id: string;
  trooth_id: string;
  recall_id: string;
  body: string;
  state: "queued" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export type CredentialState = "made" | "failed" | "skipped";

export interface CredentialRow {
  trooth_id: string;
  asset_url: string;
  /** 64 lowercase hex, or null when the asset could not be read. */
  sha256: string | null;
  kind: string;
  source: "compile" | "writeback";
  state: CredentialState;
  reason: string | null;
  made_at: string;
}

export interface OsStore {
  appendAudit(row: AuditRow): Promise<void>;
  /** Newest first; with before, only rows older than that time (the next page). */
  recentAudit(trooth_id: string, limit: number, before?: string): Promise<AuditRow[]>;
  /** The newest audit row of one action for a company, or null. */
  lastAudit(trooth_id: string, action: string): Promise<AuditRow | null>;

  /** Insert a started rotation unless the company has one started already (one conditional write). False when one is. */
  beginRotation(row: RotationRow): Promise<boolean>;
  getRotation(rotation_id: string): Promise<RotationRow | null>;
  latestRotation(trooth_id: string): Promise<RotationRow | null>;
  /** Move a started rotation to confirmed or cancelled in one conditional write. False when it was not started any more. */
  settleRotation(rotation_id: string, state: "confirmed" | "cancelled", at: string, overlap_until: string | null): Promise<boolean>;

  /** Every connector key of a company, revoked ones included, oldest first. */
  /** The last DNS binding check for a key (semanto_keys.dns_ok and dns_checked_at), or null before the first. */
  bindingCheck(trooth_id: string, kid: string): Promise<{ found: boolean; checked_at: string } | null>;
  noteBindingCheck(trooth_id: string, kid: string, found: boolean, at: string): Promise<void>;

  connectors(trooth_id: string): Promise<ConnectorRow[]>;
  connectorByKid(kid: string): Promise<ConnectorRow | null>;
  revokeConnector(kid: string, at: string): Promise<boolean>;
  /** The last signed request seen for a kid on the catalog route. */
  recordConnectorRequest(kid: string, at: string, result: ConnectorResult): Promise<void>;

  putConnectSession(s: ConnectSession): Promise<void>;
  getConnectSession(session_id: string): Promise<ConnectSession | null>;
  /** Approve or deny a pending session in one conditional write. False when it was decided already. */
  decideConnectSession(session_id: string, state: "approved" | "denied", trooth_id: string, by: string, at: string): Promise<boolean>;
  /** The pending session that offered this key, if any (an app uninstalled before the merchant approved). */
  pendingConnectSessionByKid(kid: string): Promise<ConnectSession | null>;
  /** Withdraw a pending session in one conditional write; false when it was decided already. */
  withdrawConnectSession(session_id: string, by: string, at: string): Promise<boolean>;

  putGoogleState(s: GoogleState): Promise<void>;
  /** Remove and answer the state row; a second take answers null. */
  takeGoogleState(state_hash: string): Promise<GoogleState | null>;
  getGoogle(trooth_id: string): Promise<GoogleConnection | null>;
  putGoogle(c: GoogleConnection): Promise<void>;
  deleteGoogle(trooth_id: string): Promise<void>;
  /** Set needs_reconnect with the error; answers true only for the call that first set alerted_at (one alert). */
  markGoogleNeedsReconnect(trooth_id: string, error: string, at: string): Promise<boolean>;
  noteGoogleRefresh(trooth_id: string, at: string): Promise<void>;

  alertAddresses(trooth_id: string): Promise<AlertAddress[]>;
  putAlertAddress(a: AlertAddress): Promise<void>;
  /** Add a new address in one conditional write; false when the address is on the list already (a double click). */
  insertAlertAddress(a: AlertAddress): Promise<boolean>;
  /** The address a confirmation token was sent for, or null: tells a link that expired from one that never was or was used. */
  alertByToken(token_hash: string): Promise<AlertAddress | null>;
  deleteAlertAddress(trooth_id: string, address: string): Promise<void>;
  /** Confirm the pending address whose token hash this is, once, before it expires. Answers the confirmed row or null. */
  confirmAlertToken(token_hash: string, at: string): Promise<AlertAddress | null>;

  /** Create a run and its items, unless the idempotency key has a run already; answers the run that holds the key. */
  createWritebackRun(run: WritebackRun, items: WritebackItem[]): Promise<{ run: WritebackRun; created: boolean }>;
  getWritebackRun(run_id: string): Promise<WritebackRun | null>;
  /** The run that holds an idempotency key, or null. */
  writebackRunByKey(trooth_id: string, idempotency_key: string): Promise<WritebackRun | null>;
  listWritebackRuns(trooth_id: string, limit: number): Promise<WritebackRun[]>;
  writebackItems(run_id: string): Promise<WritebackItem[]>;
  getWritebackItem(run_id: string, item_id: string): Promise<WritebackItem | null>;
  updateWritebackItem(run_id: string, item_id: string, patch: Partial<Pick<WritebackItem, "state" | "attempts" | "last_error" | "sent_at">>, at: string): Promise<void>;
  /** A failed item back to queued in one conditional write; false when it is not failed (another retry took it first). */
  requeueWritebackItem(run_id: string, item_id: string, at: string): Promise<boolean>;

  /** Insert a seller list version in one conditional write; false when that version or a newer one is on file (versions only go up, even for two submissions at once). */
  putSellerList(row: SellerListRow): Promise<boolean>;
  /** Every stored version, newest first. */
  sellerLists(trooth_id: string): Promise<SellerListRow[]>;

  /** Insert the event unless its id is on file; true when inserted. */
  putRecallEvent(row: RecallEventRow): Promise<boolean>;
  getRecallEvent(event_id: string): Promise<RecallEventRow | null>;
  /** A failed recall event (it could not be built, or its send failed for good) takes the body and goes back to queued, so the same recall stored again is sent. False when it is not failed. */
  reviveRecallEvent(event_id: string, body: string): Promise<boolean>;
  updateRecallEvent(event_id: string, patch: Partial<Pick<RecallEventRow, "state" | "attempts" | "last_error" | "sent_at">>): Promise<void>;

  putCredential(row: CredentialRow): Promise<void>;
  credentials(trooth_id: string, opts: { state?: CredentialState; offset: number; limit: number }): Promise<{ rows: CredentialRow[]; totals: Record<CredentialState, number> }>;
  credentialBySha(trooth_id: string, sha256: string): Promise<CredentialRow | null>;
  putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getBlob(key: string): Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------- in memory

const clone = <T>(v: T): T => structuredClone(v);

/**
 * The in-memory store. Connector keys live in the MemoryPipelineStore it is
 * given, the way both stores share semanto_connector_keys in D1, so a key
 * added here signs catalogs there and a key revoked here stops at once.
 */
export class MemoryOsStore implements OsStore {
  readonly audit: AuditRow[] = [];
  readonly rotations = new Map<string, RotationRow>();
  readonly sessions = new Map<string, ConnectSession>();
  readonly googleStates = new Map<string, GoogleState>();
  readonly google = new Map<string, GoogleConnection>();
  readonly alerts = new Map<string, AlertAddress>();
  readonly runs = new Map<string, WritebackRun>();
  readonly items = new Map<string, WritebackItem>();
  readonly sellerRows: SellerListRow[] = [];
  readonly recallEvents = new Map<string, RecallEventRow>();
  readonly credentialRows = new Map<string, CredentialRow>();
  readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(readonly pipeline: MemoryPipelineStore) {}

  async appendAudit(row: AuditRow): Promise<void> {
    this.audit.push(clone(row));
  }
  async recentAudit(trooth_id: string, limit: number, before?: string): Promise<AuditRow[]> {
    return this.audit.filter((r) => r.trooth_id === trooth_id && (!before || r.at < before)).reverse().slice(0, limit).map(clone);
  }
  async lastAudit(trooth_id: string, action: string): Promise<AuditRow | null> {
    const r = this.audit.filter((x) => x.trooth_id === trooth_id && x.action === action).pop();
    return r ? clone(r) : null;
  }

  async beginRotation(row: RotationRow): Promise<boolean> {
    if ([...this.rotations.values()].some((r) => r.trooth_id === row.trooth_id && r.state === "started")) return false;
    this.rotations.set(row.rotation_id, clone(row));
    return true;
  }
  async getRotation(rotation_id: string): Promise<RotationRow | null> {
    const r = this.rotations.get(rotation_id);
    return r ? clone(r) : null;
  }
  async latestRotation(trooth_id: string): Promise<RotationRow | null> {
    const mine = [...this.rotations.values()].filter((r) => r.trooth_id === trooth_id);
    return mine.length ? clone(mine[mine.length - 1]!) : null;
  }
  async settleRotation(rotation_id: string, state: "confirmed" | "cancelled", at: string, overlap_until: string | null): Promise<boolean> {
    const r = this.rotations.get(rotation_id);
    if (!r || r.state !== "started") return false;
    this.rotations.set(rotation_id, { ...r, state, ...(state === "confirmed" ? { confirmed_at: at, overlap_until } : { cancelled_at: at }) });
    return true;
  }

  readonly bindingChecks = new Map<string, { found: boolean; checked_at: string }>();
  async bindingCheck(trooth_id: string, kid: string): Promise<{ found: boolean; checked_at: string } | null> {
    return this.bindingChecks.get(`${trooth_id}\n${kid}`) ?? null;
  }
  async noteBindingCheck(trooth_id: string, kid: string, found: boolean, at: string): Promise<void> {
    this.bindingChecks.set(`${trooth_id}\n${kid}`, { found, checked_at: at });
  }

  private connectorRow(trooth_id: string, c: MemoryConnector): ConnectorRow {
    return {
      kid: c.jwk.kid,
      trooth_id,
      public_jwk: clone(c.jwk),
      source: c.source,
      label: c.label ?? null,
      created_at: c.created_at,
      revoked_at: c.revoked_at ?? null,
      last_request_at: c.last_request_at ?? null,
      last_result: c.last_result ?? null,
      last_ok_at: c.last_ok_at ?? null,
    };
  }
  async connectors(trooth_id: string): Promise<ConnectorRow[]> {
    return (this.pipeline.connectors.get(trooth_id) ?? []).map((c) => this.connectorRow(trooth_id, c));
  }
  async connectorByKid(kid: string): Promise<ConnectorRow | null> {
    for (const [trooth_id, list] of this.pipeline.connectors) {
      const c = list.find((x) => x.jwk.kid === kid);
      if (c) return this.connectorRow(trooth_id, c);
    }
    return null;
  }
  async revokeConnector(kid: string, at: string): Promise<boolean> {
    for (const list of this.pipeline.connectors.values()) {
      const c = list.find((x) => x.jwk.kid === kid);
      if (c && !c.revoked_at) {
        c.revoked_at = at;
        return true;
      }
    }
    return false;
  }
  async recordConnectorRequest(kid: string, at: string, result: ConnectorResult): Promise<void> {
    for (const list of this.pipeline.connectors.values()) {
      const c = list.find((x) => x.jwk.kid === kid);
      if (!c) continue;
      c.last_request_at = at;
      c.last_result = result;
      if (result === "ok") c.last_ok_at = at;
    }
  }

  async putConnectSession(s: ConnectSession): Promise<void> {
    this.sessions.set(s.session_id, clone(s));
  }
  async getConnectSession(session_id: string): Promise<ConnectSession | null> {
    const s = this.sessions.get(session_id);
    return s ? clone(s) : null;
  }
  async pendingConnectSessionByKid(kid: string): Promise<ConnectSession | null> {
    const s = [...this.sessions.values()].find((x) => x.kid === kid && x.state === "pending");
    return s ? clone(s) : null;
  }
  async withdrawConnectSession(session_id: string, by: string, at: string): Promise<boolean> {
    const s = this.sessions.get(session_id);
    if (!s || s.state !== "pending") return false;
    this.sessions.set(session_id, { ...s, state: "withdrawn", decided_by: by, decided_at: at });
    return true;
  }
  async decideConnectSession(session_id: string, state: "approved" | "denied", trooth_id: string, by: string, at: string): Promise<boolean> {
    const s = this.sessions.get(session_id);
    if (!s || s.state !== "pending") return false;
    this.sessions.set(session_id, { ...s, state, trooth_id, decided_by: by, decided_at: at });
    return true;
  }

  async putGoogleState(s: GoogleState): Promise<void> {
    this.googleStates.set(s.state_hash, clone(s));
  }
  async takeGoogleState(state_hash: string): Promise<GoogleState | null> {
    const s = this.googleStates.get(state_hash);
    if (!s) return null;
    this.googleStates.delete(state_hash);
    return s;
  }
  async getGoogle(trooth_id: string): Promise<GoogleConnection | null> {
    const g = this.google.get(trooth_id);
    return g ? clone(g) : null;
  }
  async putGoogle(c: GoogleConnection): Promise<void> {
    this.google.set(c.trooth_id, clone(c));
  }
  async deleteGoogle(trooth_id: string): Promise<void> {
    this.google.delete(trooth_id);
  }
  async markGoogleNeedsReconnect(trooth_id: string, error: string, at: string): Promise<boolean> {
    const g = this.google.get(trooth_id);
    if (!g) return false;
    const first = g.alerted_at === null;
    this.google.set(trooth_id, { ...g, state: "needs_reconnect", last_error: error, alerted_at: g.alerted_at ?? at });
    return first;
  }
  async noteGoogleRefresh(trooth_id: string, at: string): Promise<void> {
    const g = this.google.get(trooth_id);
    if (g) this.google.set(trooth_id, { ...g, last_refresh_at: at, last_error: null });
  }

  async alertAddresses(trooth_id: string): Promise<AlertAddress[]> {
    return [...this.alerts.values()].filter((a) => a.trooth_id === trooth_id).sort((a, b) => a.added_at.localeCompare(b.added_at)).map(clone);
  }
  async putAlertAddress(a: AlertAddress): Promise<void> {
    this.alerts.set(`${a.trooth_id}\n${a.address}`, clone(a));
  }
  async insertAlertAddress(a: AlertAddress): Promise<boolean> {
    if (this.alerts.has(`${a.trooth_id}\n${a.address}`)) return false;
    this.alerts.set(`${a.trooth_id}\n${a.address}`, clone(a));
    return true;
  }
  async alertByToken(token_hash: string): Promise<AlertAddress | null> {
    const a = [...this.alerts.values()].find((x) => x.token_hash === token_hash);
    return a ? clone(a) : null;
  }
  async deleteAlertAddress(trooth_id: string, address: string): Promise<void> {
    this.alerts.delete(`${trooth_id}\n${address}`);
  }
  async confirmAlertToken(token_hash: string, at: string): Promise<AlertAddress | null> {
    for (const [k, a] of this.alerts) {
      if (a.token_hash !== token_hash || a.state !== "pending") continue;
      if (!a.token_expires_at || a.token_expires_at <= at) return null;
      const confirmed: AlertAddress = { ...a, state: "confirmed", confirmed_at: at, token_hash: null, token_expires_at: null };
      this.alerts.set(k, confirmed);
      return clone(confirmed);
    }
    return null;
  }

  async createWritebackRun(run: WritebackRun, items: WritebackItem[]): Promise<{ run: WritebackRun; created: boolean }> {
    const existing = [...this.runs.values()].find((r) => r.trooth_id === run.trooth_id && r.idempotency_key === run.idempotency_key);
    if (existing) return { run: clone(existing), created: false };
    this.runs.set(run.run_id, clone(run));
    for (const i of items) this.items.set(`${i.run_id}\n${i.item_id}`, clone(i));
    return { run: clone(run), created: true };
  }
  async getWritebackRun(run_id: string): Promise<WritebackRun | null> {
    const r = this.runs.get(run_id);
    return r ? clone(r) : null;
  }
  async writebackRunByKey(trooth_id: string, idempotency_key: string): Promise<WritebackRun | null> {
    const r = [...this.runs.values()].find((x) => x.trooth_id === trooth_id && x.idempotency_key === idempotency_key);
    return r ? clone(r) : null;
  }
  async listWritebackRuns(trooth_id: string, limit: number): Promise<WritebackRun[]> {
    return [...this.runs.values()].filter((r) => r.trooth_id === trooth_id).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_id.localeCompare(a.run_id)).slice(0, limit).map(clone);
  }
  async writebackItems(run_id: string): Promise<WritebackItem[]> {
    return [...this.items.values()].filter((i) => i.run_id === run_id).map(clone);
  }
  async getWritebackItem(run_id: string, item_id: string): Promise<WritebackItem | null> {
    const i = this.items.get(`${run_id}\n${item_id}`);
    return i ? clone(i) : null;
  }
  async requeueWritebackItem(run_id: string, item_id: string, at: string): Promise<boolean> {
    const k = `${run_id}\n${item_id}`;
    const i = this.items.get(k);
    if (!i || i.state !== "failed") return false;
    this.items.set(k, { ...i, state: "queued", last_error: null, updated_at: at });
    return true;
  }
  async updateWritebackItem(run_id: string, item_id: string, patch: Partial<Pick<WritebackItem, "state" | "attempts" | "last_error" | "sent_at">>, at: string): Promise<void> {
    const k = `${run_id}\n${item_id}`;
    const i = this.items.get(k);
    if (i) this.items.set(k, { ...i, ...patch, updated_at: at });
  }

  async putSellerList(row: SellerListRow): Promise<boolean> {
    if (this.sellerRows.some((r) => r.trooth_id === row.trooth_id && r.version >= row.version)) return false;
    this.sellerRows.push(clone(row));
    return true;
  }
  async sellerLists(trooth_id: string): Promise<SellerListRow[]> {
    return this.sellerRows.filter((r) => r.trooth_id === trooth_id).sort((a, b) => b.version - a.version).map(clone);
  }

  async putRecallEvent(row: RecallEventRow): Promise<boolean> {
    if (this.recallEvents.has(row.event_id)) return false;
    this.recallEvents.set(row.event_id, clone(row));
    return true;
  }
  async getRecallEvent(event_id: string): Promise<RecallEventRow | null> {
    const r = this.recallEvents.get(event_id);
    return r ? clone(r) : null;
  }
  async reviveRecallEvent(event_id: string, body: string): Promise<boolean> {
    const r = this.recallEvents.get(event_id);
    if (!r || r.state !== "failed") return false;
    this.recallEvents.set(event_id, { ...r, body, state: "queued", last_error: null });
    return true;
  }
  async updateRecallEvent(event_id: string, patch: Partial<Pick<RecallEventRow, "state" | "attempts" | "last_error" | "sent_at">>): Promise<void> {
    const r = this.recallEvents.get(event_id);
    if (r) this.recallEvents.set(event_id, { ...r, ...patch });
  }

  async putCredential(row: CredentialRow): Promise<void> {
    this.credentialRows.set(`${row.trooth_id}\n${row.asset_url}`, clone(row));
  }
  async credentials(trooth_id: string, opts: { state?: CredentialState; offset: number; limit: number }): Promise<{ rows: CredentialRow[]; totals: Record<CredentialState, number> }> {
    const mine = [...this.credentialRows.values()].filter((r) => r.trooth_id === trooth_id);
    const totals: Record<CredentialState, number> = { made: 0, failed: 0, skipped: 0 };
    for (const r of mine) totals[r.state] += 1;
    const rows = mine
      .filter((r) => !opts.state || r.state === opts.state)
      .sort((a, b) => b.made_at.localeCompare(a.made_at) || a.asset_url.localeCompare(b.asset_url))
      .slice(opts.offset, opts.offset + opts.limit)
      .map(clone);
    return { rows, totals };
  }
  async credentialBySha(trooth_id: string, sha256: string): Promise<CredentialRow | null> {
    const r = [...this.credentialRows.values()].find((x) => x.trooth_id === trooth_id && x.sha256 === sha256 && x.state === "made");
    return r ? clone(r) : null;
  }
  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { bytes: bytes.slice(), contentType });
  }
  async getBlob(key: string): Promise<Uint8Array | null> {
    return this.blobs.get(key)?.bytes.slice() ?? null;
  }
}
