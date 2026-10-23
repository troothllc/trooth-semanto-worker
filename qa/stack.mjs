#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The QA stack (docs/program/reports/qa.md, qa/README.md): every part of the
// Semanto program running on loopback, so a real browser walks the dashboard
// against the real Semanto Worker.
//
//   Semanto Worker   this repository's src, bundled by its own wrangler
//                    (`wrangler deploy --dry-run`, the upload a deploy sends) and
//                    run by workerd through Miniflare: D1 with migrations 0001 to
//                    0009 applied in order, R2, KV, the compile queue with its
//                    consumer, the NonceDO, LogDO and RateLimitDO Durable
//                    Objects, a witness key made for this run, a seal secret,
//                    SEMANTO_EVENTS_SECRET, DEV_UPSTREAM_BASE and
//                    DEV_DASHBOARD_BASE (src/dev-upstream.ts).
//   worker-f         trooth-os-worker-f's src, bundled and run the same way by
//                    trooth-web's own journeys helper (scripts/journeys/worker.mjs),
//                    with its migrations and derived schema, the same
//                    SEMANTO_EVENTS_SECRET, an agent API key bound to a DPoP key
//                    for GET /v1/facts/changes, and trooth.co's profile reads
//                    answered by qa/doubles.mjs startProfileStub.
//   TROOTH_OS        the Worker's binding goes to standIn below: GET /auth/session
//                    and GET /auth/domain-claims for the people in qa/personas.mjs,
//                    and POST /internal/semanto/recall-events forwarded to worker-f
//                    at https://os/internal/semanto/recall-events.
//   api front        the route table of api.trooth.co on loopback: /os/semanto/*
//                    and /public/semanto/* to the Semanto Worker, everything else
//                    to standIn (the session reads trooth-web makes). It can be
//                    put down or made slow to walk the outage states.
//   trooth-web       its own journeys stack (scripts/journeys/stack.mjs): a
//                    throwaway PostgreSQL with every migration, the SQL-over-HTTP
//                    server, the Resend capture, `next start` on the production
//                    build in TROOTH_WEB_DIR, and preload.mjs, which sends
//                    https://api.trooth.co (the default SEMANTO_API_BASE and
//                    TROOTH_API_BASE) to the api front and refuses every other
//                    host that is not loopback.
//   doubles          Google (OAuth, Merchant API, Business Profile), Resend, DNS
//                    over HTTPS and the company sites (qa/doubles.mjs).
//
// Run: node qa/stack.mjs   (writes qa/.run/stack.json, logs to qa/.run/*.log)
// The control server named in stack.json switches modes and reads the doubles.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { generateKeyPairSync, randomBytes, createHash, webcrypto } from "node:crypto";
import { startUpstream, upstreamState, dnsAnswer, companySite, startProfileStub } from "./doubles.mjs";
import { PERSONAS, COMPANIES, domainsFor } from "./personas.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const WEB = resolve(process.env.TROOTH_WEB_DIR || join(ROOT, "../trooth-web"));
const WF = resolve(process.env.WORKER_F_DIR || join(ROOT, "../trooth-os-worker-f"));
const RUN = join(HERE, ".run");
const BASE_PORT = Number(process.env.QA_BASE_PORT || 47100);
const P = { front: BASE_PORT, upstream: BASE_PORT + 1, control: BASE_PORT + 2, profile: BASE_PORT + 3, semanto: BASE_PORT + 10, app: BASE_PORT + 20 };
const DASHBOARD = `http://localhost:${P.app}`;
const API = `http://127.0.0.1:${P.front}`;

// A fresh stack each start; the walks' records (walk-<run id>) are kept.
mkdirSync(RUN, { recursive: true });
for (const name of readdirSync(RUN)) if (!name.startsWith("walk-")) rmSync(join(RUN, name), { recursive: true, force: true });
const logFile = (name) => join(RUN, `${name}.log`);
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; process.stdout.write(line); appendFileSync(logFile("stack"), line); };

// ------------------------------------------------------------------ secrets
const b64u = (b) => Buffer.from(b).toString("base64url");
async function witnessJwk() {
  const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = await webcrypto.subtle.exportKey("jwk", kp.privateKey);
  const kid = b64u(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: priv.x })).digest());
  return { kty: "OKP", crv: "Ed25519", x: priv.x, d: priv.d, kid, alg: "EdDSA", use: "sig" };
}
const SECRETS = {
  TROOTH_WITNESS_KEY: JSON.stringify(await witnessJwk()),
  HOSTED_KEY_SEAL_SECRET: randomBytes(30).toString("base64url"),
  RECEIPT_IP_SALT_SECRET: randomBytes(18).toString("base64url"),
  SEMANTO_EVENTS_SECRET: randomBytes(24).toString("base64url"),
  GOOGLE_OAUTH_CLIENT_SECRET: "qa-google-client-secret-" + randomBytes(6).toString("hex"),
  RESEND_API_KEY: "re_qa_capture_only",
};
writeFileSync(join(RUN, "secrets.json"), JSON.stringify(SECRETS, null, 2));

// ------------------------------------------------------------------ doubles
const upstream = await startUpstream(P.upstream, upstreamState());
const profile = await startProfileStub(P.profile, Object.values(COMPANIES));
const sites = { "acmegoods-qa.com": companySite("acmegoods-qa.com", COMPANIES.acme.name), "globex-qa.com": companySite("globex-qa.com", COMPANIES.globex.name) };
const PUBLIC_IP = { "acmegoods-qa.com": "93.184.215.14", "globex-qa.com": "93.184.215.15" };
// A site "installs" Semanto when the walk says so: from then on the repository's own edge adapter
// (adapters/shared/semanto-adapter.mjs handleRequest) answers in front of the site, as the Vercel middleware would.
const adapter = await import(join(ROOT, "adapters/shared/semanto-adapter.mjs"));
const installs = {};
const directories = {};
async function siteAnswer(request, u) {
  const domain = u.hostname.replace(/^www\./, "");
  const site = sites[domain];
  const inst = installs[domain];
  if (!inst?.installed) return site.handle(u, request.method);
  const config = { troothId: inst.troothId, apiBase: API, mode: inst.mode || "semanto_only", ...(inst.connectorKey ? { connectorKey: inst.connectorKey } : {}) };
  inst.cache ??= adapter.createManifestCache({ config, ttlSeconds: 1 });
  site.seen.push(`${request.method} ${u.pathname} (adapter)`);
  return adapter.handleRequest({ request, config, manifestCache: inst.cache, next: async () => site.handle(u, request.method) });
}
const dns = {};
for (const d of Object.keys(sites)) { dns[d] = { A: [PUBLIC_IP[d]] }; dns[`www.${d}`] = { A: [PUBLIC_IP[d]] }; }

// ------------------------------------------------------------------ worker-f
const req = createRequire(join(ROOT, "package.json"));
const { Miniflare: MiniflareV5, Log, LogLevel, convertV4MiniflareOptions } = req("miniflare");
// Miniflare 5 takes a new option shape; both Workers are described in the familiar one and converted.
const Miniflare = function (opts) { return new MiniflareV5(convertV4MiniflareOptions(opts)); };
const { bundleWorker, bootstrapSchema, runSecrets } = await import(join(WEB, "scripts/journeys/worker.mjs"));
log(`bundling worker-f from ${WF}`);
const wfBundle = bundleWorker(WF);
const wfMail = await startUpstream(BASE_PORT + 4, upstreamState());
const wf = await (async () => {
  const refused = [];
  const forward = async (request, origin) => {
    const u = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(new URL(u.pathname + u.search, origin), { method: request.method, headers, body, redirect: "manual" });
  };
  const wfLog = logFile("worker-f");
  const mf = new Miniflare({
    log: new (class extends Log { constructor() { super(LogLevel.INFO); } log(m) { appendFileSync(wfLog, `${m}\n`); } })(),
    host: "127.0.0.1", port: BASE_PORT + 11,
    modules: [{ type: "ESModule", path: join(wfBundle.dir, "index.js") }],
    modulesRoot: wfBundle.dir,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "qa-workerf" },
    kvNamespaces: ["DRIVER_CACHE", "TROOTH_DIRECTORY"],
    r2Buckets: ["POLICY_BUNDLES", "AUDIT_ARCHIVE"],
    durableObjects: { TENANT_STATE: "TenantState", MCP_SSE: "McpSseSession" },
    bindings: { TROOTH_OS_VERSION: "1.0.0-alpha.1", LOG_LEVEL: "warn", RESEND_API_KEY: "re_qa_capture_only", AUTH_EMAIL_FROM: "Trooth <noreply@trooth.co>", APP_BASE_URL: DASHBOARD, ...runSecrets(), SEMANTO_EVENTS_SECRET: SECRETS.SEMANTO_EVENTS_SECRET },
    outboundService: async (request) => {
      const u = new URL(request.url);
      if (u.hostname === "api.resend.com") return forward(request, wfMail.origin + "/api.resend.com");
      if (u.hostname === "trooth.co" || u.hostname === "www.trooth.co") return forward(request, profile.origin);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return forward(request, u.origin);
      refused.push(`${request.method} ${u.origin}${u.pathname}`);
      throw new TypeError(`qa worker-f: outbound request to ${u.origin} refused (loopback only)`);
    },
  });
  const url = await mf.ready;
  const db = await mf.getD1Database("DB");
  const schema = bootstrapSchema(WF);
  for (const sql of schema.statements) await db.prepare(sql).run();
  return { mf, base: url.href.replace(/\/$/, ""), schema, refused, close: () => mf.dispose() };
})();
log(`worker-f: ${wf.base} (${wf.schema.source})`);
// An agent API key for co_acme, bound to a DPoP key the control server holds (worker-f src/dpop.ts).
const agentKey = "tk_qa_feed_" + randomBytes(12).toString("hex");
const agentKp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const agentPub = await webcrypto.subtle.exportKey("jwk", agentKp.publicKey);
const agentJwk = { kty: "EC", crv: "P-256", x: agentPub.x, y: agentPub.y };
const agentJkt = b64u(createHash("sha256").update(JSON.stringify({ crv: "P-256", kty: "EC", x: agentPub.x, y: agentPub.y })).digest());
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
{
  const db = await wf.mf.getD1Database("DB");
  await db.prepare("CREATE TABLE IF NOT EXISTS trooth_api_keys (id TEXT PRIMARY KEY, customer_id TEXT, key_hash TEXT, revoked_at INTEGER, last_used_at INTEGER, permissions TEXT, rotate_at INTEGER, rotate_expires_in TEXT)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS credential_dpop_bindings (cred_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, company_id TEXT, jkt TEXT NOT NULL, bound_by TEXT NOT NULL, bound_at INTEGER NOT NULL)").run();
  const cols = (await db.prepare("PRAGMA table_info(trooth_api_keys)").all()).results.map((r) => r.name);
  const row = { id: "key_qa_acme", customer_id: COMPANIES.acme.os_company_id, key_hash: sha256Hex(agentKey) };
  if (cols.includes("permissions")) row.permissions = JSON.stringify({ evidence: "read" }); // a restricted key that reads /v1/facts (worker-f src/key-permissions.ts)
  if (cols.includes("created_at")) row.created_at = Date.now();
  if (cols.includes("name")) row.name = "QA feed agent";
  if (cols.includes("key_prefix")) row.key_prefix = agentKey.slice(0, 10);
  const names = Object.keys(row);
  await db.prepare(`INSERT INTO trooth_api_keys (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
  await db.prepare("INSERT INTO credential_dpop_bindings (cred_hash, kind, company_id, jkt, bound_by, bound_at) VALUES (?, 'api_key', ?, ?, 'qa', ?)").bind(sha256Hex(agentKey), COMPANIES.acme.os_company_id, agentJkt, Date.now()).run();
}
async function dpopProof(method, url, token) {
  const u = new URL(url);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: agentJwk };
  const claims = { jti: randomBytes(12).toString("hex"), htm: method, htu: `${u.protocol}//${u.host}${u.pathname}`, iat: Math.floor(Date.now() / 1000), ath: b64u(createHash("sha256").update(token).digest()) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, agentKp.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64u(Buffer.from(sig))}`;
}
async function feedRest(query = "") {
  const url = `https://api.trooth.co/v1/facts/changes${query}`;
  const r = await wf.mf.dispatchFetch(url, { headers: { authorization: `DPoP ${agentKey}`, dpop: await dpopProof("GET", url, agentKey), "cf-connecting-ip": "198.51.100.7" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
let mcpIp = 0;
async function feedMcp(args) {
  mcpIp += 1;
  const r = await wf.mf.dispatchFetch("https://api.trooth.co/public/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": `198.51.100.${10 + (mcpIp % 200)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: mcpIp, method: "tools/call", params: { name: "trooth_company_changes", arguments: args } }) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { const m = /data: (.*)/.exec(text); body = m ? JSON.parse(m[1]) : text; }
  return { status: r.status, body };
}

// ------------------------------------------------------------------ TROOTH_OS stand-in
const modes = { front: "up", workerf: "up", standin: "up" };
const standInSeen = [];
const byToken = new Map(Object.values(PERSONAS).map((p) => [p.token, p]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function tokenOf(request) {
  const a = request.headers.get("authorization") || "";
  const m = /^(?:Bearer|DPoP)\s+(\S+)$/i.exec(a);
  return m ? m[1] : "";
}
async function standIn(request, from) {
  const url = new URL(request.url);
  standInSeen.push({ at: new Date().toISOString(), from, method: request.method, path: url.pathname, host: url.host });
  if (url.pathname === "/internal/semanto/recall-events") {
    if (url.hostname !== "os") return jsonResponse(404, { error: "not_found" });
    if (modes.workerf === "down") throw new TypeError("qa stand-in: worker-f is down (connection refused)");
    if (modes.workerf === "slow") await sleep(20_000);
    const body = await request.text();
    const r = await wf.mf.dispatchFetch("https://os/internal/semanto/recall-events", { method: "POST", headers: Object.fromEntries(request.headers), body });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", ...(r.headers.get("retry-after") ? { "retry-after": r.headers.get("retry-after") } : {}) } });
  }
  if (modes.standin === "down") throw new TypeError("qa stand-in: worker-f is down (connection refused)");
  const p = byToken.get(tokenOf(request));
  if (url.pathname === "/health") return jsonResponse(200, { ok: true, stub: "qa stand-in for worker-f" });
  if (url.pathname === "/directory/api/vendors") return jsonResponse(200, { vendors: [], total: 0, stub: "qa stand-in: no directory" });
  if (url.pathname === "/auth/session") {
    if (!p) return jsonResponse(401, { authenticated: false });
    const c = COMPANIES[p.company];
    // A person signed in a minute before each request (fresh for the writes that ask for a recent sign-in); ownerStale two days before.
    const signedIn = new Date(Date.now() - (p.signedInAgoSeconds || 60) * 1000).toISOString();
    return jsonResponse(200, { authenticated: true, companyId: c.os_company_id, userId: p.userId, email: p.email, name: p.name, mfaEnabled: true, emailVerified: p.emailVerified !== false, needsSetup: false, companyName: c.name, country: "US", role: "vendor", ...(p.workspaceRole ? { workspaceRole: p.workspaceRole } : {}), companySlug: c.slug, signedInAt: signedIn, authenticatedAt: signedIn, stepUpMaxAgeSeconds: 900 });
  }
  if (url.pathname === "/auth/sessions") {
    if (!p) return jsonResponse(401, { error: "Not authenticated." });
    return jsonResponse(200, { sessions: [{ id: `s-${p.token.slice(-6)}`, current: true, createdAt: new Date(Date.now() - (p.signedInAgoSeconds || 60) * 1000).toISOString() }] });
  }
  if (url.pathname === "/auth/domain-claims") {
    if (!p) return jsonResponse(401, { error: "unauthorized", message: "Sign in first." });
    return jsonResponse(200, { domains: domainsFor(p) });
  }
  if (url.pathname === "/me/dashboard") {
    if (!p) return jsonResponse(401, { error: "Not authenticated." });
    const c = COMPANIES[p.company];
    return jsonResponse(200, { me: { id: p.userId, email: p.email, name: p.name, companyName: c.name, slug: c.slug, emailVerified: p.emailVerified !== false, twoFactorEnabled: true, role: "company" } });
  }
  if (url.pathname === "/me/visibility") {
    if (!p) return jsonResponse(401, { error: "Not authenticated." });
    return jsonResponse(200, { visibility: "public" });
  }
  // The dashboard chrome's own reads (not Semanto): answered empty, in the shapes worker-f answers for a workspace with nothing in them.
  const CHROME = { "/v1/threads": { threads: [] }, "/v1/mesh": { controls: [], pillars: [], frameworks: [] }, "/v1/native/drift": { events: [], count: 0, unacknowledged: 0, regressions: 0 }, "/v1/native/sources": { sources: [] }, "/v1/receipts": { receipts: [] } };
  if (request.method === "GET" && CHROME[url.pathname]) return p ? jsonResponse(200, CHROME[url.pathname]) : jsonResponse(401, { error: "Not authenticated." });
  return jsonResponse(503, { error: "qa stand-in: this worker-f path is not provided on loopback", path: url.pathname });
}

// ------------------------------------------------------------------ Semanto Worker
log("bundling the Semanto Worker");
const sBundle = join(RUN, "semanto-bundle");
{
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", sBundle], { cwd: ROOT, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`wrangler could not bundle the Semanto Worker: ${(r.stderr || r.stdout).slice(-1500)}`);
}
const semantoOutbound = [];
const semantoRefused = [];
const semantoLog = logFile("semanto-worker");
const mfLog = new (class extends Log {
  constructor() { super(LogLevel.DEBUG); }
  log(message) { appendFileSync(semantoLog, `${message}\n`); }
})();
const semanto = new Miniflare({
  log: mfLog,
  host: "127.0.0.1",
  port: P.semanto,
  resourcePersistencePath: join(RUN, "state"),
  workers: [{
    name: "trooth-semanto-worker-dev",
    modules: [{ type: "ESModule", path: join(sBundle, "index.js") }],
    modulesRoot: sBundle,
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "qa-semanto" },
    r2Buckets: { STORE: "trooth-semanto" },
    kvNamespaces: { CACHE: "qa-cache" },
    queueProducers: { COMPILE_QUEUE: "trooth-semanto-compile" },
    queueConsumers: { "trooth-semanto-compile": { maxBatchSize: 1, maxBatchTimeout: 1, maxRetries: 3, deadLetterQueue: "trooth-semanto-compile-dlq" } },
    durableObjects: { NONCES: { className: "NonceDO", useSQLite: true }, LOG: { className: "LogDO", useSQLite: true }, RATE: { className: "RateLimitDO", useSQLite: true } },
    serviceBindings: { TROOTH_OS: (request) => standIn(request, "TROOTH_OS binding") },
    bindings: {
      ENVIRONMENT: "development",
      PUBLIC_API_BASE: `${API}/public/semanto`,
      NETWORK_BASE: `${DASHBOARD}/network/company`,
      LEDGER_URL: `${API}/public/semanto/log`,
      ALERT_FROM: "Semanto by Trooth <alerts@trooth.co>",
      GOOGLE_OAUTH_CLIENT_ID: "qa-google-client.apps.googleusercontent.com",
      GOOGLE_OAUTH_REDIRECT_URI: `${API}/public/semanto/google/callback`,
      WEBAUTHN_RP_ID: "localhost",
      DEV_UPSTREAM_BASE: upstream.origin,
      DEV_DASHBOARD_BASE: `${DASHBOARD}/dashboard/semanto`,
      ...SECRETS,
    },
    outboundService: async (request) => {
      const u = new URL(request.url);
      semantoOutbound.push(`${request.method} ${u.host}${u.pathname}`);
      if ((u.hostname === "cloudflare-dns.com" && u.pathname === "/dns-query") || (u.hostname === "dns.google" && u.pathname === "/resolve")) return jsonResponse(200, dnsAnswer(dns, u));
      if (sites[u.hostname.replace(/^www\./, "")]) return siteAnswer(request, u);
      // A reading agent's key directory (Web Bot Auth), published by qa/reads.mts through the control server.
      if (directories[u.hostname] && u.pathname === "/.well-known/http-message-signatures-directory") return new Response(directories[u.hostname].body, { status: 200, headers: directories[u.hostname].headers });
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const r = await fetch(u.href, { method: request.method, headers: Object.fromEntries(request.headers), body, redirect: "manual" });
        return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
      }
      semantoRefused.push(`${request.method} ${u.origin}${u.pathname}`);
      throw new TypeError(`qa Semanto Worker: outbound request to ${u.origin} refused (loopback only)`);
    },
  }],
});
await semanto.ready;
{
  const db = await semanto.getD1Database("DB");
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const text = readFileSync(join(ROOT, "migrations", f), "utf8").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    for (const sql of text.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  log(`Semanto D1: migrations ${files.join(", ")} applied`);
}
log(`Semanto Worker: http://127.0.0.1:${P.semanto}`);

// ------------------------------------------------------------------ api front (api.trooth.co on loopback)
const frontSeen = [];
const front = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const isSemanto = url.pathname.startsWith("/os/semanto/") || url.pathname.startsWith("/public/semanto/") || url.pathname === "/public/semanto";
  frontSeen.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, to: isSemanto ? "semanto" : "standin" });
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      if (isSemanto && modes.front === "down") { req.socket.destroy(); return; }
      if (isSemanto && modes.front === "slow") await sleep(20_000);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (!["host", "connection", "content-length"].includes(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      headers.set("cf-connecting-ip", req.headers["cf-connecting-ip"] || "198.51.100.1");
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
      let r;
      // The Worker sees the address the caller used (the front's), as api.trooth.co's route passes it: an RFC 9421
      // signature covers @authority and @target-uri, so a request signed for the front must reach the Worker under it.
      if (isSemanto) r = await semanto.dispatchFetch(`${API}${url.pathname}${url.search}`, { method: req.method, headers, body, redirect: "manual" });
      else r = await standIn(new Request(`https://api.trooth.co${url.pathname}${url.search}`, { method: req.method, headers, body }), "api front");
      const out = {};
      r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `qa api front: no answer (${String(e).slice(0, 160)})` })); }
    }
  });
});
await new Promise((ok) => front.listen(P.front, "127.0.0.1", ok));
log(`api front: ${API}`);

// ------------------------------------------------------------------ trooth-web
const { startStack } = await import(join(WEB, "scripts/journeys/stack.mjs"));
const web = await startStack({
  buildDir: process.env.TROOTH_WEB_BUILD || WEB,
  appPort: P.app,
  log: (m) => log(`trooth-web: ${m}`),
  envOverrides: {
    TROOTH_API_BASE: "https://api.trooth.co",
    JOURNEY_WORKER_TARGET: API,
    NEXT_PUBLIC_SITE_URL: DASHBOARD,
  },
});
// The website's own record of each company's confirmed domain (lib/domain-claim.ts), as trooth.co holds it for the people above.
{
  const owners = [[PERSONAS.owner.email, COMPANIES.acme.domain], [PERSONAS.globex.email, COMPANIES.globex.domain]];
  const r = web.pg.run("neondb_owner", owners.map(([e, d]) => `INSERT INTO domain_claims (owner_id, domain, token, confirmed_at, checked_at, method) VALUES ('${e}', '${d}', 'qa-token', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 'dns') ON CONFLICT DO NOTHING;`).join("\n"));
  if (r.status !== 0) log(`postgres seed failed: ${r.stderr}`);
}
const nextLog = logFile("next");
for (const line of web.next.out) appendFileSync(nextLog, line);
web.next.child.stdout.on("data", (d) => appendFileSync(nextLog, String(d)));
web.next.child.stderr.on("data", (d) => appendFileSync(nextLog, String(d)));
log(`trooth-web: ${DASHBOARD}`);

// ------------------------------------------------------------------ control server
const control = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { return send(400, { error: "not json" }); }
    try {
      if (url.pathname === "/state") return send(200, state());
      if (url.pathname === "/mode") { for (const k of ["front", "workerf", "standin"]) if (body[k]) modes[k] = body[k]; if (body.refresh) upstream.state.refresh = body.refresh; if (Array.isArray(body.writes)) upstream.state.writes = body.writes.slice(); if ("grant" in body) upstream.state.grant = body.grant; return send(200, { modes, refresh: upstream.state.refresh, writes: upstream.state.writes }); }
      if (url.pathname === "/emails") return send(200, upstream.state.emails);
      if (url.pathname === "/upstream") return send(200, { calls: upstream.state.calls, revoked: upstream.state.revoked });
      if (url.pathname === "/outbound") return send(200, { semanto: semantoOutbound, semantoRefused, workerfRefused: wf.refused, standin: standInSeen, front: frontSeen });
      if (url.pathname === "/install") { installs[body.domain] = { installed: body.installed !== false, troothId: body.troothId, mode: body.mode, connectorKey: body.connectorKey ? (typeof body.connectorKey === "string" ? body.connectorKey : JSON.stringify(body.connectorKey)) : undefined }; return send(200, { domain: body.domain, installed: installs[body.domain].installed }); }
      if (url.pathname === "/site-seen") return send(200, Object.fromEntries(Object.entries(sites).map(([d, x]) => [d, x.seen])));
      if (url.pathname === "/directory") { directories[body.host] = { body: body.body, headers: body.headers }; dns[body.host] = { A: ["93.184.215.20"] }; return send(200, { host: body.host }); }
      if (url.pathname === "/dns") { dns[body.name] = { ...(dns[body.name] || {}), [body.type]: body.values }; return send(200, dns[body.name]); }
      if (url.pathname === "/d1") {
        const db = body.db === "workerf" ? await wf.mf.getD1Database("DB") : await semanto.getD1Database("DB");
        const r = await db.prepare(body.sql).bind(...(body.binds || [])).all();
        return send(200, r.results ?? []);
      }
      if (url.pathname === "/pg") { const r = web.pg.run("neondb_owner", body.sql); return send(r.status === 0 ? 200 : 500, { out: r.stdout, err: r.stderr }); }
      if (url.pathname === "/replay-recall") {
        // The same signed event sent again, through the TROOTH_OS stand-in to worker-f, as a network retry would.
        const r = await standIn(new Request("https://os/internal/semanto/recall-events", { method: "POST", headers: { "content-type": "application/json", "trooth-event-signature": body.signature }, body: body.body }), "replay");
        return send(200, { status: r.status, body: await r.json().catch(() => null) });
      }
      if (url.pathname === "/feed/rest") return send(200, await feedRest(body.query || ""));
      if (url.pathname === "/feed/mcp") return send(200, await feedMcp(body.args || {}));
      if (url.pathname === "/worker/fetch") {
        const r = await fetch(`http://127.0.0.1:${P.semanto}${body.path}`, { method: body.method || "GET", headers: body.headers || {}, body: body.body === undefined ? undefined : typeof body.body === "string" ? body.body : JSON.stringify(body.body) });
        return send(200, { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() });
      }
      return send(404, { error: "no such control" });
    } catch (e) { return send(500, { error: String(e?.stack || e) }); }
  });
});
await new Promise((ok) => control.listen(P.control, "127.0.0.1", ok));

function state() {
  return { dashboard: DASHBOARD, api: API, semanto: `http://127.0.0.1:${P.semanto}`, workerf: wf.base, upstream: upstream.origin, control: `http://127.0.0.1:${P.control}`, webEmails: `http://127.0.0.1:${P.app + 3}/__captured`, personas: PERSONAS, companies: COMPANIES, run: RUN, modes };
}
writeFileSync(join(RUN, "stack.json"), JSON.stringify(state(), null, 2));
log(`control: http://127.0.0.1:${P.control}; ready`);

const stop = async () => { try { web.stop(); } catch {} try { await semanto.dispose(); } catch {} try { await wf.close(); } catch {} wfBundle.remove(); for (const s of [front, control]) s.close(); upstream.close(); profile.close(); wfMail.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
