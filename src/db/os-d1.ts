// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// D1 and R2 access for the workspace contract (src/os/store.ts OsStore) over
// migrations/0007_os_contract.sql: one method per query, no SQL anywhere
// else. Single-use values are taken with one conditional statement and
// RETURNING (an UPDATE or DELETE that answers no row lost the race), the
// pattern src/db/d1.ts touchPasskey uses. Follows the Cloudflare D1 client
// API (prepare, bind, first, all, run, batch; docs 2026) and the Workers R2
// bindings API.

import type { PublicJwk } from "../core/keys";
import type {
  AlertAddress,
  AuditRow,
  ConnectorResult,
  ConnectorRow,
  ConnectSession,
  CredentialRow,
  CredentialState,
  GoogleConnection,
  GoogleState,
  OsStore,
  RecallEventRow,
  RotationRow,
  SellerListRow,
  WritebackItem,
  WritebackRun,
} from "../os/store";

interface ConnectorDbRow {
  kid: string;
  trooth_id: string;
  public_jwk: string;
  source: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
  last_request_at: string | null;
  last_result: string | null;
  last_ok_at: string | null;
}

const CONNECTOR_COLUMNS = "kid, trooth_id, public_jwk, source, label, created_at, revoked_at, last_request_at, last_result, last_ok_at";

const toConnector = (r: ConnectorDbRow): ConnectorRow => ({
  kid: r.kid,
  trooth_id: r.trooth_id,
  public_jwk: JSON.parse(r.public_jwk) as PublicJwk,
  source: r.source,
  label: r.label,
  created_at: r.created_at,
  revoked_at: r.revoked_at,
  last_request_at: r.last_request_at,
  last_result: r.last_result === "ok" || r.last_result === "signature_failed" ? r.last_result : null,
  last_ok_at: r.last_ok_at,
});

interface SessionDbRow extends Omit<ConnectSession, "public_jwk"> {
  public_jwk: string;
}
const toSession = (r: SessionDbRow): ConnectSession => ({ ...r, public_jwk: JSON.parse(r.public_jwk) as PublicJwk });

interface GoogleDbRow extends Omit<GoogleConnection, "products" | "scopes" | "merchant_accounts" | "business_locations"> {
  products: string;
  scopes: string;
  merchant_accounts: string;
  business_locations: string;
}
const toGoogle = (r: GoogleDbRow): GoogleConnection => ({
  ...r,
  products: JSON.parse(r.products) as GoogleConnection["products"],
  scopes: JSON.parse(r.scopes) as string[],
  merchant_accounts: JSON.parse(r.merchant_accounts) as GoogleConnection["merchant_accounts"],
  business_locations: JSON.parse(r.business_locations) as GoogleConnection["business_locations"],
});

interface ItemDbRow extends Omit<WritebackItem, "request"> {
  request_json: string;
}
const toItem = (r: ItemDbRow): WritebackItem => {
  const { request_json, ...rest } = r;
  return { ...rest, request: JSON.parse(request_json) as WritebackItem["request"] };
};

interface SellerDbRow extends Omit<SellerListRow, "payload"> {
  payload_json: string;
}
const toSeller = (r: SellerDbRow): SellerListRow => {
  const { payload_json, ...rest } = r;
  return { ...rest, payload: JSON.parse(payload_json) as unknown };
};

interface RecallDbRow extends Omit<RecallEventRow, "body"> {
  body_json: string;
}
const toRecall = (r: RecallDbRow): RecallEventRow => {
  const { body_json, ...rest } = r;
  return { ...rest, body: body_json };
};

const ITEM_COLUMNS = "run_id, item_id, trooth_id, connector, target, summary, request_json, state, attempts, last_error, sent_at, updated_at";
const GOOGLE_COLUMNS = "trooth_id, state, account_email, products, scopes, sealed_refresh_token, merchant_accounts, business_locations, connected_at, connected_by, last_refresh_at, last_error, alerted_at";
const ALERT_COLUMNS = "trooth_id, address, state, token_hash, token_expires_at, added_at, confirmed_at, last_sent_at";
const ROTATION_COLUMNS = "rotation_id, trooth_id, next_kid, current_kid, custody, state, overlap_until, started_by, started_at, confirmed_at, cancelled_at";
const SESSION_COLUMNS = "session_id, poll_token_hash, app, account, public_jwk, kid, return_url, state, trooth_id, requested_at, expires_at, decided_at, decided_by";

export class D1OsStore implements OsStore {
  constructor(
    private db: D1Database,
    private store: R2Bucket,
  ) {}

  // ------------------------------------------------------------ audit

  async appendAudit(r: AuditRow): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_audit (trooth_id, actor, who, role, action, target, before_hash, after_hash, request_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
      .bind(r.trooth_id, r.actor, r.who, r.role, r.action, r.target, r.before_hash, r.after_hash, r.request_id, r.at)
      .run();
  }
  async recentAudit(trooth_id: string, limit: number, before?: string): Promise<AuditRow[]> {
    const { results } = await (before
      ? this.db.prepare(`SELECT trooth_id, actor, who, role, action, target, before_hash, after_hash, request_id, at FROM semanto_audit WHERE trooth_id = ?1 AND at < ?3 ORDER BY id DESC LIMIT ?2`).bind(trooth_id, limit, before)
      : this.db.prepare(`SELECT trooth_id, actor, who, role, action, target, before_hash, after_hash, request_id, at FROM semanto_audit WHERE trooth_id = ?1 ORDER BY id DESC LIMIT ?2`).bind(trooth_id, limit)
    ).all<AuditRow>();
    return results;
  }

  lastAudit(trooth_id: string, action: string): Promise<AuditRow | null> {
    return this.db
      .prepare(`SELECT trooth_id, actor, who, role, action, target, before_hash, after_hash, request_id, at FROM semanto_audit WHERE trooth_id = ?1 AND action = ?2 ORDER BY id DESC LIMIT 1`)
      .bind(trooth_id, action)
      .first<AuditRow>();
  }

  // ------------------------------------------------------------ rotations

  /** The partial unique index semanto_key_rotations_started (migration 0008) keeps one started rotation per company. */
  async beginRotation(r: RotationRow): Promise<boolean> {
    const inserted = await this.db
      .prepare(`INSERT INTO semanto_key_rotations (${ROTATION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT DO NOTHING RETURNING rotation_id`)
      .bind(r.rotation_id, r.trooth_id, r.next_kid, r.current_kid, r.custody, r.state, r.overlap_until, r.started_by, r.started_at, r.confirmed_at, r.cancelled_at)
      .first<{ rotation_id: string }>();
    return inserted !== null;
  }
  getRotation(rotation_id: string): Promise<RotationRow | null> {
    return this.db.prepare(`SELECT ${ROTATION_COLUMNS} FROM semanto_key_rotations WHERE rotation_id = ?1`).bind(rotation_id).first<RotationRow>();
  }
  latestRotation(trooth_id: string): Promise<RotationRow | null> {
    return this.db.prepare(`SELECT ${ROTATION_COLUMNS} FROM semanto_key_rotations WHERE trooth_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT 1`).bind(trooth_id).first<RotationRow>();
  }
  async settleRotation(rotation_id: string, state: "confirmed" | "cancelled", at: string, overlap_until: string | null): Promise<boolean> {
    const q =
      state === "confirmed"
        ? this.db.prepare(`UPDATE semanto_key_rotations SET state = 'confirmed', confirmed_at = ?2, overlap_until = ?3 WHERE rotation_id = ?1 AND state = 'started' RETURNING rotation_id`).bind(rotation_id, at, overlap_until)
        : this.db.prepare(`UPDATE semanto_key_rotations SET state = 'cancelled', cancelled_at = ?2 WHERE rotation_id = ?1 AND state = 'started' RETURNING rotation_id`).bind(rotation_id, at);
    return (await q.first<{ rotation_id: string }>()) !== null;
  }

  // ------------------------------------------------------------ the DNS binding check (semanto_keys.dns_ok, dns_checked_at)

  async bindingCheck(trooth_id: string, kid: string): Promise<{ found: boolean; checked_at: string } | null> {
    const r = await this.db.prepare(`SELECT dns_ok, dns_checked_at FROM semanto_keys WHERE trooth_id = ?1 AND kid = ?2`).bind(trooth_id, kid).first<{ dns_ok: number; dns_checked_at: string | null }>();
    return r && r.dns_checked_at ? { found: r.dns_ok === 1, checked_at: r.dns_checked_at } : null;
  }
  async noteBindingCheck(trooth_id: string, kid: string, found: boolean, at: string): Promise<void> {
    await this.db.prepare(`UPDATE semanto_keys SET dns_ok = ?3, dns_checked_at = ?4 WHERE trooth_id = ?1 AND kid = ?2`).bind(trooth_id, kid, found ? 1 : 0, at).run();
  }

  // ------------------------------------------------------------ connectors

  async connectors(trooth_id: string): Promise<ConnectorRow[]> {
    const { results } = await this.db.prepare(`SELECT ${CONNECTOR_COLUMNS} FROM semanto_connector_keys WHERE trooth_id = ?1 ORDER BY created_at, kid`).bind(trooth_id).all<ConnectorDbRow>();
    return results.map(toConnector);
  }
  async connectorByKid(kid: string): Promise<ConnectorRow | null> {
    const r = await this.db.prepare(`SELECT ${CONNECTOR_COLUMNS} FROM semanto_connector_keys WHERE kid = ?1`).bind(kid).first<ConnectorDbRow>();
    return r ? toConnector(r) : null;
  }
  async revokeConnector(kid: string, at: string): Promise<boolean> {
    return (await this.db.prepare(`UPDATE semanto_connector_keys SET revoked_at = ?2 WHERE kid = ?1 AND revoked_at IS NULL RETURNING kid`).bind(kid, at).first<{ kid: string }>()) !== null;
  }
  async recordConnectorRequest(kid: string, at: string, result: ConnectorResult): Promise<void> {
    await this.db
      .prepare(`UPDATE semanto_connector_keys SET last_request_at = ?2, last_result = ?3, last_ok_at = CASE WHEN ?3 = 'ok' THEN ?2 ELSE last_ok_at END WHERE kid = ?1`)
      .bind(kid, at, result)
      .run();
  }

  // ------------------------------------------------------------ connect sessions

  async putConnectSession(s: ConnectSession): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_connect_sessions (${SESSION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
      .bind(s.session_id, s.poll_token_hash, s.app, s.account, JSON.stringify(s.public_jwk), s.kid, s.return_url, s.state, s.trooth_id, s.requested_at, s.expires_at, s.decided_at, s.decided_by)
      .run();
  }
  async getConnectSession(session_id: string): Promise<ConnectSession | null> {
    const r = await this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM semanto_connect_sessions WHERE session_id = ?1`).bind(session_id).first<SessionDbRow>();
    return r ? toSession(r) : null;
  }
  async pendingConnectSessionByKid(kid: string): Promise<ConnectSession | null> {
    const r = await this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM semanto_connect_sessions WHERE kid = ?1 AND state = 'pending' ORDER BY requested_at DESC LIMIT 1`).bind(kid).first<SessionDbRow>();
    return r ? toSession(r) : null;
  }
  async withdrawConnectSession(session_id: string, by: string, at: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE semanto_connect_sessions SET state = 'withdrawn', decided_by = ?2, decided_at = ?3 WHERE session_id = ?1 AND state = 'pending' RETURNING session_id`)
      .bind(session_id, by, at)
      .first<{ session_id: string }>();
    return r !== null;
  }
  async decideConnectSession(session_id: string, state: "approved" | "denied", trooth_id: string, by: string, at: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE semanto_connect_sessions SET state = ?2, trooth_id = ?3, decided_by = ?4, decided_at = ?5 WHERE session_id = ?1 AND state = 'pending' RETURNING session_id`)
      .bind(session_id, state, trooth_id, by, at)
      .first<{ session_id: string }>();
    return r !== null;
  }

  // ------------------------------------------------------------ Google

  async putGoogleState(s: GoogleState): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_google_states (state_hash, trooth_id, user_id, who, role, code_verifier, products, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(s.state_hash, s.trooth_id, s.user_id, s.who, s.role, s.code_verifier, JSON.stringify(s.products), s.created_at, s.expires_at)
      .run();
  }
  async takeGoogleState(state_hash: string): Promise<GoogleState | null> {
    const r = await this.db
      .prepare(`DELETE FROM semanto_google_states WHERE state_hash = ?1 RETURNING state_hash, trooth_id, user_id, who, role, code_verifier, products, created_at, expires_at`)
      .bind(state_hash)
      .first<Omit<GoogleState, "products"> & { products: string }>();
    return r ? { ...r, products: JSON.parse(r.products) as GoogleState["products"] } : null;
  }
  async getGoogle(trooth_id: string): Promise<GoogleConnection | null> {
    const r = await this.db.prepare(`SELECT ${GOOGLE_COLUMNS} FROM semanto_google_connections WHERE trooth_id = ?1`).bind(trooth_id).first<GoogleDbRow>();
    return r ? toGoogle(r) : null;
  }
  async putGoogle(c: GoogleConnection): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_google_connections (${GOOGLE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
      .bind(c.trooth_id, c.state, c.account_email, JSON.stringify(c.products), JSON.stringify(c.scopes), c.sealed_refresh_token, JSON.stringify(c.merchant_accounts), JSON.stringify(c.business_locations), c.connected_at, c.connected_by, c.last_refresh_at, c.last_error, c.alerted_at)
      .run();
  }
  async deleteGoogle(trooth_id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM semanto_google_connections WHERE trooth_id = ?1`).bind(trooth_id).run();
  }
  async markGoogleNeedsReconnect(trooth_id: string, error: string, at: string): Promise<boolean> {
    await this.db.prepare(`UPDATE semanto_google_connections SET state = 'needs_reconnect', last_error = ?2 WHERE trooth_id = ?1`).bind(trooth_id, error).run();
    const first = await this.db.prepare(`UPDATE semanto_google_connections SET alerted_at = ?2 WHERE trooth_id = ?1 AND alerted_at IS NULL RETURNING trooth_id`).bind(trooth_id, at).first<{ trooth_id: string }>();
    return first !== null;
  }
  async noteGoogleRefresh(trooth_id: string, at: string): Promise<void> {
    await this.db.prepare(`UPDATE semanto_google_connections SET last_refresh_at = ?2, last_error = NULL WHERE trooth_id = ?1`).bind(trooth_id, at).run();
  }

  // ------------------------------------------------------------ alert addresses

  async alertAddresses(trooth_id: string): Promise<AlertAddress[]> {
    const { results } = await this.db.prepare(`SELECT ${ALERT_COLUMNS} FROM semanto_alert_addresses WHERE trooth_id = ?1 ORDER BY added_at, address`).bind(trooth_id).all<AlertAddress>();
    return results;
  }
  async putAlertAddress(a: AlertAddress): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_alert_addresses (${ALERT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(a.trooth_id, a.address, a.state, a.token_hash, a.token_expires_at, a.added_at, a.confirmed_at, a.last_sent_at)
      .run();
  }
  async insertAlertAddress(a: AlertAddress): Promise<boolean> {
    const r = await this.db
      .prepare(`INSERT INTO semanto_alert_addresses (${ALERT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(trooth_id, address) DO NOTHING RETURNING address`)
      .bind(a.trooth_id, a.address, a.state, a.token_hash, a.token_expires_at, a.added_at, a.confirmed_at, a.last_sent_at)
      .first<{ address: string }>();
    return r !== null;
  }
  alertByToken(token_hash: string): Promise<AlertAddress | null> {
    return this.db.prepare(`SELECT ${ALERT_COLUMNS} FROM semanto_alert_addresses WHERE token_hash = ?1`).bind(token_hash).first<AlertAddress>();
  }
  async deleteAlertAddress(trooth_id: string, address: string): Promise<void> {
    await this.db.prepare(`DELETE FROM semanto_alert_addresses WHERE trooth_id = ?1 AND address = ?2`).bind(trooth_id, address).run();
  }
  confirmAlertToken(token_hash: string, at: string): Promise<AlertAddress | null> {
    return this.db
      .prepare(
        `UPDATE semanto_alert_addresses SET state = 'confirmed', confirmed_at = ?2, token_hash = NULL, token_expires_at = NULL
         WHERE token_hash = ?1 AND state = 'pending' AND token_expires_at > ?2 RETURNING ${ALERT_COLUMNS}`,
      )
      .bind(token_hash, at)
      .first<AlertAddress>();
  }

  // ------------------------------------------------------------ write-back runs

  /**
   * The items go in first under the new run id (no reader reaches them before the run row exists), then the run row
   * in one conditional write. When the idempotency key already has a run, the items just written are removed and the
   * existing run is answered. So a run, once visible, always has every item, even for two sends at the same moment.
   */
  async createWritebackRun(run: WritebackRun, items: WritebackItem[]): Promise<{ run: WritebackRun; created: boolean }> {
    for (let i = 0; i < items.length; i += 50) {
      await this.db.batch(
        items.slice(i, i + 50).map((it) =>
          this.db
            .prepare(`INSERT INTO semanto_writeback_items (${ITEM_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
            .bind(it.run_id, it.item_id, it.trooth_id, it.connector, it.target, it.summary, JSON.stringify(it.request), it.state, it.attempts, it.last_error, it.sent_at, it.updated_at),
        ),
      );
    }
    const inserted = await this.db
      .prepare(`INSERT INTO semanto_writeback_runs (run_id, trooth_id, idempotency_key, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(trooth_id, idempotency_key) DO NOTHING RETURNING run_id`)
      .bind(run.run_id, run.trooth_id, run.idempotency_key, run.created_by, run.created_at)
      .first<{ run_id: string }>();
    if (inserted) return { run, created: true };
    await this.db.prepare(`DELETE FROM semanto_writeback_items WHERE run_id = ?1`).bind(run.run_id).run();
    const existing = await this.db
      .prepare(`SELECT run_id, trooth_id, idempotency_key, created_by, created_at FROM semanto_writeback_runs WHERE trooth_id = ?1 AND idempotency_key = ?2`)
      .bind(run.trooth_id, run.idempotency_key)
      .first<WritebackRun>();
    return { run: existing!, created: false };
  }
  getWritebackRun(run_id: string): Promise<WritebackRun | null> {
    return this.db.prepare(`SELECT run_id, trooth_id, idempotency_key, created_by, created_at FROM semanto_writeback_runs WHERE run_id = ?1`).bind(run_id).first<WritebackRun>();
  }
  writebackRunByKey(trooth_id: string, idempotency_key: string): Promise<WritebackRun | null> {
    return this.db.prepare(`SELECT run_id, trooth_id, idempotency_key, created_by, created_at FROM semanto_writeback_runs WHERE trooth_id = ?1 AND idempotency_key = ?2`).bind(trooth_id, idempotency_key).first<WritebackRun>();
  }
  async listWritebackRuns(trooth_id: string, limit: number): Promise<WritebackRun[]> {
    const { results } = await this.db
      .prepare(`SELECT run_id, trooth_id, idempotency_key, created_by, created_at FROM semanto_writeback_runs WHERE trooth_id = ?1 ORDER BY created_at DESC, run_id DESC LIMIT ?2`)
      .bind(trooth_id, limit)
      .all<WritebackRun>();
    return results;
  }
  async writebackItems(run_id: string): Promise<WritebackItem[]> {
    const { results } = await this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM semanto_writeback_items WHERE run_id = ?1 ORDER BY rowid`).bind(run_id).all<ItemDbRow>();
    return results.map(toItem);
  }
  async getWritebackItem(run_id: string, item_id: string): Promise<WritebackItem | null> {
    const r = await this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM semanto_writeback_items WHERE run_id = ?1 AND item_id = ?2`).bind(run_id, item_id).first<ItemDbRow>();
    return r ? toItem(r) : null;
  }
  async requeueWritebackItem(run_id: string, item_id: string, at: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE semanto_writeback_items SET state = 'queued', last_error = NULL, updated_at = ?3 WHERE run_id = ?1 AND item_id = ?2 AND state = 'failed' RETURNING item_id`)
      .bind(run_id, item_id, at)
      .first<{ item_id: string }>();
    return r !== null;
  }
  async updateWritebackItem(run_id: string, item_id: string, patch: Partial<Pick<WritebackItem, "state" | "attempts" | "last_error" | "sent_at">>, at: string): Promise<void> {
    const cur = await this.getWritebackItem(run_id, item_id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    await this.db
      .prepare(`UPDATE semanto_writeback_items SET state = ?3, attempts = ?4, last_error = ?5, sent_at = ?6, updated_at = ?7 WHERE run_id = ?1 AND item_id = ?2`)
      .bind(run_id, item_id, n.state, n.attempts, n.last_error, n.sent_at, at)
      .run();
  }

  // ------------------------------------------------------------ seller lists

  async putSellerList(r: SellerListRow): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO semanto_seller_lists (trooth_id, version, jws, kid, issued_at, payload_json, custody, submitted_by, submitted_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE NOT EXISTS (SELECT 1 FROM semanto_seller_lists WHERE trooth_id = ?1 AND version >= ?2)
         ON CONFLICT(trooth_id, version) DO NOTHING RETURNING version`,
      )
      .bind(r.trooth_id, r.version, r.jws, r.kid, r.issued_at, JSON.stringify(r.payload), r.custody, r.submitted_by, r.submitted_at)
      .first<{ version: number }>();
    return inserted !== null;
  }
  async sellerLists(trooth_id: string): Promise<SellerListRow[]> {
    const { results } = await this.db
      .prepare(`SELECT trooth_id, version, jws, kid, issued_at, payload_json, custody, submitted_by, submitted_at FROM semanto_seller_lists WHERE trooth_id = ?1 ORDER BY version DESC`)
      .bind(trooth_id)
      .all<SellerDbRow>();
    return results.map(toSeller);
  }

  // ------------------------------------------------------------ recall events

  async putRecallEvent(r: RecallEventRow): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO semanto_recall_events (event_id, trooth_id, recall_id, body_json, state, attempts, last_error, created_at, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      )
      .bind(r.event_id, r.trooth_id, r.recall_id, r.body, r.state, r.attempts, r.last_error, r.created_at, r.sent_at)
      .first<{ event_id: string }>();
    return inserted !== null;
  }
  async getRecallEvent(event_id: string): Promise<RecallEventRow | null> {
    const r = await this.db.prepare(`SELECT event_id, trooth_id, recall_id, body_json, state, attempts, last_error, created_at, sent_at FROM semanto_recall_events WHERE event_id = ?1`).bind(event_id).first<RecallDbRow>();
    return r ? toRecall(r) : null;
  }
  async reviveRecallEvent(event_id: string, body: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE semanto_recall_events SET body_json = ?2, state = 'queued', last_error = NULL WHERE event_id = ?1 AND state = 'failed' RETURNING event_id`)
      .bind(event_id, body)
      .first<{ event_id: string }>();
    return r !== null;
  }
  async updateRecallEvent(event_id: string, patch: Partial<Pick<RecallEventRow, "state" | "attempts" | "last_error" | "sent_at">>): Promise<void> {
    const cur = await this.getRecallEvent(event_id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    await this.db.prepare(`UPDATE semanto_recall_events SET state = ?2, attempts = ?3, last_error = ?4, sent_at = ?5 WHERE event_id = ?1`).bind(event_id, n.state, n.attempts, n.last_error, n.sent_at).run();
  }

  // ------------------------------------------------------------ credentials

  async putCredential(r: CredentialRow): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_credentials (trooth_id, asset_url, sha256, kind, source, state, reason, made_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(r.trooth_id, r.asset_url, r.sha256, r.kind, r.source, r.state, r.reason, r.made_at)
      .run();
  }
  async credentials(trooth_id: string, opts: { state?: CredentialState; offset: number; limit: number }): Promise<{ rows: CredentialRow[]; totals: Record<CredentialState, number> }> {
    const q = opts.state
      ? this.db.prepare(`SELECT trooth_id, asset_url, sha256, kind, source, state, reason, made_at FROM semanto_credentials WHERE trooth_id = ?1 AND state = ?2 ORDER BY made_at DESC, asset_url LIMIT ?3 OFFSET ?4`).bind(trooth_id, opts.state, opts.limit, opts.offset)
      : this.db.prepare(`SELECT trooth_id, asset_url, sha256, kind, source, state, reason, made_at FROM semanto_credentials WHERE trooth_id = ?1 ORDER BY made_at DESC, asset_url LIMIT ?2 OFFSET ?3`).bind(trooth_id, opts.limit, opts.offset);
    const { results } = await q.all<CredentialRow>();
    const counts = await this.db.prepare(`SELECT state, COUNT(*) AS n FROM semanto_credentials WHERE trooth_id = ?1 GROUP BY state`).bind(trooth_id).all<{ state: CredentialState; n: number }>();
    const totals: Record<CredentialState, number> = { made: 0, failed: 0, skipped: 0 };
    for (const c of counts.results) totals[c.state] = Number(c.n);
    return { rows: results, totals };
  }
  credentialBySha(trooth_id: string, sha256: string): Promise<CredentialRow | null> {
    return this.db
      .prepare(`SELECT trooth_id, asset_url, sha256, kind, source, state, reason, made_at FROM semanto_credentials WHERE trooth_id = ?1 AND sha256 = ?2 AND state = 'made' LIMIT 1`)
      .bind(trooth_id, sha256)
      .first<CredentialRow>();
  }
  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.store.put(key, bytes as unknown as ArrayBuffer, { httpMetadata: { contentType } });
  }
  async getBlob(key: string): Promise<Uint8Array | null> {
    const o = await this.store.get(key);
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }
}
