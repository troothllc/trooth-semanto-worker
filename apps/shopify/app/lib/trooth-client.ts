// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's calls to the Semanto Worker, exactly the routes the program
// contract names for the Shopify app (docs/program/CONTRACT-2026-10-23.md,
// sections 1d and 7):
//
//   POST /public/semanto/connect/sessions              start a connect session with the shop's public key
//   GET  /public/semanto/connect/sessions/{session_id} poll it, Bearer poll token
//   POST /public/semanto/connect/uninstall             revoke the shop's connector key, signed with that key
//   POST /os/semanto/{trooth_id}/commerce/catalog      the catalog, signed with that key
//
// No Trooth credential is ever typed into Shopify: the merchant approves the
// shop's public key on trooth.co, the Stripe CLI and GitHub device-flow
// pattern. Signed calls retry on 429 and 5xx with a fresh signature each time
// (app/lib/retry.ts); the connect calls are not retried here because the
// merchant's screen polls again in two seconds.

import { signJson, type ConnectorPrivateJwk, type ConnectorPublicJwk } from "./sign";
import { withRetry, type RetryOptions } from "./retry";
import { isTroothId } from "./env";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConnectSession {
  session_id: string;
  poll_token: string;
  approve_url: string;
  expires_at: string;
}

export type ConnectPoll = { state: "pending" } | { state: "approved"; trooth_id: string; kid: string } | { state: "denied" } | { state: "expired" };

export interface CatalogReceipt {
  signed: boolean;
  records: number;
  offers: number;
  skipped: number;
  /** Skus sent as discontinued whose offers Trooth removed. */
  removed: number;
  reason?: string;
}

/** The reasons the Worker's uninstall route accepts (UNINSTALL_REASONS in src/os/connectors.ts). */
export type RevokeReason = "uninstalled" | "disconnected" | "shop_redact";

export class TroothError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Trooth refused to revoke the key (401 bad signature, 403 not this app's key): Trooth still holds it. */
export class RevokeRefused extends TroothError {}

async function problemOf(res: Response, fallback: string): Promise<TroothError> {
  let detail = fallback;
  let code: string | null = null;
  try {
    const j = (await res.json()) as { detail?: unknown; title?: unknown; code?: unknown };
    if (typeof j.detail === "string") detail = j.detail;
    else if (typeof j.title === "string") detail = j.title;
    if (typeof j.code === "string") code = j.code;
  } catch {
    // The body was not a problem document; the fallback message stands.
  }
  return new TroothError(detail, res.status, code);
}

export class TroothClient {
  constructor(
    private readonly apiBase: string,
    private readonly dashboardUrl: string,
    private readonly fetchImpl: Fetch = (i, init) => fetch(i, init),
    private readonly retry: RetryOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Start a connect session (contract 1d). The approve address must be on the Trooth dashboard's own origin. */
  async createConnectSession(shop: string, publicJwk: ConnectorPublicJwk, returnUrl: string): Promise<ConnectSession> {
    const res = await this.fetchImpl(`${this.apiBase}/public/semanto/connect/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ app: "shopify", account: shop, public_jwk: publicJwk, return_url: returnUrl }),
    });
    if (!res.ok) throw await problemOf(res, `Trooth could not start the connection (answer ${res.status}).`);
    const j = (await res.json()) as Partial<ConnectSession>;
    if (typeof j.session_id !== "string" || typeof j.poll_token !== "string" || typeof j.approve_url !== "string" || typeof j.expires_at !== "string" || Number.isNaN(Date.parse(j.expires_at))) {
      throw new TroothError("Trooth answered the connection request with an unexpected shape.", 502, "bad_shape");
    }
    if (new URL(j.approve_url).origin !== new URL(this.dashboardUrl).origin) throw new TroothError("Trooth answered with an approval address outside trooth.co.", 502, "bad_approve_url");
    return j as ConnectSession;
  }

  /** Read a connect session's state with its poll token. */
  async pollConnectSession(sessionId: string, pollToken: string): Promise<ConnectPoll> {
    const res = await this.fetchImpl(`${this.apiBase}/public/semanto/connect/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${pollToken}`, accept: "application/json" },
    });
    // The Worker answers 401 for a session it does not hold or a token that does not match it (src/os/connectors.ts,
    // pollConnectSession); either way the session can no longer be approved for this key, so it reads as expired.
    if (res.status === 401 || res.status === 404 || res.status === 410) return { state: "expired" };
    if (!res.ok) throw await problemOf(res, `Trooth did not answer the connection check (answer ${res.status}).`);
    const j = (await res.json()) as { state?: unknown; trooth_id?: unknown; kid?: unknown };
    if (j.state === "approved") {
      if (!isTroothId(j.trooth_id) || typeof j.kid !== "string") throw new TroothError("Trooth said approved without a Trooth ID and key id.", 502, "bad_shape");
      return { state: "approved", trooth_id: j.trooth_id, kid: j.kid };
    }
    if (j.state === "pending" || j.state === "denied" || j.state === "expired") return { state: j.state };
    // The app itself took the request back (its uninstall or Disconnect reached Trooth first): for this screen it is
    // a request that can no longer be approved, the same as one that expired.
    if (j.state === "withdrawn") return { state: "expired" };
    throw new TroothError("Trooth answered the connection check with an unknown state.", 502, "bad_shape");
  }

  /**
   * Revoke the shop's connector key (contract 7): on uninstall, on Disconnect,
   * on shop/redact and when an unfinished connection is cleaned up. Signed with
   * the key being revoked, so only the holder of the key can revoke it. The
   * Worker's answers (src/os/connectors.ts, uninstallConnector):
   *   200                 revoked (or already revoked)
   *   404 not_registered  Trooth never registered this key (an unfinished or declined connection): nothing to revoke
   *   401                 the signature did not check out
   *   403                 the key was not made by an app install, or belongs to another shop
   * 401 and 403 throw a RevokeRefused, which the caller shows as an error:
   * Trooth still holds that key. A network failure, 429 or 5xx that outlasts
   * the retries throws too, so the queue can try again later.
   */
  async revoke(shop: string, privateJwk: ConnectorPrivateJwk, troothId: string | null, reason: RevokeReason): Promise<"revoked" | "not_registered"> {
    const url = `${this.apiBase}/public/semanto/connect/uninstall`;
    const doc = { app: "shopify", account: shop, kid: privateJwk.kid, ...(troothId ? { trooth_id: troothId } : {}), reason };
    const res = await withRetry(async () => {
      const { body, headers } = await signJson(url, doc, privateJwk, this.now());
      return this.fetchImpl(url, { method: "POST", headers, body });
    }, this.retry);
    if (res.ok) return "revoked";
    const err = await problemOf(res, `Trooth did not revoke the key (answer ${res.status}).`);
    if (res.status === 404 || res.status === 410) return "not_registered";
    if (res.status === 401 || res.status === 403 || res.status === 400) throw new RevokeRefused(err.message, res.status, err.code);
    throw err;
  }

  /** POST one catalog document, signed (contract 7, the Worker's catalog handler in src/pipeline.ts). */
  async postCatalog(troothId: string, document: unknown, privateJwk: ConnectorPrivateJwk): Promise<CatalogReceipt> {
    const url = `${this.apiBase}/os/semanto/${encodeURIComponent(troothId)}/commerce/catalog`;
    const res = await withRetry(async () => {
      const { body, headers } = await signJson(url, document, privateJwk, this.now());
      return this.fetchImpl(url, { method: "POST", headers, body });
    }, this.retry);
    if (!res.ok) throw await problemOf(res, `Trooth did not accept the catalog (answer ${res.status}).`);
    const j = (await res.json()) as { signed?: unknown; records?: unknown; offers?: unknown; skipped?: unknown; removed?: unknown; reason?: unknown };
    const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0);
    return {
      signed: j.signed === true,
      records: count(j.records),
      offers: count(j.offers),
      skipped: count(j.skipped),
      removed: count(j.removed),
      ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
    };
  }
}
