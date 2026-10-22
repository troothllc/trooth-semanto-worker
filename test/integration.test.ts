// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Integration tests: the modules wired into one Worker through src/pipeline.ts
// and src/serve/routes.ts, with in-memory ports only. The company is the
// fictional Acme Inc (acme.com) from test/fixtures/compiler; every other
// fixture is under test/fixtures/integration and is named as a fixture. No
// figure here is a measurement.
//
// The end-to-end test builds a version from the fixture site, signs it with a
// hosted key, witnesses and logs it, serves a page as markdown through the Hono
// app, checks the response signature (RFC 9421), the page proof with
// src/serve/proof.ts and the standalone verifier/js/verify.mjs, the log
// inclusion proof against the signed tree head, byte-identical answers for two
// user agents, and then the monitor and the gap report against the same
// record, so the fact keys are shown to be shared end to end.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { utf8, toBase64Url } from "@/core/encoding";
import { digest, digestBytes } from "@/core/hash";
import { generateKeyPair, importPrivate, sign as rawSign, type Jwks, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { signMessage, verifyContentDigest, verifyMessage, SEMANTO_RESPONSE_COMPONENTS } from "@/core/httpsig";
import { canonicalFactKey } from "@/core/fact-keys";
import type { SemantoFile } from "@/core/semanto";
import { MemoryHttp as SiteHttp } from "@/compiler/ports";
import { MemoryVersionStore, memoryPorts, TEST_CONFIG, MemoryReceipts } from "@/serve/memory-ports";
import { createApp, runScheduled, prefersPlainText, type RouteDeps } from "@/serve/routes";
import { verifyProof, type PageProof } from "@/serve/proof";
import type { WorkspaceAuth } from "@/serve/ports";
import { hashLeaf, MemoryFetch, type LogLeaf } from "@/ledger/ports";
import { verifyCheckpoint, verifyConsistencyDigests, verifyInclusionDigests, verifyTreeHead, LOG_SIGNER_NAME } from "@/ledger/log";
import { buildTestTimeStampResponse, decodeTimeStampRequest } from "@/ledger/timestamp";
import { verifyRevocationList } from "@/ledger/revocation";
import { MemoryHttp as IdentityHttp, } from "@/identity/ports";
import { GLEIF_BASE } from "@/identity/lei";
import { MemoryHttp as ReadersHttp, MemoryKeyCache, MemoryNonceStore, MemoryReceiptStore } from "@/readers/ports";
import { DIRECTORY_PATH } from "@/readers/webbotauth";
import { fetchFromMap, memoryStore } from "@/monitor/ports";
import { InMemoryCommerceStore } from "@/commerce/ports";
import { verifyOffer } from "@/commerce/offers";
import type { ProviderAdapter } from "@/gap/providers";
import { WEEKLY_RUN } from "@/gap/report";
import { memoryDomainProof } from "@/basic/ports";
import { verifyFirstPublication } from "@/basic/first-publication";
import { dnsClaimName, dnsClaimRecord, WITNESSED_NOT_SIGNED } from "@/basic/tier";

/** An inclusion proof from the public log, checked with the ledger's own RFC 6962 code. */
async function V_core_inclusion(p: { index: number; tree_size: number; leaf_hash: string; root_hash: string; path: string[] }): Promise<boolean> {
  const { digestBytes: db } = await import("@/core/hash");
  return verifyInclusionDigests(db(p.leaf_hash), p.index, p.tree_size, p.path, p.root_hash);
}
import { MemoryPipelineStore } from "@/pipeline-store";
import { Pipeline, ReaderReceipts, troothOsAuthorize, webBotAuthReaders, withCompanies, type PipelineDeps, type ServiceFetcher } from "@/pipeline";
import type { CompileJob, QueueMessage } from "@/env";
import { openPrivateJwk, sealPrivateJwk } from "@/db/key-seal";
import { catalogToInputs } from "@/pipeline";
import { D1BuildStaging, D1CommerceStore, D1Keys, D1MonitorStore, D1PipelineStore, D1ReceiptStore, D1Settings, D1VersionStore } from "@/db/d1";
import { D1LogStore } from "@/ledger/store-d1";
import { TransparencyLog } from "@/ledger/log";
import { LedgerLogPort } from "@/serve/ledger-port";
import { FixtureD1, FixtureR2 } from "./fixtures/integration/fixture-d1-shim";
import * as JSV from "../verifier/js/verify.mjs";
import { signPost, generateConnectorKey } from "../adapters/shared/sign-request.mjs";
import { BANNED_WORDS, ELLIPSIS } from "./helpers/house-rules";
import { PasskeyWallet, passkeySign } from "./helpers/passkey";

const COMPILER = fileURLToPath(new URL("./fixtures/compiler/", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/integration/", import.meta.url));
const readCompiler = (name: string) => readFileSync(COMPILER + name, "utf8");
const readFix = (name: string) => readFileSync(FIX + name, "utf8");

const NOW = new Date("2026-10-22T12:00:00.000Z");
const API = TEST_CONFIG.public_api_base; // https://api.trooth.co/public/semanto
const OS = "https://api.trooth.co/os/semanto";
const MC_URL = "https://merchant-feed.fixture.test/acme.tsv";
const BP_URL = "https://business-profile.fixture.test/locations/fixture-acme";

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

const WORKSPACES: Record<string, WorkspaceAuth> = {
  "Bearer owner-token": { trooth_id: "acme", role: "owner", user_id: "u-ada", name: "Ada Owner" },
  "Bearer admin-token": { trooth_id: "acme", role: "admin", user_id: "u-bo", name: "Bo Admin" },
  "Bearer member-token": { trooth_id: "acme", role: "member", user_id: "u-cy", name: "Cy Member" },
  "Bearer beta-token": { trooth_id: "beta", role: "owner", user_id: "u-di", name: "Di Owner" },
};

function gapAnswers(): ProviderAdapter[] {
  const answers = JSON.parse(readFix("fixture-gap-answers.json")) as Record<string, { answer_text: string; citations: { url: string }[] }>;
  return [
    {
      provider: "openai",
      missing: () => null,
      ask: async (q: string) => {
        const a = answers[q];
        return { provider: "openai", model: "fixture-model", answer_text: a?.answer_text ?? "", citations: a?.citations ?? [], asked_at: NOW.toISOString(), raw: null };
      },
    },
  ];
}

interface World {
  clock: { now: Date };
  witness: PrivateJwk;
  witnessPublic: PublicJwk;
  versions: MemoryVersionStore;
  ports: ReturnType<typeof memoryPorts>;
  store: MemoryPipelineStore;
  site: SiteHttp;
  pipeline: Pipeline;
  app: ReturnType<typeof createApp>;
  deps: PipelineDeps;
  queued: QueueMessage[];
  receiptRows: MemoryReceiptStore;
  agent: { priv: PrivateJwk; pub: PublicJwk };
  /** One software passkey per workspace token (test/helpers/passkey.ts). */
  wallet: PasskeyWallet;
}

async function world(opts: { custody?: "hosted" | "customer"; trooth_id?: string; company?: boolean; queue?: boolean; tsa?: boolean; random?: (n: number) => Uint8Array } = {}): Promise<World> {
  const clock = { now: new Date(NOW) };
  const now = () => new Date(clock.now);
  const w = await generateKeyPair();
  const versions = new MemoryVersionStore();
  const ports = memoryPorts(versions, w.privateJwk, { now });
  const store = new MemoryPipelineStore(versions);
  const trooth_id = opts.trooth_id ?? "acme";
  // A company that proved its domain (nothing is built for publication, signed or served before that).
  if (opts.company !== false) await store.putCompany({ trooth_id, domain: "acme.com", org: "Acme Inc", tier: "full", legal_name: "Acme Inc", current_version: null, custody: opts.custody ?? "hosted", domain_proven_at: NOW.toISOString() });
  const site = fixtureSite();
  const commerce = withCompanies(new InMemoryCommerceStore(), store, API);
  const livePages: Record<string, string> = {};
  for (const [url, file] of Object.entries(SITE_PAGES)) livePages[url] = readCompiler(file);
  const monitorFetch = fetchFromMap({
    ...livePages,
    "https://acme.com/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: readCompiler("robots.txt") },
    [MC_URL]: { status: 200, headers: { "content-type": "text/tab-separated-values" }, body: readFix("fixture-merchant-center.tsv") },
    [BP_URL]: { status: 200, headers: { "content-type": "application/json" }, body: readFix("fixture-business-profile.json") },
  });
  const gleif = `${GLEIF_BASE}5493001KJTIIGC8Y1R12`;
  const identityHttp = new IdentityHttp({
    [gleif]: {
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: {
          type: "lei-records",
          id: "5493001KJTIIGC8Y1R12",
          attributes: {
            lei: "5493001KJTIIGC8Y1R12",
            entity: { legalName: { name: "Acme Fixture Inc", language: "en" }, legalAddress: { country: "US" }, headquartersAddress: { country: "US" }, status: "ACTIVE", jurisdiction: "US-AZ" },
            registration: { status: "ISSUED", lastUpdateDate: "2026-01-02T00:00:00Z", nextRenewalDate: "2027-01-02T00:00:00Z" },
          },
        },
      }),
    },
  });
  const queued: QueueMessage[] = [];
  const tsa = opts.tsa
    ? {
        url: "https://tsa.fixture.test/",
        fetch: new MemoryFetch((_url, init) => {
          const req = decodeTimeStampRequest(init.body!);
          const nonce = req.nonce_hex ? Uint8Array.from(req.nonce_hex.match(/../g)!.map((h) => parseInt(h, 16))) : undefined;
          return { status: 200, headers: { "content-type": "application/timestamp-reply" }, body: buildTestTimeStampResponse({ imprint: req.imprint, ...(nonce ? { nonce } : {}), genTime: now() }) };
        }),
      }
    : undefined;
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
    monitor: { fetch: monitorFetch, store: memoryStore() },
    identity: { http: identityHttp },
    // The proof value a zero random source gives (src/basic/tier.ts newChallenge).
    domainProof: memoryDomainProof({ txt: { [dnsClaimName("acme.com")]: [dnsClaimRecord(`trooth-domain-challenge=${"00".repeat(24)}`)] } }),
    ...(tsa ? { tsa } : {}),
    gapAdapters: gapAnswers,
    ...(opts.queue ? { enqueue: async (job: QueueMessage) => void queued.push(job) } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    // Review finding 19: catalog nonces are claimed once (the NonceDO in the Worker).
    nonces: new MemoryNonceStore(),
  };
  const pipeline = new Pipeline(deps);

  // A fixture agent whose key directory the readers module fetches (Web Bot Auth).
  const agentKey = await generateKeyPair();
  const readersHttp = new ReadersHttp({
    [`https://agent.fixtureagent.com${DIRECTORY_PATH}`]: { status: 200, headers: { "content-type": "application/http-message-signatures-directory+json" }, body: JSON.stringify({ keys: [agentKey.publicJwk] }) },
  });
  const receiptRows = new MemoryReceiptStore();
  const routeDeps: RouteDeps = {
    ports: { ...ports, receipts: new ReaderReceipts(receiptRows, "fixture-receipt-salt-secret"), jobs: pipeline.jobs() },
    readers: webBotAuthReaders({ http: readersHttp, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => Math.floor(now().getTime() / 1000) }),
    authorize: async (req) => WORKSPACES[req.headers.get("authorization") ?? ""] ?? null,
    workspace: pipeline,
    commerce,
    firstPublications: { get: (id) => store.getFirstPublication(id) },
  };
  const app = createApp(routeDeps);
  return { clock, witness: w.privateJwk, witnessPublic: w.publicJwk, versions, ports, store, site, pipeline, app, deps, queued, receiptRows, agent: { priv: agentKey.privateJwk, pub: agentKey.publicJwk }, wallet: new PasskeyWallet() };
}

const post = (w: World, path: string, body: unknown, token = "Bearer owner-token") =>
  w.app.request(`${OS}${path}`, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
/** Hosted signing, as the wizard does it: sign/options (adding a passkey first), the assertion, then sign. */
const signHosted = (w: World, trooth_id = "acme", token = "Bearer owner-token", body: Record<string, unknown> = {}) => passkeySign((path, b, t) => post(w, path, b, t), trooth_id, token, w.wallet, body);
const get = (w: World, path: string, headers: Record<string, string> = {}) => w.app.request(`${API}${path}`, { headers });
const settle = () => new Promise((r) => setTimeout(r, 10));
/** Run every queued message, and the messages they queue, as the queue consumer would. */
async function drain(w: World): Promise<void> {
  while (w.queued.length) await w.pipeline.jobs().compile(w.queued.shift());
}

async function buildAndSign(w: World, trooth_id = "acme"): Promise<{ file: SemantoFile; signed: Record<string, any> }> {
  const built = await post(w, `/${trooth_id}/build`, {});
  expect(built.status).toBe(200);
  const signed = await signHosted(w, trooth_id);
  expect(signed.status).toBe(200);
  const s = await json(signed);
  const file = (await w.versions.getCurrent(trooth_id))!;
  return { file, signed: s };
}

// ------------------------------------------------------------------------ 1. the log leaf

describe("1. one log leaf format: the ledger's", () => {
  it("serve's verifyProof accepts the verifier kit's page-proof vector, which carries the ledger leaf record", async () => {
    const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../verifier/test-vectors/v1/page-proof.json", import.meta.url)), "utf8"));
    const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../verifier/test-vectors/v1/keys.json", import.meta.url)), "utf8"));
    const companyKeys: PublicJwk[] = keys.company.jwks.keys;
    const troothKeys: PublicJwk[] = keys.trooth.jwks.keys;
    const v = await verifyProof(vector.proof as PageProof, utf8(vector.page_markdown), { header: vector.header, resolveCompanyKey: (kid) => companyKeys.find((k) => k.kid === kid) ?? null, resolveTroothKey: (kid) => troothKeys.find((k) => k.kid === kid) ?? null, at: new Date(vector.now) });
    expect(v.failures).toEqual([]);
    expect(v.checks.ledger_leaf).toBe("ok");
    expect(v.ok).toBe(true);
  });

  it("fails a proof whose leaf record was changed, or that carries no leaf record", async () => {
    const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../verifier/test-vectors/v1/page-proof.json", import.meta.url)), "utf8"));
    const wrong = structuredClone(vector.proof) as PageProof;
    wrong.ledger!.leaf.hash = await digest("another root");
    expect((await verifyProof(wrong, utf8(vector.page_markdown))).checks.ledger_leaf).toBe("failed");
    const notVersion = structuredClone(vector.proof) as PageProof;
    notVersion.ledger!.leaf.kind = "witness";
    expect((await verifyProof(notVersion, utf8(vector.page_markdown))).checks.ledger_leaf).toBe("failed");
    const none = structuredClone(vector.proof) as { ledger: Record<string, unknown> };
    delete none.ledger.leaf;
    expect((await verifyProof(none as unknown as PageProof, utf8(vector.page_markdown))).checks.ledger_leaf).toBe("failed");
  });
});

// ------------------------------------------------------------------------ 5. end to end

describe("5. end to end: build, sign, witness, log, serve, verify", () => {
  let w: World;
  let file: SemantoFile;
  let signed: Record<string, any>;
  let jwks: Jwks;
  beforeAll(async () => {
    w = await world();
    ({ file, signed } = await buildAndSign(w));
    jwks = (await json(await get(w, "/acme/keys.json"))) as Jwks;
  });

  it("builds from the fixture site into state read, then signs with the hosted key into state signed", async () => {
    expect(file.header.state).toBe("signed");
    expect(file.header.pages_manifest.map((p) => p.url)).toContain("https://acme.com/about");
    expect(file.header.pages_manifest.map((p) => p.url)).not.toContain("https://acme.com/login");
    expect(signed.object).toBe("semanto.signed");
    expect(signed.version_id).toMatch(/^smv_[a-z2-7]{26}$/);
    expect(file.signature?.kid).toBe(jwks.keys[0]!.kid);
    // The signer named in the header, with the passkey assertion that released the hosted key.
    // Only the random WebAuthn user handle names the person; the worker-f user id never enters the signed header.
    const handle = (await w.store.passkeyUser("u-ada"))!.handle;
    expect(file.header.identity.authorized_by).toEqual([{ role: "owner", name: "Ada Owner", passkey: { credential_id: w.wallet.byToken.get("Bearer owner-token")!.id, user_handle: handle, checked_at: NOW.toISOString() } }]);
    expect(JSON.stringify(file.header)).not.toContain("u-ada");
    const ok = await verifyJws(file.signature!.jws, (kid) => jwks.keys.find((k) => k.kid === kid) ?? null, { expectTyp: JWS_TYPES.semantoVersion, payload: file.header, at: NOW });
    expect(ok.ok).toBe(true);
    const wit = await verifyJws(file.witness!.jws, (kid) => (kid === w.witnessPublic.kid ? w.witnessPublic : null), { expectTyp: JWS_TYPES.witness, payload: { root_hash: file.root_hash, witnessed_at: file.witness!.at }, at: NOW });
    expect(wit.ok).toBe(true);
  });

  it("logs the key, the semanto_version and the witness leaves in the ledger's format", async () => {
    const leaves: LogLeaf[] = [];
    for (let i = 0; ; i++) {
      const r = await get(w, `/log/leaves/${i}`);
      if (r.status !== 200) break;
      leaves.push((await json(r)).leaf);
    }
    expect(leaves.map((l) => l.kind)).toEqual(["key", "semanto_version", "witness"]);
    const versionLeaf = leaves[1]!;
    expect(versionLeaf).toMatchObject({ trooth_id: "acme", ref: signed.version_id, hash: file.root_hash });
    expect(file.ledger).toMatchObject({ log: TEST_CONFIG.ledger_url, index: 1, tree_size: 3 });
    expect(file.ledger!.tree_head).toMatch(/^smt_/);
  });

  it("serves a page as markdown with a response signature that verifies (RFC 9421, RFC 9530) in src/core and in the JavaScript kit", async () => {
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const r = await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(await digest(bytes)).toBe(entry.hash);
    expect(r.headers.get("trooth-page-hash")).toBe(entry.hash);
    expect(r.headers.get("trooth-semanto-version")).toBe(signed.version_id);
    expect(r.headers.get("trooth-signed-by")).toBeNull();
    expect(await verifyContentDigest(r.headers.get("content-digest"), bytes)).toBe(true);
    const v = await verifyMessage({ kind: "response", status: r.status, headers: r.headers }, { resolveKey: (kid) => jwks.keys.find((k) => k.kid === kid) ?? null, required: [...SEMANTO_RESPONSE_COMPONENTS], tag: "trooth-semanto", now: Math.floor(NOW.getTime() / 1000) });
    expect(v.ok).toBe(true);
    const headers: Record<string, string> = {};
    r.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const js = await JSV.verifyResponse(r.status, headers, bytes, jwks, { now: NOW });
    expect(js.ok).toBe(true);
  });

  it("serves the page proof, which verifies with src/serve/proof.ts and with verifier/js/verify.mjs", async () => {
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/contact")!;
    const bytes = new Uint8Array(await (await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" })).arrayBuffer());
    const proof = (await json(await get(w, `/acme/pages/${entry.id}/proof`))) as PageProof;
    const header = ((await json(await get(w, `/acme/versions/${file.header.version}`))) as SemantoFile).header;
    expect(proof.ledger?.leaf).toMatchObject({ kind: "semanto_version", hash: proof.root_hash });
    const at = new Date(NOW.getTime() + 10_000);
    const v = await verifyProof(proof, bytes, { header, resolveCompanyKey: (kid) => jwks.keys.find((k) => k.kid === kid) ?? null, resolveTroothKey: (kid) => (kid === w.witnessPublic.kid ? w.witnessPublic : null), at });
    expect(v.failures).toEqual([]);
    expect(Object.values(v.checks).every((c) => c === "ok")).toBe(true);
    const js = await JSV.verifyPageProof(proof, bytes, { company: jwks, trooth: { keys: [w.witnessPublic] } }, { header, now: at });
    expect(js.checks.filter((c) => !c.ok)).toEqual([]);
    expect(js.ok).toBe(true);
  });

  it("serves the log routes in the docs/spec/log.md shapes, and the inclusion proof checks against the signed tree head", async () => {
    const head = await json(await get(w, "/log/tree-head"));
    expect(Object.keys(head).sort()).toEqual(["jws", "root_hash", "signed_at", "tree_size"]);
    expect((await verifyTreeHead(head as any, w.witnessPublic)).ok).toBe(true);
    const jsHead = await JSV.verifyTreeHead({ jws: head.jws }, { keys: [w.witnessPublic] });
    expect(jsHead.ok).toBe(true);

    const index = file.ledger!.index;
    const proof = await json(await get(w, `/log/proof?index=${index}&size=${head.tree_size}`));
    expect(Object.keys(proof).sort()).toEqual(["index", "leaf_hash", "path", "root_hash", "tree_size"]);
    expect(proof.root_hash).toBe(head.root_hash);
    const leaf = (await json(await get(w, `/log/leaves/${index}`))) as { leaf: LogLeaf; leaf_hash: string };
    const recomputed = `sha256:${Buffer.from(await hashLeaf(leaf.leaf)).toString("hex")}`;
    expect(recomputed).toBe(proof.leaf_hash);
    expect(leaf.leaf_hash).toBe(proof.leaf_hash);
    expect(await verifyInclusionDigests(digestBytes(proof.leaf_hash), index, proof.tree_size, proof.path, head.root_hash)).toBe(true);
    expect(await JSV.verifyInclusionInLog(proof as any)).toBe(true);

    const text = await (await get(w, "/log/tree-head", { accept: "text/plain" })).text();
    const cp = await verifyCheckpoint(text, LOG_SIGNER_NAME, w.witnessPublic);
    expect(cp.ok && cp.checkpoint.tree_size).toBe(head.tree_size);
    expect(cp.ok && cp.checkpoint.root_hash).toBe(head.root_hash);
    expect(await (await get(w, "/log/checkpoint")).text()).toBe(text);

    const cons = await json(await get(w, `/log/consistency?from=1&to=${head.tree_size}`));
    expect(Object.keys(cons).sort()).toEqual(["from", "new_root", "old_root", "path", "to"]);
    expect(await verifyConsistencyDigests(cons.from, cons.to, cons.old_root, cons.new_root, cons.path)).toBe(true);

    expect((await get(w, "/log/proof?index=99")).status).toBe(404);
    expect((await get(w, "/log/proof?index=x")).status).toBe(400);
    expect((await get(w, "/log/leaves/99")).status).toBe(404);
    expect(prefersPlainText("text/plain")).toBe(true);
    expect(prefersPlainText("application/json, text/plain;q=0.5")).toBe(false);
  });

  it("answers byte-identical bytes and signatures to two different user agents", async () => {
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/pricing")!;
    const a = await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown", "user-agent": "fixture-agent-one/1.0" });
    const b = await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown", "user-agent": "Mozilla/5.0 fixture-browser" });
    expect(Buffer.from(await a.arrayBuffer()).equals(Buffer.from(await b.arrayBuffer()))).toBe(true);
    expect(a.headers.get("signature")).toBe(b.headers.get("signature"));
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
  });

  it("runs the monitor against the signed record and a Merchant Center fixture feed that differs, under the compiler's own fact keys", async () => {
    // The connector key, then the signed catalog the WordPress plugin or Shopify script posts.
    const connector = await generateConnectorKey();
    expect((await post(w, "/acme/connectors", { public_jwk: connector.publicJwk, source: "woocommerce" })).status).toBe(200);
    const url = `${OS}/acme/commerce/catalog`;
    const body = readFix("fixture-catalog.json");
    const headers = await signPost({ url, body, privateJwk: connector.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    const accepted = await w.app.request(url, { method: "POST", headers, body });
    expect(accepted.status).toBe(202);
    const receipt = await json(accepted);
    expect(receipt).toMatchObject({ signed: true, records: [{ sku: "ANV-100" }], offers: [{ sku: "ANV-100" }] });

    const offer = await json(await get(w, "/acme/offers/ANV-100"));
    expect(offer.found).toBe(true);
    expect((await verifyOffer(offer.jws, (kid: string) => jwks.keys.find((k) => k.kid === kid) ?? null, { at: NOW })).ok).toBe(true);
    expect(await (await get(w, "/acme/feeds/merchant-center.tsv")).text()).toContain("ANV-100");

    const r = await post(w, "/acme/monitor/run", { surfaces: { merchant_center: { url: MC_URL, format: "tsv" }, business_profile: { url: BP_URL }, live_pages: true, robots: true } });
    expect(r.status).toBe(200);
    const out = await json(r);
    const price = out.mismatches.find((m: any) => m.key === "product.ANV-100.price" && m.surface === "merchant_center");
    expect(price).toMatchObject({ kind: "differs", severity: "trust", signed_value: { amount: "49.00", currency: "USD" }, surface_value: { amount: "45.00", currency: "USD" } });
    const phoneFact = file.facts.find((f) => f.key === "contact.phone")!;
    expect(phoneFact).toBeDefined();
    const phone = out.mismatches.find((m: any) => m.key === "contact.phone" && m.surface === "business_profile");
    expect(phone).toMatchObject({ kind: "differs", signed_fact_id: phoneFact.id, severity: "trust" });
    // The website fact the compiler wrote as identity.url is the monitor's contact.website, and it matches.
    expect(canonicalFactKey("identity.url")).toBe("contact.website");
    expect(out.mismatches.find((m: any) => m.key === "contact.website" && m.surface === "business_profile")).toBeUndefined();
  });

  it("refuses a catalog whose body was changed after signing, and one signed by an unknown key", async () => {
    const connector = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: connector.publicJwk });
    const url = `${OS}/acme/commerce/catalog`;
    const body = readFix("fixture-catalog.json");
    const headers = await signPost({ url, body, privateJwk: connector.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    const tampered = await w.app.request(url, { method: "POST", headers, body: body.replace("49.00", "1.00") });
    expect(tampered.status).toBe(401);
    const stranger = await generateConnectorKey();
    const h2 = await signPost({ url, body, privateJwk: stranger.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    const unknown = await w.app.request(url, { method: "POST", headers: h2, body });
    expect(unknown.status).toBe(401);
    expect((await json(unknown)).code).toBe("unauthorized");
  });

  it("review finding 19: a catalog request is accepted once (its nonce is claimed), and a body over 5 MB is a 413 problem", async () => {
    const connector = await generateConnectorKey();
    await post(w, "/acme/connectors", { public_jwk: connector.publicJwk });
    const url = `${OS}/acme/commerce/catalog`;
    const body = readFix("fixture-catalog.json");
    const headers = await signPost({ url, body, privateJwk: connector.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    expect((await w.app.request(url, { method: "POST", headers, body })).status).toBe(202);
    const replay = await w.app.request(url, { method: "POST", headers, body });
    expect(replay.status).toBe(401);
    expect((await json(replay)).detail).toContain("already received");
    // Without a nonce the connector signature is refused.
    const noNonce = await signPost({ url, body, privateJwk: connector.privateJwk, created: Math.floor(NOW.getTime() / 1000), nonce: "" });
    const fixedInput = noNonce["Signature-Input"].replace(';nonce=""', "");
    expect((await w.app.request(url, { method: "POST", headers: { ...noNonce, "Signature-Input": fixedInput }, body })).status).toBe(401);
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    const tooBig = await w.app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(tooBig.status).toBe(413);
    expect((await json(tooBig)).code).toBe("payload_too_large");
  });

  it("runs the gap compare against a fixture answer and finds the compiler's contact.phone fact under the gap report's local.phone key", async () => {
    const r = await post(w, "/acme/gap-report", { kind: "local" });
    expect(r.status).toBe(200);
    const { report } = await json(r);
    const phoneFact = file.facts.find((f) => f.key === "contact.phone")!;
    const finding = report.findings.find((f: any) => f.key === "local.phone");
    expect(finding).toMatchObject({ classification: "differs", fact_id: phoneFact.id });
    expect(w.store.gapReports).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------ 4. the Worker's own D1 and R2 adapters

describe("4. the same flow over the D1 and R2 adapters the Worker uses (SQLite and a Map standing in)", () => {
  it("builds, signs with a sealed hosted key, logs, serves, proves, takes a catalog and runs the monitor through src/db/d1.ts and src/ledger/store-d1.ts", async () => {
    const d1 = new FixtureD1();
    const r2 = new FixtureR2();
    const db = d1.asD1();
    const bucket = r2.asR2();
    const now = () => new Date(NOW);
    const seal = "fixture-seal-secret-of-at-least-32-chars";
    const w = await generateKeyPair();
    const versions = new D1VersionStore(db, bucket);
    const keys = new D1Keys(db, bucket, w.privateJwk, seal);
    const settings = new D1Settings(db);
    const logStore = new D1LogStore(db, bucket);
    const log = new LedgerLogPort(new TransparencyLog(logStore, w.privateJwk, now), TEST_CONFIG.ledger_url);
    const store = new D1PipelineStore(db, bucket, seal);
    const commerce = withCompanies(new D1CommerceStore(db), store, API);
    const receiptRows = new D1ReceiptStore(db);
    const livePages: Record<string, string> = {};
    for (const [url, file] of Object.entries(SITE_PAGES)) livePages[url] = readCompiler(file);
    const pipeline = new Pipeline({
      store,
      versions,
      keys,
      settings,
      log,
      logStore,
      commerce,
      config: TEST_CONFIG,
      now,
      site: { http: fixtureSite(), fetcher: { minIntervalMs: 0 } },
      monitor: { fetch: fetchFromMap({ ...livePages, [MC_URL]: { status: 200, headers: {}, body: readFix("fixture-merchant-center.tsv") } }), store: new D1MonitorStore(db) },
      identity: { http: new IdentityHttp({}) },
      domainProof: memoryDomainProof(),
      gapAdapters: gapAnswers,
      staging: new D1BuildStaging(db, bucket),
    });
    const app = createApp({
      ports: { versions, log, keys, receipts: new ReaderReceipts(receiptRows, "fixture-receipt-salt-secret"), settings, jobs: pipeline.jobs(), config: TEST_CONFIG, now },
      authorize: async (req) => WORKSPACES[req.headers.get("authorization") ?? ""] ?? null,
      workspace: pipeline,
      commerce,
    });
    const osPost = (path: string, body: unknown) => app.request(`${OS}${path}`, { method: "POST", headers: { authorization: "Bearer owner-token", "content-type": "application/json" }, body: JSON.stringify(body) });

    await store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full", legal_name: "Acme Inc", current_version: null, custody: "hosted" });
    expect((await store.getCompany("acme"))?.custody).toBe("hosted");
    // Not proven yet: nothing is built for publication or served.
    expect((await osPost("/acme/build", {})).status).toBe(409);
    await store.markDomainProven("acme", NOW.toISOString(), "dns_txt");
    expect((await store.getCompany("acme"))?.domain_proven_at).toBe(NOW.toISOString());
    expect((await app.request(`${API}/acme`)).status).toBe(409);
    expect((await osPost("/acme/build", {})).status).toBe(200);
    const signedRes = await passkeySign((path, b, t) => app.request(`${OS}${path}`, { method: "POST", headers: { authorization: t, "content-type": "application/json" }, body: JSON.stringify(b) }), "acme", "Bearer owner-token", new PasskeyWallet());
    expect(signedRes.status).toBe(200);
    const signed = await json(signedRes);

    // The hosted private key is in R2 only in sealed form.
    const kid = signed.kid as string;
    const sealed = r2.objects.get(`keys/acme/${kid}.jwk`)!;
    expect(new TextDecoder().decode(sealed.bytes)).not.toMatch(/"d"/);
    expect((await keys.getCompanySigningKey("acme"))?.kid).toBe(kid);

    const file = (await versions.getCurrent("acme"))!;
    expect(file.header.state).toBe("signed");
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const page = await app.request(`${API}/acme/by-path/about`, { headers: { accept: "text/markdown", "cf-connecting-ip": "198.51.100.4" } });
    expect(page.status).toBe(200);
    const bytes = new Uint8Array(await page.arrayBuffer());
    expect(await digest(bytes)).toBe(entry.hash);
    const jwks = (await json(await app.request(`${API}/acme/keys.json`))) as Jwks;
    const sig = await verifyMessage({ kind: "response", status: 200, headers: page.headers }, { resolveKey: (k) => jwks.keys.find((x) => x.kid === k) ?? null, required: [...SEMANTO_RESPONSE_COMPONENTS], tag: "trooth-semanto", now: Math.floor(NOW.getTime() / 1000) });
    expect(sig.ok).toBe(true);

    const proof = (await json(await app.request(`${API}/acme/pages/${entry.id}/proof`))) as PageProof;
    const v = await verifyProof(proof, bytes, { header: file.header, resolveCompanyKey: (k) => jwks.keys.find((x) => x.kid === k) ?? null, resolveTroothKey: (k) => (k === w.publicJwk.kid ? w.publicJwk : null), at: NOW });
    expect(v.failures).toEqual([]);
    const head = await json(await app.request(`${API}/log/tree-head`));
    expect(head.tree_size).toBe(3);
    const incl = await json(await app.request(`${API}/log/proof?index=${proof.ledger!.index}&size=3`));
    expect(await verifyInclusionDigests(digestBytes(incl.leaf_hash), incl.index, 3, incl.path, head.root_hash)).toBe(true);
    expect(r2.objects.has("semanto/log/leaf/1")).toBe(true);

    const connector = await generateConnectorKey();
    expect((await osPost("/acme/connectors", { public_jwk: connector.publicJwk })).status).toBe(200);
    const url = `${OS}/acme/commerce/catalog`;
    const body = readFix("fixture-catalog.json");
    const headers = await signPost({ url, body, privateJwk: connector.privateJwk, created: Math.floor(NOW.getTime() / 1000) });
    expect((await app.request(url, { method: "POST", headers, body })).status).toBe(202);
    expect((await json(await app.request(`${API}/acme/products`))).products).toHaveLength(1);

    const run = await json(await osPost("/acme/monitor/run", { surfaces: { merchant_center: { url: MC_URL, format: "tsv" }, live_pages: true, robots: false } }));
    expect(run.mismatches.find((m: any) => m.key === "product.ANV-100.price")).toMatchObject({ kind: "differs" });
    const runs = d1.db.prepare("SELECT COUNT(*) AS n FROM semanto_monitor_runs").get() as { n: number };
    expect(runs.n).toBe(1);

    await settle();
    const receipts = d1.db.prepare("SELECT proof, ip_hash FROM semanto_read_receipts").all() as { proof: string; ip_hash: string }[];
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every((r) => r.proof === "none" && /^[0-9a-f]{64}$/.test(r.ip_hash))).toBe(true);

    // A rebuild reads the previous version back from D1 and R2 and stays incremental.
    const again = await pipeline.compile({ trooth_id: "acme", domain: "acme.com", reason: "manual", requested_at: NOW.toISOString() });
    expect(again.version).toBe(2);
    expect(again.coverage.changed).toEqual([]);
  });
});

// ------------------------------------------------------------------------ 3. adapter routes

describe("3. the routes the adapters assume", () => {
  let w: World;
  let file: SemantoFile;
  beforeAll(async () => {
    w = await world();
    ({ file } = await buildAndSign(w));
  });

  it("serves a page by its path on the company's domain with the same bytes and headers as /pages/{smp_id}", async () => {
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const byId = await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" });
    const byPath = await get(w, "/acme/by-path/about", { accept: "text/markdown" });
    expect(byPath.status).toBe(200);
    const a = Buffer.from(await byId.arrayBuffer());
    const b = Buffer.from(await byPath.arrayBuffer());
    expect(b.equals(a)).toBe(true);
    for (const h of ["content-type", "etag", "trooth-page-hash", "trooth-semanto-version", "content-digest", "signature", "vary"]) expect(byPath.headers.get(h)).toBe(byId.headers.get(h));
    const suffix = await get(w, "/acme/by-path/about.md");
    expect(Buffer.from(await suffix.arrayBuffer()).equals(a)).toBe(true);
    const home = await get(w, "/acme/by-path", { accept: "text/markdown" });
    expect(home.status).toBe(200);
    const html = await get(w, "/acme/by-path/about", { accept: "text/html" });
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe("https://acme.com/about");
    const missing = await get(w, "/acme/by-path/nowhere", { accept: "text/markdown" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("serves /keys.json where the adapters expect it, the same set as /.well-known/trooth-keys.json", async () => {
    const a = await json(await get(w, "/acme/keys.json"));
    const b = await json(await get(w, "/acme/.well-known/trooth-keys.json"));
    expect(a.keys).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("serves the commerce public routes signed, with problems as RFC 9457", async () => {
    const products = await get(w, "/acme/products");
    expect(products.status).toBe(200);
    expect((await json(products)).products).toEqual([]);
    expect(products.headers.get("signature-input")).toContain('tag="trooth-semanto"');
    const ucp = await json(await get(w, "/acme/.well-known/ucp"));
    expect(JSON.stringify(ucp)).toContain("co.trooth.semanto");
    const none = await get(w, "/acme/offers/NOPE-1");
    expect(none.status).toBe(404);
    expect(none.headers.get("content-type")).toBe("application/problem+json");
  });
});

// ------------------------------------------------------------------------ 4. the pipeline: signing, keys, LEI, Basic, first publication

describe("4. signing paths, keys and the workspace actions", () => {
  it("enforces the two-officer rule: two distinct people over the same root hash", async () => {
    const w = await world();
    await w.store.putConfig("acme", { ...(await w.store.getConfig("acme")), signing: { officers: "two_officer" } });
    expect((await post(w, "/acme/build", {})).status).toBe(200);
    const first = await signHosted(w);
    expect(first.status).toBe(202);
    // Review finding 8: the answer says two officers need two distinct accounts, which a one-account workspace cannot give.
    expect(await json(first)).toMatchObject({ object: "semanto.sign_waiting", approvals_missing: 1, two_officer_note: expect.stringContaining("two different people with their own accounts") });
    const again = await signHosted(w);
    expect((await json(again)).approvals_missing).toBe(1);
    // Without a passkey assertion, a second person's approval does not count.
    expect((await post(w, "/acme/sign", {}, "Bearer admin-token")).status).toBe(409);
    const second = await signHosted(w, "acme", "Bearer admin-token");
    expect(second.status).toBe(200);
    const file = (await w.versions.getCurrent("acme"))!;
    const handles = { "u-ada": (await w.store.passkeyUser("u-ada"))!.handle, "u-bo": (await w.store.passkeyUser("u-bo"))!.handle };
    const passkeyOf = (token: string, user_id: "u-ada" | "u-bo") => ({ credential_id: w.wallet.byToken.get(token)!.id, user_handle: handles[user_id], checked_at: NOW.toISOString() });
    expect(file.header.identity.authorized_by).toEqual([
      { role: "owner", name: "Ada Owner", passkey: passkeyOf("Bearer owner-token", "u-ada") },
      { role: "admin", name: "Bo Admin", passkey: passkeyOf("Bearer admin-token", "u-bo") },
    ]);
    // A member may build and run reports but never sign.
    const member = await post(w, "/acme/sign", {}, "Bearer member-token");
    expect(member.status).toBe(403);
  });

  it("customer custody: hands out the exact signing input, accepts the signature, assembles and checks the JWS", async () => {
    const w = await world({ custody: "customer" });
    const customer = await generateKeyPair();
    const { d: _d, ...pub } = customer.privateJwk;
    expect((await post(w, "/acme/keys/rotate", { public_jwk: pub })).status).toBe(200);
    expect((await post(w, "/acme/keys/rotate", { public_jwk: customer.privateJwk })).status).toBe(400);
    expect((await post(w, "/acme/build", {})).status).toBe(200);
    const prep = await json(await post(w, "/acme/sign", {}));
    expect(prep.object).toBe("semanto.signing_input");
    expect(prep.kid).toBe(customer.publicJwk.kid);
    const bad = await post(w, "/acme/sign", { version: prep.version, signature: toBase64Url(new Uint8Array(64)) });
    expect(bad.status).toBe(422);
    const sig = await rawSign(await importPrivate(customer.privateJwk), utf8(prep.signing_input));
    const done = await post(w, "/acme/sign", { version: prep.version, signature: toBase64Url(sig) });
    expect(done.status).toBe(200);
    const file = (await w.versions.getCurrent("acme"))!;
    const v = await verifyJws(file.signature!.jws, (kid) => (kid === customer.publicJwk.kid ? customer.publicJwk : null), { expectTyp: JWS_TYPES.semantoVersion, payload: file.header, at: NOW });
    expect(v.ok).toBe(true);
    // Trooth holds no company key, so responses are witness-signed and say so.
    const page = await get(w, `/acme/pages/${file.header.pages_manifest[0]!.id}`, { accept: "text/markdown" });
    expect(page.headers.get("trooth-signed-by")).toBe("witness");
  });

  it("rotates a hosted key with a 30-day overlap, logs the new key, and signs responses with it", async () => {
    const w = await world();
    const { file } = await buildAndSign(w);
    const before = file.signature!.kid;
    const r = await json(await post(w, "/acme/keys/rotate", {}));
    expect(r.retired).toEqual([before]);
    expect(r.kid).not.toBe(before);
    expect(r.overlap_until).toBe("2026-11-21T12:00:00.000Z");
    expect(r.dns_record).toBe(`v=trooth1; kid=${r.kid}`);
    const jwks = (await json(await get(w, "/acme/keys.json"))) as Jwks;
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual([before, r.kid].sort());
    expect(jwks.keys.find((k) => k.kid === before)?.exp).toBe(r.overlap_until);
    const page = await get(w, `/acme/pages/${file.header.pages_manifest[0]!.id}`, { accept: "text/markdown" });
    expect(page.headers.get("signature-input")).toContain(`keyid="${r.kid}"`);
    const lastLeaf = (await json(await get(w, "/log/tree-head"))).tree_size - 1;
    expect((await json(await get(w, `/log/leaves/${lastLeaf}`))).leaf).toMatchObject({ kind: "key", ref: r.kid });
    expect((await post(w, "/acme/keys/rotate", {}, "Bearer member-token")).status).toBe(403);
  });

  it("looks up an LEI at GLEIF and adds the public_record facts to the next build", async () => {
    const w = await world();
    const r = await post(w, "/acme/lei", { lei: "5493001KJTIIGC8Y1R12" });
    expect(r.status).toBe(200);
    const out = await json(r);
    expect(out.facts.every((f: any) => f.provenance === "public_record")).toBe(true);
    expect(out.name.kind).toBeDefined();
    expect((await post(w, "/acme/lei", { lei: "5493001KJTIIGC8Y1R13" })).status).toBe(400);
    await post(w, "/acme/build", {});
    const v = (await w.store.latestVersion("acme"))!;
    expect(v.file.header.identity.lei).toBe("5493001KJTIIGC8Y1R12");
    expect(v.file.facts.filter((f) => f.provenance === "public_record").map((f) => f.key)).toContain("identity.lei");
  });

  it("Semanto Basic: claims, proves by DNS, builds the witnessed record and measures the setup", async () => {
    const w = await world({ company: false, random: (n) => new Uint8Array(n) });
    await w.store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "basic", current_version: null, custody: "customer", domain_proven_at: null });
    const claimed = await json(await post(w, "/acme/basic/claim", { domain: "https://acme.com/" }));
    expect(claimed.dns).toEqual({ name: "_trooth-challenge.acme.com", type: "TXT", value: `trooth-domain-challenge=${"00".repeat(24)}` });
    const proved = await post(w, "/acme/basic/prove", {});
    expect(proved.status).toBe(200);
    expect(proved.headers.get("trooth-record-state")).toBe("read");
    const body = await json(proved);
    expect(body.signed_by_company).toBe(false);
    expect(body.body.proved).toBe(true);
    expect(body.body.method).toBe("dns_txt");
    expect(body.body.read.status).toBe("done");
    expect(body.body.read.read).toBeGreaterThan(3);
    expect(body.body.setup.steps.map((s: any) => s.id)).toEqual(["sign_in", "company", "prove_domain", "read_site", "review", "sign", "install", "check", "monitoring"]);
    expect(body.body.setup.basic.spent_seconds).toBeNull();

    // Review finding 15: the Basic build is witnessed (Trooth's witness statement and a "witness" log leaf), never signed by the company.
    const leaves: LogLeaf[] = [];
    for (let i = 0; ; i++) {
      const r = await get(w, `/log/leaves/${i}`);
      if (r.status !== 200) break;
      leaves.push((await json(r)).leaf);
    }
    expect(leaves.map((l) => l.kind)).toEqual(["witness"]);
    expect(leaves[0]).toMatchObject({ kind: "witness", trooth_id: "acme" });
    const served = (await w.versions.getCurrent("acme"))!;
    expect(served.header.state).toBe("read");
    expect(served.signature).toBeNull();
    expect(served.witness?.by).toBe("Trooth");

    // The public routes serve it marked witnessed-not-signed, and every body carries the notice.
    const obj = await get(w, "/acme");
    expect(obj.status).toBe(200);
    expect(obj.headers.get("trooth-semanto-state")).toBe("witnessed-not-signed");
    const objBody = await json(obj);
    expect(objBody.notice).toBe(WITNESSED_NOT_SIGNED);
    expect(objBody.header.state).toBe("read");
    const page = await get(w, `/acme/pages/${served.header.pages_manifest[0]!.id}`, { accept: "text/markdown" });
    expect(page.headers.get("trooth-semanto-state")).toBe("witnessed-not-signed");
    const pageText = await page.text();
    expect(pageText.startsWith("---\ntrooth_state: witnessed-not-signed\n")).toBe(true);
    expect(pageText).toContain(WITNESSED_NOT_SIGNED);
    const llms = await (await get(w, "/acme/llms.txt")).text();
    expect(llms).toContain("witnessed by Trooth and not signed by the company");
    expect(llms).not.toContain("signed by the company and witnessed by Trooth");
    // The JS kit reads it as an unsigned file whose witness statement checks out against Trooth's keys.
    const kit = await JSV.verifySemanto(served, {}, { company: { keys: [] }, trooth: { keys: [w.witnessPublic] } }, { now: NOW });
    expect(kit.checks.find((c) => c.name === "witness")?.ok).toBe(true);
    expect(kit.state).toBe("unsigned");
  });

  it("witnesses a first publication, logs it, and the record verifies against the text", async () => {
    const w = await world();
    const r = await json(await post(w, "/acme/first-publication", { url: "https://acme.com/blog/launch-notes" }));
    expect(r.record.object).toBe("semanto.first_publication");
    const check = await verifyFirstPublication(r.record, r.jws, r.markdown, (kid: string) => (kid === w.witnessPublic.kid ? w.witnessPublic : null));
    expect(check.ok).toBe(true);
    const logged = await json(await get(w, `/log/leaves/${r.log.index}`));
    expect(logged.leaf).toEqual(r.leaf);
    expect(logged.leaf_hash).toBe(r.leaf_hash);
    expect((await post(w, "/acme/first-publication", { url: "https://elsewhere.example/post" })).status).toBe(403);

    // Review finding 17: the statement points at routes that can check it; the record and its proof are public.
    expect(r.check_url).toBe(`${API}/first-publication/check`);
    expect(r.dispute).toContain(`${API}/first-publication/check`);
    expect(r.record.declared.stated_by).toBe("requester");
    const doc = await json(await get(w, `/first-publication/${r.record.id}`));
    expect(doc.object).toBe("semanto.first_publication_record");
    expect(doc.record).toEqual(r.record);
    expect(doc.inclusion).toMatchObject({ index: r.log.index, leaf_hash: r.leaf_hash });
    expect(await V_core_inclusion(doc.inclusion)).toBe(true);
    const checkText = (markdown: string) => w.app.request(`${API}/first-publication/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ record_id: r.record.id, markdown }) });
    expect((await json(await checkText(r.markdown))).status).toBe("matches");
    expect((await json(await checkText(`${r.markdown} changed`))).status).toBe("differs");
    expect((await get(w, "/first-publication/smb_aaaaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(404);
  });

  it("seals a hosted private key at rest and opens it only with the same secret", async () => {
    const k = await generateKeyPair();
    const secret = "fixture-seal-secret-of-at-least-32-chars";
    const sealed = await sealPrivateJwk(k.privateJwk, secret);
    expect(new TextDecoder().decode(sealed)).not.toContain(k.privateJwk.d);
    expect(await openPrivateJwk(sealed, secret)).toEqual(k.privateJwk);
    expect(await openPrivateJwk(sealed, "another-secret-of-at-least-32-characters")).toBeNull();
    expect(await openPrivateJwk(sealed, undefined)).toBeNull();
    await expect(sealPrivateJwk(k.privateJwk, "short")).rejects.toThrow(/HOSTED_KEY_SEAL_SECRET/);
  });

  it("maps a connector catalog with variants to variant-level records and offers, and skips what it cannot price", () => {
    const company = { trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full" as const, current_version: 1, custody: "hosted" as const };
    const out = catalogToInputs(
      [
        { id: "7", name: "Acme Glove", url: "https://acme.com/glove", variants: [{ id: "71", sku: "GLV-S", price: "12.00", stock_status: "instock", stock: 3, attributes: { pa_size: "S", pa_color: "red" } }, { id: "72", sku: "GLV-M", stock_status: "instock" }] },
      ],
      { company, currency: "USD", at: NOW.toISOString(), source: "woocommerce" },
    );
    expect(out.records.map((r) => [r.sku, r.product_id, r.variant_id, r.parent_product_id, r.variant_axes])).toEqual([
      ["GLV-S", "7", "71", "7", { size: "S", color: "red" }],
      ["GLV-M", "7", "72", "7", {}],
    ]);
    expect(out.offers).toEqual([expect.objectContaining({ sku: "GLV-S", price: { amount: 1200, currency: "USD" }, availability: "in_stock", inventory_quantity: 3 })]);
    expect(out.skipped).toEqual([{ sku: "GLV-M", reason: "no offer: the price or the stock status is missing" }]);
  });

  it("queues the build when a compile queue is bound, and the queue consumer compiles", async () => {
    const w = await world({ queue: true });
    const r = await post(w, "/acme/build", {});
    expect(r.status).toBe(202);
    expect(w.queued).toHaveLength(1);
    // The job becomes a build in stages (discover, render of at most 25 pages, assemble), each its own message.
    await drain(w);
    expect((await w.store.latestVersion("acme"))?.file.header.state).toBe("read");
  });
});

// ------------------------------------------------------------------------ 4. scheduled work

describe("4. scheduled work", () => {
  it("hourly: detects a changed signed page, queues a rebuild of that url, and the page is served as behind", async () => {
    const w = await world({ queue: true });
    await post(w, "/acme/build", {});
    await drain(w);
    expect((await signHosted(w)).status).toBe(200);
    w.site.set("https://acme.com/about", { body: readCompiler("about.html").replace("coyote", "roadrunner"), headers: { "content-type": "text/html" } });
    // The cron fans out one message per 25 companies; the message checks them and queues the rebuild.
    await w.pipeline.hourlyChangeDetection();
    expect(w.queued).toEqual([{ kind: "companies", job: "changes", trooth_ids: ["acme"] }]);
    w.queued.length = 0;
    const result = await w.pipeline.checkCompanyChanges(["acme"]);
    expect(result).toEqual([{ trooth_id: "acme", changed: ["https://acme.com/about"] }]);
    expect(w.queued[0]).toMatchObject({ trooth_id: "acme", reason: "change_detected", changed_urls: ["https://acme.com/about"] });
    const file = (await w.versions.getCurrent("acme"))!;
    const entry = file.header.pages_manifest.find((p) => p.url === "https://acme.com/about")!;
    const page = await get(w, `/acme/pages/${entry.id}`, { accept: "text/markdown" });
    expect(page.headers.get("trooth-semanto-state")).toBe("behind");
    // The next hour, the same new bytes are not a new change.
    w.queued.length = 0;
    expect((await w.pipeline.checkCompanyChanges(["acme"]))[0]!.changed).toEqual([]);
    // The rebuild keeps unchanged pages and re-renders the changed one.
    const summary = await w.pipeline.compile({ trooth_id: "acme", domain: "acme.com", reason: "change_detected", changed_urls: ["https://acme.com/about"], requested_at: NOW.toISOString() });
    expect(summary.version).toBe(2);
    expect(summary.coverage.changed).toEqual(["https://acme.com/about"]);
  });

  it("nightly: signs a tree head, anchors it with an RFC 3161 timestamp, and re-signs the revocation list", async () => {
    const w = await world({ tsa: true });
    const { signed } = await buildAndSign(w);
    expect(signed.timestamp).toMatchObject({ token_key: "semanto/log/tsa/3.tsr", signature_checked: false });
    expect(Date.parse(signed.timestamp.gen_time)).toBe(NOW.getTime());
    w.clock.now = new Date(NOW.getTime() + 86_400_000);
    w.store.revocationEntries.push({ trooth_id: "acme", entry: { kind: "version", ref: "smv_fixtureoneaaaaaaaaaaaaaaaaaaa", reason: "Replaced by a newer version.", revoked_at: NOW.toISOString() } });
    const out = await w.pipeline.nightlyCheckpoint();
    expect(out.tree_head?.tree_size).toBe(3);
    expect(out.timestamp).toMatchObject({ token_key: "semanto/log/tsa/3.tsr" });
    expect(w.store.blobs.has("semanto/log/tsa/3.tsr")).toBe(true);
    expect((await w.ports.log.store.getTreeHead(3))?.tsa_token_key).toBe("semanto/log/tsa/3.tsr");
    const list = w.store.revocationLists.at(-1)!;
    const check = await verifyRevocationList(list.jws, w.witnessPublic, w.clock.now);
    expect(check).toMatchObject({ ok: true });
  });

  it("weekly: one schedule, in wrangler.toml, WEEKLY_RUN and runScheduled, runs the gap report for each signed company", async () => {
    const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
    const crons = JSON.parse(/crons = (\[[^\]]*\])/.exec(toml)![1]!) as string[];
    expect(crons).toEqual(["15 * * * *", "30 1 * * *", WEEKLY_RUN.cron]);
    expect(WEEKLY_RUN.cron).toBe("0 6 * * 1");
    expect(toml).toContain('binding = "TROOTH_OS"');
    expect(toml).toContain('service = "trooth-os-worker-f"');
    const w = await world();
    await buildAndSign(w);
    await w.store.putConfig("acme", { ...(await w.store.getConfig("acme")), gap: { kinds: ["local", "shopping"], products: [] } });
    await runScheduled({ ...w.ports, jobs: w.pipeline.jobs() }, WEEKLY_RUN.cron);
    expect(w.store.gapReports.map((r) => r.kind)).toEqual(["local"]);
  });
});

// ------------------------------------------------------------------------ 4. readers and authorization

describe("4. readers: Web Bot Auth behind the receipt middleware, receipts through src/readers", () => {
  it("records web_bot_auth with the key id only when the agent proved its key, and never keeps the address", async () => {
    const w = await world();
    const { file } = await buildAndSign(w);
    const entry = file.header.pages_manifest[0]!;
    const url = `${API}/acme/pages/${entry.id}`;
    const headers: Record<string, string> = { accept: "text/markdown", "signature-agent": '"https://agent.fixtureagent.com"', "cf-connecting-ip": "203.0.113.7" };
    const signed = await signMessage({ kind: "request", method: "GET", url, headers }, w.agent.priv, { components: ["@authority", "signature-agent"], created: Math.floor(NOW.getTime() / 1000) - 5, ttlSeconds: 60, nonce: "fixture-nonce-1", tag: "web-bot-auth" });
    const proven = await w.app.request(url, { headers: { ...headers, ...signed } });
    const unsigned = await w.app.request(url, { headers: { accept: "text/markdown", "signature-agent": '"https://agent.fixtureagent.com"', "cf-connecting-ip": "203.0.113.7" } });
    expect(Buffer.from(await proven.arrayBuffer()).equals(Buffer.from(await unsigned.arrayBuffer()))).toBe(true);
    await settle();
    const rows = w.receiptRows.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ proof: "web_bot_auth", agent_key_url: "https://agent.fixtureagent.com/", keyid: w.agent.pub.kid, representation: "markdown", page_id: entry.id });
    expect(rows[1]).toMatchObject({ proof: "none", agent_key_url: null, keyid: null });
    expect(rows[0]!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
  });

  it("keeps the in-memory receipt port working for the serving tests", async () => {
    expect(new MemoryReceipts().recorded).toEqual([]);
  });
});

describe("4. /os authorization: worker-f's session check, denied by default", () => {
  it("answers a 401 problem without a hook, without a token, or with a refused token, and 403 for another company's session", async () => {
    const w = await world();
    const bare = createApp({ ports: w.ports, workspace: w.pipeline });
    const none = await bare.request(`${OS}/acme/build`, { method: "POST" });
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toBe("application/problem+json");
    expect((await json(none)).code).toBe("unauthorized");
    expect((await post(w, "/acme/build", {}, "Bearer nobody")).status).toBe(401);
    const other = await post(w, "/acme/build", {}, "Bearer beta-token");
    expect(other.status).toBe(403);
    expect((await w.app.request(`${OS}/acme/settings`)).status).toBe(401);
  });

  it("accepts a workspace bearer token through the TROOTH_OS service binding and reads the trooth_id and role", async () => {
    const calls: string[] = [];
    const service: ServiceFetcher = {
      fetch: async (input, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        calls.push(typeof input === "string" ? input : input.url);
        if (auth !== "Bearer live-session" && auth !== "Bearer buyer-session") return new Response(JSON.stringify({ authenticated: false }), { status: 401 });
        const role = auth === "Bearer live-session" ? "vendor" : "buyer";
        return new Response(JSON.stringify({ authenticated: true, companyId: "co-ada-acme-com", userId: "u-1", email: "ada@acme.com", role }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const req = (auth?: string) => new Request(`${OS}/acme/build`, { method: "POST", headers: auth ? { authorization: auth } : {} });
    // Without a registered owner and without an explicit workspaceRole, a vendor session is a member, never the owner.
    const noOwner = troothOsAuthorize(service, async (c) => (c === "co-ada-acme-com" ? "acme" : null));
    expect(await noOwner(req("Bearer live-session"), "acme")).toEqual({ trooth_id: "acme", role: "member", user_id: "u-1", name: "ada@acme.com" });
    // The registered owner (semanto_companies.os_owner_user_id) is the owner; another user of the workspace is a member.
    const authorize = troothOsAuthorize(service, async (c) => (c === "co-ada-acme-com" ? "acme" : null), async () => "u-1");
    expect(await authorize(req("Bearer live-session"), "acme")).toEqual({ trooth_id: "acme", role: "owner", user_id: "u-1", name: "ada@acme.com" });
    expect((await troothOsAuthorize(service, async () => "acme", async () => "u-someone-else")(req("Bearer live-session"), "acme"))?.role).toBe("member");
    expect(await authorize(req("Bearer buyer-session"), "acme")).toBeNull();
    expect(await troothOsAuthorize(service, async () => null)(req("Bearer live-session"), "acme")).toBeNull();
    expect(await authorize(req("Bearer stale"), "acme")).toBeNull();
    expect(await authorize(req(), "acme")).toBeNull();
    expect(await troothOsAuthorize(undefined)(req("Bearer live-session"), "acme")).toBeNull();
    expect(calls[0]).toBe("https://trooth-os-worker-f/auth/session");
    const w = await world();
    const app = createApp({ ports: { ...w.ports, jobs: w.pipeline.jobs() }, workspace: w.pipeline, authorize });
    const built = await app.request(`${OS}/acme/build`, { method: "POST", headers: { authorization: "Bearer live-session" } });
    expect(built.status).toBe(200);
  });
});

// ------------------------------------------------------------------------ 6. house rules across the wired Worker

describe("6. house rules across every source file", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|sql)$/.test(name)) files.push(p);
    }
  };
  walk(fileURLToPath(new URL("../src", import.meta.url)));
  walk(fileURLToPath(new URL("../migrations", import.meta.url)));

  // Every folder a person reads (review finding 19, audit finding 22): src, migrations, adapters, verifier, web, docs
  // and test, plus the text files at the repository root, excluding node_modules, vendored lockfiles and caches. The
  // Next.js folder name [[...path]] is framework syntax and is removed from the text before the ellipsis check.
  const everyFile: string[] = [];
  const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".pytest_cache", ".git"]);
  const SKIP_FILES = new Set(["package-lock.json", "go.sum", "yarn.lock", "pnpm-lock.yaml"]);
  const TEXT = /\.(ts|tsx|mts|mjs|js|json|sql|md|py|go|php|conf|toml|sh|txt|html|css|yml|yaml)$|^_redirects$/;
  const walkAll = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walkAll(p);
      } else if (TEXT.test(name) && !SKIP_FILES.has(name)) everyFile.push(p);
    }
  };
  for (const d of ["src", "migrations", "adapters", "verifier", "web", "docs", "test"]) walkAll(fileURLToPath(new URL(`../${d}`, import.meta.url)));
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  for (const name of readdirSync(rootDir)) if (TEXT.test(name) && !SKIP_FILES.has(name) && statSync(`${rootDir}${name}`).isFile()) everyFile.push(`${rootDir}${name}`);

  it("no banned word (inflections included), no ellipsis and no X-prefixed Semanto header in any folder or root file", () => {
    const xHeader = new RegExp(["X", "Semanto", ""].join("-"), "i");
    expect(everyFile.length).toBeGreaterThan(250);
    expect(everyFile.some((f) => f.includes("/test/"))).toBe(true);
    for (const f of everyFile) {
      const s = readFileSync(f, "utf8").split("[[...path]]").join("");
      expect([f, BANNED_WORDS.test(s)]).toEqual([f, false]);
      expect([f, ELLIPSIS.test(s)]).toEqual([f, false]);
      expect([f, xHeader.test(s)]).toEqual([f, false]);
    }
  });
  const seeding = new RegExp(["mention", "seed"].join("[-_ ]?") + "|" + ["seed", "mention"].join("[-_ ]?") + "|" + ["astro", "turf"].join(""), "i");

  it("no banned word, no ellipsis, no X-Semanto header, and no mention-seeding feature anywhere in src or the migrations", () => {
    expect(files.length).toBeGreaterThan(60);
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect([f, BANNED_WORDS.test(s)]).toEqual([f, false]);
      expect([f, ELLIPSIS.test(s)]).toEqual([f, false]);
      expect([f, new RegExp(["X", "Semanto", ""].join("-"), "i").test(s)]).toEqual([f, false]);
      expect([f, seeding.test(s)]).toEqual([f, false]);
    }
  });

  it("no source file chooses a representation by reading User-Agent", () => {
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect([f, /header\(\s*["']user-agent["']\s*\)|headers\.get\(\s*["']user-agent["']\s*\)/i.test(s)]).toEqual([f, false]);
    }
  });

  it("every source file carries the SPDX and copyright header (audit finding 22): proprietary everywhere, Apache-2.0 in verifier/", () => {
    for (const f of files.filter((x) => x.endsWith(".ts"))) {
      const s = readFileSync(f, "utf8");
      expect([f, s.startsWith("// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary\n// Copyright (c) 2026 Trooth, LLC")]).toEqual([f, true]);
    }
    // Code and configuration in every folder and at the root. JSON cannot carry a comment, and the page vectors are hashed bytes.
    const CODE = /\.(ts|tsx|mts|mjs|js|sql|py|go|php|conf|toml|sh)$|^_redirects$|^go\.mod$/;
    const code = [...everyFile.filter((f) => CODE.test(f.split("/").pop()!)), ...["verifier/go/go.mod"].map((x) => `${rootDir}${x}`)];
    expect(code.length).toBeGreaterThan(150);
    for (const f of code) {
      const head = readFileSync(f, "utf8").split("\n").slice(0, 4).join("\n");
      const license = f.includes("/verifier/") ? "Apache-2.0" : "LicenseRef-Trooth-Proprietary";
      expect([f, head.includes(`SPDX-License-Identifier: ${license}`) && head.includes("Copyright (c) 2026 Trooth, LLC")]).toEqual([f, true]);
    }
  });
});
