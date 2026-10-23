// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Connector keys and the public connect flow for app installs (contract
// section 1d, section 7's uninstall).
//
//   keys        list; paste a public JWK (validation that names the exact
//               problem); create a pair here and answer the private JWK once
//               (GitHub's "copy your new token now, you will not see it
//               again"); test the connection from the last signed request
//               per kid, and for an edge adapter by reading
//               https://{domain}/.well-known/trooth-semanto-connector through
//               the SSRF guard; revoke with the typed kid
//   connect     Stripe CLI's "stripe login" and GitHub's device flow: the
//               app server opens a session with its public key, the merchant
//               approves it on trooth.co while the app server polls with a
//               bearer poll token (kept only as its SHA-256), and approval
//               registers the key with source "shopify:<shop>"; sessions end
//               after 15 minutes
//   uninstall   the app's own signed request (RFC 9421, tag
//               trooth-connector) revokes its key; no Trooth credential is
//               ever typed into the app

import { generateKeyPair, type PublicJwk } from "../core/keys";
import { verifyContentDigest, verifyMessage } from "../core/httpsig";
import { acceptCustomerPublicKey } from "../identity/keys";
import { CONNECTOR_COMPONENTS, CONNECTOR_MAX_AGE_SECONDS, CONNECTOR_TAG, namedConnectorKid } from "../pipeline";
import type { SignedRequest, WorkspaceAuth, WorkspaceResult, WorkspaceSession } from "../serve/ports";
import { ADMIN_ONLY, audit, iso, isRecord, mayAdminister, mayOperate, OPERATOR_ONLY, ok, problem, randomId, randomToken, str, tokenHash, type RequestContext } from "./common";
import type { OsService } from "./service";
import type { ConnectorRow, ConnectSession } from "./store";

export const CONNECT_SESSION_TTL_MS = 15 * 60 * 1000;
/** Seconds between two polls, answered as interval the way RFC 8628 section 3.2 answers it to a device, so the app server need not hard-code it. */
export const CONNECT_POLL_INTERVAL_SECONDS = 2;
export const CONNECT_APPS = ["shopify"] as const;
export const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
/** What a key pasted or made in the dashboard is for: a host adapter on the company's domain, an API client, or an app. App installs register "<app>:<account>" through the connect flow. */
export const CONNECTOR_SOURCES = ["edge", "api", "app"] as const;
/** The sources that are host adapters running on the company's own domain; the test reads their well-known answer. */
export const EDGE_ADAPTER_SOURCES = ["edge", "cloudflare-worker", "vercel", "netlify", "fastly", "akamai", "gcore", "nginx", "apache", "wordpress"] as const;
export const CONNECTOR_WELL_KNOWN = "/.well-known/trooth-semanto-connector";
/** Why an app revokes its own key: the app was uninstalled, the merchant pressed Disconnect, or Shopify asked for the shop's data to be removed. */
export const UNINSTALL_REASONS = ["uninstalled", "disconnected", "shop_redact"] as const;

/** The exact validation sentences the paste route answers (docs/spec/os-api.md). */
export const PASTE_MESSAGES = {
  missing: "Send the connector's public key as public_jwk.",
  not_json: "The key is not JSON. Paste the public key exactly as the connector printed it: a JSON object that starts with {.",
  private_parts: 'This key has private parts (the "d" member). Paste only the public key and keep the private key on the connector\'s server.',
  not_ed25519: "This is not an Ed25519 key (kty must be OKP and crv Ed25519). Make an Ed25519 key in the connector and paste its public key.",
  duplicate: (kid: string) => `This key is already on file (kid ${kid}). Each connector needs its own key.`,
} as const;

const isEdgeAdapter = (source: string) => (EDGE_ADAPTER_SOURCES as readonly string[]).includes(source) || source.startsWith("adapter:");

function keyView(r: ConnectorRow) {
  return { kid: r.kid, source: r.source, label: r.label, created_at: r.created_at, last_used_at: r.last_ok_at, revoked_at: r.revoked_at };
}

function readLabel(v: unknown): { ok: true; label: string | null } | { ok: false; detail: string } {
  if (v === undefined || v === null) return { ok: true, label: null };
  if (typeof v !== "string" || v.trim().length > 100) return { ok: false, detail: "label is plain text of at most 100 characters." };
  return { ok: true, label: v.trim() || null };
}

function readSource(v: unknown, fallback: string | null): { ok: true; source: string } | { ok: false; detail: string } {
  if (v === undefined && fallback) return { ok: true, source: fallback };
  if (typeof v !== "string" || !(CONNECTOR_SOURCES as readonly string[]).includes(v)) return { ok: false, detail: "source is edge (a host adapter on your domain), api (your own code calling Trooth) or app." };
  return { ok: true, source: v };
}

/** Read a pasted public JWK and name the exact problem. */
export async function readPastedKey(input: unknown, now: Date): Promise<{ ok: true; jwk: PublicJwk } | { ok: false; detail: string }> {
  if (input === undefined || input === null) return { ok: false, detail: PASTE_MESSAGES.missing };
  let v: unknown = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, detail: PASTE_MESSAGES.not_json };
    }
  }
  if (!isRecord(v)) return { ok: false, detail: PASTE_MESSAGES.not_json };
  if ("d" in v || "p" in v || "q" in v) return { ok: false, detail: PASTE_MESSAGES.private_parts };
  if (v.kty !== "OKP" || v.crv !== "Ed25519") return { ok: false, detail: PASTE_MESSAGES.not_ed25519 };
  const accepted = await acceptCustomerPublicKey(v, now);
  if (!accepted.ok) return { ok: false, detail: accepted.reason };
  return { ok: true, jwk: accepted.jwk };
}

/** GET /os/semanto/{id}/connectors. */
export async function listConnectors(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  return ok(200, { object: "semanto.connectors", trooth_id, keys: (await s.store.connectors(trooth_id)).map(keyView) });
}

/** POST /os/semanto/{id}/connectors: paste a public JWK. */
export async function pasteConnector(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("add a connector key");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const now = s.now();
  const key = await readPastedKey(body.public_jwk, now);
  if (!key.ok) return problem("invalid_request", key.detail);
  const label = readLabel(body.label);
  if (!label.ok) return problem("invalid_request", label.detail);
  const source = readSource(body.source, "api");
  if (!source.ok) return problem("invalid_request", source.detail);
  if (!(await s.p.d.store.putConnectorKey(trooth_id, key.jwk, source.source, iso(now), label.label))) return problem("conflict", PASTE_MESSAGES.duplicate(key.jwk.kid));
  await audit(s.store, { trooth_id, ws, action: "connectors.add", target: key.jwk.kid, after: { kid: key.jwk.kid, source: source.source, label: label.label }, ctx, at: now });
  return ok(200, { object: "semanto.connector_key", trooth_id, kid: key.jwk.kid, source: source.source, label: label.label });
}

/** POST /os/semanto/{id}/connectors/create: an Ed25519 pair made here; the private JWK is answered once and never stored or logged. */
export async function createConnector(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("add a connector key");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const source = readSource(body.source, null);
  if (!source.ok) return problem("invalid_request", source.detail);
  const label = readLabel(body.label);
  if (!label.ok) return problem("invalid_request", label.detail);
  const now = s.now();
  const pair = await generateKeyPair();
  const pub: PublicJwk = { ...pair.publicJwk, nbf: iso(now) };
  if (!(await s.p.d.store.putConnectorKey(trooth_id, pub, source.source, iso(now), label.label))) return problem("conflict", PASTE_MESSAGES.duplicate(pub.kid));
  await audit(s.store, { trooth_id, ws, action: "connectors.create", target: pub.kid, after: { kid: pub.kid, source: source.source, label: label.label }, ctx, at: now });
  return ok(201, {
    object: "semanto.connector_key_created",
    trooth_id,
    kid: pub.kid,
    source: source.source,
    label: label.label,
    public_jwk: pub,
    private_jwk: { ...pair.privateJwk, nbf: pub.nbf },
    secret_shown_once: true,
    next: "Copy or download the private key now and put it in the connector's settings. Trooth does not keep it and cannot show it again.",
  });
}

type Verdict = "connected" | "never_seen" | "signature_failed" | "revoked";
/** What to do next for each test verdict, in plain words (the guidance Stripe's webhook endpoint test shows beside its result). */
export const CONNECTOR_ADVICE: Record<Verdict, string> = {
  connected: "This connector is working. Nothing to do.",
  never_seen: "Trooth has not received a signed request from this connector yet. Put the private key in the connector's settings, then send one product or press its sync button, and test again.",
  signature_failed: "The last request named this key but its signature did not check out. Check that the connector holds the private key that matches this key id and that its clock is right, then send again.",
  revoked: "This key is revoked and can no longer send. Create or paste a new key for the connector.",
};

/** POST /os/semanto/{id}/connectors/{kid}/test. */
export async function testConnector(s: OsService, ws: WorkspaceAuth, trooth_id: string, kid: string): Promise<WorkspaceResult> {
  if (!mayOperate(ws.role)) return OPERATOR_ONLY("test a connector");
  const company = await s.company(trooth_id);
  if (!company) return problem("conflict", "This company has no record yet.");
  const row = (await s.store.connectors(trooth_id)).find((r) => r.kid === kid);
  if (!row) return problem("conflict", `No connector key ${kid} is on file for this company.`);
  const answer = (verdict: Verdict, r: ConnectorRow, extra: Record<string, unknown> = {}) =>
    ok(200, { object: "semanto.connector_test", trooth_id, kid, last_signed_request_at: r.last_request_at, last_result: r.last_result, verdict, advice: CONNECTOR_ADVICE[verdict], ...extra });
  if (row.revoked_at) return answer("revoked", row);
  if (isEdgeAdapter(row.source)) {
    const url = `https://${company.domain}${CONNECTOR_WELL_KNOWN}`;
    const res = await s.p.siteProbe(url, { accept: "application/json" });
    let answered: string | null = null;
    if (res && res.status === 200) {
      try {
        const j = JSON.parse(new TextDecoder().decode(res.body)) as { kid?: unknown };
        answered = typeof j.kid === "string" ? j.kid : null;
      } catch {
        answered = null;
      }
    }
    // The well-known answer is an unsigned GET: it shows the adapter holds this kid, so the verdict is connected, but it
    // is not a signed request, so last_signed_request_at and last_result keep what the catalog route last saw.
    if (answered === kid) return answer("connected", row, { checked_url: url, adapter_kid: answered });
    const extra = { checked_url: url, adapter_kid: answered };
    if (row.last_result === "ok") return answer("connected", row, extra);
    if (row.last_result === "signature_failed") return answer("signature_failed", row, extra);
    return answer("never_seen", row, extra);
  }
  if (row.last_result === "ok") return answer("connected", row);
  if (row.last_result === "signature_failed") return answer("signature_failed", row);
  return answer("never_seen", row);
}

/** POST /os/semanto/{id}/connectors/{kid}/revoke with { confirm: kid }. */
export async function revokeConnector(s: OsService, ws: WorkspaceAuth, trooth_id: string, kid: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("revoke a connector key");
  if (body.confirm !== kid) return problem("invalid_request", `Type the key id to confirm: send { "confirm": "${kid}" }. The connector stops working at once.`);
  const row = (await s.store.connectors(trooth_id)).find((r) => r.kid === kid);
  if (!row) return problem("conflict", `No connector key ${kid} is on file for this company.`);
  if (row.revoked_at) return problem("conflict", `Connector key ${kid} was already revoked on ${row.revoked_at}.`);
  const now = s.now();
  // One conditional write: of two revokes at once (a double click), one revokes and audits; the other gets the same answer.
  if (!(await s.store.revokeConnector(kid, iso(now)))) {
    const again = await s.store.connectorByKid(kid);
    return ok(200, { object: "semanto.connector_revoked", trooth_id, kid, revoked_at: again?.revoked_at ?? iso(now) });
  }
  await audit(s.store, { trooth_id, ws, action: "connectors.revoke", target: kid, before: keyView(row), after: { kid, revoked_at: iso(now) }, ctx, at: now });
  return ok(200, { object: "semanto.connector_revoked", trooth_id, kid, revoked_at: iso(now) });
}

// ---------------------------------------------------------------- the public connect flow

const sessionState = (c: ConnectSession, now: Date): "pending" | "approved" | "denied" | "withdrawn" | "expired" => (c.state === "pending" && now.getTime() >= Date.parse(c.expires_at) ? "expired" : c.state);

/** POST /public/semanto/connect/sessions. */
export async function openConnectSession(s: OsService, input: unknown): Promise<WorkspaceResult> {
  const body = isRecord(input) ? input : {};
  if (!(CONNECT_APPS as readonly unknown[]).includes(body.app)) return problem("invalid_request", `app is one of ${CONNECT_APPS.join(", ")}.`);
  const account = str(body.account)?.toLowerCase();
  if (!account || !SHOP_RE.test(account)) return problem("invalid_request", "account is the shop's myshopify.com address, for example acme.myshopify.com.");
  const now = s.now();
  const key = await readPastedKey(body.public_jwk, now);
  if (!key.ok) return problem("invalid_request", key.detail);
  if (await s.store.connectorByKid(key.jwk.kid)) return problem("conflict", PASTE_MESSAGES.duplicate(key.jwk.kid));
  let return_url: string | null = null;
  if (body.return_url !== undefined) {
    const r = str(body.return_url);
    let parsed: URL | null = null;
    try {
      parsed = r && r.length <= 2000 ? new URL(r) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || (parsed.host !== account && parsed.host !== "admin.shopify.com")) return problem("invalid_request", `return_url is an https address of at most 2000 characters on ${account} or admin.shopify.com.`);
    return_url = parsed.toString();
  }
  const session_id = randomId("cs", (n) => s.random(n));
  const poll_token = randomToken((n) => s.random(n));
  const expires_at = iso(new Date(now.getTime() + CONNECT_SESSION_TTL_MS));
  await s.store.putConnectSession({ session_id, poll_token_hash: await tokenHash(poll_token), app: String(body.app), account, public_jwk: key.jwk, kid: key.jwk.kid, return_url, state: "pending", trooth_id: null, requested_at: iso(now), expires_at, decided_at: null, decided_by: null });
  return ok(201, { object: "semanto.connect_session", session_id, poll_token, approve_url: `${s.dashboard()}/connect/${session_id}`, expires_at, kid: key.jwk.kid, interval: CONNECT_POLL_INTERVAL_SECONDS });
}

/** GET /public/semanto/connect/sessions/{session_id} with Authorization: Bearer {poll_token}. */
export async function pollConnectSession(s: OsService, session_id: string, authorization: string | null): Promise<WorkspaceResult> {
  const token = authorization && /^Bearer\s+\S+$/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, "").trim() : null;
  const c = await s.store.getConnectSession(session_id);
  if (!c || !token || (await tokenHash(token)) !== c.poll_token_hash) return problem("unauthorized", "Send the poll_token this session answered as Authorization: Bearer.");
  const state = sessionState(c, s.now());
  return ok(200, { object: "semanto.connect_session", session_id, state, ...(state === "approved" ? { trooth_id: c.trooth_id, kid: c.kid } : {}), expires_at: c.expires_at, ...(state === "pending" ? { interval: CONNECT_POLL_INTERVAL_SECONDS } : {}) });
}

/** GET /os/semanto/connect/{session_id}: what the approve page shows, for a signed-in session with or without a company. */
export async function describeConnectSession(s: OsService, session: WorkspaceSession, session_id: string): Promise<WorkspaceResult> {
  const c = await s.store.getConnectSession(session_id);
  if (!c) return problem("connect_session_not_found", "This connect request does not exist. Start again from the app.");
  if (sessionState(c, s.now()) === "expired") return problem("connect_session_expired", "This connect request has expired (they last 15 minutes). Start again from the app.");
  const company = await s.p.d.store.getCompanyByOsCompany(session.os_company_id);
  return ok(200, {
    object: "semanto.connect_request",
    session_id,
    app: c.app,
    account: c.account,
    kid: c.kid,
    requested_at: c.requested_at,
    expires_at: c.expires_at,
    state: sessionState(c, s.now()),
    // The app's own return address (checked when the request was opened), for the page's way back to the app.
    return_url: c.return_url,
    companies: company ? [{ trooth_id: company.trooth_id, domain: company.domain, org: company.org }] : [],
  });
}

/** POST /os/semanto/{id}/connect/{session_id}/approve and /deny. */
export async function decideConnectSession(s: OsService, ws: WorkspaceAuth, trooth_id: string, session_id: string, decision: "approved" | "denied", ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY(decision === "approved" ? "connect an app" : "decline an app");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const c = await s.store.getConnectSession(session_id);
  if (!c) return problem("connect_session_not_found", "This connect request does not exist. Start again from the app.");
  const now = s.now();
  const state = sessionState(c, now);
  if (state === "expired") return problem("connect_session_expired", "This connect request has expired (they last 15 minutes). Start again from the app.");
  // The same decision for the same company again (a double click, a retried request): the same answer, nothing changes.
  if (state === decision && c.trooth_id === trooth_id) return ok(200, { object: "semanto.connect_session", session_id, state: decision, trooth_id, ...(decision === "approved" ? { kid: c.kid, source: `${c.app}:${c.account}` } : {}), return_url: c.return_url });
  if (state === "withdrawn") return problem("connect_session_withdrawn", "The store withdrew this request (the app was removed or disconnected before it was approved). Nothing was connected. Start again from the app.");
  if (state !== "pending") return problem("conflict", `This connect request was already ${state}.`);
  const source = `${c.app}:${c.account}`;
  // The key is registered first, insert only: of two approvals at once (into two companies, or a double click), one
  // registers it and the other is refused, so a key never moves between companies.
  if (decision === "approved" && !(await s.p.d.store.putConnectorKey(trooth_id, c.public_jwk, source, iso(now), `${c.app === "shopify" ? "Shopify" : c.app}: ${c.account}`))) {
    const settled = await s.store.getConnectSession(session_id);
    if (settled?.state === "approved" && settled.trooth_id === trooth_id) return ok(200, { object: "semanto.connect_session", session_id, state: decision, trooth_id, kid: c.kid, source, return_url: c.return_url });
    return problem("conflict", PASTE_MESSAGES.duplicate(c.kid));
  }
  if (!(await s.store.decideConnectSession(session_id, decision, trooth_id, ws.user_id, iso(now)))) {
    // A deny or an approval elsewhere settled the session first: the key this request registered is revoked at once.
    if (decision === "approved") await s.store.revokeConnector(c.kid, iso(now));
    return problem("conflict", "This connect request was decided by another request.");
  }
  await audit(s.store, { trooth_id, ws, action: decision === "approved" ? "connect.approve" : "connect.deny", target: session_id, before: { state: "pending" }, after: { state: decision, kid: c.kid, source }, ctx, at: now });
  return ok(200, { object: "semanto.connect_session", session_id, state: decision, trooth_id, ...(decision === "approved" ? { kid: c.kid, source } : {}), return_url: c.return_url });
}

/**
 * An uninstall (or Disconnect) signed by a key Trooth never registered. When a
 * connect request that offered this key is still waiting for the merchant, and
 * the request is signed by that key, the request is withdrawn (state
 * "withdrawn", by the app), so a later Approve cannot register a key no app holds any more (QA-16).
 * Either way the answer is 404 not_registered: there was no key to revoke.
 */
async function withdrawPending(s: OsService, req: SignedRequest, kid: string): Promise<WorkspaceResult> {
  const notRegistered = (extra = "") => problem("not_registered", `No connector key ${kid} was ever registered with Trooth. There is nothing to revoke.${extra}`);
  const pending = await s.store.pendingConnectSessionByKid(kid);
  if (!pending) return notRegistered();
  // The request's key proves the app sent this; its nbf is the moment the request was opened, to the millisecond, so a
  // withdrawal signed in that same second (created is whole seconds) would read as signed before the key began.
  const { nbf: _nbf, ...proofKey } = pending.public_jwk as typeof pending.public_jwk & { nbf?: unknown };
  const nowSec = Math.floor(s.now().getTime() / 1000);
  const sig = await verifyMessage({ kind: "request", method: req.method, url: req.url, headers: req.headers }, { resolveKey: (k) => (k === pending.kid ? proofKey : null), required: [...CONNECTOR_COMPONENTS], tag: CONNECTOR_TAG, now: nowSec, maxAgeSeconds: CONNECTOR_MAX_AGE_SECONDS });
  if (!sig.ok || !sig.params.nonce || !(await verifyContentDigest(req.headers.get("content-digest"), req.body))) return notRegistered();
  if (s.p.d.nonces) {
    const until = (sig.params.expires ?? sig.params.created + CONNECTOR_MAX_AGE_SECONDS) * 1000;
    if (!(await s.p.d.nonces.claim(`${sig.keyid}:${sig.params.nonce}`, until, nowSec * 1000))) return problem("unauthorized", "This request was already received (its nonce was used). Send a new request.");
  }
  await s.store.withdrawConnectSession(pending.session_id, `app:${pending.app}`, iso(s.now()));
  return notRegistered(" The connect request that offered it was withdrawn, so it cannot be approved.");
}

/** POST /public/semanto/connect/uninstall, signed with the app's own key (RFC 9421, tag trooth-connector): the key is revoked. */
export async function uninstallConnector(s: OsService, req: SignedRequest, ctx: RequestContext): Promise<WorkspaceResult> {
  const kid = namedConnectorKid(req.headers);
  if (!kid) return problem("unauthorized", "Sign the request with the app's connector key (RFC 9421, tag trooth-connector).");
  const row = await s.store.connectorByKid(kid);
  // A well-formed signature by a key never registered: nothing to revoke, and the app can tell it from a bad signature.
  if (!row) return withdrawPending(s, req, kid);
  if (!row.source.includes(":")) return problem("forbidden", "This key was not registered by an app install, so an app cannot revoke it. Revoke it in the dashboard.");
  const nowSec = Math.floor(s.now().getTime() / 1000);
  const sig = await verifyMessage({ kind: "request", method: req.method, url: req.url, headers: req.headers }, { resolveKey: (k) => (k === row.kid ? row.public_jwk : null), required: [...CONNECTOR_COMPONENTS], tag: CONNECTOR_TAG, now: nowSec, maxAgeSeconds: CONNECTOR_MAX_AGE_SECONDS });
  if (!sig.ok) return problem("unauthorized", `The connector signature did not check out (${sig.reason}).`);
  if (!(await verifyContentDigest(req.headers.get("content-digest"), req.body))) return problem("unauthorized", "Content-Digest does not match the body.");
  if (!sig.params.nonce) return problem("unauthorized", "The connector signature carries no nonce. Every request needs a fresh nonce.");
  if (s.p.d.nonces) {
    const until = (sig.params.expires ?? sig.params.created + CONNECTOR_MAX_AGE_SECONDS) * 1000;
    if (!(await s.p.d.nonces.claim(`${sig.keyid}:${sig.params.nonce}`, until, nowSec * 1000))) return problem("unauthorized", "This request was already received (its nonce was used). Send a new request.");
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = req.body.length ? (JSON.parse(new TextDecoder().decode(req.body)) as unknown) : {};
    body = isRecord(parsed) ? parsed : {};
  } catch {
    return problem("invalid_request", "The body is not JSON.");
  }
  const account = str(body.account)?.toLowerCase();
  if (account && row.source !== `${row.source.split(":")[0]}:${account}`) return problem("forbidden", `This key belongs to ${row.source}, not ${account}.`);
  const reason = body.reason === undefined ? "uninstalled" : body.reason;
  if (!(UNINSTALL_REASONS as readonly unknown[]).includes(reason)) return problem("invalid_request", `reason is one of ${UNINSTALL_REASONS.join(", ")}.`);
  // Revoked already (an uninstall sent twice): the same answer, nothing changes.
  if (row.revoked_at) return ok(200, { object: "semanto.connector_revoked", trooth_id: row.trooth_id, kid: row.kid, revoked_at: row.revoked_at, reason });
  const at = iso(s.now());
  if (!(await s.store.revokeConnector(row.kid, at))) {
    const again = await s.store.connectorByKid(row.kid);
    return ok(200, { object: "semanto.connector_revoked", trooth_id: row.trooth_id, kid: row.kid, revoked_at: again?.revoked_at ?? at, reason });
  }
  await audit(s.store, { trooth_id: row.trooth_id, ws: { user_id: `connector:${row.kid}`, role: "connector", name: `connector:${row.kid}` }, action: `connectors.uninstall.${reason}`, target: row.kid, before: keyView(row), after: { kid: row.kid, revoked_at: at, reason }, ctx, at: s.now() });
  return ok(200, { object: "semanto.connector_revoked", trooth_id: row.trooth_id, kid: row.kid, revoked_at: at, reason });
}
