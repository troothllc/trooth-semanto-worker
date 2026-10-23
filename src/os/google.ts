// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Connect Google: Merchant Center and Business Profile (contract section 1e).
//
// OAuth 2.0 for web server applications as Google's own guide describes it:
// the authorization code flow with PKCE (S256), access_type=offline for a
// refresh token, prompt=consent, include_granted_scopes=true for incremental
// scopes, a state value bound to the company, the person and a ten-minute
// expiry (kept only as its SHA-256, used once), revocation at
// https://oauth2.googleapis.com/revoke, and invalid_grant read as "the
// person must connect again". The refresh token is sealed with AES-256-GCM
// (src/db/key-seal.ts, context google-refresh) and opened only to refresh,
// on use, never on a schedule. A refresh answering invalid_grant sets
// needs_reconnect and sends one alert to the confirmed alert addresses; the
// screen then shows Reconnect, as Zapier, Shopify and HubSpot show an
// expired connection.
//
// Merchant writes use the Merchant API (merchantapi.googleapis.com), not the
// Content API for Shopping, whose sunset Google announced for 2026.

import { sha256 } from "../core/hash";
import { toBase64Url } from "../core/encoding";
import { openText, sealText } from "../db/key-seal";
import type { WorkspaceAuth, WorkspaceResult } from "../serve/ports";
import { ADMIN_ONLY, audit, iso, isRecord, mayAdminister, ok, problem, randomToken, str, tokenHash, type RequestContext } from "./common";
import type { OsService } from "./service";
import type { GoogleConnection, GoogleProduct } from "./store";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const MERCHANT_ACCOUNTS_URL = "https://merchantapi.googleapis.com/accounts/v1/accounts";
export const GBP_ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
export const GBP_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const SEAL_CONTEXT = "google-refresh";

export const SCOPES: Record<GoogleProduct | "identity", { scope: string; purpose: string }[]> = {
  merchant: [{ scope: "https://www.googleapis.com/auth/content", purpose: "Send your signed product details to Merchant Center." }],
  business: [{ scope: "https://www.googleapis.com/auth/business.manage", purpose: "Send your signed name, phone, address, hours and website to Business Profile." }],
  identity: [
    { scope: "openid", purpose: "Know which Google account you connected." },
    { scope: "email", purpose: "Show the Google account's email address on this screen." },
  ],
};
const ALL_SCOPES = [...SCOPES.merchant, ...SCOPES.business, ...SCOPES.identity];
const PRODUCTS: GoogleProduct[] = ["merchant", "business"];

function googleView(trooth_id: string, g: GoogleConnection | null) {
  const granted = new Set(g?.scopes ?? []);
  return {
    object: "semanto.google",
    trooth_id,
    state: g ? g.state : "not_connected",
    account_email: g?.account_email ?? null,
    scopes: ALL_SCOPES.map((s) => ({ scope: s.scope, purpose: s.purpose, granted: granted.has(s.scope) || (s.scope === "email" && granted.has("https://www.googleapis.com/auth/userinfo.email")) })),
    merchant_accounts: g?.merchant_accounts ?? [],
    business_locations: g?.business_locations ?? [],
    connected_at: g?.connected_at ?? null,
    last_refresh_at: g?.last_refresh_at ?? null,
    last_error: g?.last_error ?? null,
  };
}

/** GET /os/semanto/{id}/google. */
export async function googleStatus(s: OsService, trooth_id: string): Promise<WorkspaceResult> {
  return ok(200, googleView(trooth_id, await s.store.getGoogle(trooth_id)));
}

/** POST /os/semanto/{id}/google/connect: the authorization URL, PKCE and state stored for ten minutes. */
export async function connectGoogle(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("connect Google");
  if (!(await s.company(trooth_id))) return problem("conflict", "This company has no record yet.");
  const client = s.d.google;
  if (!client) return problem("conflict", "Connect Google is not set up on this deployment yet (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET). Nothing was changed.");
  if (!s.d.sealSecret || s.d.sealSecret.length < 32) return problem("conflict", "This deployment cannot keep a Google token safely yet (HOSTED_KEY_SEAL_SECRET). Nothing was changed.");
  const list = Array.isArray(body.products) ? body.products : null;
  if (!list || list.length === 0 || list.some((p) => !PRODUCTS.includes(p as GoogleProduct))) return problem("invalid_request", 'products is a list of "merchant" and "business", at least one.');
  const products = PRODUCTS.filter((p) => list.includes(p));
  const now = s.now();
  const verifier = toBase64Url(s.random(32));
  const challenge = toBase64Url(await sha256(verifier));
  const state = randomToken((n) => s.random(n));
  await s.store.putGoogleState({ state_hash: await tokenHash(state), trooth_id, user_id: ws.user_id, who: ws.name, role: ws.role, code_verifier: verifier, products, created_at: iso(now), expires_at: iso(new Date(now.getTime() + STATE_TTL_MS)) });
  const scope = [...products.flatMap((p) => SCOPES[p].map((x) => x.scope)), "openid", "email"].join(" ");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  await audit(s.store, { trooth_id, ws, action: "google.connect.start", target: products.join(","), after: { products }, ctx, at: now });
  return ok(200, { object: "semanto.google_authorization", trooth_id, authorization_url: `${GOOGLE_AUTH_URL}?${params.toString()}`, expires_at: iso(new Date(now.getTime() + STATE_TTL_MS)) });
}

/** The email claim of an ID token received straight from Google's token endpoint over TLS (Google's guide: no signature check needed then). */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = idToken.split(".")[1] ?? "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    return typeof json.email === "string" ? json.email : null;
  } catch {
    return null;
  }
}

const form = (v: Record<string, string>) => new URLSearchParams(v).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

/** GET /public/semanto/google/callback: always a redirect to the dashboard, connected or with a reason code. */
export async function googleCallback(s: OsService, query: Record<string, string>, ctx: RequestContext): Promise<{ location: string }> {
  const back = (q: string) => ({ location: `${s.dashboard()}/connections?${q}` });
  const fail = (reason: string) => back(`google=error&reason=${encodeURIComponent(reason)}`);
  const client = s.d.google;
  if (!client || !s.d.sealSecret) return fail("not_configured");
  if (query.error) return fail(/^[a-z_]{1,40}$/.test(query.error) ? query.error : "access_denied");
  if (!query.state) return fail("state_invalid");
  const st = await s.store.takeGoogleState(await tokenHash(query.state));
  if (!st) return fail("state_invalid");
  const now = s.now();
  if (Date.parse(st.expires_at) <= now.getTime()) return fail("state_expired");
  if (!query.code) return fail("no_code");
  let tokenAnswer: Record<string, unknown>;
  try {
    const res = await s.d.http(GOOGLE_TOKEN_URL, { method: "POST", headers: FORM, body: form({ code: query.code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: client.redirect_uri, grant_type: "authorization_code", code_verifier: st.code_verifier }) });
    if (res.status !== 200) return fail("exchange_failed");
    const parsed = JSON.parse(res.body) as unknown;
    if (!isRecord(parsed)) return fail("exchange_failed");
    tokenAnswer = parsed;
  } catch (e) {
    s.logError(ctx.request_id, "google callback", e);
    return fail("exchange_failed");
  }
  const refresh = str(tokenAnswer.refresh_token);
  const access = str(tokenAnswer.access_token);
  if (!refresh || !access) return fail("no_refresh_token");
  const scopes = (str(tokenAnswer.scope) ?? "").split(/\s+/).filter(Boolean);
  const wanted = st.products.flatMap((p) => SCOPES[p].map((x) => x.scope));
  if (!wanted.some((w) => scopes.includes(w))) return fail("scopes_declined");
  const previous = await s.store.getGoogle(st.trooth_id);
  const accounts = await readAccounts(s, access, scopes);
  const conn: GoogleConnection = {
    trooth_id: st.trooth_id,
    state: "connected",
    account_email: emailOf(tokenAnswer.id_token),
    products: PRODUCTS.filter((p) => SCOPES[p].every((x) => scopes.includes(x.scope))),
    scopes,
    sealed_refresh_token: await sealText(refresh, s.d.sealSecret, SEAL_CONTEXT, st.trooth_id),
    merchant_accounts: accounts.merchant,
    business_locations: accounts.business,
    connected_at: iso(now),
    connected_by: st.user_id,
    last_refresh_at: iso(now),
    last_error: null,
    alerted_at: null,
  };
  await s.store.putGoogle(conn);
  s.googleTokens.delete(st.trooth_id);
  await audit(s.store, { trooth_id: st.trooth_id, ws: { user_id: st.user_id, role: st.role, name: st.who }, action: previous ? "google.reconnect" : "google.connect", target: conn.account_email ?? "google", before: previous ? { state: previous.state, scopes: previous.scopes } : null, after: { state: "connected", scopes }, ctx, at: now });
  return back("google=connected");
}

/** The Merchant Center accounts and Business Profile locations this token can see, read once at connect time. Best effort. */
async function readAccounts(s: OsService, access: string, scopes: string[]): Promise<{ merchant: GoogleConnection["merchant_accounts"]; business: GoogleConnection["business_locations"] }> {
  const auth = { authorization: `Bearer ${access}`, accept: "application/json" };
  const merchant: GoogleConnection["merchant_accounts"] = [];
  const business: GoogleConnection["business_locations"] = [];
  const getJson = async (url: string): Promise<Record<string, unknown> | null> => {
    try {
      const r = await s.d.http(url, { method: "GET", headers: auth });
      if (r.status !== 200) return null;
      const j = JSON.parse(r.body) as unknown;
      return isRecord(j) ? j : null;
    } catch {
      return null;
    }
  };
  if (scopes.includes(SCOPES.merchant[0]!.scope)) {
    const j = await getJson(MERCHANT_ACCOUNTS_URL);
    for (const a of Array.isArray(j?.accounts) ? j!.accounts : []) {
      if (!isRecord(a)) continue;
      const id = str(a.accountId) ?? str(a.name)?.split("/")[1];
      if (id) merchant.push({ id, name: str(a.accountName) ?? id });
    }
  }
  if (scopes.includes(SCOPES.business[0]!.scope)) {
    const j = await getJson(GBP_ACCOUNTS_URL);
    const accounts = (Array.isArray(j?.accounts) ? j!.accounts : []).filter(isRecord).slice(0, 10);
    for (const a of accounts) {
      const name = str(a.name);
      if (!name) continue;
      const l = await getJson(`${GBP_INFO_BASE}/${name}/locations?readMask=name,title&pageSize=100`);
      for (const loc of Array.isArray(l?.locations) ? l!.locations : []) {
        if (isRecord(loc) && str(loc.name)) business.push({ name: str(loc.name)!, title: str(loc.title) ?? str(loc.name)! });
      }
    }
  }
  return { merchant, business };
}

/** POST /os/semanto/{id}/google/disconnect with { confirm: true }: revoke at Google, delete the sealed token. */
export async function disconnectGoogle(s: OsService, ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext): Promise<WorkspaceResult> {
  if (!mayAdminister(ws.role)) return ADMIN_ONLY("disconnect Google");
  if (body.confirm !== true) return problem("invalid_request", 'Send { "confirm": true } to disconnect. Write-back to Google stops until you connect again.');
  const g = await s.store.getGoogle(trooth_id);
  if (!g) return problem("conflict", "Google is not connected.");
  let revoked = false;
  const token = await openText(g.sealed_refresh_token, s.d.sealSecret, SEAL_CONTEXT, trooth_id);
  if (token) {
    try {
      revoked = (await s.d.http(GOOGLE_REVOKE_URL, { method: "POST", headers: FORM, body: form({ token }) })).status === 200;
    } catch (e) {
      s.logError(ctx.request_id, "google revoke", e);
    }
  }
  await s.store.deleteGoogle(trooth_id);
  s.googleTokens.delete(trooth_id);
  const now = s.now();
  await audit(s.store, { trooth_id, ws, action: "google.disconnect", target: g.account_email ?? "google", before: { state: g.state, scopes: g.scopes }, after: { state: "not_connected", revoked_at_google: revoked }, ctx, at: now });
  return ok(200, { ...googleView(trooth_id, null), revoked_at_google: revoked });
}

export type AccessToken = { ok: true; token: string; connection: GoogleConnection } | { ok: false; reason: "not_connected" | "needs_reconnect" | "upstream"; detail: string };

/**
 * An access token, refreshed now (on use only). invalid_grant sets
 * needs_reconnect and sends one alert to the confirmed alert addresses.
 */
export async function googleAccessToken(s: OsService, trooth_id: string): Promise<AccessToken> {
  const g = await s.store.getGoogle(trooth_id);
  if (!g) return { ok: false, reason: "not_connected", detail: "Google is not connected. Connect it under Connections." };
  if (g.state === "needs_reconnect") return { ok: false, reason: "needs_reconnect", detail: "Google needs you to connect again. Press Reconnect under Connections." };
  const cached = s.googleTokens.get(trooth_id);
  if (cached && cached.until > s.now().getTime()) return { ok: true, token: cached.token, connection: g };
  const client = s.d.google;
  const refresh = await openText(g.sealed_refresh_token, s.d.sealSecret, SEAL_CONTEXT, trooth_id);
  if (!client || !refresh) return { ok: false, reason: "upstream", detail: "This deployment cannot open the Google token right now." };
  let res;
  try {
    res = await s.d.http(GOOGLE_TOKEN_URL, { method: "POST", headers: FORM, body: form({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: refresh, grant_type: "refresh_token" }) });
  } catch {
    return { ok: false, reason: "upstream", detail: "Google did not answer the token refresh." };
  }
  let j: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(res.body) as unknown;
    j = isRecord(parsed) ? parsed : {};
  } catch {
    j = {};
  }
  if (res.status === 200 && str(j.access_token)) {
    await s.store.noteGoogleRefresh(trooth_id, iso(s.now()));
    const lifetime = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 0;
    if (lifetime > 120) s.googleTokens.set(trooth_id, { token: str(j.access_token)!, until: s.now().getTime() + (lifetime - 60) * 1000 });
    return { ok: true, token: str(j.access_token)!, connection: g };
  }
  s.googleTokens.delete(trooth_id);
  if (j.error === "invalid_grant") {
    const detail = "Google no longer accepts this connection (the access was removed or has expired). Press Reconnect under Connections.";
    if (await s.store.markGoogleNeedsReconnect(trooth_id, detail, iso(s.now()))) await alertReconnect(s, trooth_id);
    return { ok: false, reason: "needs_reconnect", detail };
  }
  return { ok: false, reason: "upstream", detail: `Google answered ${res.status} to the token refresh.` };
}

/** The one alert for needs_reconnect, to the confirmed alert addresses only. */
async function alertReconnect(s: OsService, trooth_id: string): Promise<void> {
  if (!s.d.email || !s.d.from) return;
  const to = (await s.store.alertAddresses(trooth_id)).filter((a) => a.state === "confirmed").map((a) => a.address);
  if (!to.length) return;
  const company = await s.company(trooth_id);
  const name = company?.domain ?? trooth_id;
  const link = `${s.dashboard()}/connections`;
  const text = `Google no longer accepts Semanto's connection for ${name}, so write-back to Merchant Center and Business Profile has stopped.\n\nConnect again here: ${link}\n`;
  await s.d.email.send({ from: s.d.from, to, subject: `Reconnect Google for ${name}`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
}
