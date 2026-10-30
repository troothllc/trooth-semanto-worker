// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Regression tests for the pre-deploy audit (docs/audit/pre-deploy-audit.md,
// fixes in docs/reports/audit-fixes.md) and for the setup backend
// (docs/spec/setup-api.md). Each describe names the finding it guards; each
// test would fail if that fix were undone. In-memory ports only, with the
// fictional Acme Inc (acme.com) from test/fixtures/compiler; the D1 tests run
// the real SQL over node:sqlite (test/fixtures/integration/fixture-d1-shim.ts).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { utf8, toBase64 } from "@/core/encoding";
import { generateKeyPair, WitnessKeyMissingError, type Jwks, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { versionId } from "@/core/semanto";
import { signMessage } from "@/core/httpsig";
import type { SemantoFile } from "@/core/semanto";
import { MemoryHttp as SiteHttp, WebFetchHttp } from "@/compiler/ports";
import { Fetcher } from "@/compiler/fetch";
import { discover } from "@/compiler/discover";
import { buildVersion } from "@/compiler/build";
import { MemoryBuildStaging, PAGES_PER_MESSAGE } from "@/compiler/stream";
import { MemoryVersionStore, memoryPorts, TEST_CONFIG } from "@/serve/memory-ports";
import { createApp, readCapped, safeDecode, type RouteDeps } from "@/serve/routes";
import { classifyHost, detectHost } from "@/serve/detect";
import type { KeyPort, WorkspaceAuth } from "@/serve/ports";
import { MemoryKeyCache, MemoryNonceStore, MemoryHttp as ReadersHttp, MemoryReceiptStore, D1ReceiptStore } from "@/readers/ports";
import { DIRECTORY_PATH, verifyWebBotAuth } from "@/readers/webbotauth";
import { proveReader } from "@/readers/forwarded";
import { nonceShard, NONCE_SHARDS_PER_KEY } from "@/readers/nonce-do";
import { CountedReceipts, MemoryRateLimiter, RateLimitDO, minuteRow, take, RATE_LIMITS, type RateNamespace } from "@/readers/rate-limit";
import { verifyRevocationList } from "@/ledger/revocation";
import { fetchFromMap, guardedFetchPort, guardedGet, memoryEmail, memoryStore } from "@/monitor/ports";
import { InMemoryCommerceStore } from "@/commerce/ports";
import { dnsClaimName, pointerRecordValue, WITNESSED_NOT_SIGNED } from "@/basic/tier";
import { MemoryHttp as IdentityHttp } from "@/identity/ports";
import { D1Keys } from "@/db/d1";
import { MemoryPipelineStore } from "@/pipeline-store";
import { Pipeline, troothOsAuthorize, troothOsSession, withCompanies, type PipelineDeps, type ServiceFetcher } from "@/pipeline";
import { memorySetupDns } from "@/setup/ports";
import { applyUrl, discover as dcDiscover, ONBOARDED, readReturn } from "@/setup/domain-connect";
import { hostFromNameservers, manualSteps, nameToType, UNKNOWN_HOST } from "@/setup/dns-hosts";
import { diagnose } from "@/setup/dns-diagnosis";
import { runInstallCheck, INSTALL_OK, INSTALL_MESSAGES } from "@/setup/install-check";
import { leftOutPlain } from "@/setup/state";
import type { QueueMessage } from "@/env";
import { FixtureD1, FixtureR2 } from "./fixtures/integration/fixture-d1-shim";
import * as JSV from "../verifier/js/verify.mjs";
import { clientAddress, forwardingHeaders } from "../adapters/shared/semanto-adapter.mjs";
import { generateConnectorKey } from "../adapters/shared/sign-request.mjs";
import { PasskeyWallet, addPasskey, passkeySign } from "./helpers/passkey";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPILER = fileURLToPath(new URL("./fixtures/compiler/", import.meta.url));
const readCompiler = (name: string) => readFileSync(COMPILER + name, "utf8");
const NOW = new Date("2026-10-22T12:00:00.000Z");
const API = TEST_CONFIG.public_api_base;
const OS = "https://api.trooth.co/os/semanto";
const ZERO_CHALLENGE = `trooth-domain-challenge=${"00".repeat(24)}`;

const SITE_PAGES: Record<string, string> = {
  "https://acme.com/": "index.html",
  "https://acme.com/about": "about.html",
  "https://acme.com/pricing": "pricing.html",
  "https://acme.com/contact": "contact.html",
  "https://acme.com/security": "security.html",
  "https://acme.com/blog/launch-notes": "blog-launch-notes.html",
  "https://acme.com/careers": "careers.html",
  "https://acme.com/login": "login.html",
};

function fixtureSite(): SiteHttp {
  const http = new SiteHttp();
  http.set("https://acme.com/robots.txt", { body: readCompiler("robots.txt"), headers: { "content-type": "text/plain" } });
  http.set("https://acme.com/sitemap.xml", { body: readCompiler("sitemap.xml"), headers: { "content-type": "application/xml" } });
  http.set("https://acme.com/llms.txt", { body: readCompiler("llms.txt"), headers: { "content-type": "text/plain" } });
  for (const [url, file] of Object.entries(SITE_PAGES)) http.set(url, { body: readCompiler(file), headers: { "content-type": "text/html; charset=utf-8" } });
  return http;
}

/** worker-f's session answers, by bearer token (GET /auth/session, read 22 Oct 2026). */
const SESSIONS: Record<string, Record<string, unknown>> = {
  "Bearer ada": { authenticated: true, companyId: "co-acme", userId: "u-ada", email: "ada@acme.com", role: "vendor", companyName: "Acme Inc", signedInAt: new Date(NOW.getTime() - 20_000).toISOString() },
  "Bearer cy": { authenticated: true, companyId: "co-acme", userId: "u-cy", email: "cy@acme.com", role: "vendor" },
  "Bearer eve": { authenticated: true, companyId: "co-evil", userId: "u-eve", email: "eve@evil.example", role: "vendor" },
  "Bearer buyer": { authenticated: true, companyId: "co-buyer", userId: "u-bea", role: "buyer" },
  "Bearer slug": { authenticated: true, companyId: "co-slug", userId: "u-sam", role: "vendor", companySlug: "acme-widgets" },
  "Bearer nod": { authenticated: true, companyId: "co-nodomain", userId: "u-nod", email: "nod@nodomain.example", role: "vendor" },
};
/** When trooth.co confirmed the fixture domains: the day before NOW. */
const CONFIRMED_AT = "2026-10-21T09:00:00.000Z";
const confirmed = (domain: string) => ({ domain, status: "confirmed", confirmed_at: CONFIRMED_AT, method: "dns" });
const unconfirmed = (domain: string) => ({ domain, status: "unconfirmed", confirmed_at: null, method: "dns" });
/** worker-f's GET /auth/domain-claims answers, by companyId (the session's rows of trooth.co's domain_claims). Reset by world(). */
const defaultDomains = (): Record<string, Record<string, unknown>[]> => ({
  "co-acme": [confirmed("acme.com")],
  "co-evil": [confirmed("acme.com")],
  "co-slug": [confirmed("widgets.example")],
  "co-nodomain": [unconfirmed("nodomain.example")],
});
let DOMAINS = defaultDomains();
/** Every call through the binding, with the credential it carried. */
const workerFCalls: { url: string; authorization: string; dpop: string | null }[] = [];
const workerF: ServiceFetcher = {
  fetch: async (url, init) => {
    const h = new Headers(init?.headers);
    const auth = h.get("authorization") ?? "";
    const u = typeof url === "string" ? url : url.url;
    workerFCalls.push({ url: u, authorization: auth, dpop: h.get("dpop") });
    // A DPoP-scheme request is the same session as its bearer twin, in this fixture.
    const s = SESSIONS[auth.replace(/^DPoP /, "Bearer ")];
    if (!s) return new Response(null, { status: 401 });
    if (u === "https://api.trooth.co/auth/session") return Response.json(s);
    if (u === "https://api.trooth.co/auth/domain-claims") {
      const rows = DOMAINS[String(s.companyId)];
      return rows === undefined ? new Response(null, { status: 503 }) : Response.json({ domains: rows });
    }
    return new Response(null, { status: 404 });
  },
};

interface World {
  clock: { now: Date };
  witness: PrivateJwk;
  witnessPublic: PublicJwk;
  versions: MemoryVersionStore;
  ports: ReturnType<typeof memoryPorts>;
  store: MemoryPipelineStore;
  staging: MemoryBuildStaging;
  site: SiteHttp;
  dns: ReturnType<typeof memorySetupDns>;
  email: ReturnType<typeof memoryEmail>;
  pipeline: Pipeline;
  app: ReturnType<typeof createApp>;
  queued: QueueMessage[];
  probes: string[];
  deps: PipelineDeps;
}

async function world(opts: { queue?: boolean; probe?: (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array } | null>; rateLimit?: RouteDeps["rateLimit"]; companies?: { trooth_id: string; proven: boolean; os?: string }[] } = {}): Promise<World> {
  const clock = { now: new Date(NOW) };
  const now = () => new Date(clock.now);
  DOMAINS = defaultDomains();
  workerFCalls.length = 0;
  const w = await generateKeyPair();
  const versions = new MemoryVersionStore();
  const ports = memoryPorts(versions, w.privateJwk, { now });
  const store = new MemoryPipelineStore(versions);
  for (const c of opts.companies ?? []) await store.putCompany({ trooth_id: c.trooth_id, domain: c.trooth_id === "acme" ? "acme.com" : `${c.trooth_id}.example`, org: `${c.trooth_id} Inc`, tier: "full", current_version: null, custody: "hosted", domain_proven_at: c.proven ? NOW.toISOString() : null, os_company_id: c.os ?? null });
  const site = fixtureSite();
  const dns = memorySetupDns({ ns: { "acme.com": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] } });
  const email = memoryEmail();
  const staging = new MemoryBuildStaging();
  const queued: QueueMessage[] = [];
  const probes: string[] = [];
  const commerce = withCompanies(new InMemoryCommerceStore(), store, API);
  const holder: { app?: ReturnType<typeof createApp> } = {};
  const deps: PipelineDeps = {
    store,
    versions,
    keys: ports.keys,
    settings: ports.settings,
    log: ports.log,
    logStore: ports.log.store,
    commerce,
    config: TEST_CONFIG,
    now,
    site: { http: site, fetcher: { minIntervalMs: 0 } },
    monitor: { fetch: fetchFromMap({}), store: memoryStore(), email, from: "Trooth <alerts@trooth.co>" },
    identity: { http: new IdentityHttp({}) },
    setupDns: dns,
    staging,
    gapAdapters: () => [],
    gapReports: true,
    random: (n) => new Uint8Array(n),
    nonces: new MemoryNonceStore(),
    receiptStore: new MemoryReceiptStore(),
    // The company's site as an adapter would answer: by path from the API, the well-known files from their hosted copies.
    siteProbe:
      opts.probe ??
      (async (url, headers) => {
        probes.push(url);
        const u = new URL(url);
        const api = u.pathname === "/.well-known/trooth.semanto" ? `${API}/acme/.well-known/trooth.semanto` : u.pathname === "/.well-known/trooth-keys.json" ? `${API}/acme/keys.json` : `${API}/acme/by-path${u.pathname}`;
        const r = await holder.app!.request(api, { headers });
        const h: Record<string, string> = {};
        r.headers.forEach((v, k) => (h[k] = v));
        return { status: r.status, headers: h, body: new Uint8Array(await r.arrayBuffer()) };
      }),
    ...(opts.queue ? { enqueue: async (m: QueueMessage) => void queued.push(m) } : {}),
  };
  const pipeline = new Pipeline(deps);
  const app = createApp({
    ports: { ...ports, jobs: pipeline.jobs() },
    authorize: troothOsAuthorize(workerF, async (id) => (await store.getCompanyByOsCompany(id))?.trooth_id ?? null, (tid) => store.ownerUserId(tid)),
    session: troothOsSession(workerF),
    workspace: pipeline,
    commerce,
    revocations: (tid) => store.getRevocationList(tid),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
  });
  holder.app = app;
  return { clock, witness: w.privateJwk, witnessPublic: w.publicJwk, versions, ports, store, staging, site, dns, email, pipeline, app, queued, probes, deps };
}

const call = (w: World, method: "GET" | "POST", path: string, token: string, body?: unknown) =>
  w.app.request(`${OS}${path}`, { method, headers: { authorization: token, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
/** One software passkey per workspace token and world (test/helpers/passkey.ts). */
const wallets = new WeakMap<World, PasskeyWallet>();
const walletOf = (w: World) => {
  let x = wallets.get(w);
  if (!x) wallets.set(w, (x = new PasskeyWallet()));
  return x;
};
const poster = (w: World) => (path: string, body: unknown, token: string) => call(w, "POST", path, token, body);
/** Hosted signing as the wizard does it: sign/options (adding a passkey first), the assertion, then sign. */
const signHosted = (w: World, token = "Bearer ada", trooth_id = "acme") => passkeySign(poster(w), trooth_id, token, walletOf(w));
const pub = (w: World, path: string, headers: Record<string, string> = {}) => w.app.request(`${API}${path}`, { headers });
async function drain(w: World, beforeAssemble?: () => void): Promise<number> {
  let n = 0;
  while (w.queued.length) {
    const m = w.queued.shift()!;
    if (beforeAssemble && (m as { stage?: string }).stage === "assemble") beforeAssemble();
    await w.pipeline.jobs().compile(m);
    n++;
  }
  return n;
}
const advance = (w: World, ms: number) => (w.clock.now = new Date(w.clock.now.getTime() + ms));

// ------------------------------------------------------------------------ finding 1

describe("finding 1: a worker-f workspace claims its company, and then every /os route maps to it", () => {
  it("claims on first contact, maps companyId to the company, registers the owner, and refuses a second workspace and a changed domain", async () => {
    const w = await world();
    // Signed in, with no Semanto company yet: refused as not this workspace's company (QA-11), not told to sign in.
    expect((await call(w, "GET", "/acme/setup", "Bearer ada")).status).toBe(403);
    // No company step and no proof step: the workspace's domain confirmed on trooth.co is the website, and the action reads it.
    const empty = await json(await call(w, "GET", "/setup", "Bearer ada"));
    expect(empty).toMatchObject({ object: "semanto.setup", trooth_id: null, domain: "acme.com", step: "read", proof: { source: "trooth_domain_claim", status: "confirmed", confirmed_at: CONFIRMED_AT, confirm_url: "https://trooth.co/dashboard/public-page?tab=domain", pointer: null }, next_action: { label: "Read my website", method: "POST", url: `${OS}/setup/start` } });
    const r = await call(w, "POST", "/claim", "Bearer ada", { domain: "https://www.Acme.com/about?x=1", org: "Acme Inc" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(r)).toEqual({ object: "semanto.claim", trooth_id: "acme", domain: "acme.com", org: "Acme Inc", created: true, owner: true });
    const company = (await w.store.getCompany("acme"))!;
    expect(company.os_company_id).toBe("co-acme");
    // Proven by the confirmation on trooth.co, at its date, with that source.
    expect(company.domain_proven_at).toBe(CONFIRMED_AT);
    expect((await w.store.getBasic("acme"))!.proof_method).toBe("trooth_domain_claim");
    expect(await w.store.ownerUserId("acme")).toBe("u-ada");
    // The existing authorize mapping now works: owner for the claimer, member for a colleague.
    const auth = troothOsAuthorize(workerF, async (id) => (await w.store.getCompanyByOsCompany(id))?.trooth_id ?? null, (tid) => w.store.ownerUserId(tid));
    const req = (t: string) => new Request(`${OS}/acme/setup`, { headers: { authorization: t } });
    expect(await auth(req("Bearer ada"), "acme")).toMatchObject({ trooth_id: "acme", role: "owner", user_id: "u-ada" });
    expect(await auth(req("Bearer cy"), "acme")).toMatchObject({ trooth_id: "acme", role: "member" });
    expect((await call(w, "GET", "/acme/setup", "Bearer ada")).status).toBe(200);
    // Again from the same workspace: linked, not created.
    expect((await call(w, "POST", "/claim", "Bearer ada", { domain: "acme.com", org: "Acme Inc" })).status).toBe(200);
    // Another workspace: a 409 in plain words.
    const other = await call(w, "POST", "/claim", "Bearer eve", { domain: "acme.com", org: "Evil" });
    expect(other.status).toBe(409);
    const p = await json(other);
    expect(p.code).toBe("domain_claimed_elsewhere");
    expect(p.detail).toBe("acme.com is already held by another Trooth workspace. Ask to join it, or ask Trooth to review the claim.");
    // The same workspace cannot change its domain.
    const moved = await call(w, "POST", "/claim", "Bearer ada", { domain: "other.example", org: "Acme Inc" });
    expect(moved.status).toBe(409);
    expect((await json(moved)).code).toBe("domain_fixed");
    // A buyer account has no company to act for; no token at all is refused.
    expect((await call(w, "POST", "/claim", "Bearer buyer", { domain: "buyer.example" })).status).toBe(401);
    expect((await w.app.request(`${OS}/claim`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("takes the domain only from the workspace's confirmed domains on trooth.co, and points an unconfirmed one at the trooth.co page", async () => {
    const w = await world();
    // An unconfirmed domain: the step is the domain, and the one action is the trooth.co page that confirms it.
    const waiting = await json(await call(w, "GET", "/setup", "Bearer nod"));
    expect(waiting).toMatchObject({ trooth_id: null, domain: "nodomain.example", step: "prove", proof: { source: null, status: "unconfirmed", confirmed_at: null }, next_action: { label: "Confirm your domain", method: "GET", url: "https://trooth.co/dashboard/public-page?tab=domain" } });
    // The state never carries a record to publish: there is one proof, on trooth.co.
    expect(JSON.stringify(waiting)).not.toContain("_trooth-challenge");
    for (const path of ["/claim", "/setup/start"]) {
      const refused = await call(w, "POST", path, "Bearer nod", { domain: "nodomain.example" });
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({ code: "domain_not_confirmed", detail: "nodomain.example is not a confirmed domain of this workspace on trooth.co. Confirm it at https://trooth.co/dashboard/public-page?tab=domain, then start again." });
    }
    // A domain the workspace never listed is refused the same way; no domain at all names the trooth.co page too.
    expect((await json(await call(w, "POST", "/setup/start", "Bearer ada", { domain: "elsewhere.example" }))).code).toBe("domain_not_confirmed");
    expect((await json(await call(w, "POST", "/setup/start", "Bearer nod", {}))).detail).toBe("This workspace has no confirmed domain on trooth.co yet. Add and confirm one at https://trooth.co/dashboard/public-page?tab=domain, then start again.");
    expect(await w.store.getCompanyByOsCompany("co-nodomain")).toBeNull();
    // The list could not be read: a plain problem, never "no domains", and nothing is created.
    delete DOMAINS["co-nodomain"];
    const unread = await call(w, "POST", "/setup/start", "Bearer nod", {});
    expect([unread.status, (await json(unread)).code]).toEqual([502, "upstream_unavailable"]);
    expect((await json(await call(w, "GET", "/setup", "Bearer nod"))).proof).toMatchObject({ status: "unavailable" });
    // Confirmed on trooth.co: start takes it without a domain in the body and with worker-f's company name.
    DOMAINS["co-nodomain"] = [confirmed("nodomain.example")];
    const started = await call(w, "POST", "/setup/start", "Bearer nod", {});
    expect(started.status).toBe(201);
    expect(await json(started)).toMatchObject({ trooth_id: "nodomain", domain: "nodomain.example", step: "read", proof: { source: "trooth_domain_claim", status: "confirmed" } });
  });

  it("sends trooth.co's DPoP proofs to worker-f, one per address, with the DPoP scheme", async () => {
    const w = await world();
    const proofA = "eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJodHUiOiJzZXNzaW9uIn0.c2ln";
    const proofB = "eyJ0eXAiOiJkcG9wK2p3dCJ9.eyJodHUiOiJkb21haW5zIn0.c2ln";
    const r = await w.app.request(`${OS}/setup`, { headers: { authorization: "Bearer ada", "trooth-os-session-proof": proofA, "trooth-os-domains-proof": proofB } });
    expect(r.status).toBe(200);
    expect(workerFCalls).toEqual([
      { url: "https://api.trooth.co/auth/session", authorization: "DPoP ada", dpop: proofA },
      { url: "https://api.trooth.co/auth/domain-claims", authorization: "DPoP ada", dpop: proofB },
    ]);
    // Without proofs (a deployment where worker-f does not require them), the plain bearer; a malformed proof is not forwarded.
    workerFCalls.length = 0;
    await w.app.request(`${OS}/setup`, { headers: { authorization: "Bearer ada", "trooth-os-session-proof": "not a proof" } });
    expect(workerFCalls.map((c) => [c.authorization, c.dpop])).toEqual([["Bearer ada", null], ["Bearer ada", null]]);
  });

  it("takes worker-f's company slug when it is free, and never a reserved route name", async () => {
    const w = await world();
    expect(await json(await call(w, "POST", "/claim", "Bearer slug", { domain: "widgets.example", org: "Acme Widgets" }))).toMatchObject({ trooth_id: "acme-widgets" });
    const w2 = await world();
    await w2.store.putCompany({ trooth_id: "acme", domain: "acme.io", org: "Acme IO", tier: "basic", current_version: null, custody: "hosted", os_company_id: "co-other" });
    expect(await json(await call(w2, "POST", "/claim", "Bearer ada", { domain: "acme.com", org: "Acme Inc" }))).toMatchObject({ trooth_id: "acme-com" });
    const w3 = await world();
    DOMAINS["co-acme"] = [confirmed("setup.example")];
    expect(await json(await call(w3, "POST", "/claim", "Bearer ada", { domain: "setup.example", org: "Setup Co" }))).toMatchObject({ trooth_id: "setup-example" });
  });
});

// ------------------------------------------------------------------------ finding 2 (claimswap.mts)

describe("finding 2: the domain is fixed at the claim, proven only by its confirmation on trooth.co, and nothing is published before the proof", () => {
  it("a claim for another domain is refused; a DNS record proves nothing; nothing is built, signed, witnessed or served until trooth.co confirms the domain", async () => {
    const w = await world();
    // A company linked before one signup, its domain not confirmed on trooth.co yet.
    await w.store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "basic", current_version: null, custody: "hosted", domain_proven_at: null, os_company_id: "co-acme" });
    await w.store.registerOwner("acme", "u-ada");
    DOMAINS["co-acme"] = [unconfirmed("acme.com"), confirmed("attacker.example")];
    const swap = await call(w, "POST", "/acme/basic/claim", "Bearer ada", { domain: "attacker.example" });
    expect(swap.status).toBe(409);
    expect((await json(swap)).code).toBe("domain_fixed");
    // Semanto runs no proof of its own: the old record, published, proves nothing.
    w.dns.set(dnsClaimName("acme.com"), [ZERO_CHALLENGE]);
    const prove = await json(await call(w, "POST", "/acme/basic/prove", "Bearer ada", {}));
    expect(prove.body).toMatchObject({ proved: false, method: null, proof: { status: "unconfirmed", confirm_url: "https://trooth.co/dashboard/public-page?tab=domain" } });
    expect((await w.store.getCompany("acme"))!.domain_proven_at).toBeNull();
    for (const action of ["build", "sign", "first-publication"]) {
      const r = await call(w, "POST", `/acme/${action}`, "Bearer ada", action === "first-publication" ? { url: "https://acme.com/about" } : {});
      expect([action, r.status, (await json(r)).code]).toEqual([action, 409, "domain_not_proven"]);
    }
    expect((await pub(w, "/acme")).status).toBe(409);
    expect(await w.ports.log.ledger.size()).toBe(0);
    // Confirmed on trooth.co: the proof is recorded against acme.com, and the record served is acme.com's.
    DOMAINS["co-acme"] = [confirmed("acme.com")];
    const ok = await json(await call(w, "POST", "/acme/basic/prove", "Bearer ada", {}));
    expect(ok.body).toMatchObject({ proved: true, method: "trooth_domain_claim" });
    expect((await w.store.getCompany("acme"))!.domain_proven_at).toBe(CONFIRMED_AT);
    const served = await pub(w, "/acme");
    expect(served.status).toBe(200);
    const file = (await json(served)) as SemantoFile & { notice: string };
    expect(file.header.identity.domain).toBe("acme.com");
    expect(file.header.domains).toEqual(["acme.com"]);
    expect(file.notice).toBe(WITNESSED_NOT_SIGNED);
  });
});

// ------------------------------------------------------------------------ the setup backend (part B)

describe("setup: the six-screen backend over docs/spec/setup-api.md", () => {
  it("start takes the confirmed domain and reads at once, with no company or proof step; Basic finishes inside 600 seconds", async () => {
    const w = await world({ queue: true });
    const r = await call(w, "POST", "/setup/start", "Bearer ada", {});
    expect(r.status).toBe(201);
    const s0 = await json(r);
    expect(s0).toMatchObject({ trooth_id: "acme", org: "Acme Inc", domain: "acme.com", step: "read", basic: true, read: { status: "queued", held: false }, next_action: { label: "Wait for the read", method: "GET" } });
    expect(s0.proof).toEqual({ source: "trooth_domain_claim", status: "confirmed", confirmed_at: CONFIRMED_AT, confirm_url: "https://trooth.co/dashboard/public-page?tab=domain", pointer: { record_name: "_trooth.acme.com", record_value: null } });
    expect(s0.timings.steps.map((x: any) => x.id)).toEqual(["sign_in", "company", "prove_domain", "read_site", "review", "sign", "install", "check", "monitoring"]);
    expect(s0.timings.steps[0].spent_seconds).toBe(0);
    expect(s0.timings.steps[1].spent_seconds).toBe(20);
    // A domain confirmed before setup began costs setup no time.
    expect(s0.timings.steps[2].spent_seconds).toBe(0);
    expect(w.queued).toHaveLength(1);
    // Start again from the same workspace: linked, not created, and no second read.
    expect((await call(w, "POST", "/setup/start", "Bearer ada", { domain: "acme.com" })).status).toBe(200);
    expect(w.queued).toHaveLength(1);

    // A long read is emailed when it finishes, with the link to the Semanto page on trooth.co.
    advance(w, 30_000);
    const messages = await drain(w, () => advance(w, 61_000));
    expect(messages).toBe(3);
    const read = await json(await call(w, "GET", "/acme/setup", "Bearer ada"));
    expect(read.read).toMatchObject({ status: "done", held: false });
    expect(read.read.read).toBeGreaterThan(3);
    expect(read.read.left_out).toContainEqual({ url: "https://acme.com/login", reason: "Needs a login", code: "login" });
    expect(w.email.sent.map((m) => m.subject)).toEqual([`Semanto read ${read.read.read} of ${read.read.found} pages on acme.com`]);
    expect(w.email.sent[0]!.to).toEqual(["ada@acme.com"]);
    expect(w.email.sent[0]!.text).toContain("https://trooth.co/dashboard/semanto");
    expect(read.step).toBe("read");
    expect(read.next_action).toEqual({ label: "Finish setup", method: "POST", url: `${OS}/acme/setup/choose` });
    const served = await pub(w, "/acme");
    expect(served.status).toBe(200);
    expect(served.headers.get("trooth-semanto-state")).toBe("witnessed-not-signed");

    // Save for later and resume persist on the server.
    expect((await json(await call(w, "POST", "/acme/setup/save-for-later", "Bearer cy", { screen: "D" }))).saved_for_later).toBe(true);
    expect((await w.store.getSetup("acme"))!.saved_screen).toBe("D");
    expect((await json(await call(w, "POST", "/acme/setup/resume", "Bearer cy", {}))).saved_for_later).toBe(false);

    // The receipt was seen and Basic chosen: done, measured from server timestamps.
    advance(w, 20_000);
    const done = await json(await call(w, "POST", "/acme/setup/choose", "Bearer cy", { path: "basic" }));
    expect(done.step).toBe("done");
    expect(done.next_action).toBeNull();
    expect(done.timings.basic.spent_seconds).not.toBeNull();
    expect(done.timings.basic.target_seconds).toBe(600);
    expect(done.timings.full.target_seconds).toBe(900);
    expect(done.timings.basic.within_target).toBe(done.timings.basic.spent_seconds <= 600);
  });

  it("a company whose domain is not confirmed yet waits on the trooth.co page; the poll after it is confirmed there records the proof and promotes the held read", async () => {
    const w = await world({ queue: true });
    await w.store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "basic", current_version: null, custody: "hosted", domain_proven_at: null, os_company_id: "co-acme" });
    DOMAINS["co-acme"] = [unconfirmed("acme.com")];
    const s0 = await json(await call(w, "POST", "/setup/start", "Bearer ada", {}));
    expect(s0).toMatchObject({ trooth_id: "acme", step: "prove", read: { status: "queued", held: true }, proof: { source: null, status: "unconfirmed" }, next_action: { label: "Confirm your domain", method: "GET", url: "https://trooth.co/dashboard/public-page?tab=domain" } });
    await drain(w);
    const held = await json(await call(w, "GET", "/acme/setup", "Bearer ada"));
    expect(held.read).toMatchObject({ status: "done", held: true });
    expect((await pub(w, "/acme")).status).toBe(409);
    expect(await w.ports.log.ledger.size()).toBe(0);
    // Not on the list at all reads as not listed; the step and the action stay the same.
    DOMAINS["co-acme"] = [];
    expect((await json(await call(w, "GET", "/acme/setup", "Bearer ada"))).proof.status).toBe("not_listed");
    DOMAINS["co-acme"] = [confirmed("acme.com")];
    const found = await json(await call(w, "GET", "/acme/setup", "Bearer ada"));
    expect(found).toMatchObject({ step: "read", read: { held: false }, proof: { source: "trooth_domain_claim", status: "confirmed", confirmed_at: CONFIRMED_AT } });
    expect((await pub(w, "/acme")).headers.get("trooth-semanto-state")).toBe("witnessed-not-signed");
  });

  it("the full path: review, confirm, sign, the install check against the site, monitoring, done", async () => {
    const w = await world();
    await call(w, "POST", "/setup/start", "Bearer ada", { org: "Acme Inc", domain: "acme.com" });
    expect((await json(await call(w, "GET", "/acme/setup", "Bearer ada"))).proof).toMatchObject({ source: "trooth_domain_claim", status: "confirmed" });
    expect((await call(w, "POST", "/acme/setup/choose", "Bearer cy", { path: "full" })).status).toBe(403);
    const review = await json(await call(w, "POST", "/acme/setup/choose", "Bearer ada", { path: "full" }));
    expect(review).toMatchObject({ step: "review", basic: false, next_action: { label: "Confirm these facts", method: "POST" } });
    const doc = await json(await call(w, "GET", "/acme/setup/review", "Bearer ada"));
    expect(doc.object).toBe("semanto.setup_review");
    expect(doc.sections.map((x: any) => x.id)).toEqual(["company", "products", "contact", "policies"]);
    expect(doc.sections.flatMap((x: any) => x.facts).every((f: any) => f.source_url.startsWith("https://acme.com/"))).toBe(true);
    const wrong = await call(w, "POST", "/acme/setup/confirm", "Bearer ada", { version: doc.version, root_hash: `sha256:${"0".repeat(64)}` });
    expect(wrong.status).toBe(409);
    expect((await json(wrong)).detail).toBe("This version changed while you were reviewing. Review the changes, then confirm.");
    const confirmed = await json(await call(w, "POST", "/acme/setup/confirm", "Bearer ada", { version: doc.version, root_hash: doc.root_hash }));
    // No passkey yet: the one action is to add one. Signing without a passkey assertion is refused.
    expect(confirmed.next_action).toMatchObject({ label: "Add a signing passkey", url: `${OS}/acme/passkeys/options` });
    expect(confirmed.sign).toMatchObject({ custody: "hosted", passkey_required: true, has_passkey: false, two_officer: false });
    const bare = await call(w, "POST", "/acme/sign", "Bearer ada", {});
    expect(bare.status).toBe(409);
    expect(await json(bare)).toMatchObject({ code: "passkey_missing", title: "Add a signing passkey first", detail: expect.stringContaining(`${OS}/acme/passkeys/options`) });
    expect((await addPasskey(poster(w), "acme", "Bearer ada", await walletOf(w).for("Bearer ada"))).status).toBe(201);
    const ready = await json(await call(w, "GET", "/acme/setup", "Bearer ada"));
    expect(ready.next_action).toMatchObject({ label: "Sign with my passkey", url: `${OS}/acme/sign/options` });
    expect(ready.sign).toMatchObject({ has_passkey: true });
    // has_passkey is the signed-in person's own: the member, who has none, is told so.
    expect((await json(await call(w, "GET", "/acme/setup", "Bearer cy"))).sign).toMatchObject({ has_passkey: false });
    expect((await signHosted(w)).status).toBe(200);
    const install = await json(await call(w, "GET", "/acme/setup", "Bearer ada"));
    expect(install.step).toBe("install");
    expect(install.install).toMatchObject({ checks: { markdown: "pending", signature: "pending", well_known: "pending" } });
    expect(install.proof.pointer.record_value).toMatch(/^v=trooth1; id=acme; key=/);
    // The check fetches the company's site (here an adapter in front of the API) and checks the bytes and the signature.
    const check = await json(await call(w, "POST", "/acme/setup/install-check", "Bearer cy", {}));
    expect(check).toMatchObject({ object: "semanto.install_check", url: "https://acme.com/", checks: { markdown: "pass", signature: "pass", well_known: "pass" }, message: INSTALL_OK });
    expect(w.probes).toEqual(expect.arrayContaining(["https://acme.com/", "https://acme.com/.well-known/trooth.semanto", "https://acme.com/.well-known/trooth-keys.json"]));
    // A site whose cache still holds the previously signed copy is told so, not told a page changed.
    const keys = (await (await pub(w, "/acme/keys.json")).json()) as { keys: PublicJwk[] };
    const servedLike = { domain: "acme.com", homePageHash: `sha256:${"b".repeat(64)}`, pageHashes: [], networkCopy: await w.pipeline.networkCopy((await w.store.getCompany("acme"))!), resolveKey: (kid: string) => keys.keys.find((k) => k.kid === kid) ?? null, now: NOW };
    const probe = { fetch: (url: string, headers: Record<string, string>) => w.deps.siteProbe!(url, headers) };
    expect((await runInstallCheck({ ...servedLike, currentVersionId: "smv_newerversionaaaaaaaaaaaaaaaaa" }, probe)).messages.signature).toBe(INSTALL_MESSAGES.earlierVersion);
    const servedId = (await w.versions.getCurrent("acme"))!;
    expect((await runInstallCheck({ ...servedLike, currentVersionId: versionId(servedId.root_hash) }, probe)).messages.signature).toBe(INSTALL_MESSAGES.mismatch);
    expect(check.setup.next_action).toMatchObject({ label: "Start monitoring" });
    const started = await json(await call(w, "POST", "/acme/setup/monitoring", "Bearer ada", { questions: ["Does Acme Inc ship to Canada?"], competitors: [{ name: "Beta Ltd", domain: "beta.example" }] }));
    expect(started.step).toBe("done");
    expect(started.monitoring).toMatchObject({ questions: ["Does Acme Inc ship to Canada?"], competitors: [{ name: "Beta Ltd", domain: "beta.example" }] });
    expect(started.timings.full.spent_seconds).not.toBeNull();
    expect(started.timings.not_started).toEqual([]);
  });

  it("GET reports answers the newest gap report for the Watch page, and null before the first", async () => {
    const w = await world();
    await call(w, "POST", "/setup/start", "Bearer ada", {});
    const none = await json(await call(w, "GET", "/acme/reports", "Bearer cy"));
    expect(none).toEqual({ object: "semanto.reports", trooth_id: "acme", gap: null });
    expect((await call(w, "GET", "/acme/reports", "Bearer eve")).status).toBe(403);
    await call(w, "POST", "/acme/gap-report", "Bearer ada", {});
    const one = await json(await call(w, "GET", "/acme/reports", "Bearer cy"));
    expect(one.gap).toMatchObject({ object: "semanto.gap_report", trooth_id: "acme" });
  });

  it("the install check names each failure and its fix", async () => {
    const html = { status: 200, headers: { "content-type": "text/html" }, body: utf8("<html></html>") };
    const base = { domain: "acme.com", homePageHash: `sha256:${"a".repeat(64)}`, pageHashes: [], networkCopy: { semanto: utf8("{}"), keys: utf8('{"keys":[]}') }, resolveKey: () => null, now: NOW };
    const r1 = await runInstallCheck(base, { fetch: async () => null });
    expect(r1).toMatchObject({ reached: false, checks: { markdown: "fail", signature: "fail", well_known: "fail" }, message: INSTALL_MESSAGES.unreachable("acme.com") });
    const r2 = await runInstallCheck(base, { fetch: async () => html });
    expect(r2.messages.markdown).toBe(INSTALL_MESSAGES.html);
    const r3 = await runInstallCheck(base, { fetch: async (url) => (url.endsWith("/") ? { status: 200, headers: { "content-type": "text/markdown", "x-markdown-tokens": "12" }, body: utf8("# Hi") } : null) });
    expect(r3.messages.markdown).toBe(INSTALL_MESSAGES.cloudflare);
    expect(r3.messages.well_known).toBe(INSTALL_MESSAGES.wellKnownMissing);
  });
});

describe("setup modules: one proof record, Domain Connect, the DNS host, the diagnosis, host detection", () => {
  it("Domain Connect: ONBOARDED is empty; discovery offers the link only for an onboarded provider; the apply link is RS256-signed over its query", async () => {
    expect(ONBOARDED.size).toBe(0);
    const deps = { resolveTxt: async () => ["api.dns.example"], fetchJson: async () => ({ urlSyncUX: "https://dash.dns.example/domainconnect", providerName: "Fixture DNS", providerId: "fixturedns" }) };
    expect(await dcDiscover("acme.com", deps)).toMatchObject({ onboarded: false, providerId: "fixturedns" });
    expect(await dcDiscover("acme.com", { ...deps, onboarded: new Set(["fixturedns"]) })).toMatchObject({ onboarded: true, urlSyncUX: "https://dash.dns.example/domainconnect" });
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
    const url = await applyUrl({ urlSyncUX: "https://dash.dns.example/domainconnect", domain: "acme.com", challenge: ZERO_CHALLENGE, tid: "acme", fp: "A".repeat(43), redirectUri: "https://trooth.co/dashboard/semanto/setup", state: "s1", privateKeyPem: pem });
    expect(url.startsWith("https://dash.dns.example/domainconnect/v2/domainTemplates/providers/trooth.co/services/domainclaim/apply?")).toBe(true);
    const query = url.split("?")[1]!;
    const signed = query.slice(0, query.indexOf("&sig="));
    const sig = decodeURIComponent(/&sig=([^&]+)/.exec(query)![1]!);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), new TextEncoder().encode(signed));
    expect(ok).toBe(true);
    await expect(applyUrl({ urlSyncUX: "https://x", domain: "acme.com", challenge: "v=trooth1; claim=old", tid: "acme", fp: "A".repeat(43), redirectUri: "https://trooth.co/", state: "s", privateKeyPem: pem })).rejects.toThrow();
    expect(readReturn(new URLSearchParams("state=s1&error=access_denied&error_description=user_cancel"))).toEqual({ state: "s1", outcome: "cancelled" });
  });

  it("names the DNS host from NS records and writes its steps; diagnoses in plain words", () => {
    expect(hostFromNameservers(["ns1.domaincontrol.com"])?.name).toBe("GoDaddy");
    expect(hostFromNameservers(["ns.unknown.example"])).toBeNull();
    expect(nameToType("_trooth-challenge.acme.com", "acme.com")).toBe("_trooth-challenge");
    expect(manualSteps(UNKNOWN_HOST, "_trooth-challenge.acme.com", "acme.com")[2]).toContain("type _trooth-challenge");
    const base = { domain: "acme.com", expected: { name: "_trooth-challenge.acme.com", value: ZERO_CHALLENGE }, wellKnown: null, lookingSince: NOW.toISOString(), provenAt: null, claimedByAnotherWorkspace: false, now: NOW.getTime() };
    expect(diagnose({ ...base, resolvers: [{ resolver: "a", found: [], doubled: [] }] }).state).toBe("looking");
    expect(diagnose({ ...base, resolvers: [{ resolver: "a", found: [], doubled: [] }], now: NOW.getTime() + 73 * 3600_000 }).state).toBe("timed_out");
    expect(diagnose({ ...base, resolvers: [{ resolver: "a", found: [ZERO_CHALLENGE], doubled: [] }, { resolver: "b", found: [], doubled: [] }] }).state).toBe("propagating");
    expect(diagnose({ ...base, resolvers: [{ resolver: "a", found: [ZERO_CHALLENGE], doubled: [] }] }).state).toBe("proven");
    expect(diagnose({ ...base, resolvers: [{ resolver: "a", found: [`${ZERO_CHALLENGE} `.replace("=", "= ")], doubled: [] }] }).detail).toContain("extra spaces");
    for (const d of [diagnose({ ...base, resolvers: [] }), diagnose({ ...base, resolvers: [], provenAt: NOW.toISOString() })]) expect(`${d.title} ${d.detail}`).not.toMatch(/verif/i);
    expect(leftOutPlain([{ url: "u", reason: "robots.txt disallows this path" }, { url: "v", reason: "answered 503" }, { url: "x", reason: "canonical is https://acme.com/" }])).toEqual([
      { url: "u", reason: "Blocked by your robots.txt", code: "robots" },
      { url: "v", reason: "Server error (5xx)", code: "server_error" },
      { url: "x", reason: "Same page as another one", code: "duplicate" },
    ]);
  });

  it("detects Shopify, Squarespace, Wix and Webflow ahead of the CDN they sit behind; the DNS pointer check matches only the pointer", async () => {
    expect(classifyHost({ server: "cloudflare", "cf-ray": "1", "powered-by": "Shopify" }, "")).toMatchObject({ host: "shopify" });
    expect(classifyHost({ "cf-ray": "1" }, '<script src="https://cdn.shopify.com/s/x.js"></script>')).toMatchObject({ host: "shopify" });
    expect(classifyHost({ server: "Squarespace" }, "")).toMatchObject({ host: "squarespace" });
    expect(classifyHost({ "x-wix-request-id": "1" }, "")).toMatchObject({ host: "wix" });
    expect(classifyHost({ "x-served-by": "cache-ams-fastly" }, '<meta name="generator" content="Webflow">')).toMatchObject({ host: "webflow" });
    const fetchNone = async () => null;
    const proofOnly = await detectHost("acme.com", { fetch: fetchNone, dnsTxt: async () => [ZERO_CHALLENGE, "v=trooth1; claim=old-token-value-xyz"], networkCopy: { semanto: utf8(""), keys: utf8("") } }, NOW);
    expect(proofOnly.dns_pointer).toBe(false);
    const pointer = await detectHost("acme.com", { fetch: fetchNone, dnsTxt: async () => [pointerRecordValue("acme", "A".repeat(43))], networkCopy: { semanto: utf8(""), keys: utf8("") } }, NOW);
    expect(pointer.dns_pointer).toBe(true);
  });
});

// ------------------------------------------------------------------------ finding 4

describe("finding 4: a build in queue messages of at most 25 pages, holding no site in memory", () => {
  it("500 synthetic pages: each message reads at most 25 staged pages, and the assembled roots equal a one-shot build", { timeout: 180_000 }, async () => {
    const N = 499; // plus the home page: 500 pages, discovery's cap
    const site = new SiteHttp();
    const nav = `<nav><a href="/">Home</a> <a href="/p/1">One</a></nav>`;
    const footer = `<footer><p>Acme Inc is a fictional company used in Trooth fixtures.</p></footer>`;
    const filler = "Acme fixture text for a synthetic page. ".repeat(450);
    const page = (n: number) => `<!doctype html><html lang="en"><head><title>Fixture page ${n}</title></head><body>${nav}<main><h1>Fixture page ${n}</h1><p>This is synthetic fixture page number ${n} of Acme Inc.</p><p>${filler}</p></main>${footer}</body></html>`;
    site.set("https://acme.com/robots.txt", { body: "User-agent: *\nAllow: /\n", headers: { "content-type": "text/plain" } });
    const urls = ["https://acme.com/", ...Array.from({ length: N }, (_, i) => `https://acme.com/p/${i + 1}`)];
    site.set("https://acme.com/sitemap.xml", { body: `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`, headers: { "content-type": "application/xml" } });
    for (const [i, u] of urls.entries()) site.set(u, { body: page(i), headers: { "content-type": "text/html; charset=utf-8" } });
    const pageBytes = utf8(page(N)).length;
    expect(pageBytes).toBeGreaterThan(18_000);

    const w = await world({ queue: true, companies: [{ trooth_id: "acme", proven: true }] });
    (w.deps.site as { http: SiteHttp }).http = site;
    expect((await call(w, "POST", "/acme/build", "Bearer ada", {})).status).toBe(403); // not claimed by a workspace (QA-11)
    await w.store.linkOsCompany("acme", "co-acme");
    await w.store.registerOwner("acme", "u-ada");
    expect((await call(w, "POST", "/acme/build", "Bearer ada", {})).status).toBe(202);
    const stages: string[] = [];
    let renderSizes: number[] = [];
    let fannedOut = -1;
    while (w.queued.length) {
      const m = w.queued.shift()! as { kind?: string; stage?: string; from?: number; to?: number };
      if (m.kind === "stage") {
        stages.push(m.stage!);
        if (m.stage === "render") renderSizes.push(m.to! - m.from!);
      }
      await w.pipeline.jobs().compile(m);
      // The read hands every render batch to the queue at once, so they run side by side.
      if (m.stage === "discover") fannedOut = w.queued.length;
    }
    expect(fannedOut).toBe(Math.ceil(500 / PAGES_PER_MESSAGE));
    expect(stages[0]).toBe("discover");
    expect(stages.at(-1)).toBe("assemble");
    expect(stages.filter((x) => x === "assemble")).toHaveLength(1);
    expect(renderSizes).toHaveLength(Math.ceil(500 / PAGES_PER_MESSAGE));
    expect(Math.max(...renderSizes)).toBeLessThanOrEqual(PAGES_PER_MESSAGE);
    // The meter: HTML read back from staging in any one message is at most 25 pages, never the site.
    const total = [...w.staging.raw.values()].reduce((n, b) => n + b.length, 0);
    expect(w.staging.peakRawReadPerInvocation).toBeLessThanOrEqual(PAGES_PER_MESSAGE * pageBytes);
    expect(w.staging.peakRawReadPerInvocation).toBeLessThan(500 * pageBytes / 10);
    expect(total).toBe(0); // cleared after assembly
    const streamed = (await w.store.latestFile("acme"))!.file;
    expect(streamed.header.pages_manifest).toHaveLength(500);

    // The same pages built in one shot: equal roots.
    const build = (await w.staging.latestBuild("acme"))!;
    const fetcher = new Fetcher({ http: site, clock: { now: () => new Date(w.clock.now) } }, { minIntervalMs: 0 });
    const discovery = await discover("acme.com", fetcher);
    const fetched = Object.values(discovery.fetched).map((f) => ({ url: f.url, status: f.status, html: f.text, source_hash: f.source_hash, witnessed_at: f.fetchedAt, headers: f.headers, truncated: f.truncated }));
    const oneShot = await buildVersion({ org: build.job.org, identity: build.job.identity, profile: build.job.profile, version: 1, supersedes: null, built_at: build.job.requested_at, discovery, fetched, controls: build.job.controls ?? {} });
    expect(streamed.header.pages_root).toBe(oneShot.file.header.pages_root);
    expect(streamed.header.facts_root).toBe(oneShot.file.header.facts_root);
    expect(streamed.root_hash).toBe(oneShot.file.root_hash);
  });
});

describe("render batches side by side: one assembly per build", () => {
  it("a second assemble message for the same build does nothing, and a claim left by a stopped message is taken again after two minutes", async () => {
    const staging = new MemoryBuildStaging();
    const job = { trooth_id: "acme" } as never;
    await staging.createBuild({ build_id: "b1", trooth_id: "acme", job, status: "rendering" } as never);
    expect(await staging.claimAssemble("b1", NOW.toISOString(), 120_000)).toBe(true);
    expect(await staging.claimAssemble("b1", new Date(NOW.getTime() + 1_000).toISOString(), 120_000)).toBe(false);
    expect(await staging.claimAssemble("b1", new Date(NOW.getTime() + 121_000).toISOString(), 120_000)).toBe(true);
  });
});

// ------------------------------------------------------------------------ findings 5 and 6

async function signedWorld(): Promise<World> {
  const w = await world({ companies: [{ trooth_id: "acme", proven: true, os: "co-acme" }] });
  await w.store.registerOwner("acme", "u-ada");
  expect((await call(w, "POST", "/acme/build", "Bearer ada", {})).status).toBe(200);
  expect((await signHosted(w)).status).toBe(200);
  return w;
}

describe("finding 5: this Worker serves Trooth's witness keys, and the three CLIs read them here by default", () => {
  it("serves the witness JWK Set at both addresses, signed by the witness key, with earlier keys and their revocation honored", async () => {
    const w = await world();
    for (const path of ["/.well-known/trooth-keys.json", "/keys/trooth.json"]) {
      const r = await pub(w, path);
      expect(r.status).toBe(200);
      expect(r.headers.get("trooth-signed-by")).toBe("witness");
      const jwks = (await json(r)) as Jwks;
      expect(jwks.keys).toEqual([w.witnessPublic]);
      expect(jwks.keys.some((k) => "d" in k)).toBe(false);
    }
    const old = (await generateKeyPair()).publicJwk;
    const keys = new D1Keys(new FixtureD1().asD1(), new FixtureR2().asR2(), w.witness, undefined, [{ ...old, revoked_at: "2026-10-01T00:00:00.000Z" }]);
    const set = await keys.getWitnessPublicKeys();
    expect(set.keys.map((k) => k.kid)).toEqual([w.witnessPublic.kid, old.kid]);
    expect(set.keys[1]!.revoked_at).toBe("2026-10-01T00:00:00.000Z");
    expect(await keys.resolveTrooth(old.kid)).toMatchObject({ kid: old.kid });
  });

  it("the JavaScript, Python and Go CLIs default to https://api.trooth.co/public/semanto/.well-known/trooth-keys.json", () => {
    const js = readFileSync(join(ROOT, "verifier/js/cli.mjs"), "utf8");
    const py = readFileSync(join(ROOT, "verifier/python/trooth_semanto_verify/cli.py"), "utf8");
    const go = readFileSync(join(ROOT, "verifier/go/cmd/semanto-verify/main.go"), "utf8");
    expect(js).toContain('const TROOTH_KEYS_BASE = `${TROOTH_API}/public/semanto`;');
    expect(js).toContain("const troothBase = args.trooth ?? TROOTH_KEYS_BASE;");
    expect(py).toContain('TROOTH_KEYS_BASE = f"{TROOTH_API}/public/semanto"');
    expect(py).not.toContain("args.trooth or TROOTH_API}");
    expect(go).toContain('const troothKeysBase = troothAPI + "/public/semanto"');
    expect(go).toContain("troothBase = troothKeysBase");
    expect(readFileSync(join(ROOT, "verifier/README.md"), "utf8")).toContain("https://api.trooth.co/.well-known/trooth-keys.json");
  });
});

describe("finding 6: withdraw and revoke, logged, served, re-signed, and read by the three kits", () => {
  it("withdraws a version: 410 from then on, a revocation leaf, the served list, and the JS, Python and Go kits all read it as withdrawn", { timeout: 120_000 }, async () => {
    const w = await signedWorld();
    expect((await call(w, "POST", "/acme/build", "Bearer ada", {})).status).toBe(200);
    expect((await signHosted(w)).status).toBe(200);
    const v2 = (await w.versions.getVersion("acme", 2))!;
    expect((await call(w, "POST", "/acme/withdraw", "Bearer cy", { version: 2, reason: "Wrong prices." })).status).toBe(403);
    expect((await json(await call(w, "POST", "/acme/withdraw", "Bearer ada", { version: 2 }))).code).toBe("invalid_request");
    const r = await json(await call(w, "POST", "/acme/withdraw", "Bearer ada", { version: 2, reason: "Wrong prices on the pricing page." }));
    expect(r).toMatchObject({ object: "semanto.withdrawn", trooth_id: "acme", version: 2, revocations_url: `${API}/acme/revocations` });
    const versionId = r.version_id as string;
    const gone = await pub(w, "/acme/versions/2");
    expect(gone.status).toBe(410);
    expect((await json(gone)).code).toBe("semanto_withdrawn");
    expect((await w.versions.getCurrent("acme"))!.header.version).toBe(1);
    const leaf = await json(await pub(w, `/log/leaves/${r.log_index}`));
    expect(leaf.leaf).toMatchObject({ kind: "revocation", trooth_id: "acme", ref: versionId });
    const served = await json(await pub(w, "/acme/revocations"));
    expect(served.list.revocations).toEqual([{ kind: "version", ref: versionId, reason: "Wrong prices on the pricing page.", revoked_at: NOW.toISOString() }]);
    expect((await verifyRevocationList(served.jws, w.witnessPublic, NOW)).ok).toBe(true);
    expect((await json(await pub(w, "/revocations"))).list.revocations).toHaveLength(1);
    const keys = { company: { keys: [] }, trooth: { keys: [w.witnessPublic] } };
    // JavaScript kit.
    const js = await JSV.verifyRevocationList(served.jws, keys, { now: NOW });
    expect(js.ok).toBe(true);
    expect(JSV.stateOf(v2, new Date(NOW.getTime() + 1000), (js as { payload?: unknown }).payload)).toBe("withdrawn");
    // Python kit.
    const dir = mkdtempSync(join(tmpdir(), "semanto-served-"));
    const file = join(dir, "served.json");
    writeFileSync(file, JSON.stringify({ served, keys, now: new Date(NOW.getTime() + 1000).toISOString(), file: v2 }));
    const py = spawnSync("python3", ["-c", "import json,sys\nfrom trooth_semanto_verify.verify import verify_revocation_list, state_of\nd=json.load(open(sys.argv[1]))\nv=verify_revocation_list(d['served']['jws'], d['keys'], now=d['now'])\nprint(json.dumps({'ok': v['ok'], 'state': state_of(d['file'], d['now'], v.get('payload'))}))", file], { cwd: join(ROOT, "verifier/python"), env: { ...process.env, PYTHONPATH: join(ROOT, "verifier/python"), PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    // The Python and Go kits run only where their toolchains are installed; the kits' own suites cover them in CI.
    // Python counts as installed only with the kit's one dependency (cryptography): a Mac with python3 alone has none.
    const pyReady = spawnSync("python3", ["-c", "import cryptography"], { encoding: "utf8" }).status === 0;
    if (pyReady && (py.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      expect(py.stderr).toBe("");
      expect(JSON.parse(py.stdout)).toEqual({ ok: true, state: "withdrawn" });
    }
    // Go kit.
    const go = spawnSync("go", ["test", "./semanto/", "-run", "TestServedRevocationList", "-count=1", "-v"], { cwd: join(ROOT, "verifier/go"), env: { ...process.env, SEMANTO_SERVED_REVOCATIONS: file }, encoding: "utf8" });
    if ((go.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      expect(go.stdout).toContain("--- PASS: TestServedRevocationList");
      expect(go.status).toBe(0);
    }
  });

  it("revokes a key, backdated to compromised_at; refuses a future time and a missing reason; the nightly re-sign includes it", async () => {
    const w = await signedWorld();
    const kid = (await w.store.keys("acme"))[0]!.public_jwk.kid;
    const path = `/acme/keys/${kid}/revoke`;
    expect((await json(await call(w, "POST", path, "Bearer ada", {}))).code).toBe("invalid_request");
    expect((await json(await call(w, "POST", path, "Bearer ada", { reason: "Leaked.", compromised_at: "2027-01-01T00:00:00Z" }))).code).toBe("invalid_request");
    expect((await call(w, "POST", path, "Bearer cy", { reason: "Leaked." })).status).toBe(403);
    const r = await json(await call(w, "POST", path, "Bearer ada", { reason: "The laptop holding it was stolen.", compromised_at: "2026-10-20T08:00:00Z" }));
    expect(r).toMatchObject({ object: "semanto.key_revoked", kid, revoked_at: "2026-10-20T08:00:00.000Z" });
    const keys = await json(await call(w, "GET", "/acme/keys", "Bearer cy"));
    expect(keys.keys.find((k: any) => k.kid === kid)).toMatchObject({ state: "revoked", revoked_at: "2026-10-20T08:00:00.000Z" });
    const leaf = await json(await pub(w, `/log/leaves/${r.log_index}`));
    expect(leaf.leaf).toMatchObject({ kind: "revocation", ref: kid });
    advance(w, 86_400_000);
    await w.pipeline.nightlyCheckpoint();
    const list = await json(await pub(w, "/acme/revocations"));
    expect(list.list.issued_at).toBe(w.clock.now.toISOString());
    expect(list.list.revocations.map((e: any) => e.kind)).toEqual(["key"]);
  });
});

// ------------------------------------------------------------------------ finding 8

describe("finding 8: rate limits, receipts counted per minute, directory fetch limits", () => {
  it("answers 429 with Retry-After past a client's burst on a public route, per route group, and never limits /os", async () => {
    const limiter = new MemoryRateLimiter(() => NOW.getTime());
    const w = await signedWorld();
    const app = createApp({ ports: { ...w.ports, jobs: w.pipeline.jobs() }, rateLimit: limiter.hook(), authorize: async () => ({ trooth_id: "acme", role: "owner", user_id: "u-ada", name: "Ada" }) as WorkspaceAuth, workspace: w.pipeline });
    const ip = { "cf-connecting-ip": "198.51.100.7" };
    for (let i = 0; i < RATE_LIMITS.check.burst; i++) expect((await app.request(`${API}/verify?url=https://acme.com/&hash=x`, { headers: ip })).status).toBe(200);
    const limited = await app.request(`${API}/verify?url=https://acme.com/&hash=x`, { headers: ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
    expect((await json(limited)).code).toBe("rate_limited");
    expect(limited.headers.get("signature")).not.toBeNull();
    // Another group still has its own bucket; another client its own too; /os is not limited here.
    expect((await app.request(`${API}/acme`, { headers: ip })).status).toBe(200);
    expect((await app.request(`${API}/verify?url=https://acme.com/&hash=x`, { headers: { "cf-connecting-ip": "198.51.100.8" } })).status).toBe(200);
    for (let i = 0; i < 15; i++) expect((await app.request(`${OS}/acme/settings`, { headers: { ...ip, authorization: "Bearer x" } })).status).toBe(200);
    expect(take({ tokens: 0, updated_ms: 0 }, RATE_LIMITS.read, 500)).toMatchObject({ allowed: true });
  });

  it("counts receipts per minute in the RateLimitDO and writes one D1 row per key and minute, with the count", async () => {
    const d1 = new FixtureD1();
    const storage = new Map<string, unknown>();
    let alarm: number | null = null;
    const state = {
      storage: {
        get: async <T,>(k: string) => storage.get(k) as T | undefined,
        put: async (k: string, v: unknown) => void storage.set(k, structuredClone(v)),
        delete: async (keys: string[]) => keys.map((k) => storage.delete(k)).length,
        list: async <T,>({ prefix }: { prefix: string }) => new Map([...storage].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => void (alarm = t),
      },
    };
    const obj = new RateLimitDO(state, { DB: d1.asD1() });
    const ns: RateNamespace = { idFromName: (n) => n, get: () => ({ fetch: (input, init) => obj.fetch(new Request(input, init)) }) };
    const receipts = new CountedReceipts(ns, "fixture-receipt-salt-secret");
    const read = { trooth_id: "acme", version: 1, page_id: null, representation: "markdown" as const, agent_key_url: null, proof: "none" as const, address: "198.51.100.7" };
    for (const s of [1, 20, 59]) await receipts.record({ ...read, read_at: new Date(NOW.getTime() + s * 1000).toISOString() });
    await receipts.record({ ...read, read_at: new Date(NOW.getTime() + 61_000).toISOString() });
    expect(alarm).not.toBeNull();
    expect((d1.db.prepare("SELECT COUNT(*) AS n FROM semanto_read_receipts").get() as { n: number }).n).toBe(0);
    await obj.alarm();
    const rows = d1.db.prepare("SELECT read_at, count, ip_hash FROM semanto_read_receipts ORDER BY read_at").all() as { read_at: string; count: number; ip_hash: string }[];
    expect(rows.map((r) => [r.read_at, r.count])).toEqual([["2026-10-22T12:00:00.000Z", 3], ["2026-10-22T12:01:00.000Z", 1]]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash))).toBe(true);
    expect(storage.size).toBe(0);
    // A second flush for the same minute adds to the row instead of losing it.
    await receipts.record({ ...read, read_at: new Date(NOW.getTime() + 30_000).toISOString() });
    await obj.alarm();
    expect((d1.db.prepare("SELECT count FROM semanto_read_receipts WHERE read_at = '2026-10-22T12:00:00.000Z'").get() as { count: number }).count).toBe(4);
    const digestRows = await new D1ReceiptStore(d1.asD1()).list("acme", "2026-10-22T00:00:00.000Z", "2026-10-23T00:00:00.000Z");
    expect(digestRows.reduce((n, r) => n + (r.count ?? 1), 0)).toBe(5);
    expect((await minuteRow({ ...digestRows[0]!, read_at: "2026-10-22T12:00:42.123Z" })).read_at).toBe("2026-10-22T12:00:00.000Z");
  });

  it("does not fetch a Web Bot Auth key directory past the per-origin or per-client limit", async () => {
    const agent = await generateKeyPair();
    const http = new ReadersHttp({ [`https://agent.fixtureagent.com${DIRECTORY_PATH}`]: { status: 200, headers: {}, body: JSON.stringify({ keys: [agent.publicJwk] }) } });
    const nowS = Math.floor(NOW.getTime() / 1000);
    const seen: string[] = [];
    const deps = { http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => nowS, limit: async (key: string, group: string) => (seen.push(`${group}:${key}`), false) };
    const headers: Record<string, string> = { "signature-agent": '"https://agent.fixtureagent.com"', "cf-connecting-ip": "203.0.113.4" };
    const signed = await signMessage({ kind: "request", method: "GET", url: "https://acme.com/", headers }, agent.privateJwk, { components: ["@authority", "signature-agent"], created: nowS - 5, ttlSeconds: 60, nonce: "n-1", tag: "web-bot-auth" });
    const r = await verifyWebBotAuth({ method: "GET", url: "https://acme.com/", headers: { ...headers, ...signed } }, deps);
    expect(r).toMatchObject({ proven: false, reason: "directory_refused" });
    expect(http.calls).toEqual([]);
    expect(seen).toEqual(["directory_origin:https://agent.fixtureagent.com"]);
  });
});

// ------------------------------------------------------------------------ finding 9

describe("finding 9: every monitor fetch goes through the SSRF guard, https only, redirects by hand, 2 MB, a timeout", () => {
  it("refuses http, metadata and private addresses before fetching, re-checks each redirect hop, cuts the body at 2 MB and passes a signal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://hop.fixture-surface.com/feed") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      if (url === "https://big.fixture-surface.com/feed") return new Response(new Uint8Array(3 * 1024 * 1024));
      return new Response("ok");
    }) as unknown as typeof fetch;
    const port = guardedFetchPort({ fetchImpl, resolve: async () => ["93.184.216.34"] });
    await expect(port.get("http://fixture-surface.com/feed")).rejects.toThrow(/not_https/);
    await expect(port.get("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/link_local|metadata/);
    await expect(port.get("https://metadata.google.internal/")).rejects.toThrow(/metadata/);
    const privateResolve = guardedFetchPort({ fetchImpl, resolve: async () => ["10.0.0.7"] });
    await expect(privateResolve.get("https://rebinding.fixture-surface.com/")).rejects.toThrow(/private/);
    expect(calls).toEqual([]);
    await expect(port.get("https://hop.fixture-surface.com/feed")).rejects.toThrow(/not_https/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const big = await guardedGet("https://big.fixture-surface.com/feed", {}, { fetchImpl, resolve: async () => ["93.184.216.34"] });
    expect(big.body.length).toBe(2 * 1024 * 1024);
    expect(big.truncated).toBe(true);
    await expect(port.send!("https://evil.example/collect", { method: "POST", headers: {}, body: "{}" })).rejects.toThrow(/write-back sends only/);
  });

  it("a member's monitor run pointing a surface at the metadata address reads nothing from it", async () => {
    const w = await signedWorld();
    (w.deps.monitor as { fetch: unknown }).fetch = guardedFetchPort({ fetchImpl: (async () => new Response("secret")) as unknown as typeof fetch });
    const r = await json(await call(w, "POST", "/acme/monitor/run", "Bearer cy", { surfaces: { merchant_center: { url: "http://169.254.169.254/latest/meta-data/", format: "tsv" }, live_pages: false } }));
    expect(r.object).toBe("semanto.monitor_result");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

// ------------------------------------------------------------------------ the medium findings

describe("findings 10 to 18 (medium)", () => {
  it("finding 10: authenticated /os answers carry Cache-Control: private, no-store and only the dashboard origin", async () => {
    const w = await signedWorld();
    const r = await call(w, "GET", "/acme/settings", "Bearer ada");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe("https://trooth.co");
    expect((await w.app.request(`${OS}/acme/settings`, { method: "OPTIONS" })).headers.get("access-control-allow-origin")).toBe("https://trooth.co");
    expect((await pub(w, "/acme")).headers.get("cache-control")).toContain("public");
  });

  it("finding 11: a body over 5 MB is a 413 problem on the public check route and on every POST", async () => {
    const w = await signedWorld();
    const big = "x".repeat(5 * 1024 * 1024 + 10);
    const declared = await w.app.request(`${API}/first-publication/check`, { method: "POST", headers: { "content-length": String(big.length) }, body: big });
    expect(declared.status).toBe(413);
    const streamed = await w.app.request(`${OS}/acme/gap-report`, { method: "POST", headers: { authorization: "Bearer ada" }, body: new Blob([big]).stream(), duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await readCapped(new Request("https://x/", { method: "POST", body: "12345" }), 4)).toBeNull();
  });

  it("finding 12: the hourly cron queues one message per 25 companies; the weekly gap cron one per company, with the run's start", async () => {
    const companies = Array.from({ length: 60 }, (_, i) => ({ trooth_id: `co${i}`, proven: true }));
    const w = await world({ queue: true, companies });
    for (const c of companies) {
      await w.store.saveBuilt(c.trooth_id, { file: { header: { version: 1, pages_manifest: [], state: "signed" } } as unknown as SemantoFile, bodies: {}, original_tokens: {}, signed_at: NOW.toISOString() }, { llms: { llmsTxt: "", llmsFull: "", sitemapMd: "" }, jsonld: utf8("{}") });
      await w.store.markSigned(c.trooth_id, { header: { version: 1, pages_manifest: [], state: "signed" } } as unknown as SemantoFile, NOW.toISOString());
    }
    await w.pipeline.hourlyChangeDetection();
    expect(w.queued.map((m) => (m as { trooth_ids: string[] }).trooth_ids.length)).toEqual([25, 25, 10]);
    expect(w.site.log).toHaveLength(0);
    w.queued.length = 0;
    await w.pipeline.weeklyGapReports();
    // A report asks every question of every assistant, so a gap message carries one company (2026-10-29).
    expect(w.queued).toEqual(companies.map((c) => ({ kind: "companies", job: "gap", trooth_ids: [c.trooth_id], started_at: w.clock.now.toISOString() })));
  });

  it("ARCH-6: the nightly job re-signs revocation lists on the queue, 100 companies a message, and the consumer signs each", async () => {
    const companies = Array.from({ length: 250 }, (_, i) => ({ trooth_id: `rv${i}`, proven: true }));
    const w = await world({ queue: true, companies });
    await w.pipeline.nightlyCheckpoint();
    const revs = w.queued.filter((m) => (m as { job?: string }).job === "revocations") as { trooth_ids: string[] }[];
    expect(revs.map((m) => m.trooth_ids.length)).toEqual([100, 100, 50]);
    expect(w.store.revocationLists.filter((l) => l.trooth_id !== null)).toHaveLength(0);
    for (const m of revs) await w.pipeline.jobs().compile(m);
    expect(new Set(w.store.revocationLists.filter((l) => l.trooth_id !== null).map((l) => l.trooth_id)).size).toBe(250);
  });

  it("finding 13: basic/prove never compiles inside the request; it records the proof and queues the read", async () => {
    const w = await world({ queue: true });
    await w.store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "basic", current_version: null, custody: "hosted", domain_proven_at: null, os_company_id: "co-acme" });
    await w.store.registerOwner("acme", "u-ada");
    // Confirmed on trooth.co since the company was linked: prove reads it and queues the read.
    const r = await json(await call(w, "POST", "/acme/basic/prove", "Bearer ada", {}));
    expect(r.body.proved).toBe(true);
    expect(w.site.log).toHaveLength(0);
    expect(w.queued).toEqual([expect.objectContaining({ kind: "stage", stage: "discover" })]);
  });

  it("finding 14: without a witness key the Worker still answers: a 503 problem where it must sign, the rest working; a dead letter queue is configured", async () => {
    const w = await signedWorld();
    const keys: KeyPort = { ...w.ports.keys, getWitnessKey: async () => { throw new WitnessKeyMissingError(); }, getWitnessPublicKeys: async () => ({ keys: [] }), getCompanyJwks: (id) => w.ports.keys.getCompanyJwks(id), getCompanySigningKey: (id) => w.ports.keys.getCompanySigningKey(id), resolveCompany: (a, b) => w.ports.keys.resolveCompany(a, b), resolveTrooth: async () => null };
    const app = createApp({ ports: { ...w.ports, keys } });
    const head = await app.request(`${API}/log/tree-head`);
    expect(head.status).toBe(503);
    expect(head.headers.get("signature")).toBeNull();
    expect((await json(head)).code).toBe("witness_key_missing");
    // A hosted company's page is signed with its own key and still served.
    const file = (await w.versions.getCurrent("acme"))!;
    expect((await app.request(`${API}/acme/pages/${file.header.pages_manifest[0]!.id}`, { headers: { accept: "text/markdown" } })).status).toBe(200);
    expect((await app.request(`${API}/acme`, { method: "OPTIONS" })).status).toBe(204);
    const p = new Pipeline({ ...w.deps, keys });
    const sign = await p.handle("withdraw", { trooth_id: "acme", role: "owner", user_id: "u-ada", name: "Ada" }, "acme", { version: 1, reason: "Test." });
    expect(sign.problem?.code).toBe("witness_key_missing");
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    expect(toml.match(/dead_letter_queue = "trooth-semanto-compile-dlq"/g)).toHaveLength(2);
    expect(readFileSync(join(ROOT, "src/index.ts"), "utf8")).not.toContain("throw new Error(\"TROOTH_WITNESS_KEY");
  });

  it("finding 15: the modules marked built are reached through routes (write-back, detection, keys, competitor report, receipts, Content Signals drift, sellers, nested catalogs, synonyms)", async () => {
    const w = await signedWorld();
    expect(await json(await call(w, "GET", "/acme/writeback", "Bearer cy"))).toMatchObject({ object: "semanto.writeback_preview", trooth_id: "acme" });
    expect(await json(await call(w, "POST", "/acme/detect", "Bearer cy", {}))).toMatchObject({ domain: "acme.com" });
    expect(await json(await call(w, "GET", "/acme/keys", "Bearer cy"))).toMatchObject({ object: "semanto.keys", binding: { level: "trooth_hosted_only" } });
    const comp = await call(w, "POST", "/acme/competitor-report", "Bearer cy", { kind: "local", competitors: [{ name: "Beta Ltd", domain: "beta.example" }] });
    expect(await json(comp)).toMatchObject({ object: "semanto.competitor_report", view: { object: "semanto.competitor_view" } });
    const rec = w.deps.receiptStore as MemoryReceiptStore;
    rec.rows.push({ id: "smd_aaaaaaaaaaaaaaaaaaaaaaaaaa", trooth_id: "acme", version: 1, page_id: null, representation: "markdown", agent_key_url: null, keyid: null, proof: "none", read_at: "2026-10-21T10:00:00.000Z", ip_hash: "a".repeat(64), count: 3 });
    const digestDoc = await json(await call(w, "GET", "/acme/receipts?day=2026-10-21", "Bearer cy"));
    expect(digestDoc.digest.total).toBe(3);
    expect((await verifyRevocationList(digestDoc.jws, w.witnessPublic, NOW)).ok).toBe(false); // a digest, not a revocation list: the type is checked
    expect((await JSV.verifyJws(digestDoc.jws, (kid: string) => (kid === w.witnessPublic.kid ? w.witnessPublic : null), { expectTyp: "https://trooth.co/types/read-receipt", at: NOW })).ok).toBe(true);
    const csv = await call(w, "GET", "/acme/receipts.csv?from=2026-10-21T00:00:00Z&to=2026-10-22T00:00:00Z", "Bearer cy");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect((await csv.text()).split("\r\n")[0]).toContain(",count");
    const run = await json(await call(w, "POST", "/acme/monitor/run", "Bearer cy", { surfaces: { live_pages: false } }));
    expect(run.content_signals).toHaveProperty("signed");
    expect(await json(await pub(w, "/acme/sellers?domain=shop.example&sku=ANV-100"))).toMatchObject({ object: "semanto.seller_authorization", state: "not_listed" });
    expect(await json(await pub(w, "/acme/synonyms?name=vitamin c"))).toMatchObject({ object: "semanto.synonyms" });
    const check = await w.app.request(`${API}/catalogs/check`, { method: "POST", body: JSON.stringify({ jws: "a.b.c" }) });
    expect(check.status).toBe(200);
    expect((await json(check)).ok).toBe(false);
  });

  it("finding 17: the API honors the delivery settings: a format off is a 404 problem; a changed page follows when_page_changed", async () => {
    const w = await signedWorld();
    const file = (await w.versions.getCurrent("acme"))!;
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const settings = (await json(await call(w, "GET", "/acme/settings", "Bearer ada"))) as any;
    const off = await call(w, "POST", "/acme/settings", "Bearer ada", { ...settings, host: "cloudflare", where: { ...settings.where, own_domain: true }, markdown_source: "cloudflare_format_semanto_proof_only", formats: { ...settings.formats, markdown: false, llms: false, jsonld: false } });
    expect([off.status, off.status === 200 ? null : (await json(off)).issues]).toEqual([200, null]);
    for (const path of [`/acme/pages/${entry.id}.md`, "/acme/llms.txt", "/acme/facts.jsonld", `/acme/pages/${entry.id}.jsonld`]) {
      const r = await pub(w, path);
      expect([path, r.status, (await json(r)).code]).toEqual([path, 404, "representation_not_offered"]);
    }
    await call(w, "POST", "/acme/settings", "Bearer ada", { ...settings, when_page_changed: "serve_live_marked_unsigned" });
    w.versions.companies.get("acme")!.live.set(entry.id, "behind");
    const r = await pub(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://acme.com/about");
    expect(r.headers.get("trooth-semanto-state")).toBe("unsigned");
    expect(r.headers.get("signature-input")).toContain('"trooth-semanto-state"');
    await call(w, "POST", "/acme/settings", "Bearer ada", { ...settings, when_page_changed: "prompt_to_sign" });
    const behind = await pub(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" });
    expect(behind.headers.get("trooth-semanto-state")).toBe("behind");
  });

  it("finding 18: the production page fetch passes a 15-second abort signal", async () => {
    let seen: RequestInit | undefined;
    const http = new WebFetchHttp((async (_u: string, init: RequestInit) => ((seen = init), new Response("hi"))) as unknown as typeof fetch);
    await http.request({ url: "https://acme.com/", method: "GET", headers: {}, maxBytes: 100 });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.redirect).toBe("manual");
  });
});

// ------------------------------------------------------------------------ the low findings

describe("findings 19 to 26 (low)", () => {
  it("finding 19: migration 0005 seeds the log frontier, so no reader writes it", () => {
    const d1 = new FixtureD1();
    expect(d1.db.prepare("SELECT id, size, nodes FROM semanto_log_frontier").all()).toEqual([{ id: 1, size: 0, nodes: "[]" }]);
  });

  it("finding 20: malformed percent-encoding is a signed 400 problem, never an unsigned 500", async () => {
    const w = await signedWorld();
    const r = await pub(w, "/acme/offers/%E0%A4%A");
    expect(r.status).toBe(400);
    expect(r.headers.get("signature")).not.toBeNull();
    expect((await json(r)).code).toBe("invalid_request");
    expect(safeDecode("%E0%A4%A")).toBeNull();
  });

  it("finding 21: the only X- names are the two token headers, and the docs say so", async () => {
    const w = await signedWorld();
    const file = (await w.versions.getCurrent("acme"))!;
    const r = await pub(w, `/acme/pages/${file.header.pages_manifest[0]!.id}`, { accept: "text/markdown" });
    const xNames: string[] = [];
    r.headers.forEach((_v, k) => {
      if (/^x-/i.test(k)) xNames.push(k);
    });
    expect(xNames.sort()).toEqual(["x-markdown-tokens", "x-original-tokens"]);
    for (const doc of ["docs/ARCHITECTURE.md", "docs/REQUIREMENTS-TRACEABILITY.md", "docs/reports/adapters.md"]) {
      const s = readFileSync(join(ROOT, doc), "utf8");
      expect([doc, /no X- names|no `X-` prefixed header/.test(s)]).toEqual([doc, false]);
    }
    expect(readFileSync(join(ROOT, "docs/ARCHITECTURE.md"), "utf8")).toContain("Those two token headers are the only X- names");
  });

  it("finding 26: one busy agent key spreads its nonces over several Durable Objects, and a nonce always lands in the same one", () => {
    const shards = new Set(Array.from({ length: 200 }, (_, i) => nonceShard(`kid-busy:nonce-${i}`)));
    expect(shards.size).toBe(NONCE_SHARDS_PER_KEY);
    expect([...shards].every((s) => s.startsWith("nonces:kid-busy:"))).toBe(true);
    expect(nonceShard("kid-busy:nonce-7")).toBe(nonceShard("kid-busy:nonce-7"));
  });

  it("finding 26: reserved route names are never given as a Trooth ID, and a plain wrangler deploy is not production", async () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    expect(toml).toMatch(/^name = "trooth-semanto-worker-dev"/m);
    for (const name of ["log", "verify", "first-publication"]) {
      const w = await world();
      DOMAINS["co-acme"] = [confirmed(`${name}.example`)];
      expect((await json(await call(w, "POST", "/claim", "Bearer ada", { domain: `${name}.example`, org: "Fixture" }))).trooth_id).toBe(`${name}-example`);
    }
  });

  it("finding 23: the stray forged files are gone from the root", () => {
    expect(existsSync(join(ROOT, "forged-file.json"))).toBe(false);
    expect(existsSync(join(ROOT, "forged-page.md"))).toBe(false);
  });

  it("finding 24: the adapter vouches only for the platform's own client address, never a header the client sent", async () => {
    const spoofed = new Request("https://acme.com/", { headers: { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "1.2.3.4", "True-Client-IP": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4" } });
    expect(clientAddress(spoofed, { troothId: "acme" } as never)).toBe("");
    expect(clientAddress(spoofed, { troothId: "acme", clientAddress: "203.0.113.9" } as never)).toBe("203.0.113.9");
    expect(readFileSync(join(ROOT, "adapters/cloudflare-worker/src/index.ts"), "utf8")).toContain('clientAddress: request.headers.get("CF-Connecting-IP")');
  });

  it("finding 25: an agent that signs @path is proven through an adapter that forwards and signs Trooth-Forwarded-Path; a replayed forwarding is not trusted twice", async () => {
    const agent = await generateKeyPair();
    const connector = await generateConnectorKey();
    const nowS = Math.floor(NOW.getTime() / 1000);
    const http = new ReadersHttp({ [`https://agent.fixtureagent.com${DIRECTORY_PATH}`]: { status: 200, headers: {}, body: JSON.stringify({ keys: [agent.publicJwk] }) } });
    const nonces = new MemoryNonceStore();
    const deps = { http, cache: new MemoryKeyCache(), nonces, now: () => nowS };
    const ctx = { domain: "acme.com", connectorKeys: [connector.publicJwk as unknown as PublicJwk] };
    const agentHeaders: Record<string, string> = { accept: "text/markdown", "signature-agent": '"https://agent.fixtureagent.com"' };
    const agentSig = await signMessage({ kind: "request", method: "GET", url: "https://acme.com/pricing?x=1", headers: agentHeaders }, agent.privateJwk, { components: ["@authority", "@path", "signature-agent"], created: nowS - 5, ttlSeconds: 60, nonce: "agent-path-1", tag: "web-bot-auth" });
    const request = new Request("https://acme.com/pricing?x=1", { headers: { ...agentHeaders, ...agentSig } });
    const decision = { serve: true as const, kind: "page" as const, representation: null, url: `${API}/acme/by-path/pricing` };
    const fwd = await forwardingHeaders(decision, request, { troothId: "acme", connectorKey: connector.privateJwk, clientAddress: "203.0.113.9", now: () => nowS } as never);
    expect(fwd.get("Trooth-Forwarded-Path")).toBe("/pricing?x=1");
    const h: Record<string, string> = {};
    fwd.forEach((v: string, k: string) => (h[k] = v));
    const proof = await proveReader({ method: "GET", url: decision.url, headers: h }, deps, ctx);
    expect(proof).toMatchObject({ proven: true, via_adapter: true, address: "203.0.113.9" });
    // The same forwarded request again: its connector nonce was claimed, so the vouched address is not used twice.
    const again = await proveReader({ method: "GET", url: decision.url, headers: h }, deps, ctx);
    expect(again.via_adapter).toBeUndefined();
    // Without the forwarded path the API path is used as @path, and the agent is not proven through the adapter.
    const noPath = { ...h };
    delete noPath["trooth-forwarded-path"];
    const nonces2 = new MemoryNonceStore();
    expect((await proveReader({ method: "GET", url: decision.url, headers: noPath }, { ...deps, nonces: nonces2 }, ctx)).proven).toBe(false);
  });

  it("the verifier kit is open source: Apache-2.0 for verifier/ only, said in its README; a Basic page proof can be accepted knowingly without a company signature", async () => {
    expect(readFileSync(join(ROOT, "verifier/LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(ROOT, "verifier/README.md"), "utf8")).toContain("open source under the Apache License 2.0");
    expect(readFileSync(join(ROOT, "verifier/js/verify.mjs"), "utf8").startsWith("// SPDX-License-Identifier: Apache-2.0")).toBe(true);
    expect(readFileSync(join(ROOT, "src/pipeline.ts"), "utf8").startsWith("// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary")).toBe(true);
    expect(readFileSync(join(ROOT, "verifier/README.md"), "utf8")).not.toContain("without trusting Trooth's servers");
    expect(readFileSync(join(ROOT, "docs/spec/log.md"), "utf8")).toContain("When `TSA_URL` is set");
    expect(readFileSync(join(ROOT, "web/semanto/key-binding-panel.tsx"), "utf8")).not.toContain("Both have to agree");
    // A Basic page: witnessed, not signed. Strict fails with signature_absent; allowUnsigned passes with the reason shown.
    const w = await world();
    await call(w, "POST", "/claim", "Bearer ada", { domain: "acme.com", org: "Acme Inc" });
    await call(w, "GET", "/acme/setup", "Bearer ada");
    const file = (await w.versions.getCurrent("acme"))!;
    const entry = file.header.pages_manifest[0]!;
    const proof = await json(await pub(w, `/acme/pages/${entry.id}/proof`));
    const page = (await w.versions.getPage("acme", entry.id))!.bytes;
    const keys = { company: { keys: [] }, trooth: { keys: [w.witnessPublic] } };
    const strict = await JSV.verifyPageProof(proof, page, keys, { now: NOW, header: file.header, allowUnlogged: true });
    expect(strict.ok).toBe(false);
    expect(strict.checks.find((c: any) => c.name === "company_signature")).toMatchObject({ ok: false, detail: "The proof carries no company signature." });
    const basic = await JSV.verifyPageProof(proof, page, keys, { now: NOW, header: file.header, allowUnlogged: true, allowUnsigned: true });
    expect(basic.checks.find((c: any) => c.name === "company_signature")?.ok).toBe(true);
    expect(basic.ok).toBe(true);
  });
});
