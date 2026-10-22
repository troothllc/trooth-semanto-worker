// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// A mock of the setup API (docs/spec/setup-api.md) for the browser harness:
// a small node http server with one session per bearer token and scripted
// state transitions (company, prove waiting, a wrong value, proved, a read
// that moves on each poll, review, sign, install, the three checks). The
// token's first word picks the scenario (full, basic, customer, officer, dc,
// errors, timeout, unknownhost). DNS changes come from a control route, the
// way a real record is added at the DNS host and not in the wizard. It also
// serves the built page. Field names follow the spec exactly; nothing here is
// a measurement, every figure is a fixture.
//
// Passkeys are real: the mock bundles src/identity/webauthn.ts (esbuild, at
// start) and runs the same W3C WebAuthn Level 3 checks the Worker runs
// (sections 7.1 and 7.2), with rp id localhost and the development origin.
// The sign route takes the assertion over the single-use challenge that
// sign/options issued for the exact version and root hash, as the Worker does.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** The Worker's own passkey checks, bundled for Node. */
async function loadWebAuthn() {
  const out = await build({ entryPoints: [join(here, "../../../../src/identity/webauthn.ts")], bundle: true, platform: "node", format: "esm", target: "node20", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const W = await loadWebAuthn();
const RP = W.webauthnConfig({ rp_id: "localhost", development: true });
const b64url = (n) => randomBytes(n).toString("base64url");

const HEX48 = "0123456789abcdef0123456789abcdef0123456789abcdef";
const ROOT = "sha256:" + "ab".repeat(32);
const ROOT2 = "sha256:" + "cd".repeat(32);
const GUIDES = { cloudflare: "cloudflare-worker", vercel: "vercel-middleware", netlify: "netlify-edge", fastly: "fastly-compute", akamai: "akamai-edgeworkers", gcore: "gcore-fastedge", nginx: "nginx-config", apache: "apache-config", wordpress: "wordpress-plugin", shopify: "shopify-app", webflow: "webflow-head-code", squarespace: "squarespace-code-injection", wix: "wix-custom-code", head_tag: "head-tag", unknown: "pick-host" };
const STEPS = [
  ["sign_in", 30],
  ["company", 30],
  ["prove_domain", 270],
  ["read_site", 240],
  ["review", 60],
  ["sign", 45],
  ["install", 120],
  ["check", 30],
  ["monitoring", 30],
];
const LEFT_OUT = [
  { url: "https://acme.com/account/login", reason: "Needs a login", code: "login" },
  { url: "https://acme.com/staff", reason: "Asked search engines not to show it (noindex)", code: "noindex" },
  { url: "https://acme.com/drafts/2025", reason: "Asked search engines not to show it (noindex)", code: "noindex" },
  { url: "https://acme.com/old-pricing", reason: "Page not found (404)", code: "not_found" },
  { url: "https://acme.com/print/catalog", reason: "Blocked by your robots.txt", code: "robots" },
  { url: "https://acme.com/about?ref=footer", reason: "Same page as another one", code: "duplicate" },
];
const FOUND = 212;
const MESSAGES = {
  markdownFail: "Your site sent a web page, not markdown. The app or code is not live yet. On Webflow and Squarespace, publish the site; on WordPress, clear the cache; then check again.",
  markdownOk: "Your site answers markdown when asked (Accept: text/markdown).",
  signatureOk: "The signature on what your site sends matches what you signed.",
  signaturePending: "Checked after your site answers markdown.",
  wellKnownMissing: "Your site does not serve /.well-known/trooth.semanto and /.well-known/trooth-keys.json yet. The app or code serves both; check that it is live.",
  wellKnownOk: "Your site serves the two /.well-known files exactly as Trooth holds them.",
  ok: "Your site answers in markdown and the signature checks out.",
};

const sessions = new Map();
const stats = { gets: [] };

function session(token) {
  let s = sessions.get(token);
  if (s) return s;
  const scenario = token.split("-")[0];
  s = {
    token,
    scenario,
    started_at: new Date().toISOString(),
    stamps: { sign_in: new Date().toISOString() },
    company: null,
    dns: "none", // none | wrong | right
    lookingSince: null,
    proven_at: null,
    proofChecks: 0,
    read: null,
    readGets: 0,
    // The full walk holds the read at 0 pages until it says go, so it can watch the bar move on Screen D.
    readHeld: scenario === "full",
    path: null,
    basic: true,
    confirmed_at: null,
    confirmFails: scenario === "errors" ? 1 : 0,
    changed: false,
    signed_at: null,
    custody: scenario === "customer" ? "customer" : "hosted",
    two_officer: scenario === "officer",
    approvals: [],
    pending: false,
    host: scenario === "unknownhost" ? "unknown" : "shopify",
    hostChosen: false,
    installChecks: 0,
    checks: { markdown: "pending", signature: "pending", well_known: "pending" },
    install_checked_at: null,
    monitoring: null,
    saved: false,
    assertions: [],
    requests: [],
    // Passkeys, as the Worker keeps them: a per-user handle, the stored credentials, single-use challenges.
    passkeyUser: { user_id: `user-${token}`, handle: b64url(32), created_at: new Date().toISOString() },
    passkeys: [],
    challenges: new Map(),
    issued: [],
  };
  sessions.set(token, s);
  return s;
}

const iso = () => new Date().toISOString();

function timings(s) {
  let prev = Date.parse(s.started_at);
  const steps = [];
  const not_started = [];
  const spent = {};
  for (const [id, target] of STEPS) {
    const done = s.stamps[id];
    if (!done) {
      steps.push({ id, target_seconds: target, spent_seconds: null, within_target: null });
      not_started.push(id);
      continue;
    }
    const t = Date.parse(done);
    const sec = Math.max(0, Math.round((t - prev) / 1000));
    spent[id] = sec;
    steps.push({ id, target_seconds: target, spent_seconds: sec, within_target: sec <= target });
    prev = Math.max(prev, t);
  }
  const sum = (ids) => (ids.every((i) => i in spent) ? ids.reduce((n, i) => n + spent[i], 0) : null);
  const b = sum(STEPS.slice(0, 4).map((x) => x[0]));
  const f = sum(STEPS.map((x) => x[0]));
  return { steps, basic: { target_seconds: 600, spent_seconds: b, within_target: b === null ? null : b <= 600 }, full: { target_seconds: 900, spent_seconds: f, within_target: f === null ? null : f <= 900 }, not_started };
}

function readState(s) {
  if (!s.read) return null;
  const r = s.read;
  const out = { status: r.status, held: !s.proven_at, found: r.found, read: r.status === "done" ? r.found - LEFT_OUT.length : 0, pages_done: r.pages_done, left_out: r.status === "reading" || r.status === "queued" ? [] : LEFT_OUT, started_at: r.started_at, version: r.status === "done" ? 1 : null };
  if (r.status === "reading" && r.pages_done > 0) out.eta_seconds = Math.max(1, Math.round(((r.found - r.pages_done) / 25) * 0.4));
  if (r.status === "done" || r.status === "failed") out.finished_at = r.finished_at;
  if (r.status === "failed") out.error = "Semanto could not reach acme.com after 3 tries. Your site may be down or blocking readers. Try again, or check that acme.com opens in a browser.";
  if (r.status === "failed") out.left_out = [];
  return out;
}

function decideStep(s) {
  if (!s.company) return "company";
  if (!s.proven_at) return "prove";
  if (!s.read || s.read.status !== "done" || s.path === null) return "read";
  if (s.basic) return "done";
  if (!s.confirmed_at || !s.signed_at) return "review";
  const pass = s.checks.markdown === "pass" && s.checks.signature === "pass" && s.checks.well_known === "pass";
  if (!pass || !s.monitoring) return "install";
  return "done";
}

function diagnosis(s) {
  const d = s.company.domain;
  const resolvers = [
    { resolver: "cloudflare-dns.com", found: s.dns === "right" ? [`trooth-domain-challenge=${HEX48}`] : s.dns === "wrong" ? ["trooth-domain-challenge=ffff"] : [] },
    { resolver: "dns.google", found: s.dns === "right" ? [`trooth-domain-challenge=${HEX48}`] : s.dns === "wrong" ? ["trooth-domain-challenge=ffff"] : [] },
  ];
  if (s.proven_at) return { state: "proven", tone: "done", title: `You proved control of ${d}`, detail: "Trooth found your record. Keep it in place: Trooth looks again every day.", keep_looking: false, resolvers };
  if (s.scenario === "timeout") return { state: "timed_out", tone: "stopped", title: "Trooth stopped looking after 72 hours", detail: "No record was found at the name above in that time.", fix: "Check the record with your DNS host, then press Look again.", keep_looking: false, resolvers };
  if (s.dns === "wrong") return { state: "wrong_value", tone: "attention", title: "A record is there, but the value does not match", detail: "The value at this name is different from the one Trooth gave you.", fix: "Paste the value again using the Copy button, so nothing is retyped.", keep_looking: true, resolvers };
  return { state: "looking", tone: "working", title: "Looking for your record", detail: "Most hosts publish a new record within minutes. Some take a few hours. Trooth asked cloudflare-dns.com and dns.google and keeps looking. You can leave this page: Trooth emails you when it is found.", keep_looking: true, resolvers };
}

function proofState(s, found) {
  const d = s.company.domain;
  const status = s.proven_at ? (found ? "found" : "proved") : s.dns === "wrong" ? "found_wrong_value" : "waiting";
  const provider = { id: "cloudflare", name: "Cloudflare", manual_steps: ["Open your domain in Cloudflare, then DNS, then Records.", "Add a new record and choose the type TXT.", `In Name (some hosts call it Host), type _trooth-challenge. If your host does not add ${d} on its own, type _trooth-challenge.${d}.`, "In Value (some hosts call it Content), paste the value with the Copy button.", "Save it. Trooth keeps looking on its own and moves on when it finds the record."] };
  if (s.scenario === "dc") provider.domain_connect_url = `/__guide/domain-connect?domain=${d}`;
  return {
    record_type: "TXT",
    record_name: `_trooth-challenge.${d}`,
    name_to_type: "_trooth-challenge",
    record_value: `trooth-domain-challenge=${HEX48}`,
    status,
    checked_at: s.lastCheck ?? null,
    next_check_at: s.lastCheck ? new Date(Date.parse(s.lastCheck) + 10_000).toISOString() : null,
    proven_at: s.proven_at,
    method: s.proven_at ? "dns_txt" : null,
    provider,
    diagnosis: diagnosis(s),
    well_known: { url: `https://${d}/.well-known/trooth-claim.txt`, body: `trooth-domain-challenge=${HEX48}` },
    pointer: { record_name: `_trooth.${d}`, record_value: s.signed_at ? `v=trooth1; id=${s.company.trooth_id}; key=fixture-kid-1` : null },
  };
}

function nextAction(s, step) {
  const b = `https://api.trooth.co/os/semanto/${s.company?.trooth_id ?? ""}`;
  switch (step) {
    case "company":
      return { label: "Continue", method: "POST", url: "https://api.trooth.co/os/semanto/setup/start" };
    case "prove":
      return { label: "Add the record, then wait here", method: "GET", url: `${b}/setup` };
    case "read":
      return s.read?.status === "done" ? { label: "Finish setup", method: "POST", url: `${b}/setup/choose` } : { label: "Wait for the read", method: "GET", url: `${b}/setup` };
    case "review":
      if (!s.confirmed_at) return { label: "Confirm these facts", method: "POST", url: `${b}/setup/confirm` };
      if (s.custody === "customer") return { label: "Sign with our own key", method: "POST", url: `${b}/sign` };
      return s.passkeys.length ? { label: "Sign with my passkey", method: "POST", url: `${b}/sign/options` } : { label: "Add a passkey", method: "POST", url: `${b}/passkeys/options` };
    case "install":
      return s.checks.markdown === "pass" && s.checks.signature === "pass" && s.checks.well_known === "pass" ? { label: "Start monitoring", method: "POST", url: `${b}/setup/monitoring` } : { label: "Check my site", method: "POST", url: `${b}/setup/install-check` };
    default:
      return null;
  }
}

function doc(s, opts = {}) {
  const step = decideStep(s);
  if (!s.company) {
    return { object: "semanto.setup", trooth_id: null, org: null, domain: null, step, basic: true, saved_for_later: false, proof: null, read: null, review: null, sign: null, install: null, monitoring: null, timings: timings(s), next_action: nextAction(s, step), checked_at: iso() };
  }
  const built = s.read?.status === "done";
  return {
    object: "semanto.setup",
    trooth_id: s.company.trooth_id,
    org: s.company.org,
    domain: s.company.domain,
    step,
    basic: s.basic,
    saved_for_later: s.saved,
    proof: proofState(s, opts.found),
    read: readState(s),
    review: { version: built ? 1 : null, root_hash: built ? (s.changed ? ROOT2 : ROOT) : null, changed_since_read: s.changed, changed_urls: s.changed ? ["https://acme.com/pricing", "https://acme.com/hours", "https://acme.com/returns"] : [], facts_count: 6, pages_count: FOUND - LEFT_OUT.length, saved_for_later: s.saved, confirmed_at: s.confirmed_at },
    sign: { custody: s.custody, passkey_required: s.custody === "hosted", has_passkey: s.passkeys.length > 0, two_officer: s.two_officer, approvals: s.approvals, signed_version: s.signed_at ? 1 : null, signed_at: s.signed_at },
    install: { host: s.host, guide_id: GUIDES[s.host], detected_at: s.host === "unknown" ? null : s.started_at, checks: s.checks, message: s.host === "unknown" ? "We could not tell where your site runs. Pick it from the list." : s.install_checked_at ? (s.checks.markdown === "pass" ? MESSAGES.ok : MESSAGES.markdownFail) : "Put Semanto on your site, then Trooth checks it.", checked_at: s.install_checked_at },
    monitoring: { started_at: s.monitoring?.started_at ?? null, questions: s.monitoring?.questions ?? [], competitors: s.monitoring?.competitors ?? [], suggested_questions: ["What does Acme Inc do?", "Where is Acme Inc based?", "What are Acme Inc's opening hours?", "How much does Acme Inc charge for delivery?"] },
    timings: timings(s),
    next_action: nextAction(s, step),
    checked_at: iso(),
  };
}

function review(s) {
  const src = (path, title) => ({ source_url: `https://acme.com${path}`, source_title: title });
  return {
    object: "semanto.setup_review",
    trooth_id: s.company.trooth_id,
    version: 1,
    root_hash: s.changed ? ROOT2 : ROOT,
    changed_since_read: s.changed,
    changed_urls: s.changed ? ["https://acme.com/pricing", "https://acme.com/hours", "https://acme.com/returns"] : [],
    sections: [
      { id: "company", title: "Company", facts: [{ id: "smf_01FIXTURE0000000000000001", key: "company.name", statement: "Acme Inc", value: "Acme Inc", provenance: "declared", ...src("/about", "About Acme") }, { id: "smf_01FIXTURE0000000000000002", key: "company.founded", statement: "Founded in 2011", value: "2011", provenance: "declared", ...src("/about", "About Acme") }] },
      { id: "products", title: "Products", facts: [{ id: "smf_01FIXTURE0000000000000003", key: "product.anvil", statement: "The Acme Anvil, 50 kg, cast iron", value: null, provenance: "declared", ...src("/products/anvil", "Acme Anvil") }] },
      { id: "contact", title: "Contact and hours", facts: [{ id: "smf_01FIXTURE0000000000000004", key: "contact.hours", statement: "Open Monday to Friday, 8 to 6", value: null, provenance: "declared", ...src("/contact", "Contact Acme") }, { id: "smf_01FIXTURE0000000000000005", key: "contact.email", statement: "hello@acme.com", value: "hello@acme.com", provenance: "declared", ...src("/contact", "Contact Acme") }] },
      { id: "policies", title: "Policies", facts: [{ id: "smf_01FIXTURE0000000000000006", key: "policy.returns", statement: "Returns accepted within 30 days", value: null, provenance: "declared", ...src("/returns", "Returns") }] },
    ],
    pages: [
      { id: "smp_01FIXTURE0000000000000001", url: "https://acme.com/", title: "Acme Inc" },
      { id: "smp_01FIXTURE0000000000000002", url: "https://acme.com/about", title: "About Acme" },
      { id: "smp_01FIXTURE0000000000000003", url: "https://acme.com/products/anvil", title: "Acme Anvil" },
      { id: "smp_01FIXTURE0000000000000004", url: "https://acme.com/contact", title: "Contact Acme" },
      { id: "smp_01FIXTURE0000000000000005", url: "https://acme.com/returns", title: "Returns" },
    ],
  };
}

function problem(res, status, code, detail, next_action, extraHeaders = {}) {
  const body = JSON.stringify({ type: `https://trooth.co/problems/${code}`, title: code, status, detail, code, retryable: status >= 500, next_action, terminal: false });
  res.writeHead(status, { "Content-Type": "application/problem+json", "Cache-Control": "private, no-store", "Trooth-Request-Id": randomBytes(8).toString("hex"), ...extraHeaders });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Trooth-Request-Id": randomBytes(8).toString("hex") });
  res.end(JSON.stringify(body));
}

function cleanDomain(raw) {
  let h = String(raw ?? "").trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d*$/, "").replace(/^www\./, "");
  return h;
}

/** The poll's live lookup: at most a fixed step per GET, from the DNS the control route set. */
function livePoll(s) {
  let found = false;
  if (s.company && !s.proven_at) {
    s.lastCheck = iso();
    s.proofChecks += 1;
    if (s.dns === "right") {
      s.proven_at = iso();
      s.stamps.prove_domain = s.proven_at;
      found = true;
    }
  }
  // The read moves only while the read screen is the step, so the harness can watch the bar.
  if (s.company && s.proven_at && s.read && s.read.status === "reading" && decideStep(s) === "read" && !s.readHeld) {
    s.readGets += 1;
    if (s.scenario === "errors" && !s.read.retried && s.read.pages_done >= 120) {
      s.read.status = "failed";
      s.read.finished_at = iso();
    } else {
      s.read.pages_done = Math.min(FOUND, s.read.pages_done + 20);
      if (s.read.pages_done >= FOUND) {
        s.read.status = "done";
        s.read.finished_at = iso();
      }
    }
  }
  return found;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString("utf8");
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

async function handleApi(req, res, path, input) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return problem(res, 401, "unauthorized", "Sign in again. Your session ended.", "Sign in again.");
  const s = session(token);
  s.requests.push(`${req.method} ${path}`);
  if (req.method === "GET" && /\/setup$/.test(path)) stats.gets.push({ token, at: Date.now() });

  if (req.method === "GET" && path === "/os/semanto/setup") return json(res, 200, doc(s));
  if (req.method === "POST" && path === "/os/semanto/setup/start") {
    const domain = cleanDomain(input.domain);
    if (domain === "taken.com") return problem(res, 409, "domain_claimed_elsewhere", "taken.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim.", "Ask to join that workspace, or ask Trooth to review the claim.");
    if (domain === "boom.com") return problem(res, 500, "internal_error", "The step did not finish. Quote request id 0a1b2c3d4e5f6071 to Trooth support.", "Try again in a minute. If it keeps happening, quote the request id to Trooth support.", { "Trooth-Request-Id": "0a1b2c3d4e5f6071" });
    s.company = { org: String(input.org ?? ""), domain, trooth_id: domain.split(".")[0] };
    s.stamps.company = iso();
    s.lookingSince = iso();
    s.read = { status: "reading", found: FOUND, pages_done: 0, started_at: iso(), finished_at: null, retried: false };
    return json(res, 201, doc(s));
  }
  const m = /^\/os\/semanto\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return problem(res, 404, "invalid_request", "No such route.", "Check the address.");
  if (!s.company || m[1] !== s.company.trooth_id) return problem(res, 403, "forbidden", "This session belongs to another company.", "Sign in with your own company's account.");
  const route = m[2];
  if (req.method === "GET" && route === "setup") {
    const found = livePoll(s);
    return json(res, 200, doc(s, { found }));
  }
  if (req.method === "GET" && route === "setup/review") return json(res, 200, review(s));
  if (req.method !== "POST") return problem(res, 404, "invalid_request", "No such route.", "Check the address.");
  switch (route) {
    case "setup/look-again":
      s.scenario = s.scenario === "timeout" ? "timeout-looked" : s.scenario;
      s.lookingSince = iso();
      return json(res, 200, doc(s));
    case "setup/read-again":
      if (s.read) {
        s.read.status = "reading";
        s.read.retried = true;
        s.read.finished_at = null;
        if (s.read.pages_done >= FOUND) s.read.pages_done = 0;
      }
      return json(res, 200, doc(s));
    case "setup/choose":
      if (!s.read || s.read.status !== "done") return problem(res, 409, "conflict", "The read is not done yet.", "Wait for the read.");
      s.path = input.path === "full" ? "full" : "basic";
      s.basic = s.path === "basic";
      s.stamps.read_site = iso();
      return json(res, 200, doc(s));
    case "setup/confirm":
      if (s.confirmFails > 0) {
        s.confirmFails -= 1;
        s.changed = true;
        return problem(res, 409, "conflict", "This version changed while you were reviewing. Review the changes, then confirm.", "Review the changes, then confirm.");
      }
      if (input.root_hash !== (s.changed ? ROOT2 : ROOT)) return problem(res, 409, "conflict", "This version changed while you were reviewing. Review the changes, then confirm.", "Review the changes, then confirm.");
      s.confirmed_at = iso();
      s.stamps.review = s.confirmed_at;
      return json(res, 200, doc(s));
    case "passkeys/options": {
      const challenge = b64url(32);
      s.challenges.set(challenge, { kind: "create", expires: Date.now() + W.CHALLENGE_TTL_MS });
      return json(res, 200, { object: "semanto.passkey_options", trooth_id: s.company.trooth_id, expires_at: new Date(Date.now() + W.CHALLENGE_TTL_MS).toISOString(), has_passkey: s.passkeys.length > 0, publicKey: W.creationOptions({ config: RP, user: s.passkeyUser, name: "ada@acme.com", challenge, existing: s.passkeys }) });
    }
    case "passkeys": {
      const reg = W.readRegistration(input);
      if (!reg) return problem(res, 400, "invalid_request", "Send the credential navigator.credentials.create gave.", "Try again.");
      const cd = W.readClientData(reg.clientDataJSON);
      const c = cd && s.challenges.get(cd.challenge);
      if (cd) s.challenges.delete(cd.challenge);
      if (!c || c.kind !== "create" || c.expires < Date.now()) return problem(res, 409, "passkey_challenge_expired", "The passkey request has expired or was already used. The passkey was not added.", "Start the passkey step again.");
      const r = await W.verifyRegistration({ input: reg, challenge: cd.challenge, config: RP });
      if (!r.ok) return problem(res, 422, "passkey_invalid", `The passkey answer did not check out: ${r.reason}. The passkey was not added.`, "Try again.");
      const { fmt: _fmt, ...kept } = r.passkey;
      s.passkeys.push({ ...kept, user_id: s.passkeyUser.user_id, trooth_id: s.company.trooth_id, created_at: iso(), last_used_at: null });
      return json(res, 201, { object: "semanto.passkey", trooth_id: s.company.trooth_id, credential_id: r.passkey.credential_id, alg: r.passkey.alg, transports: r.passkey.transports, created_at: iso() });
    }
    case "sign/options": {
      if (s.custody !== "hosted") return problem(res, 409, "conflict", "This company signs with its own key, so there is no passkey step.", "Ask for the signing input.");
      if (!s.passkeys.length) return problem(res, 409, "passkey_missing", "Add a passkey first. Trooth keeps your company's signing key and releases it only after you use your passkey.", "Add a passkey first, then sign again.");
      const root_hash = s.changed ? ROOT2 : ROOT;
      const challenge = b64url(32);
      s.challenges.set(challenge, { kind: "get", version: 1, root_hash, expires: Date.now() + W.CHALLENGE_TTL_MS });
      s.issued.push(challenge);
      return json(res, 200, { object: "semanto.sign_options", trooth_id: s.company.trooth_id, version: 1, root_hash, expires_at: new Date(Date.now() + W.CHALLENGE_TTL_MS).toISOString(), publicKey: W.requestOptions({ config: RP, challenge, passkeys: s.passkeys }) });
    }
    case "sign": {
      if (!s.confirmed_at) return problem(res, 409, "conflict", "Confirm the facts first.", "Confirm the facts.");
      // Hosted custody: the key is released only after the assertion over this version's single-use challenge.
      if (s.custody === "hosted") {
        if (!s.passkeys.length) return problem(res, 409, "passkey_missing", "Add a passkey first. Trooth keeps your company's signing key and releases it only after you use your passkey.", "Add a passkey first, then sign again.");
        if (!input.assertion) return problem(res, 400, "passkey_cancelled", "The passkey step did not finish, so the signing key was not released. Nothing was signed.", "Press the button again and finish the step on your device.");
        const a = W.readAssertion(input.assertion);
        const cd = a && W.readClientData(a.clientDataJSON);
        const c = cd && s.challenges.get(cd.challenge);
        if (cd) s.challenges.delete(cd.challenge);
        if (!c || c.kind !== "get" || c.expires < Date.now()) return problem(res, 409, "passkey_challenge_expired", "The passkey request has expired or was already used. Nothing was signed.", "Start the passkey step again.");
        if (c.version !== input.version || c.root_hash !== (s.changed ? ROOT2 : ROOT)) return problem(res, 422, "passkey_invalid", "The passkey answer was for another version. Nothing was signed.", "Start the passkey step again for this version.");
        const passkey = s.passkeys.find((k) => k.credential_id === a.id);
        if (!passkey) return problem(res, 422, "passkey_invalid", "The passkey used is not one of yours. Nothing was signed.", "Try again.");
        const r = await W.verifyAssertion({ input: a, challenge: cd.challenge, config: RP, passkey, user: s.passkeyUser });
        if (!r.ok) return problem(res, r.code === "origin" ? 403 : 422, r.code === "origin" ? "passkey_origin_mismatch" : "passkey_invalid", `The passkey answer did not check out: ${r.reason}. Nothing was signed.`, "Try again.");
        passkey.sign_count = r.sign_count;
        s.assertions.push({ ...a, challenge: cd.challenge, origin: cd.origin, type: cd.type });
      }
      if (s.two_officer) {
        if (!s.approvals.length) s.approvals.push({ name: "ada@acme.com", role: "owner", at: iso(), passkey: true });
        return json(res, 202, { object: "semanto.sign_waiting", trooth_id: s.company.trooth_id, version: 1, root_hash: ROOT, reason: "Two officers must approve this version. One has.", approvals_missing: 1, two_officer_note: "A second officer needs their own Trooth account to approve. Invite them from Team settings." });
      }
      if (s.custody === "customer") {
        if (typeof input.signature !== "string") {
          s.pending = true;
          return json(res, 200, { object: "semanto.signing_input", trooth_id: s.company.trooth_id, version: 1, kid: "fixture-customer-kid-1", typ: "https://trooth.co/types/semanto-version", signing_input: "eyJhbGciOiJFZERTQSIsImtpZCI6ImZpeHR1cmUtY3VzdG9tZXIta2lkLTEifQ.eyJ2ZXJzaW9uIjoxLCJyb290X2hhc2giOiJmaXh0dXJlIn0", protected: "eyJhbGciOiJFZERTQSIsImtpZCI6ImZpeHR1cmUtY3VzdG9tZXIta2lkLTEifQ", payload: "eyJ2ZXJzaW9uIjoxLCJyb290X2hhc2giOiJmaXh0dXJlIn0", next: "Sign the UTF-8 bytes of signing_input with your Ed25519 private key and send the 64-byte signature, base64url, as { \"version\": n, \"signature\": \"<base64url signature>\" } to this same address." });
        }
        if (/^A+$/.test(input.signature)) return problem(res, 422, "signature_invalid", "The signature did not check out: it was not made by key fixture-customer-kid-1 over this signing input.", "Sign the signing input shown, with the private key for fixture-customer-kid-1, and paste the new signature.");
      }
      s.signed_at = iso();
      s.stamps.sign = s.signed_at;
      return json(res, 200, { object: "semanto.signed", trooth_id: s.company.trooth_id, version: 1, version_id: "smv_01FIXTURE00000000000000001", root_hash: ROOT, signed_at: s.signed_at, kid: "fixture-kid-1" });
    }
    case "setup/host":
      if (!(input.host in GUIDES)) return problem(res, 400, "invalid_request", "host must be one of the listed hosts.", "Pick a host from the list.");
      s.host = input.host;
      s.hostChosen = true;
      return json(res, 200, doc(s));
    case "setup/install-check": {
      s.installChecks += 1;
      const pass = s.scenario === "errors" ? s.installChecks >= 2 : true;
      s.checks = pass ? { markdown: "pass", signature: "pass", well_known: "pass" } : { markdown: "fail", signature: "pending", well_known: "fail" };
      s.install_checked_at = iso();
      if (!s.stamps.install) s.stamps.install = s.install_checked_at;
      if (pass) s.stamps.check = s.install_checked_at;
      const messages = pass ? { markdown: MESSAGES.markdownOk, signature: MESSAGES.signatureOk, well_known: MESSAGES.wellKnownOk } : { markdown: MESSAGES.markdownFail, signature: MESSAGES.signaturePending, well_known: MESSAGES.wellKnownMissing };
      return json(res, 200, { object: "semanto.install_check", url: `https://${s.company.domain}/`, checks: s.checks, messages, message: pass ? MESSAGES.ok : MESSAGES.markdownFail, checked_at: s.install_checked_at, setup: doc(s) });
    }
    case "setup/monitoring":
      if ((input.questions ?? []).length > 10 || (input.competitors ?? []).length > 3) return problem(res, 400, "invalid_request", "At most 10 questions and 3 companies.", "Remove some.");
      s.monitoring = { started_at: iso(), questions: input.questions ?? [], competitors: input.competitors ?? [] };
      s.stamps.monitoring = s.monitoring.started_at;
      return json(res, 200, doc(s));
    case "setup/save-for-later":
      s.saved = true;
      s.savedScreen = input.screen ?? null;
      return json(res, 200, doc(s));
    case "setup/resume":
      s.saved = false;
      return json(res, 200, doc(s));
    default:
      return problem(res, 404, "invalid_request", "No such route.", "Check the address.");
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2" };

export function startMockServer({ staticDir, port = 0 }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/os/")) return await handleApi(req, res, path, req.method === "POST" ? await body(req) : {});
      if (path === "/__harness/email-link" && req.method === "POST") {
        const b = await body(req);
        if (String(b.email).includes("fail")) return problem(res, 503, "upstream_unavailable", "The sign-in link was not sent.", "Try again in a minute.");
        return json(res, 200, { link: `/?token=full-${Date.now().toString(36)}&fresh=1` });
      }
      if (path.startsWith("/__control/") && req.method === "POST") {
        const token = decodeURIComponent(path.split("/")[2] ?? "");
        const b = await body(req);
        const s = session(token);
        if (b.dns) s.dns = b.dns;
        if (b.read === "go") s.readHeld = false;
        return json(res, 200, { ok: true, dns: s.dns });
      }
      if (path.startsWith("/__session/")) {
        const s = session(decodeURIComponent(path.split("/")[2] ?? ""));
        return json(res, 200, { requests: s.requests, assertions: s.assertions, issued: s.issued, passkeys: s.passkeys.map((k) => k.credential_id), saved: s.saved, savedScreen: s.savedScreen ?? null, host: s.host, monitoring: s.monitoring });
      }
      if (path === "/__stats") {
        const token = url.searchParams.get("token");
        return json(res, 200, { gets: stats.gets.filter((g) => !token || g.token === token).map((g) => g.at) });
      }
      if (path.startsWith("/__guide/")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Guide</title><p>Fixture page for ${path.slice(9).replace(/[<>&]/g, "")}</p>`);
      }
      const file = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
      const data = await readFile(join(staticDir, file));
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(data);
    } catch (e) {
      if (e && e.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port })));
}
