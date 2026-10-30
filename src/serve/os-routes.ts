// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The routes of the workspace contract of 23 October 2026
// (docs/program/CONTRACT-2026-10-23.md, docs/spec/os-api.md), registered on
// the Hono app by src/serve/routes.ts before its own routes, so the paths
// they share (keys, keys/{kid}/revoke, keys/rotate, settings, receipts,
// receipts.csv, connectors, writeback) answer in the contract's shapes when
// the contract's service is wired, as it always is in the Worker.
//
// Every /os route here passes workspaceFor (deny by default, the caller's
// company only) or, for the connect approve page, the worker-f session; every
// write passes the os_write rate group (30 a minute per session subject),
// reads a JSON body of at most 5 MB, and appends an audit row in its handler.
// The public connect routes pass the public_connect group (10 a minute per
// address) in the middleware; the Google callback and the alert confirmation
// are links a browser opens and answer with a redirect to the dashboard.
// Every answer is signed through the same send as every other route.

import type { Context, Hono } from "hono";
import { isTroothId } from "../core/ids";
import type { LimitGroup } from "../readers/rate-limit";
import type { OsService } from "../os/service";
import { audit, type RequestContext } from "../os/common";
import { bindingCheck, cancelRotation, confirmRotation, keysView, revokeKey, rotateNow, rotationOptions, startRotation } from "../os/keys";
import { previewSettings, saveSettings, settingsView } from "../os/settings";
import { receiptsCsvRead, receiptsRead } from "../os/receipts";
import { createConnector, decideConnectSession, describeConnectSession, listConnectors, openConnectSession, pasteConnector, pollConnectSession, revokeConnector, testConnector, uninstallConnector } from "../os/connectors";
import { connectGoogle, disconnectGoogle, googleCallback, googleStatus } from "../os/google";
import { companySettings, changesPage, confirmAlert, editAlerts, editSurfaces, setSigningPolicy } from "../os/company";
import { getRun, listRuns, retryRun, sendWriteback, writebackPreview } from "../os/writeback";
import { listSellerLists, sellerListOptions, submitSellerList } from "../os/sellers";
import { listCredentials, publicCredential } from "../os/credentials";
import { listRecalls, recallOptions, submitRecall } from "../os/recalls";
import { WORKSPACE_ACTIONS, type WorkspaceAuth, type WorkspaceResult, type WorkspaceSession } from "./ports";
import { createAgentKey, listAgentKeys, revokeAgentKey, type AgentKeyStore } from "../os/agent-keys";
import { namedConnectorKid } from "../pipeline";
import type { ProblemCode } from "./errors";

/** What src/serve/routes.ts hands this module: its own helpers, so every answer is built the same way. */
export interface RouteKit<V extends { Variables: Record<string, unknown> }> {
  osPrefix: string;
  apiPrefix: string;
  requestIdOf(c: Context<V>): string;
  workspaceFor(c: Context<V>, trooth_id: string): Promise<WorkspaceAuth | Response>;
  sessionFor(c: Context<V>): Promise<WorkspaceSession | Response>;
  /** The body as JSON up to 5 MB: the value, "too_large", or undefined when it is not JSON. */
  readBody(c: Context<V>): Promise<unknown>;
  readRaw(c: Context<V>): Promise<Uint8Array | null>;
  sendWorkspace(c: Context<V>, trooth_id: string, result: WorkspaceResult): Promise<Response>;
  sendProblem(c: Context<V>, code: ProblemCode, detail?: string, retry_after?: number): Promise<Response>;
  sendRedirect(c: Context<V>, location: string): Promise<Response>;
  sendJson(c: Context<V>, status: number, value: unknown): Promise<Response>;
  /** A keyed token bucket (src/readers/rate-limit.ts); absent in tests that do not limit. */
  limit?: (key: string, group: LimitGroup) => Promise<{ allowed: boolean; retry_after: number }>;
  /** Agent keys for AI agents (src/os/agent-keys.ts); absent in tests that do not use them. */
  agentKeys?: AgentKeyStore;
}

type Handler = (ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>, ctx: RequestContext, kid: string | undefined, run: string | undefined) => Promise<WorkspaceResult>;

export function registerOsRoutes<V extends { Variables: Record<string, unknown> }>(app: Hono<V>, kit: RouteKit<V>, os: OsService): void {
  const { osPrefix, apiPrefix } = kit;
  const ctxOf = (c: Context<V>): RequestContext => ({ request_id: kit.requestIdOf(c) });
  const query = (c: Context<V>): Record<string, string> => {
    const q: Record<string, string> = {};
    new URL(c.req.url).searchParams.forEach((v, k) => {
      q[k] = v;
    });
    return q;
  };

  /** A handler that throws answers a problem with a request id (the exception is logged under it, never sent), as the pipeline's actions do. */
  const guarded = async (action: string, run: () => Promise<WorkspaceResult>): Promise<WorkspaceResult> => {
    try {
      return await run();
    } catch (e) {
      return os.p.failed(action, e);
    }
  };

  /** A workspace write: auth, the os_write group per session subject, a JSON body, the handler (which audits). */
  const written = new Set<string>();
  const write = (path: string, handler: Handler) =>
    written.add(path) &&
    app.post(`${osPrefix}/:trooth_id/${path}`, async (c) => {
      const trooth_id = c.req.param("trooth_id") ?? "";
      if (!isTroothId(trooth_id)) return kit.sendProblem(c, "invalid_trooth_id");
      const ws = await kit.workspaceFor(c, trooth_id);
      if (ws instanceof Response) return ws;
      if (kit.limit) {
        const r = await kit.limit(`${trooth_id}:${ws.user_id}`, "os_write");
        if (!r.allowed) return kit.sendProblem(c, "rate_limited", "Too many changes in a minute from this session. Wait, then try again.", r.retry_after);
      }
      const input = await kit.readBody(c);
      if (input === "too_large") return kit.sendProblem(c, "payload_too_large", "The body is larger than 5 MB.");
      if (input === undefined) return kit.sendProblem(c, "invalid_request", "The body is not JSON.");
      const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      return kit.sendWorkspace(c, trooth_id, await guarded(path, () => handler(ws, trooth_id, body, ctxOf(c), c.req.param("kid") as string | undefined, (c.req.param("run_id") ?? c.req.param("session_id")) as string | undefined)));
    });

  /** A workspace read: auth, then the handler. */
  const read = (path: string, handler: (ws: WorkspaceAuth, trooth_id: string, q: Record<string, string>, param: string | undefined) => Promise<WorkspaceResult>) =>
    app.get(`${osPrefix}/:trooth_id/${path}`, async (c) => {
      const trooth_id = c.req.param("trooth_id") ?? "";
      if (!isTroothId(trooth_id)) return kit.sendProblem(c, "invalid_trooth_id");
      const ws = await kit.workspaceFor(c, trooth_id);
      if (ws instanceof Response) return ws;
      return kit.sendWorkspace(c, trooth_id, await guarded(path, () => handler(ws, trooth_id, query(c), c.req.param("run_id") as string | undefined)));
    });

  // ------------------------------------------------------------ the sensitive pipeline actions, audited (review, 23 October 2026)
  // Adding a signing passkey, signing a version and withdrawing one change what a company publishes; they keep the
  // pipeline's handlers and shapes and also append the audit row every other write appends, so they show under
  // "Recent changes". Registered here, before src/serve/routes.ts registers the same paths without the audit.
  const audited = (path: "passkeys" | "sign" | "withdraw") =>
    write(path, async (ws, id, body, ctx) => {
      const result = await os.p.handle(path, ws, id, body);
      if (result.problem || result.status >= 300) return result;
      const b = (result.body ?? {}) as Record<string, unknown>;
      const record = async (action: string, target: string, after: unknown) => audit(os.store, { trooth_id: id, ws, action, target, after, ctx, at: os.now() });
      if (path === "passkeys") await record("passkeys.add", String(b.credential_id ?? ""), { credential_id: b.credential_id, alg: b.alg });
      else if (path === "withdraw") await record("versions.withdraw", `v${String(b.version ?? "")}`, { version: b.version, version_id: b.version_id, revoked_at: b.revoked_at });
      else if (b.object === "semanto.signed") await record("versions.sign", `v${String(b.version ?? "")}`, { version: b.version, version_id: b.version_id, kid: b.kid });
      else if (b.object === "semanto.sign_waiting") await record("versions.approve", `v${String(b.version ?? "")}`, { version: b.version, root_hash: b.root_hash });
      return result;
    });
  audited("passkeys");
  audited("sign");
  audited("withdraw");

  // ------------------------------------------------------------ 1a. delivery settings
  read("settings", (_ws, id) => settingsView(os, id));
  write("settings/preview", (ws, id, body) => previewSettings(os, ws, id, body));
  write("settings", (ws, id, body, ctx) => saveSettings(os, ws, id, body, ctx));

  // ------------------------------------------------------------ 1b. keys, binding, rotation
  read("keys", (_ws, id) => keysView(os, id));
  write("keys/rotation/start", (ws, id, body, ctx) => startRotation(os, ws, id, body, ctx));
  write("keys/rotation/options", (ws, id, body) => rotationOptions(os, ws, id, body));
  write("keys/rotation/confirm", (ws, id, body, ctx) => confirmRotation(os, ws, id, body, ctx));
  write("keys/rotation/cancel", (ws, id, body, ctx) => cancelRotation(os, ws, id, body, ctx));
  write("keys/binding/check", (ws, id) => bindingCheck(os, ws, id));
  write("keys/rotate", (ws, id, body, ctx) => rotateNow(os, ws, id, body, ctx));
  write("keys/:kid/revoke", (ws, id, body, ctx, kid) => revokeKey(os, ws, id, kid ?? "", body, ctx));

  // ------------------------------------------------------------ 1c. read receipts
  read("receipts", (_ws, id, q) => receiptsRead(os, id, q));
  read("receipts.csv", (_ws, id, q) => receiptsCsvRead(os, id, q));

  // ------------------------------------------------------------ 1d. connector keys and the connect flow
  read("connectors", (_ws, id) => listConnectors(os, id));
  write("connectors", (ws, id, body, ctx) => pasteConnector(os, ws, id, body, ctx));
  write("connectors/create", (ws, id, body, ctx) => createConnector(os, ws, id, body, ctx));
  write("connectors/:kid/test", (ws, id, _body, _ctx, kid) => testConnector(os, ws, id, kid ?? ""));
  write("connectors/:kid/revoke", (ws, id, body, ctx, kid) => revokeConnector(os, ws, id, kid ?? "", body, ctx));
  write("connect/:session_id/approve", (ws, id, _body, ctx, _kid, session) => decideConnectSession(os, ws, id, session ?? "", "approved", ctx));
  write("connect/:session_id/deny", (ws, id, _body, ctx, _kid, session) => decideConnectSession(os, ws, id, session ?? "", "denied", ctx));

  app.get(`${osPrefix}/connect/:session_id`, async (c) => {
    const s = await kit.sessionFor(c);
    if (s instanceof Response) return s;
    const result = await describeConnectSession(os, s, c.req.param("session_id") ?? "");
    return kit.sendWorkspace(c, "", result);
  });

  app.post(`${apiPrefix}/connect/sessions`, async (c) => {
    const input = await kit.readBody(c);
    if (input === "too_large") return kit.sendProblem(c, "payload_too_large", "The body is larger than 5 MB.");
    if (input === undefined) return kit.sendProblem(c, "invalid_request", "The body is not JSON.");
    return kit.sendWorkspace(c, "", await openConnectSession(os, input));
  });
  /** A keyed bucket for the public connect routes (connect_poll by session id, connect_uninstall by key id). */
  const limited = async (c: Context<V>, key: string, group: LimitGroup): Promise<Response | null> => {
    if (!kit.limit) return null;
    const r = await kit.limit(key, group);
    return r.allowed ? null : kit.sendProblem(c, "rate_limited", undefined, r.retry_after);
  };
  app.get(`${apiPrefix}/connect/sessions/:session_id`, async (c) => {
    const id = c.req.param("session_id") ?? "";
    const over = await limited(c, `session:${id}`, "connect_poll");
    if (over) return over;
    return kit.sendWorkspace(c, "", await pollConnectSession(os, id, c.req.header("authorization") ?? null));
  });
  app.post(`${apiPrefix}/connect/uninstall`, async (c) => {
    // Per key id and client address: the kid is read before the signature is checked, so a bucket per kid alone would
    // let anyone who knows a kid use up that app's uninstalls by sending requests that name it.
    const over = await limited(c, `kid:${namedConnectorKid(c.req.raw.headers) ?? "unsigned"}:${c.req.header("cf-connecting-ip") ?? "unknown"}`, "connect_uninstall");
    if (over) return over;
    const body = await kit.readRaw(c);
    if (body === null) return kit.sendProblem(c, "payload_too_large", "The body is larger than 5 MB.");
    return kit.sendWorkspace(c, "", await uninstallConnector(os, { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body }, ctxOf(c)));
  });

  // ------------------------------------------------------------ 1e. Connect Google
  read("google", (_ws, id) => googleStatus(os, id));
  write("google/connect", (ws, id, body, ctx) => connectGoogle(os, ws, id, body, ctx));
  write("google/disconnect", (ws, id, body, ctx) => disconnectGoogle(os, ws, id, body, ctx));
  app.get(`${apiPrefix}/google/callback`, async (c) => kit.sendRedirect(c, (await googleCallback(os, query(c), ctxOf(c))).location));

  // ------------------------------------------------------------ 2. company settings
  read("company", (_ws, id) => companySettings(os, id));
  read("company/changes", (_ws, id, q) => changesPage(os, id, q));
  write("company/signing-policy", (ws, id, body, ctx) => setSigningPolicy(os, ws, id, body, ctx));
  write("company/surfaces", (ws, id, body, ctx) => editSurfaces(os, ws, id, body, ctx));
  write("company/alerts", (ws, id, body, ctx) => editAlerts(os, ws, id, body, ctx));
  app.get(`${apiPrefix}/alerts/confirm`, async (c) => kit.sendRedirect(c, (await confirmAlert(os, c.req.query("token"), ctxOf(c))).location));

  // ------------------------------------------------------------ 3. write-back that sends
  read("writeback", (ws, id) => writebackPreview(os, ws, id));
  write("writeback/send", (ws, id, body, ctx) => sendWriteback(os, ws, id, body, ctx));
  read("writeback/runs", (_ws, id, q) => listRuns(os, id, q));
  read("writeback/runs/:run_id", (_ws, id, _q, run) => getRun(os, id, run ?? ""));
  write("writeback/runs/:run_id/retry", (ws, id, body, ctx, _kid, run) => retryRun(os, ws, id, run ?? "", body, ctx));

  // ------------------------------------------------------------ 4. seller lists
  write("sellers/lists/options", (ws, id, body) => sellerListOptions(os, ws, id, body));
  write("sellers/lists", (ws, id, body, ctx) => submitSellerList(os, ws, id, body, ctx));
  read("sellers/lists", (_ws, id) => listSellerLists(os, id));

  // ------------------------------------------------------------ 5. recalls: the write path the changes feed reads (review, 23 October 2026)
  write("recalls/options", (ws, id, body) => recallOptions(os, ws, id, body));
  write("recalls", (ws, id, body, ctx) => submitRecall(os, ws, id, body, ctx));
  read("recalls", (_ws, id) => listRecalls(os, id));

  // ------------------------------------------------------------ 7. agent keys: a person makes and revokes them; an agent key never can
  if (kit.agentKeys) {
    const keys = kit.agentKeys;
    read("agent-keys", (ws, id) => listAgentKeys(keys, ws, id));
    write("agent-keys", (ws, id, body, ctx) => createAgentKey(keys, os, ws, id, body, ctx));
    write("agent-keys/:kid/revoke", (ws, id, _body, ctx, kid) => revokeAgentKey(keys, os, ws, id, kid ?? "", ctx));
  }

  // ------------------------------------------------------------ the other pipeline actions, rate limited and audited
  // Every other pipeline write (build, the setup steps, detect, the reports, the LEI, Basic) goes through write() too,
  // so each is counted in the os_write group per company and session or agent key (OWASP API4:2023) and appends an
  // audit row naming who did it, which "Recent changes" shows (an agent key shows as itself). Erase is left to the
  // pipeline: it deletes the audit trail with everything else.
  for (const path of WORKSPACE_ACTIONS) {
    if (written.has(path) || path === "erase") continue;
    write(path, async (ws, id, body, ctx) => {
      const result = await os.p.handle(path, ws, id, body);
      // A passkey request (the options before a ceremony) changes nothing a person would look for in Recent changes.
      if (!result.problem && result.status < 300 && !path.endsWith("/options")) await audit(os.store, { trooth_id: id, ws, action: path.replace(/\//g, "."), target: id, after: body, ctx, at: os.now() });
      return result;
    });
  }

  // ------------------------------------------------------------ 6. credentials
  read("credentials", (_ws, id, q) => listCredentials(os, id, q));
  app.get(`${apiPrefix}/:trooth_id/credentials/:sha256`, async (c) => {
    const trooth_id = c.req.param("trooth_id") ?? "";
    if (!isTroothId(trooth_id)) return kit.sendProblem(c, "invalid_trooth_id");
    const bytes = await publicCredential(os, trooth_id, c.req.param("sha256") ?? "");
    if (!bytes) return kit.sendProblem(c, "semanto_not_found", "No credential with this digest is served for this company.");
    return kit.sendJson(c, 200, JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  });
}
