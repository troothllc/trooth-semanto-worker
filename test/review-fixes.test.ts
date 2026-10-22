// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Regression tests for the independent review (docs/reports/review-fixes.md).
// Each describe block names its finding; each test fails on the code before
// the fix and passes after it. The verifier kits' side of findings 1 to 4, 6,
// 10 and 19 is also covered by the shared negative vectors in
// verifier/test-vectors/v1, which the JavaScript, Python and Go tests run.
// Companies and agents are fictional fixtures (Acme Inc, acme.com,
// agent.fixtureagent.com); no figure is a measurement.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPair, toPublic, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { signObject, verifyJws, JWS_TYPES } from "@/core/jws";
import { canonicalize } from "@/core/canonical";
import { toBase64Url, utf8, toBase64 } from "@/core/encoding";
import { digest } from "@/core/hash";
import { leafHash, rootFromLeafHashes, inclusionProof, consistencyProof } from "@/core/merkle";
import { signMessage, verifyMessage, contentDigest, parseSignatureInput } from "@/core/httpsig";
import { checkUrl, classifyAddress, dohResolver, checkUrlResolved } from "@/core/ssrf";
import { Fetcher } from "@/compiler/fetch";
import { MemoryHttp as SiteHttp } from "@/compiler/ports";
import { buildResponse, SIGNATURE_TTL_SECONDS } from "@/serve/headers";
import { createApp } from "@/serve/routes";
import { verifyProof, buildPageProof, type PageProof } from "@/serve/proof";
import { MemoryHttp, MemoryKeyCache, MemoryNonceStore, platformHttp } from "@/readers/ports";
import { verifyWebBotAuth, fetchDirectory, DIRECTORY_PATH, type WebBotAuthDeps } from "@/readers/webbotauth";
import { NonceDO, DurableNonceStore, MemoryNonceStorage } from "@/readers/nonce-do";
import { proveReader } from "@/readers/forwarded";
import { MemoryLogStore, TransparencyLog } from "@/ledger/log";
import { frontierAppend, frontierRoot, EMPTY_FRONTIER, Tiles, MemoryTileBucket, inclusionFromTiles, consistencyFromTiles, type Frontier } from "@/ledger/tiles";
import { LogDO } from "@/ledger/log-do";
import { trustLine, withTrustState, buildLlmsTxt } from "@/compiler/llms";
import { Pipeline, troothOsAuthorize, webBotAuthReaders, type PipelineDeps, type ServiceFetcher } from "@/pipeline";
import { createFirstPublication, checkAgainstRecord, verifyFirstPublication, type FirstPublicationDocument } from "@/basic/first-publication";
import type { WorkspaceAuth } from "@/serve/ports";
import { decide, handleRequest, createManifestCache, mergeVary } from "../adapters/shared/semanto-adapter.mjs";
import { generateConnectorKey } from "../adapters/shared/sign-request.mjs";
import * as V from "../verifier/js/verify.mjs";
import { buildEstate, FIXED_NOW, type Estate } from "./fixtures/serve/fixture";

const VECTORS = join(__dirname, "..", "verifier", "test-vectors", "v1");
const vector = (name: string) => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));
const BASE = "https://api.trooth.co/public/semanto";
const settle = () => new Promise((r) => setTimeout(r, 30));

// ------------------------------------------------------------------ 1

describe("finding 1: an embedded JWS payload must be the payload the caller expected", () => {
  it("core verifyJws refuses a detached signature made compact with the old payload, beside a new object", async () => {
    const kp = await generateKeyPair();
    const old = { org: "Acme Inc", version: 1 };
    const forged = { org: "Acme Inc", version: 1, pricing: "free forever" };
    const sig = await signObject(old, kp.privateJwk, JWS_TYPES.semantoVersion, { iat: FIXED_NOW });
    const [h, , s] = sig.detached.split(".");
    const compactWithOld = `${h}.${toBase64Url(utf8(canonicalize(old)))}.${s}`;
    const r = await verifyJws(compactWithOld, () => kp.publicJwk, { expectTyp: JWS_TYPES.semantoVersion, payload: forged, at: FIXED_NOW });
    expect(r).toEqual({ ok: false, reason: "payload_mismatch" });
    // The honest forms still verify: detached with the right payload, and compact whose payload is the expected one.
    expect((await verifyJws(sig.detached, () => kp.publicJwk, { payload: old, at: FIXED_NOW })).ok).toBe(true);
    expect((await verifyJws(sig.compact, () => kp.publicJwk, { payload: old, at: FIXED_NOW })).ok).toBe(true);
  });

  it("serve verifyProof refuses the forged page proof vector, and the kit refuses the forged file vector", async () => {
    const keys = vector("keys.json");
    const v = vector("negative/page-proof-forged-compact.json");
    const company: PublicJwk[] = keys.company.jwks.keys;
    const trooth: PublicJwk[] = keys.trooth.jwks.keys;
    const r = await verifyProof(v.proof as PageProof, utf8(v.page_markdown), { header: v.header, resolveCompanyKey: (k) => company.find((x) => x.kid === k) ?? null, resolveTroothKey: (k) => trooth.find((x) => x.kid === k) ?? null, at: new Date(v.now), allowUnlogged: true });
    expect(r.ok).toBe(false);
    expect(r.checks.signature).toBe("failed");
    expect(r.failures.join(" ")).toContain("payload_mismatch");
    const f = vector("negative/forged-compact-payload.json");
    const k = await V.verifySemanto(f.file, f.pages_by_url, keys, { now: f.now });
    expect(k.ok).toBe(false);
    expect(k.reason).toBe("payload_mismatch");
  });

  it("verifyFirstPublication passes the record as the expected payload", async () => {
    const kp = await generateKeyPair();
    const fp = await createFirstPublication({ url: "https://acme.com/blog/a", markdown: "# A\n", title: "A", trooth_id: "acme-inc", witnessed_at: FIXED_NOW }, kp.privateJwk);
    const other = await createFirstPublication({ url: "https://acme.com/blog/b", markdown: "# B\n", title: "B", trooth_id: "acme-inc", witnessed_at: FIXED_NOW }, kp.privateJwk);
    const r = await verifyFirstPublication(other.record, fp.jws, "# B\n", () => kp.publicJwk);
    expect(!r.ok && r.reason).toBe("payload_mismatch");
  });
});

// ------------------------------------------------------------------ 2

describe("finding 2: a company key never passes as Trooth's witness", () => {
  it("serve verifyProof resolves the witness only against Trooth's keys", async () => {
    const estate = await buildEstate();
    const entry = estate.acme.entries[0]!;
    const proof = (await buildPageProof(estate.acme.file, entry.id, null))!;
    // A witness statement signed with the company's own key, which is in the company's published set.
    const forgedWitness = await signObject({ root_hash: proof.root_hash, witnessed_at: proof.witnessed_at }, estate.companyKey, JWS_TYPES.witness, { iat: FIXED_NOW });
    const r = await verifyProof({ ...proof, witness: forgedWitness.detached }, estate.acme.pages.get(entry.id)!, {
      header: estate.acme.file.header,
      resolveCompanyKey: (k) => (k === estate.companyPublic.kid ? estate.companyPublic : null),
      resolveTroothKey: (k) => (k === estate.witnessPublic.kid ? estate.witnessPublic : null),
      at: FIXED_NOW,
      allowUnlogged: true,
    });
    expect(r.checks.witness).toBe("failed");
    expect(r.failures.join(" ")).toContain("unknown_key");
  });

  it("the key port keeps company and Trooth keys apart", async () => {
    const estate = await buildEstate();
    expect(await estate.ports.keys.resolveCompany("acme-inc", estate.witnessPublic.kid)).toBeNull();
    expect(await estate.ports.keys.resolveTrooth(estate.companyPublic.kid)).toBeNull();
    expect((await estate.ports.keys.resolveCompany("acme-inc", estate.companyPublic.kid))?.kid).toBe(estate.companyPublic.kid);
    expect(await estate.ports.keys.resolveCompany("beta-ltd", estate.companyPublic.kid)).toBeNull();
  });

  it("the kits check a checkpoint against Trooth's keys only, with Trooth's signer name and origin", async () => {
    const keys = vector("keys.json");
    const log = vector("log.json");
    expect((await V.verifyCheckpoint(log.checkpoint, keys)).ok).toBe(true);
    // The same checkpoint with only the company's keys offered as Trooth's: no Trooth key matches.
    expect((await V.verifyCheckpoint(log.checkpoint, { company: keys.company, trooth: { keys: [] } })).ok).toBe(false);
    const renamed = log.checkpoint.replace("— trooth.co ", "— acme.com ");
    expect(await V.verifyCheckpoint(renamed, keys)).toEqual({ ok: false, reason: "wrong_signer" });
    expect(await V.verifyCheckpoint(log.checkpoint.replace("trooth.co/semanto/log/v1", "acme.com/log"), keys)).toEqual({ ok: false, reason: "wrong_origin" });
  });
});

// ------------------------------------------------------------------ 3

describe("finding 3: a key is judged at the signature's iat, not at now", () => {
  it("rotated after signing verifies; revoked after signing verifies with a note; revoked before signing fails", async () => {
    const kp = await generateKeyPair();
    const iat = new Date("2026-10-22T12:00:00Z");
    const later = new Date("2026-12-01T00:00:00Z");
    const s = await signObject({ a: 1 }, kp.privateJwk, JWS_TYPES.semantoVersion, { iat });
    const rotated = { ...kp.publicJwk, exp: "2026-10-22T12:00:05Z" };
    expect((await verifyJws(s.compact, () => rotated, { at: later })).ok).toBe(true);
    const revokedAfter = { ...kp.publicJwk, revoked_at: "2026-10-22T12:00:05Z" };
    const r = await verifyJws(s.compact, () => revokedAfter, { at: later });
    expect(r.ok && r.notes).toEqual(["key revoked after signing on 2026-10-22T12:00:05Z"]);
    const revokedBefore = { ...kp.publicJwk, revoked_at: "2026-10-21T00:00:00Z" };
    expect(await verifyJws(s.compact, () => revokedBefore, { at: later })).toEqual({ ok: false, reason: "key_revoked" });
  });

  it("core verifyMessage judges the key at created", async () => {
    const kp = await generateKeyPair();
    const headers = { "content-type": "text/plain", "content-digest": await contentDigest("x") };
    const signed = await signMessage({ kind: "response", status: 200, headers }, kp.privateJwk, { components: ["@status", "content-digest"], created: 1_792_000_000, ttlSeconds: 3600 });
    const all = { ...headers, ...signed };
    const retiredBefore = new Date((1_792_000_000 - 10) * 1000).toISOString();
    const ok = await verifyMessage({ kind: "response", status: 200, headers: all }, { resolveKey: () => ({ ...kp.publicJwk, exp: retiredBefore }), now: 1_792_000_100 });
    expect(ok).toEqual({ ok: false, reason: "key_expired" });
    const created = new Date(1_792_000_000_000).toISOString();
    const later = new Date(1_792_000_050_000).toISOString();
    expect((await verifyMessage({ kind: "response", status: 200, headers: all }, { resolveKey: () => ({ ...kp.publicJwk, exp: later }), now: 1_792_000_100 })).ok).toBe(true);
    expect((await verifyMessage({ kind: "response", status: 200, headers: all }, { resolveKey: () => ({ ...kp.publicJwk, revoked_at: created }), now: 1_792_000_100 })).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ 4, 11, 12, 19 (signed redirect)

describe("findings 4, 11 and 12: the response signature", () => {
  let estate: Estate;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    estate = await buildEstate();
    app = createApp({ ports: estate.ports });
  });

  it("finding 4: a page's JSON-LD carries Trooth-Page-Hash of its own bytes and Trooth-Signed-Page-Hash of the page, and the kit accepts it", async () => {
    const kp = await generateKeyPair();
    const body = utf8(JSON.stringify({ "@context": "https://schema.org", name: "x" }));
    const markdownHash = `sha256:${"ab".repeat(32)}`;
    const p = await buildResponse({ status: 200, rep: "jsonld", body, version_id: "smv_aaaaaaaaaaaaaaaaaaaaaaaaaa", page_hash: markdownHash, signer: { key: kp.privateJwk, by: "company" }, now: FIXED_NOW });
    expect(p.headers["Trooth-Page-Hash"]).toBe(await digest(body));
    expect(p.headers["Trooth-Signed-Page-Hash"]).toBe(markdownHash);
    expect(p.headers["Signature-Input"]).toContain('"trooth-signed-page-hash"');
    const r = await V.verifyResponse(p.status, p.headers, body, { keys: [kp.publicJwk] }, { now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });

  it("finding 4: a page behind its live copy verifies with the kit end to end", async () => {
    const id = estate.acme.entries[1]!.id;
    estate.store.companies.get("acme-inc")!.live.set(id, "behind");
    try {
      const res = await app.request(`${BASE}/acme-inc/pages/${id}`, { headers: { accept: "text/markdown" } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const r = await V.verifyResponse(res.status, headers, bytes, { company: { keys: [estate.companyPublic] }, trooth: { keys: [estate.witnessPublic] } }, { now: FIXED_NOW });
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.signed_page_hash).toBe(estate.acme.entries[1]!.hash);
      expect(headers["signature-input"]).toContain('"trooth-semanto-state"');
    } finally {
      estate.store.companies.get("acme-inc")!.live.delete(id);
    }
  });

  it("finding 11: Trooth-Signed-By, Trooth-Semanto-State, Content-Signal and Link are covered when present, and an injected Trooth header fails", async () => {
    const res = await app.request(`${BASE}/beta-ltd`, { headers: { accept: "application/json" } });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    expect(headers["trooth-signed-by"]).toBe("witness");
    const covered = Object.values(parseSignatureInput(headers["signature-input"]!))[0]!.components;
    expect(covered).toEqual(expect.arrayContaining(["trooth-signed-by"]));
    const page = await app.request(`${BASE}/acme-inc/pages/${estate.acme.entries[0]!.id}`, { headers: { accept: "text/markdown" } });
    const pc = Object.values(parseSignatureInput(page.headers.get("signature-input")!))[0]!.components;
    expect(pc).toEqual(expect.arrayContaining(["content-signal", "link"]));
    const bytes = new Uint8Array(await page.arrayBuffer());
    const ph: Record<string, string> = {};
    page.headers.forEach((v, k) => (ph[k] = v));
    const injected = await V.verifyResponse(200, { ...ph, "trooth-semanto-state": "behind" }, bytes, { keys: [estate.companyPublic] }, { now: FIXED_NOW });
    expect(injected.ok).toBe(false);
    expect(injected.reason).toBe("header_not_covered");
  });

  it("finding 12: the signature lasts max-age plus stale-while-revalidate, so a response served at the end of its cache life still verifies", async () => {
    expect(SIGNATURE_TTL_SECONDS).toBe(3900);
    const kp = await generateKeyPair();
    const body = utf8("# Pricing\n");
    const p = await buildResponse({ status: 200, rep: "markdown", body, version_id: "smv_aaaaaaaaaaaaaaaaaaaaaaaaaa", signer: { key: kp.privateJwk, by: "company" }, now: FIXED_NOW });
    const t0 = Math.floor(FIXED_NOW.getTime() / 1000);
    expect((await V.verifyResponse(200, p.headers, body, { keys: [kp.publicJwk] }, { now: t0 + 3899 })).ok).toBe(true);
    expect((await V.verifyResponse(200, p.headers, body, { keys: [kp.publicJwk] }, { now: t0 + 3900 })).reason).toBe("expired");
  });

  it("finding 19: the 303 to the company's page is signed, with Location covered", async () => {
    const res = await app.request(`${BASE}/acme-inc/pages/${estate.acme.entries[0]!.id}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(estate.acme.entries[0]!.url);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const covered = Object.values(parseSignatureInput(headers["signature-input"]!))[0]!.components;
    expect(covered).toContain("location");
    const r = await V.verifyResponse(303, headers, new Uint8Array(0), { keys: [estate.companyPublic] }, { now: FIXED_NOW });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  });
});

// ------------------------------------------------------------------ 5

const NOW = 1_792_000_000;
const AGENT = "https://agent.fixtureagent.com";
const DIR = `${AGENT}${DIRECTORY_PATH}`;

async function agentRequest(priv: PrivateJwk, opts: { url?: string; agent?: string; nonce?: string; label?: string } = {}) {
  const headers: Record<string, string> = { "signature-agent": `"${opts.agent ?? AGENT}"` };
  const s = await signMessage({ kind: "request", method: "GET", url: opts.url ?? "https://acme.com/pricing", headers }, priv, { label: opts.label ?? "sig1", components: ["@authority", "signature-agent"], created: NOW - 5, ttlSeconds: 60, nonce: opts.nonce ?? "n-1", tag: "web-bot-auth" });
  return { headers: { ...headers, "signature-input": s["Signature-Input"], signature: s.Signature }, url: opts.url ?? "https://acme.com/pricing" };
}

describe("finding 5: the key directory fetch cannot be pointed anywhere", () => {
  const deps = (http: MemoryHttp, extra: Partial<WebBotAuthDeps> = {}): WebBotAuthDeps => ({ http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => NOW, ...extra });

  it("never fetches a private, reserved or local name, or an IP literal, named in an unsigned request", async () => {
    for (const agent of ["https://internal-admin.example/anything?x=1", "https://10.0.0.1", "https://8.8.8.8", "https://localhost.", "https://[::ffff:0:7f00:1]", "http://agent.fixtureagent.com"]) {
      const http = new MemoryHttp({});
      const r = await verifyWebBotAuth({ method: "GET", url: "https://acme.com/pricing", headers: { "signature-agent": `"${agent}"`, "signature-input": `s=("@authority" "signature-agent");created=${NOW};expires=${NOW + 60};keyid="k";nonce="n";tag="web-bot-auth"`, signature: "s=:AAAA:" } }, deps(http));
      expect(r.proven).toBe(false);
      expect(http.calls).toEqual([]);
    }
  });

  it("drops the requester's path and query, refuses a redirect, remembers a failure for five minutes, and caps the body", async () => {
    const kp = await generateKeyPair();
    const http = new MemoryHttp({ [DIR]: { status: 302, headers: { location: "http://169.254.169.254/" }, body: "" } });
    const d = deps(http);
    const req = await agentRequest(kp.privateJwk, { agent: `${AGENT}/somewhere/else?x=1` });
    const r1 = await verifyWebBotAuth({ method: "GET", ...req }, d);
    expect(r1).toMatchObject({ proven: false, reason: "directory_unreachable" });
    expect(http.calls).toEqual([DIR]);
    // A flood after a failure does not reach the origin again inside the negative-cache window.
    for (let i = 0; i < 5; i++) await verifyWebBotAuth({ method: "GET", ...(await agentRequest(kp.privateJwk, { nonce: `n-${i + 2}` })) }, d);
    expect(http.calls).toEqual([DIR]);
    const big = new MemoryHttp({ [DIR]: { status: 200, headers: {}, body: JSON.stringify({ keys: [kp.publicJwk], pad: "x".repeat(70 * 1024) }) } });
    expect(await fetchDirectory(AGENT, deps(big))).toMatchObject({ ok: false, reason: "directory_malformed" });
  });

  it("clamps the cache TTL between five minutes and a day, and refuses a name that resolves to a private address or does not resolve", async () => {
    const kp = await generateKeyPair();
    const body = JSON.stringify({ keys: [kp.publicJwk] });
    const short = deps(new MemoryHttp({ [DIR]: { status: 200, headers: { "cache-control": "max-age=1" }, body } }));
    await fetchDirectory(AGENT, short);
    expect((await short.cache.get(DIR))!.expires_at).toBe(NOW * 1000 + 300 * 1000);
    const long = deps(new MemoryHttp({ [DIR]: { status: 200, headers: { "cache-control": "max-age=999999999" }, body } }));
    await fetchDirectory(AGENT, long);
    expect((await long.cache.get(DIR))!.expires_at).toBe(NOW * 1000 + 86400 * 1000);
    const rebinding = new MemoryHttp({ [DIR]: { status: 200, headers: {}, body } });
    expect(await fetchDirectory(AGENT, deps(rebinding, { resolve: async () => ["127.0.0.1"] }))).toMatchObject({ ok: false, reason: "directory_refused" });
    expect(await fetchDirectory(AGENT, deps(rebinding, { resolve: async () => { throw new Error("DoH down"); } }))).toMatchObject({ ok: false, reason: "directory_refused" });
    expect(rebinding.calls).toEqual([]);
  });

  it("platformHttp never follows a redirect, cuts the body at the cap and passes a timeout signal", async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("y".repeat(1000), { status: 200 });
    }) as typeof fetch;
    const r = await platformHttp(fake).get("https://agent.fixtureagent.com/x", {}, { maxBytes: 100, timeoutMs: 3000 });
    expect(r.tooLarge).toBe(true);
    expect(seen[0]!.redirect).toBe("manual");
    expect(seen[0]!.signal).toBeDefined();
  });
});

// ------------------------------------------------------------------ 6

describe("finding 6: one label is chosen, checked and its nonce claimed", () => {
  it("a decoy label with a fresh nonce cannot replay a captured request", async () => {
    const kp = await generateKeyPair();
    const http = new MemoryHttp({ [DIR]: { status: 200, headers: {}, body: JSON.stringify({ keys: [kp.publicJwk] }) } });
    const d: WebBotAuthDeps = { http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => NOW };
    const orig = await agentRequest(kp.privateJwk, { nonce: "n-orig" });
    expect((await verifyWebBotAuth({ method: "GET", ...orig }, d)).proven).toBe(true);
    expect(await verifyWebBotAuth({ method: "GET", ...orig }, d)).toMatchObject({ proven: false, reason: "replayed_nonce" });
    const decoy = `a=("@authority" "signature-agent");created=${NOW - 5};expires=${NOW + 55};keyid="${kp.publicJwk.kid}";alg="ed25519";nonce="fresh-1";tag="web-bot-auth"`;
    const replay = await verifyWebBotAuth({ method: "GET", url: orig.url, headers: { ...orig.headers, "signature-input": `${decoy}, ${orig.headers["signature-input"]}`, signature: `a=:${toBase64(new Uint8Array(64))}:, ${orig.headers.signature}` } }, d);
    expect(replay).toMatchObject({ proven: false, reason: "more_than_one_label" });
  });

  it("verifyMessage with a label verifies that label only", async () => {
    const kp = await generateKeyPair();
    const a = await agentRequest(kp.privateJwk, { label: "real" });
    const v = await verifyMessage({ kind: "request", method: "GET", url: a.url, headers: a.headers }, { resolveKey: () => kp.publicJwk, now: NOW, label: "other" });
    expect(v.ok).toBe(false);
    expect((await verifyMessage({ kind: "request", method: "GET", url: a.url, headers: a.headers }, { resolveKey: () => kp.publicJwk, now: NOW, label: "real" })).ok).toBe(true);
  });

  it("NonceDO claims atomically: of many simultaneous claims of one nonce exactly one wins, and it frees after the TTL", async () => {
    let clock = 1_000_000;
    const dobj = new NonceDO({ storage: new MemoryNonceStorage() }, null, () => clock);
    const results = await Promise.all(Array.from({ length: 25 }, () => dobj.claim("kid:n-1", 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await dobj.claim("kid:n-2", 60)).toBe(true);
    clock += 61_000;
    expect(await dobj.claim("kid:n-1", 60)).toBe(true);
    await dobj.alarm();
    // Over the namespace, as the Worker uses it.
    const objects = new Map<string, NonceDO>();
    const ns = {
      idFromName: (n: string) => n,
      get: (id: never) => {
        const key = id as unknown as string;
        if (!objects.has(key)) objects.set(key, new NonceDO({ storage: new MemoryNonceStorage() }, null, () => clock));
        const o = objects.get(key)!;
        return { fetch: (input: Request | string, init?: RequestInit) => o.fetch(new Request(input, init)) };
      },
    };
    const store = new DurableNonceStore(ns);
    const both = await Promise.all([store.claim("kid:z", clock + 60_000, clock), store.claim("kid:z", clock + 60_000, clock)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 7

describe("finding 7: a reader is proven through an adapter only when the adapter signed the forwarding", () => {
  it("a Web Bot Auth request through the shared adapter code is proven; a forged Trooth-Forwarded-Authority without the connector signature is not", async () => {
    const estate = await buildEstate();
    const agent = await generateKeyPair();
    const connector = await generateConnectorKey();
    const http = new MemoryHttp({ [DIR]: { status: 200, headers: {}, body: JSON.stringify({ keys: [agent.publicJwk] }) } });
    const nowS = Math.floor(FIXED_NOW.getTime() / 1000);
    const readers = webBotAuthReaders({ http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => nowS }, async (id) => (id === "acme-inc" ? { domain: "acme.com", connectorKeys: [connector.publicJwk as unknown as PublicJwk] } : null));
    const app = createApp({ ports: estate.ports, readers });
    const apiFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
    // The host entry passes the platform's own client address (adapters/cloudflare-worker reads Cloudflare's CF-Connecting-IP); the shared code never reads a request header for it.
    const config = { troothId: "acme-inc", apiBase: "https://api.trooth.co", mode: "semanto_only", connectorKey: connector.privateJwk, now: () => nowS, clientAddress: "203.0.113.9" };

    const headers: Record<string, string> = { accept: "text/markdown", "signature-agent": `"${AGENT}"`, "cf-connecting-ip": "203.0.113.9" };
    const signed = await signMessage({ kind: "request", method: "GET", url: "https://acme.com/pricing", headers }, agent.privateJwk, { components: ["@authority", "signature-agent"], created: nowS - 5, ttlSeconds: 60, nonce: "through-adapter", tag: "web-bot-auth" });
    const request = new Request("https://acme.com/pricing", { headers: { ...headers, ...signed } });
    const res = await handleRequest({ request, config, manifestCache: createManifestCache({ config, fetchImpl: apiFetch }), fetchImpl: apiFetch, next: async () => new Response("<html></html>") });
    expect(res.status).toBe(200);
    await settle();
    const proven = estate.ports.receipts.recorded.find((r) => r.page_id !== null)!;
    expect(proven).toMatchObject({ proof: "web_bot_auth", keyid: agent.publicJwk.kid, address: "203.0.113.9" });

    // The same agent request sent straight to the API with a forged forwarded authority and no connector signature.
    const again = await signMessage({ kind: "request", method: "GET", url: "https://acme.com/pricing", headers }, agent.privateJwk, { components: ["@authority", "signature-agent"], created: nowS - 5, ttlSeconds: 60, nonce: "forged-forwarding", tag: "web-bot-auth" });
    estate.ports.receipts.recorded.length = 0;
    await app.request(`${BASE}/acme-inc/pages/${estate.acme.entries[2]!.id}`, { headers: { ...headers, ...again, "trooth-forwarded-authority": "acme.com", "trooth-forwarded-for": "198.51.100.1" } });
    await settle();
    expect(estate.ports.receipts.recorded[0]).toMatchObject({ proof: "none" });
    // The forged Trooth-Forwarded-For is ignored too: the address is the one the platform saw.
    expect(estate.ports.receipts.recorded[0]!.address).toBe("203.0.113.9");
  });

  it("proveReader ignores a forwarded authority whose connector key is not the company's", async () => {
    const agent = await generateKeyPair();
    const stranger = await generateKeyPair();
    const http = new MemoryHttp({ [DIR]: { status: 200, headers: {}, body: JSON.stringify({ keys: [agent.publicJwk] }) } });
    const r = await proveReader({ method: "GET", url: `${BASE}/acme-inc/by-path/pricing`, headers: { "trooth-forwarded-authority": "acme.com", "trooth-connector-signature-input": 'adapter=("@method");created=1;keyid="x";tag="trooth-connector"', "trooth-connector-signature": "adapter=:AAAA:" } }, { http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => NOW }, { domain: "acme.com", connectorKeys: [stranger.publicJwk] });
    expect(r.proven).toBe(false);
    expect(r.via_adapter).toBeUndefined();
  });
});

// ------------------------------------------------------------------ 8

describe("finding 8: workspace roles are read honestly and enforced", () => {
  const session = (body: Record<string, unknown>): ServiceFetcher => ({ fetch: async () => new Response(JSON.stringify({ authenticated: true, companyId: "co-acme", userId: "u-1", email: "ada@acme.com", role: "vendor", ...body }), { status: 200 }) });
  const req = new Request("https://api.trooth.co/os/semanto/acme/build", { method: "POST", headers: { authorization: "Bearer t" } });

  it("an explicit workspaceRole is used; without it only the registered owner is owner", async () => {
    expect((await troothOsAuthorize(session({ workspaceRole: "viewer" }), async () => "acme", async () => "u-1")(req, "acme"))?.role).toBe("viewer");
    expect((await troothOsAuthorize(session({ workspaceRole: "admin" }), async () => "acme")(req, "acme"))?.role).toBe("admin");
    expect((await troothOsAuthorize(session({}), async () => "acme")(req, "acme"))?.role).toBe("member");
    expect((await troothOsAuthorize(session({}), async () => "acme", async () => "u-1")(req, "acme"))?.role).toBe("owner");
    expect((await troothOsAuthorize(session({ workspaceRole: "superuser" }), async () => "acme")(req, "acme"))?.role).toBe("member");
  });

  it("a viewer can start nothing; a member cannot sign, rotate keys, bind an LEI or add a connector", async () => {
    const p = new Pipeline({} as PipelineDeps);
    const viewer: WorkspaceAuth = { trooth_id: "acme", role: "viewer", user_id: "u-v", name: "V" };
    const member: WorkspaceAuth = { trooth_id: "acme", role: "member", user_id: "u-m", name: "M" };
    for (const a of ["build", "gap-report", "monitor/run", "basic/prove", "first-publication"] as const) expect((await p.handle(a, viewer, "acme", {})).problem?.code).toBe("forbidden");
    for (const a of ["sign", "keys/rotate", "lei", "connectors"] as const) expect((await p.handle(a, member, "acme", {})).problem?.code).toBe("forbidden");
  });
});

// ------------------------------------------------------------------ 9

describe("finding 9: the shared SSRF guard", () => {
  it("refuses trailing-dot local names and IPv4 hidden in IPv6 forms", () => {
    for (const u of ["https://localhost./", "https://foo.localhost./", "https://[::ffff:0:7f00:1]/", "https://[2002:7f00:1::]/", "https://[2002:a9fe:a9fe::]/", "https://[64:ff9b:1::a9fe:a9fe]/", "https://[fec0::1]/", "https://[::ffff:127.0.0.1]/", "https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/", "https://[64:ff9b::a9fe:a9fe]/", "https://[100::1]/", "https://[3fff::1]/"]) {
      expect([u, checkUrl(u).ok]).toEqual([u, false]);
    }
    expect(classifyAddress("2002:a9fe:a9fe::")).toBe("metadata");
    expect(classifyAddress("2001:0:4136:e378:8000:63bf:80ff:fffe")).toBe("loopback");
    expect(checkUrl("https://acme.com/").ok).toBe(true);
    expect(checkUrl("https://[2606:4700::1111]/").ok).toBe(true);
  });

  it("the DNS over HTTPS resolver fails closed, and so does the compiler's fetcher", async () => {
    const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(dohResolver(answering(500, {}))("acme.com")).rejects.toThrow();
    await expect(dohResolver(answering(200, { Status: 2 }))("acme.com")).rejects.toThrow();
    expect(await dohResolver(answering(200, { Status: 0, Answer: [{ type: 1, data: "93.184.215.14" }, { type: 5, data: "x." }] }))("acme.com")).toEqual(["93.184.215.14"]);
    expect(await checkUrlResolved("https://acme.com/", dohResolver(answering(200, { Status: 3 })))).toMatchObject({ ok: false, reason: "unresolvable" });
    const site = new SiteHttp({ "https://acme.com/": { status: 200, headers: {}, body: "<html></html>" } });
    const f = new Fetcher({ http: site, resolve: async () => { throw new Error("resolver down"); } }, { minIntervalMs: 0 });
    expect(await f.fetch("https://acme.com/")).toMatchObject({ ok: false, reason: "unresolvable" });
  });
});

// ------------------------------------------------------------------ 10

describe("finding 10: a page proof is strict", () => {
  it("a missing witness or log entry is absent and fails unless the caller allows it", async () => {
    const estate = await buildEstate();
    const entry = estate.acme.entries[0]!;
    const proof = (await buildPageProof(estate.acme.file, entry.id, null))!;
    const keys = { header: estate.acme.file.header, resolveCompanyKey: (k: string) => (k === estate.companyPublic.kid ? estate.companyPublic : null), resolveTroothKey: (k: string) => (k === estate.witnessPublic.kid ? estate.witnessPublic : null), at: FIXED_NOW };
    const strict = await verifyProof(proof, estate.acme.pages.get(entry.id)!, keys);
    expect(strict.ok).toBe(false);
    expect(strict.checks.ledger_inclusion).toBe("absent");
    const allowed = await verifyProof(proof, estate.acme.pages.get(entry.id)!, { ...keys, allowUnlogged: true });
    expect(allowed.ok).toBe(true);
    const unwitnessed = await verifyProof({ ...proof, witness: null }, estate.acme.pages.get(entry.id)!, { ...keys, allowUnlogged: true });
    expect(unwitnessed.checks.witness).toBe("absent");
    expect(unwitnessed.ok).toBe(false);
    expect((await verifyProof({ ...proof, witness: null }, estate.acme.pages.get(entry.id)!, { ...keys, allowUnlogged: true, allowUnwitnessed: true })).ok).toBe(true);
    expect((await verifyProof({ ...proof, signature: null }, estate.acme.pages.get(entry.id)!, { ...keys, allowUnlogged: true })).checks.signature).toBe("absent");
  });
});

// ------------------------------------------------------------------ 13 and 14

describe("findings 13 and 14: the adapter's answers", () => {
  let estate: Estate;
  let app: ReturnType<typeof createApp>;
  let apiFetch: typeof fetch;
  const config = { troothId: "acme-inc", apiBase: "https://api.trooth.co", mode: "semanto_only" };
  beforeAll(async () => {
    estate = await buildEstate();
    app = createApp({ ports: estate.ports });
    apiFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  });

  it("finding 13: the host's HTML gets Vary: Accept, merged with the Vary it had", async () => {
    const next = async () => new Response("<html></html>", { headers: { "Content-Type": "text/html", Vary: "Cookie" } });
    const res = await handleRequest({ request: new Request("https://acme.com/pricing", { headers: { Accept: "text/html" } }), config, manifestCache: null, fetchImpl: apiFetch, next });
    expect(res.headers.get("Vary")).toBe("Cookie, Accept");
    expect(mergeVary("Accept")).toBe("Accept");
    expect(mergeVary(null)).toBe("Accept");
  });

  it("finding 14: for every Accept and path, the adapter's upstream URL answers the same bytes as the API's by-path route", async () => {
    const manifestCache = createManifestCache({ config, fetchImpl: apiFetch });
    const manifest = await manifestCache.get();
    const paths = ["/", "/about", "/pricing", "/pricing.md", "/index.md", "/pricing.jsonld", "/about.jsonld", "/facts.jsonld"];
    const accepts = ["text/markdown", "application/ld+json", null, "text/*"];
    let compared = 0;
    for (const path of paths) {
      for (const accept of accepts) {
        const d = decide(path, accept, manifest, config);
        if (!d.serve) continue;
        const h: Record<string, string> = accept ? { accept } : {};
        const viaAdapter = new Uint8Array(await (await apiFetch(d.url, { headers: h })).arrayBuffer());
        const viaApi = new Uint8Array(await (await app.request(`${BASE}/acme-inc/by-path${path}`, { headers: h })).arrayBuffer());
        expect([path, accept, Buffer.from(viaAdapter).toString("utf8")]).toEqual([path, accept, Buffer.from(viaApi).toString("utf8")]);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

// ------------------------------------------------------------------ 15 (the parts that need no pipeline; the flow is in test/integration.test.ts)

describe("finding 15: llms.txt says what is true of the version", () => {
  it("one line per state, and the served file is rewritten to the state it is served with", () => {
    expect(trustLine("signed_and_witnessed", "https://acme.com/.well-known/trooth.semanto")).toContain("signed by the company and witnessed by Trooth");
    expect(trustLine("witnessed", "https://acme.com/.well-known/trooth.semanto")).toContain("witnessed by Trooth and not signed by the company");
    expect(trustLine("neither", "https://acme.com/.well-known/trooth.semanto")).toContain("not signed by the company or witnessed by Trooth yet");
    const built = buildLlmsTxt({ siteName: "Acme Inc", domain: "acme.com", summary: "Acme makes workflow software.", pages: [], troothId: "acme", networkUrl: "https://trooth.co/network/company/acme" });
    expect(built).toContain("not signed by the company or witnessed by Trooth yet");
    expect(withTrustState(built, "witnessed")).toContain("witnessed by Trooth and not signed by the company");
    expect(withTrustState(built, "signed_and_witnessed")).not.toContain("not signed");
  });
});

// ------------------------------------------------------------------ 16

describe("finding 16: the log appends in O(log n) from its frontier and proves from its tiles", () => {
  it("the frontier root equals the full recomputation for every size from 1 to 600", async () => {
    const leaves: Uint8Array[] = [];
    let f: Frontier = EMPTY_FRONTIER;
    for (let i = 0; i < 600; i++) {
      const lh = await leafHash(utf8(`leaf ${i}`));
      leaves.push(lh);
      f = await frontierAppend(f, lh);
      expect(Buffer.from(await frontierRoot(f)).equals(Buffer.from(await rootFromLeafHashes(leaves)))).toBe(true);
      expect(f.nodes.length).toBeLessThanOrEqual(Math.ceil(Math.log2(i + 2)));
    }
  }, 60_000);

  it("inclusion and consistency proofs from the 256-hash tiles equal the proofs from all leaves at sizes 255, 256, 257 and 513", async () => {
    const leaves: Uint8Array[] = [];
    const tiles = new Tiles(new MemoryTileBucket());
    for (let i = 0; i < 513; i++) {
      const lh = await leafHash(utf8(`leaf ${i}`));
      leaves.push(lh);
      await tiles.appendLeafHash(i, lh);
    }
    const hex = (xs: Uint8Array[]) => xs.map((x) => Buffer.from(x).toString("hex"));
    for (const size of [255, 256, 257, 513]) {
      const prefix = leaves.slice(0, size);
      for (const index of [0, 1, 127, 254, size - 1, Math.floor(size / 2)]) {
        if (index >= size) continue;
        expect(hex(await inclusionFromTiles(tiles, index, size))).toEqual(hex(await inclusionProof(prefix, index)));
      }
      for (const m of [1, 2, 100, 128, 255, 256, size - 1, size]) {
        if (m > size) continue;
        expect(hex(await consistencyFromTiles(tiles, m, size))).toEqual(hex(await consistencyProof(prefix, m)));
      }
    }
  }, 60_000);

  it("appends through LogDO are serialized: concurrent appends get distinct indexes and one consistent root", async () => {
    const w = await generateKeyPair();
    const store = new MemoryLogStore();
    const log = new TransparencyLog(store, w.privateJwk, () => FIXED_NOW);
    const dobj = new LogDO(null, null, log);
    const leaf = async (i: number) => ({ kind: "witness" as const, trooth_id: "acme", ref: `ref-${i}`, hash: await digest(`h${i}`), at: FIXED_NOW.toISOString() });
    const results = await Promise.all(Array.from({ length: 30 }, async (_, i) => dobj.append(await leaf(i))));
    expect(results.map((r) => r.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(await log.rootAt(30)).toBe(results.find((r) => r.tree_size === 30)!.root);
    // Without the Durable Object, a second writer that read a stale frontier is refused, never written at a taken index.
    const before = await store.frontier();
    await log.append(await leaf(100));
    await expect(store.appendLeaf(await leaf(101), await leafHash(utf8("x")), await frontierAppend(before, await leafHash(utf8("x"))))).rejects.toThrow(/serialized/);
  });
});

// ------------------------------------------------------------------ 17

describe("finding 17: the first-publication record is checkable where the statement points", () => {
  it("witnesses only url, content_hash and witnessed_at; title and author are declared by the requester; the check answers matches or differs", async () => {
    const kp = await generateKeyPair();
    const fp = await createFirstPublication({ url: "https://acme.com/blog/a", markdown: "# A post\n", title: "A post", author: "Ada", trooth_id: "acme-inc", witnessed_at: FIXED_NOW }, kp.privateJwk);
    expect(fp.record.declared).toEqual({ stated_by: "requester", title: "A post", author: "Ada" });
    expect("title" in fp.record).toBe(false);
    const estate = await buildEstate();
    const app = createApp({ ports: estate.ports, firstPublications: { get: async (id) => (id === fp.record.id ? fp : null) } });
    const doc = (await (await app.request(`${BASE}/first-publication/${fp.record.id}`)).json()) as FirstPublicationDocument;
    expect(doc).toMatchObject({ object: "semanto.first_publication_record", record: fp.record, jws: fp.jws, check_url: `${BASE}/first-publication/check` });
    const post = (body: unknown) => app.request(`${BASE}/first-publication/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const status = async (body: unknown) => ((await (await post(body)).json()) as { status: string }).status;
    expect(await status({ record_id: fp.record.id, markdown: "# A post\n" })).toBe("matches");
    expect(await status({ record_id: fp.record.id, markdown: "# Another post\n" })).toBe("differs");
    expect((await post({ record_id: fp.record.id })).status).toBe(400);
    expect((await checkAgainstRecord(doc, "# A post\n")).witnessed_hash).toBe(fp.record.content_hash);
  });
});

// ------------------------------------------------------------------ 19

describe("finding 19: malformed inputs, the kits' type registry, and errors", () => {
  it("created=abc and expires=abc are malformed, never treated as absent", async () => {
    const kp = await generateKeyPair();
    const headers = { "content-digest": await contentDigest("x") };
    const s = await signMessage({ kind: "response", status: 200, headers }, kp.privateJwk, { components: ["@status", "content-digest"], created: NOW, ttlSeconds: 60 });
    for (const bad of [s["Signature-Input"].replace(/created=\d+/, "created=abc"), s["Signature-Input"].replace(/expires=\d+/, "expires=abc")]) {
      const v = await verifyMessage({ kind: "response", status: 200, headers: { ...headers, "signature-input": bad, signature: s.Signature } }, { resolveKey: () => kp.publicJwk, now: NOW });
      expect(v).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("a JWS whose nbf, exp or iat does not parse, or whose header is not an object, is malformed", async () => {
    const kp = await generateKeyPair();
    const { importPrivate, sign } = await import("@/core/keys");
    const raw = async (header: unknown) => {
      const h = toBase64Url(utf8(JSON.stringify(header)));
      const p = toBase64Url(utf8(canonicalize({ a: 1 })));
      return `${h}.${p}.${toBase64Url(await sign(await importPrivate(kp.privateJwk), utf8(`${h}.${p}`)))}`;
    };
    for (const header of [{ alg: "EdDSA", kid: kp.publicJwk.kid, typ: "t", iat: "2026-10-22T12:00:00Z", nbf: "soon" }, { alg: "EdDSA", kid: kp.publicJwk.kid, typ: "t", iat: "2026-10-22T12:00:00Z", exp: 5 }, { alg: "EdDSA", kid: kp.publicJwk.kid, typ: "t", iat: "yesterday" }, null, [1, 2], "x"]) {
      expect(await verifyJws(await raw(header), () => kp.publicJwk)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("the JS kit's JWS_TYPES is the core registry, marketplaceCatalog included", () => {
    expect(V.JWS_TYPES).toEqual({ ...JWS_TYPES });
    expect(V.JWS_TYPES.marketplaceCatalog).toBe("https://trooth.co/types/marketplace-catalog");
  });

  it("a pipeline handler never returns an exception message: it logs it and answers with a request id", async () => {
    const logged: { id: string; error: unknown }[] = [];
    const p = new Pipeline({
      store: { getCompany: async () => { throw new Error("D1_ERROR: secret column os_owner_user_id at 10.0.0.7"); } },
      now: () => FIXED_NOW,
      random: (n: number) => new Uint8Array(n).fill(7),
      logError: (id: string, _a: string, error: unknown) => logged.push({ id, error }),
    } as unknown as PipelineDeps);
    const owner: WorkspaceAuth = { trooth_id: "acme", role: "owner", user_id: "u", name: "O" };
    const r = await p.handle("build", owner, "acme", {});
    // Audit finding 26: a fault inside Trooth is internal_error, never "an outside source failed".
    expect(r.problem?.code).toBe("internal_error");
    expect(r.problem?.detail).not.toContain("D1_ERROR");
    expect(r.problem?.detail).toContain("0707070707070707");
    expect(logged[0]!.id).toBe("0707070707070707");
    expect(String(logged[0]!.error)).toContain("D1_ERROR");
  });
});

// Keep the shared helper used by more than one block typed.
void toPublic;
