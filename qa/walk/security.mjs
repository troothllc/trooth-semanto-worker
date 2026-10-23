// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The security review, proven with requests against the running stack:
// another company's ids (IDOR) on every route that takes one, the proxy's
// allowlist and traversal, bodies of the wrong shape on every write (never a
// 500), the rate groups (os_write, public_connect, connect_poll), the connect
// poll token, the uninstall replay, and the captured logs and answers searched
// for private JWK material, tokens and secrets.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { control, d1, BASE, STACK } from "./lib.mjs";

const worker = async (method, path, token, body, headers = {}) => {
  const r = await fetch(`${STACK.api}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), "cf-connecting-ip": headers.ip ?? "198.51.100.90", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const T = (p) => STACK.personas[p].token;

export async function security(w, ctx) {
  const acme = ctx.troothId;
  // Globex gets its own Semanto company, read through the setup route as its owner.
  w.step("security-globex");
  const start = await worker("POST", "/os/semanto/setup/start", T("globex"), {});
  if (start.status >= 300) w.note(`Globex's setup start answered ${start.status} ${start.text.slice(0, 160)}`);
  let globex = null;
  for (let i = 0; i < 30 && !globex; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    globex = (await d1("SELECT trooth_id FROM semanto_companies WHERE os_company_id = ?", STACK.companies.globex.os_company_id))[0]?.trooth_id ?? null;
  }
  if (!globex) { w.note("Globex has no Semanto company"); return; }

  // IDOR: Acme's owner on Globex's routes, and the reverse, read and write.
  w.step("security-idor");
  const runId = (await d1("SELECT run_id FROM semanto_writeback_runs WHERE trooth_id = ? LIMIT 1", acme))[0]?.run_id ?? "run_none";
  const kid = (await d1("SELECT kid FROM semanto_connector_keys WHERE trooth_id = ? LIMIT 1", acme))[0]?.kid ?? "kid_none_000";
  const reads = ["settings", "keys", "receipts", "receipts.csv", "connectors", "google", "company", "writeback", "writeback/runs", `writeback/runs/${runId}`, "sellers/lists", "credentials", "recalls", "setup/review", "reports"];
  for (const r of reads) {
    const a = await worker("GET", `/os/semanto/${acme}/${r}`, T("globex"));
    if (a.status < 400 || a.text.includes(STACK.companies.acme.domain)) w.note(`Globex's owner GET ${acme}/${r} answered ${a.status}`);
  }
  const writes = [["settings", {}], ["keys/rotation/start", { custody: "hosted" }], [`keys/${kid}/revoke`, { confirm: kid }], [`connectors/${kid}/revoke`, { confirm: kid }], [`connectors/${kid}/test`, {}], ["company/alerts", { add: "x@globex-qa.com" }], [`writeback/runs/${runId}/retry`, {}], ["writeback/send", { confirm: true, idempotency_key: "qa-idor-key-000001" }], ["google/disconnect", { confirm: true }], ["monitor/run", {}]];
  for (const [path, body] of writes) {
    const a = await worker("POST", `/os/semanto/${acme}/${path}`, T("globex"), body);
    if (a.status !== 403 && a.status !== 404) w.note(`Globex's owner POST ${acme}/${path} answered ${a.status}`);
  }
  // A connect request for Acme approved by Globex's owner into Acme's company.
  const kp = await (await import(new URL("../../adapters/shared/sign-request.mjs", import.meta.url).href)).generateConnectorKey();
  const sess = await worker("POST", "/public/semanto/connect/sessions", null, { app: "shopify", account: "qa-idor.myshopify.com", public_jwk: kp.publicJwk, return_url: "https://qa-idor.myshopify.com/admin/apps/semanto-by-trooth" }, { ip: "198.51.100.91" });
  if (sess.status === 201) {
    const ap = await worker("POST", `/os/semanto/${acme}/connect/${sess.json.session_id}/approve`, T("globex"), {});
    if (ap.status !== 403 && ap.status !== 404) w.note(`Globex's owner approving into Acme answered ${ap.status}`);
    const view = await worker("GET", `/os/semanto/connect/${sess.json.session_id}`, T("globex"));
    if (view.json?.companies?.some((c) => c.trooth_id === acme)) w.note("the approve page lists another company to a Globex owner");
    // The poll token: missing, wrong, and another session's.
    const noTok = await worker("GET", `/public/semanto/connect/sessions/${sess.json.session_id}`, null);
    const wrongTok = await worker("GET", `/public/semanto/connect/sessions/${sess.json.session_id}`, "not-the-poll-token");
    if (noTok.status !== 401 || wrongTok.status !== 401) w.note(`the poll without its token answered ${noTok.status} and ${wrongTok.status}`);
    if (JSON.stringify(view.json ?? {}).includes(sess.json.poll_token)) w.note("the approve page's answer carries the poll token");
  } else w.note(`opening a connect session answered ${sess.status}`);

  // The trooth-web proxy: paths outside the allowlist, traversal, a bad query, a POST from another site.
  w.step("security-proxy");
  const cookie = `trooth_session=${T("owner")}`;
  const proxied = async (method, path, extra = {}) => (await fetch(`${BASE}/api/semanto/${path}`, { method, headers: { cookie, origin: extra.origin ?? BASE, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined, redirect: "manual" })).status;
  for (const [m, p, want, extra] of [["POST", `${acme}/keys/rotate`, 404], ["GET", `${acme}/keys/rotation/start`, 404], ["GET", `${acme}/receipts?from=2026-10-01&evil=1`, 400], ["GET", `${acme}/receipts?agent=${"a".repeat(300)}`, 400], ["POST", "setup/start", 403, { origin: "https://evil-qa.com" }], ["GET", "admin/anything", 404]]) {
    const s = await proxied(m, p, extra ?? {});
    const expect = want;
    if (s !== expect && !(expect === 404 && s === 400)) w.note(`the proxy answered ${s} to ${m} ${p} (expected ${expect})`);
  }

  // Traversal, sent raw (fetch would tidy the path first): the proxy refuses a segment that is "." or ".." or holds a slash.
  const http = await import("node:http");
  const raw = (path) => new Promise((ok) => { const u = new URL(BASE); const rq = http.request({ host: u.hostname, port: u.port, path, method: "GET", headers: { cookie } }, (res) => { res.resume(); ok(res.statusCode); }); rq.on("error", () => ok(0)); rq.end(); });
  // The server resolves "." and ".." before routing (as a browser does), so those land on the route they name, under
  // the same cookie: the answer equals the resolved path's. An encoded slash stays one segment and is refused.
  for (const [p, resolved] of [[`/api/semanto/${acme}/../setup`, "/api/semanto/setup"], [`/api/semanto/${acme}/%2e%2e/setup`, "/api/semanto/setup"], [`/api/semanto/x/../../me`, "/api/me"]]) {
    const s = await raw(p);
    const want = await raw(resolved);
    if (s !== want) w.note(`the raw path ${p} answered ${s}, its resolved path ${want}`);
  }
  for (const p of [`/api/semanto/${acme}/keys%2Frotation%2Fstart`, `/api/semanto/${acme}%2Fkeys`]) {
    const s = await raw(p);
    if (s === 200) w.note(`the proxy answered 200 to the raw path ${p}`);
  }

  // Bodies of the wrong shape on every write: a 4xx with words, never a 500.
  w.step("security-bodies");
  const writePaths = ["settings", "settings/preview", "keys/rotation/start", "keys/rotation/options", "keys/rotation/confirm", "keys/rotation/cancel", "keys/binding/check", `keys/${kid}/revoke`, "connectors", "connectors/create", `connectors/${kid}/revoke`, "google/connect", "google/disconnect", "company/signing-policy", "company/surfaces", "company/alerts", "writeback/send", `writeback/runs/${runId}/retry`, "sellers/lists", "sellers/lists/options", "recalls", "recalls/options", "sign/options"];
  for (const p of writePaths) {
    for (const body of ["not json", "[]", '{"a":', JSON.stringify({ x: "y".repeat(10) }), JSON.stringify({ custody: 7, products: "all", officers_required: "two", add: { kind: "planet" }, item_ids: [1, 2], jws: 5, draft: [], notice: null, rotation_id: { $gt: "" }, confirm: [] })]) {
      const r = await worker("POST", `/os/semanto/${acme}/${p}`, T("owner"), body, { ip: `198.51.100.${100 + (p.length % 50)}` });
      if (r.status >= 500) w.note(`POST ${p} with ${body.slice(0, 30)} answered ${r.status}`);
      if (r.status === 429) break;
    }
  }
  const huge = await worker("POST", `/os/semanto/${acme}/company/surfaces`, T("owner"), JSON.stringify({ add: { kind: "marketplace", label: "x".repeat(6 * 1024 * 1024) } }), { ip: "198.51.100.99" });
  if (huge.status !== 413) w.note(`a 6 MB body answered ${huge.status}`);

  // Rate groups: os_write 30 a minute per person; public_connect 10 a minute per address.
  w.step("security-rates");
  let limited = null;
  for (let i = 0; i < 35 && !limited; i++) {
    const r = await worker("POST", `/os/semanto/${acme}/keys/binding/check`, T("admin"), {}, { ip: "198.51.100.120" });
    if (r.status === 429) limited = r;
  }
  if (!limited) w.note("35 writes in a minute by one person were never limited");
  else if (!limited.headers.get("retry-after")) w.note("the os_write 429 has no Retry-After");
  let connectLimited = false;
  for (let i = 0; i < 12 && !connectLimited; i++) {
    const k2 = await (await import(new URL("../../adapters/shared/sign-request.mjs", import.meta.url).href)).generateConnectorKey();
    const r = await worker("POST", "/public/semanto/connect/sessions", null, { app: "shopify", account: `qa-rate-${i}.myshopify.com`, public_jwk: k2.publicJwk }, { ip: "198.51.100.130" });
    if (r.status === 429) connectLimited = true;
  }
  if (!connectLimited) w.note("12 connect sessions from one address in a minute were never limited");

  // The uninstall route: a replayed nonce is refused.
  w.step("security-uninstall-replay");
  if (ctx.shopifyShop) {
    const signMod = await import(new URL("../../adapters/shared/sign-request.mjs", import.meta.url).href);
    const k3 = await signMod.generateConnectorKey();
    const s3 = await worker("POST", "/public/semanto/connect/sessions", null, { app: "shopify", account: "qa-replay.myshopify.com", public_jwk: k3.publicJwk }, { ip: "198.51.100.140" });
    if (s3.status === 201) {
      // The owner's session may have spent its minute of writes on the probes above: wait the minute out once.
      let ap = await worker("POST", `/os/semanto/${acme}/connect/${s3.json.session_id}/approve`, T("owner"), {});
      if (ap.status === 429) {
        await new Promise((ok) => setTimeout(ok, ((ap.json?.retry_after ?? 60) + 1) * 1000));
        ap = await worker("POST", `/os/semanto/${acme}/connect/${s3.json.session_id}/approve`, T("owner"), {});
      }
      if (ap.status !== 200) w.note(`approving the replay test's request answered ${ap.status} ${JSON.stringify(ap.json).slice(0, 200)}`);
      const url = `${STACK.api}/public/semanto/connect/uninstall`;
      const body = JSON.stringify({ app: "shopify", account: "qa-replay.myshopify.com", reason: "uninstalled" });
      const h = await signMod.signPost({ url, body, privateJwk: k3.privateJwk });
      const first = await fetch(url, { method: "POST", headers: { ...h, "cf-connecting-ip": "198.51.100.141" }, body });
      const again = await fetch(url, { method: "POST", headers: { ...h, "cf-connecting-ip": "198.51.100.141" }, body });
      if (first.status !== 200) w.note(`a signed uninstall answered ${first.status}`);
      if (again.status !== 401) w.note(`the same signed uninstall replayed answered ${again.status}`);
    }
  }

  // Secrets in the logs and in answers.
  w.step("security-secrets");
  const run = new URL("../.run/", import.meta.url).pathname;
  const logs = readdirSync(run).filter((f) => f.endsWith(".log")).map((f) => [f, readFileSync(join(run, f), "utf8")]);
  // The workers' own console output (console.log and console.error under workerd) lands in the stack's stdout.
  const out = new URL("../.stack-out.log", import.meta.url).pathname;
  if (existsSync(out)) logs.push([".stack-out.log", readFileSync(out, "utf8")]);
  const secrets = JSON.parse(readFileSync(join(run, "secrets.json"), "utf8"));
  const witnessD = JSON.parse(secrets.TROOTH_WITNESS_KEY).d;
  const needles = [["the witness private key", witnessD], ["the seal secret", secrets.HOSTED_KEY_SEAL_SECRET], ["the events secret", secrets.SEMANTO_EVENTS_SECRET], ["the Google client secret", secrets.GOOGLE_OAUTH_CLIENT_SECRET], ["the receipt salt", secrets.RECEIPT_IP_SALT_SECRET], ["a Google access token", "ya29.qa-"], ["a Google refresh token", "1//qa-refresh-"]];
  for (const jwk of [ctx.customerJwk, ctx.edgeConnector, ctx.pastedConnector?.privateJwk, ctx.expiredJwk, ctx.revokedJwk].filter(Boolean)) needles.push(["a private JWK (d)", jwk.d]);
  for (const t of Object.values(STACK.personas).map((p) => p.token)) needles.push(["a session token", t]);
  for (const [name, value] of needles) {
    if (!value || value.length < 8) continue;
    for (const [f, text] of logs) if (f !== "next.log" && text.includes(value)) w.note(`${name} is in ${f}`);
  }
  // The session tokens may appear in trooth-web's own request log only if it logs cookies; check it separately.
  const nextLog = logs.find(([f]) => f === "next.log")?.[1] ?? "";
  for (const [name, value] of needles) if (value && value.length >= 8 && nextLog.includes(value)) w.note(`${name} is in next.log`);
  // Answers: the company, connectors, google, keys reads carry no private part.
  for (const r of ["connectors", "google", "keys", "company", "writeback/runs", "sellers/lists"]) {
    const a = await worker("GET", `/os/semanto/${acme}/${r}`, T("owner"));
    for (const [name, value] of needles) if (value && value.length >= 8 && a.text.includes(value)) w.note(`GET ${r} carries ${name}`);
    if (/"d"\s*:\s*"[A-Za-z0-9_-]{43}"/.test(a.text)) w.note(`GET ${r} carries a private key member`);
  }
}
