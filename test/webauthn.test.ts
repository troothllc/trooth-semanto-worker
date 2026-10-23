// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for passkey signing (W3C Web Authentication Level 3, sections 7.1 and
// 7.2): src/identity/cbor.ts, src/identity/webauthn.ts, the passkey routes in
// src/pipeline-passkeys.ts, the hosted sign route that releases the key only
// after an assertion for the exact version and root hash, the D1 store for
// passkeys, and Trooth-Request-Id on every response. Credentials are real
// ES256, Ed25519 and RS256 keys made in Node WebCrypto; authenticatorData,
// clientDataJSON and the attestationObject are written by hand
// (test/helpers/passkey.ts). Fixture company: Acme Inc, acme.com.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromBase64Url, toBase64Url, utf8 } from "@/core/encoding";
import { generateKeyPair, type PrivateJwk } from "@/core/keys";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { decodeCbor, CborError } from "@/identity/cbor";
import { checkSignature, creationOptions, derToRaw, readAssertion, readRegistration, requestOptions, verifyAssertion, verifyRegistration, webauthnConfig, CHALLENGE_TTL_MS, type CreationOptionsJSON, type PasskeyUser, type RequestOptionsJSON, type StoredPasskey } from "@/identity/webauthn";
import { mayBeSigned, type Authorization } from "@/identity/roles";
import { MemoryHttp as SiteHttp } from "@/compiler/ports";
import { MemoryVersionStore, memoryPorts, TEST_CONFIG } from "@/serve/memory-ports";
import { createApp, DASHBOARD_ORIGINS, DEVELOPMENT_DASHBOARD_ORIGIN, type RouteDeps } from "@/serve/routes";
import { EXPOSED_HEADERS } from "@/serve/headers";
import type { WorkspaceAuth } from "@/serve/ports";
import { MemoryHttp as IdentityHttp } from "@/identity/ports";
import { fetchFromMap, memoryStore } from "@/monitor/ports";
import { InMemoryCommerceStore } from "@/commerce/ports";
import { MemoryNonceStore } from "@/readers/ports";
import { MemoryPipelineStore } from "@/pipeline-store";
import { Pipeline, withCompanies, type PipelineDeps } from "@/pipeline";
import { D1PipelineStore } from "@/db/d1";
import { FixtureD1, FixtureR2 } from "./fixtures/integration/fixture-d1-shim";
import { cborEncode, FLAGS, PasskeyWallet, SoftAuthenticator, addPasskey, passkeySign, rawToDer, type Poster } from "./helpers/passkey";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const OS = "https://api.trooth.co/os/semanto";
const API = TEST_CONFIG.public_api_base;
const COMPILER = fileURLToPath(new URL("./fixtures/compiler/", import.meta.url));
const readCompiler = (name: string) => readFileSync(COMPILER + name, "utf8");
const CONFIG = webauthnConfig();
const b64 = (s: string) => toBase64Url(utf8(s));

// ------------------------------------------------------------------------ the pure checks

const USER: PasskeyUser = { user_id: "u-ada", handle: toBase64Url(new Uint8Array(32).fill(7)), created_at: NOW.toISOString() };
const CHALLENGE = toBase64Url(new Uint8Array(32).fill(9));

function createOpts(challenge = CHALLENGE): CreationOptionsJSON {
  return creationOptions({ config: CONFIG, user: USER, name: "Ada Owner", challenge, existing: [] });
}

async function registered(alg: "ES256" | "EdDSA" | "RS256" = "ES256"): Promise<{ auth: SoftAuthenticator; passkey: StoredPasskey }> {
  const auth = await SoftAuthenticator.create(alg);
  const input = readRegistration(await auth.register(createOpts()))!;
  const r = await verifyRegistration({ input, challenge: CHALLENGE, config: CONFIG });
  if (!r.ok) throw new Error(r.reason);
  const { fmt: _fmt, ...kept } = r.passkey;
  const passkey: StoredPasskey = { ...kept, user_id: USER.user_id, trooth_id: "acme", created_at: NOW.toISOString(), last_used_at: null };
  return { auth, passkey };
}

const getOpts = (passkeys: StoredPasskey[], challenge = CHALLENGE): RequestOptionsJSON => requestOptions({ config: CONFIG, challenge, passkeys });

describe("CBOR (RFC 8949, CTAP2 canonical form)", () => {
  it("decodes the shapes WebAuthn uses and refuses what CTAP2 never sends", () => {
    const m = decodeCbor(cborEncode(new Map<number | string, any>([[1, 2], [-1, 1], ["fmt", "none"], ["b", new Uint8Array([1, 2])], ["arr", [true, false, null]], [3, -257], [4, 70000], [5, 2 ** 40]])));
    expect(m).toBeInstanceOf(Map);
    const map = m as Map<number | string, unknown>;
    expect(map.get(1)).toBe(2);
    expect(map.get(-1)).toBe(1);
    expect(map.get(3)).toBe(-257);
    expect(map.get(4)).toBe(70000);
    expect(map.get(5)).toBe(2 ** 40);
    expect(map.get("fmt")).toBe("none");
    expect(map.get("b")).toEqual(new Uint8Array([1, 2]));
    expect(map.get("arr")).toEqual([true, false, null]);
    expect(() => decodeCbor(new Uint8Array([0x9f, 0xff]))).toThrow(CborError); // indefinite array
    expect(() => decodeCbor(new Uint8Array([0xc0, 0x00]))).toThrow(CborError); // a tag
    expect(() => decodeCbor(new Uint8Array([0xf9, 0x3c, 0x00]))).toThrow(CborError); // a half float
    expect(() => decodeCbor(new Uint8Array([0x42, 0x01]))).toThrow(CborError); // bytes cut short
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow(CborError); // extra bytes
    expect(() => decodeCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(CborError); // a repeated key
    let deep: any = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => decodeCbor(cborEncode(deep))).toThrow(CborError);
  });

  it("turns a DER ECDSA signature into raw r || s and refuses malformed DER", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r needs a leading zero in DER
    raw[63] = 1; // s is short in DER
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    expect(derToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeNull();
    expect(derToRaw(new Uint8Array([0x31, 0x00]))).toBeNull();
  });
});

describe("7.1 registration", () => {
  it("accepts ES256, EdDSA and RS256 credentials with attestation none, and keeps the public key as a JWK", async () => {
    for (const alg of ["ES256", "EdDSA", "RS256"] as const) {
      const { passkey, auth } = await registered(alg);
      expect(passkey.credential_id).toBe(auth.id);
      expect(passkey.alg).toBe({ ES256: -7, EdDSA: -8, RS256: -257 }[alg]);
      expect(passkey.public_jwk.kty).toBe({ ES256: "EC", EdDSA: "OKP", RS256: "RSA" }[alg]);
      expect(passkey.transports).toEqual(["internal", "hybrid"]);
      expect(passkey.sign_count).toBe(0);
    }
  });

  it("builds the creation options the brief names", () => {
    const o = createOpts();
    expect(o.rp).toEqual({ id: "trooth.co", name: "Trooth" });
    expect(fromBase64Url(o.user.id).length).toBe(32);
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(o.attestation).toBe("none");
    expect(o.authenticatorSelection).toEqual({ residentKey: "preferred", requireResidentKey: false, userVerification: "required" });
    expect(o.timeout).toBe(CHALLENGE_TTL_MS);
  });

  it("accepts packed self attestation and refuses packed with a certificate, other formats, and a wrong algorithm", async () => {
    const auth = await SoftAuthenticator.create("ES256");
    const packed = await verifyRegistration({ input: readRegistration(await auth.register(createOpts(), { fmt: "packed" }))!, challenge: CHALLENGE, config: CONFIG });
    expect(packed.ok && packed.passkey.fmt).toBe("packed");
    const u2f = await verifyRegistration({ input: readRegistration(await auth.register(createOpts(), { fmt: "fido-u2f" }))!, challenge: CHALLENGE, config: CONFIG });
    expect(u2f).toMatchObject({ ok: false, code: "attestation", reason: expect.stringContaining("does not accept") });
    const wrongAlg = await verifyRegistration({ input: readRegistration(await auth.register(createOpts(), { fmt: "packed", packedAlg: -8 }))!, challenge: CHALLENGE, config: CONFIG });
    expect(wrongAlg).toMatchObject({ ok: false, code: "attestation" });
    // A packed statement with x5c is full attestation: refused with a plain message.
    const reg = await auth.register(createOpts(), { fmt: "packed" });
    const att = decodeCbor(fromBase64Url((reg.credential.response as any).attestationObject)) as Map<string, any>;
    att.get("attStmt").set("x5c", [new Uint8Array(4)]);
    (reg.credential.response as any).attestationObject = toBase64Url(cborEncode(att));
    const x5c = await verifyRegistration({ input: readRegistration(reg)!, challenge: CHALLENGE, config: CONFIG });
    expect(x5c).toMatchObject({ ok: false, code: "attestation", reason: expect.stringContaining("maker certificate") });
  });

  it("refuses the wrong type, challenge, origin, rp id, and missing UP, UV or attested data", async () => {
    const auth = await SoftAuthenticator.create("EdDSA");
    const run = async (o: Parameters<SoftAuthenticator["register"]>[1]) => verifyRegistration({ input: readRegistration(await auth.register(createOpts(), o))!, challenge: CHALLENGE, config: CONFIG });
    expect(await run({ type: "webauthn.get" })).toMatchObject({ ok: false, code: "type" });
    expect(await run({ challenge: b64("another") })).toMatchObject({ ok: false, code: "challenge" });
    expect(await run({ origin: "https://trooth.co.fixture.test" })).toMatchObject({ ok: false, code: "origin" });
    expect(await run({ origin: "http://localhost:8787" })).toMatchObject({ ok: false, code: "origin" });
    expect(await run({ crossOrigin: true })).toMatchObject({ ok: false, code: "cross_origin" });
    expect(await run({ rpId: "acme.com" })).toMatchObject({ ok: false, code: "rp_id" });
    expect(await run({ flags: FLAGS.UV | FLAGS.AT })).toMatchObject({ ok: false, code: "user_present" });
    expect(await run({ flags: FLAGS.UP | FLAGS.AT })).toMatchObject({ ok: false, code: "user_verified" });
    expect(await run({ flags: FLAGS.UP | FLAGS.UV | FLAGS.AT | FLAGS.BS })).toMatchObject({ ok: false, code: "flags" });
    // Without AT the authenticator data ends after the counter: nothing to register.
    expect(await run({ flags: FLAGS.UP | FLAGS.UV })).toMatchObject({ ok: false });
    // The credential id the browser names must be the one the device made.
    const reg = await auth.register(createOpts());
    reg.credential.id = toBase64Url(new Uint8Array(16));
    reg.credential.rawId = reg.credential.id;
    expect(await verifyRegistration({ input: readRegistration(reg)!, challenge: CHALLENGE, config: CONFIG })).toMatchObject({ ok: false, code: "credential" });
  });

  it("accepts http://localhost only in development, and https://www.trooth.co always", async () => {
    const auth = await SoftAuthenticator.create("ES256");
    const dev = webauthnConfig({ development: true, rp_id: "localhost" });
    const devOpts = creationOptions({ config: dev, user: USER, name: "Ada", challenge: CHALLENGE, existing: [] });
    expect((await verifyRegistration({ input: readRegistration(await auth.register(devOpts, { origin: "http://localhost:5173" }))!, challenge: CHALLENGE, config: dev })).ok).toBe(true);
    expect((await verifyRegistration({ input: readRegistration(await auth.register(createOpts(), { origin: "https://www.trooth.co" }))!, challenge: CHALLENGE, config: CONFIG })).ok).toBe(true);
    expect(webauthnConfig().origins).toEqual(["https://trooth.co", "https://www.trooth.co"]);
    expect(webauthnConfig({ rp_id: "trooth.fixture.test" }).rp_id).toBe("trooth.fixture.test");
  });
});

describe("7.2 authentication", () => {
  it("accepts a fresh assertion from ES256, Ed25519 and RS256 passkeys", async () => {
    for (const alg of ["ES256", "EdDSA", "RS256"] as const) {
      const { auth, passkey } = await registered(alg);
      const input = readAssertion(await auth.assert(getOpts([passkey])))!;
      const r = await verifyAssertion({ input, challenge: CHALLENGE, config: CONFIG, passkey, user: USER });
      expect(r).toEqual({ ok: true, sign_count: 1, backed_up: false });
    }
  });

  it("refuses a wrong origin, wrong rp id, missing UV, a bad signature, another challenge, and another person's handle", async () => {
    const { auth, passkey } = await registered("ES256");
    const run = async (o: Parameters<SoftAuthenticator["assert"]>[1], p = passkey) => verifyAssertion({ input: readAssertion(await auth.assert(getOpts([p]), o))!, challenge: CHALLENGE, config: CONFIG, passkey: p, user: USER });
    expect(await run({ origin: "https://evil.fixture.test" })).toMatchObject({ ok: false, code: "origin" });
    expect(await run({ rpId: "evil.fixture.test" })).toMatchObject({ ok: false, code: "rp_id" });
    expect(await run({ flags: FLAGS.UP })).toMatchObject({ ok: false, code: "user_verified" });
    expect(await run({ flags: FLAGS.UV })).toMatchObject({ ok: false, code: "user_present" });
    expect(await run({ badSignature: true })).toMatchObject({ ok: false, code: "signature" });
    expect(await run({ challenge: b64("old") })).toMatchObject({ ok: false, code: "challenge" });
    expect(await run({ type: "webauthn.create" })).toMatchObject({ ok: false, code: "type" });
    const other = { ...(await auth.assert(getOpts([passkey]))), userHandle: toBase64Url(new Uint8Array(32)) };
    expect(await verifyAssertion({ input: readAssertion(other)!, challenge: CHALLENGE, config: CONFIG, passkey, user: USER })).toMatchObject({ ok: false, code: "credential" });
    // A signature made by another key over the same bytes does not check out.
    const stranger = await registered("ES256");
    expect(await verifyAssertion({ input: readAssertion(await auth.assert(getOpts([passkey])))!, challenge: CHALLENGE, config: CONFIG, passkey: { ...stranger.passkey, credential_id: passkey.credential_id }, user: USER })).toMatchObject({ ok: false, code: "signature" });
  });

  it("refuses a sign count that does not grow when either count is not zero, and accepts zero after zero", async () => {
    const { auth, passkey } = await registered("ES256");
    const at = (count: number, stored: number) => auth.assert(getOpts([passkey]), { signCount: count }).then((a) => verifyAssertion({ input: readAssertion(a)!, challenge: CHALLENGE, config: CONFIG, passkey: { ...passkey, sign_count: stored }, user: USER }));
    expect(await at(5, 4)).toMatchObject({ ok: true, sign_count: 5 });
    expect(await at(4, 4)).toMatchObject({ ok: false, code: "counter" });
    expect(await at(3, 4)).toMatchObject({ ok: false, code: "counter" });
    expect(await at(0, 4)).toMatchObject({ ok: false, code: "counter" });
    expect(await at(0, 0)).toMatchObject({ ok: true, sign_count: 0 });
  });

  it("checks RS256 with RSASSA-PKCS1-v1_5 and refuses a key whose type does not match the algorithm", async () => {
    const { passkey } = await registered("RS256");
    expect(await checkSignature(passkey.public_jwk, -7, new Uint8Array(70), new Uint8Array(4))).toBe(false);
  });
});

describe("the two-officer rule counts passkey assertions", () => {
  const rec = (user: string) => ({ role: "owner" as const, name: user, since: NOW.toISOString(), subject: `trooth:user:${user}` });
  const root = `sha256:${"1".repeat(64)}`;
  it("counts distinct users who each completed an assertion for the same root hash", () => {
    const pk = (user: string, cred: string) => ({ credential_id: cred, user_id: user, user_handle: `handle-${user}`, checked_at: NOW.toISOString() });
    const a: Authorization = { record: rec("u-ada"), at: NOW.toISOString(), root_hash: root, passkey: pk("u-ada", "c1") };
    const aAgain: Authorization = { record: rec("u-ada"), at: NOW.toISOString(), root_hash: root, passkey: pk("u-ada", "c2") };
    const bNoPasskey: Authorization = { record: rec("u-bo"), at: NOW.toISOString(), root_hash: root };
    const bOther: Authorization = { record: rec("u-bo"), at: NOW.toISOString(), root_hash: `sha256:${"2".repeat(64)}`, passkey: pk("u-bo", "c3") };
    const bForged: Authorization = { record: rec("u-bo"), at: NOW.toISOString(), root_hash: root, passkey: pk("u-ada", "c1") };
    const b: Authorization = { record: rec("u-bo"), at: NOW.toISOString(), root_hash: root, passkey: pk("u-bo", "c3") };
    const policy = { officers: "two_officer" as const, require_passkey: true };
    expect(mayBeSigned(root, [a, aAgain, bNoPasskey, bOther, bForged], policy)).toMatchObject({ allowed: false, missing: 1 });
    const ok = mayBeSigned(root, [a, b], policy);
    // The header entries name each person by their WebAuthn user handle only.
    expect(ok.allowed && ok.authorized_by?.map((e) => e.passkey)).toEqual([
      { credential_id: "c1", user_handle: "handle-u-ada", checked_at: NOW.toISOString() },
      { credential_id: "c3", user_handle: "handle-u-bo", checked_at: NOW.toISOString() },
    ]);
    expect(mayBeSigned(root, [bNoPasskey], { officers: "single", require_passkey: true }).allowed).toBe(false);
    expect(mayBeSigned(root, [bNoPasskey], { officers: "single" }).allowed).toBe(true);
  });
});

// ------------------------------------------------------------------------ over the routes

const WORKSPACES: Record<string, WorkspaceAuth> = {
  "Bearer owner-token": { trooth_id: "acme", role: "owner", user_id: "u-ada", name: "Ada Owner" },
  "Bearer admin-token": { trooth_id: "acme", role: "admin", user_id: "u-bo", name: "Bo Admin" },
  "Bearer member-token": { trooth_id: "acme", role: "member", user_id: "u-cy", name: "Cy Member" },
};

function fixtureSite(): SiteHttp {
  const http = new SiteHttp();
  http.set("https://acme.com/robots.txt", { body: readCompiler("robots.txt"), headers: { "content-type": "text/plain" } });
  http.set("https://acme.com/sitemap.xml", { body: readCompiler("sitemap.xml"), headers: { "content-type": "application/xml" } });
  for (const [url, file] of Object.entries({ "https://acme.com/": "index.html", "https://acme.com/about": "about.html", "https://acme.com/pricing": "pricing.html", "https://acme.com/contact": "contact.html" })) {
    http.set(url, { body: readCompiler(file), headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return http;
}

async function world(opts: { custody?: "hosted" | "customer"; development?: boolean; dashboardOrigins?: readonly string[] } = {}) {
  const clock = { now: new Date(NOW) };
  const now = () => new Date(clock.now);
  const w = await generateKeyPair();
  const versions = new MemoryVersionStore();
  const ports = memoryPorts(versions, w.privateJwk, { now });
  const store = new MemoryPipelineStore(versions);
  await store.putCompany({ trooth_id: "acme", domain: "acme.com", org: "Acme Inc", tier: "full", legal_name: "Acme Inc", current_version: null, custody: opts.custody ?? "hosted", domain_proven_at: NOW.toISOString() });
  const deps: PipelineDeps = {
    store,
    versions,
    keys: ports.keys,
    settings: ports.settings,
    log: ports.log,
    logStore: ports.log.store,
    commerce: withCompanies(new InMemoryCommerceStore(), store, API),
    config: TEST_CONFIG,
    now,
    site: { http: fixtureSite(), fetcher: { minIntervalMs: 0 } },
    monitor: { fetch: fetchFromMap({}), store: memoryStore() },
    identity: { http: new IdentityHttp({}) },
    gapAdapters: () => [],
    nonces: new MemoryNonceStore(),
    webauthn: webauthnConfig({ development: opts.development ?? false }),
  };
  const pipeline = new Pipeline(deps);
  const routeDeps: RouteDeps = { ports: { ...ports, jobs: pipeline.jobs() }, authorize: async (req) => WORKSPACES[req.headers.get("authorization") ?? ""] ?? null, workspace: pipeline, ...(opts.dashboardOrigins ? { dashboardOrigins: opts.dashboardOrigins } : {}) };
  const app = createApp(routeDeps);
  const post: Poster = (path, body, token) => app.request(`${OS}${path}`, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { clock, store, versions, pipeline, app, post, witness: w.privateJwk as PrivateJwk, wallet: new PasskeyWallet() };
}
type World = Awaited<ReturnType<typeof world>>;
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const OWNER = "Bearer owner-token";

async function built(w: World): Promise<{ version: number; root_hash: string }> {
  const r = await w.post("/acme/build", {}, OWNER);
  expect(r.status).toBe(200);
  const b = await json(r);
  return { version: b.version, root_hash: b.root_hash };
}

/** sign/options for the owner, with a passkey added first. */
async function signOptionsFor(w: World, token = OWNER, body: Record<string, unknown> = {}) {
  const auth = await w.wallet.for(token);
  if (!(await w.store.passkeys(WORKSPACES[token]!.user_id)).length) expect((await addPasskey(w.post, "acme", token, auth)).status).toBe(201);
  const r = await w.post("/acme/sign/options", body, token);
  expect(r.status).toBe(200);
  return { auth, options: (await json(r)) as { version: number; root_hash: string; expires_at: string; publicKey: RequestOptionsJSON } };
}

describe("passkey routes", () => {
  it("adds a passkey: options with a per-user handle and a single-use challenge, then the credential stored for that user", async () => {
    const w = await world();
    const o = await json(await w.post("/acme/passkeys/options", {}, OWNER));
    expect(o).toMatchObject({ object: "semanto.passkey_options", has_passkey: false, publicKey: { rp: { id: "trooth.co", name: "Trooth" }, attestation: "none", pubKeyCredParams: [{ alg: -7 }, { alg: -8 }, { alg: -257 }] } });
    expect(fromBase64Url(o.publicKey.challenge).length).toBe(32);
    expect(Date.parse(o.expires_at) - NOW.getTime()).toBe(5 * 60 * 1000);
    const handle = (await w.store.passkeyUser("u-ada"))!.handle;
    expect(o.publicKey.user).toEqual({ id: handle, name: "Ada Owner", displayName: "Ada Owner" });
    // The handle is per user and stable; the worker-f user id is never sent as the handle.
    expect((await json(await w.post("/acme/passkeys/options", {}, OWNER))).publicKey.user.id).toBe(handle);
    expect(handle).not.toBe(toBase64Url(utf8("u-ada")));
    const auth = await SoftAuthenticator.create("EdDSA");
    const reg = await auth.register(o.publicKey);
    const added = await w.post("/acme/passkeys", reg, OWNER);
    expect(added.status).toBe(201);
    expect(await json(added)).toMatchObject({ object: "semanto.passkey", credential_id: auth.id, alg: -8, transports: ["internal", "hybrid"], created_at: NOW.toISOString() });
    const stored = await w.store.passkeys("u-ada");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ credential_id: auth.id, user_id: "u-ada", trooth_id: "acme", public_jwk: { kty: "OKP", crv: "Ed25519" }, sign_count: 0 });
    // The same answer again: the challenge was used.
    const replay = await w.post("/acme/passkeys", reg, OWNER);
    expect(replay.status).toBe(409);
    expect((await json(replay)).code).toBe("passkey_challenge_expired");
    // A second options call lists the passkey to exclude.
    expect((await json(await w.post("/acme/passkeys/options", {}, OWNER))).publicKey.excludeCredentials).toEqual([{ type: "public-key", id: auth.id, transports: ["internal", "hybrid"] }]);
  });

  it("refuses a registration from another origin, after five minutes, or with another person's challenge", async () => {
    const w = await world();
    const auth = await SoftAuthenticator.create("ES256");
    const opts = async (token = OWNER) => (await json(await w.post("/acme/passkeys/options", {}, token))).publicKey as CreationOptionsJSON;
    const wrongOrigin = await w.post("/acme/passkeys", await auth.register(await opts(), { origin: "https://evil.fixture.test" }), OWNER);
    expect(wrongOrigin.status).toBe(403);
    expect(await json(wrongOrigin)).toMatchObject({ code: "passkey_origin_mismatch", title: "The passkey step ran on another site" });
    const local = await w.post("/acme/passkeys", await auth.register(await opts(), { origin: "http://localhost:8787" }), OWNER);
    expect((await json(local)).code).toBe("passkey_origin_mismatch");
    const late = await auth.register(await opts());
    w.clock.now = new Date(NOW.getTime() + CHALLENGE_TTL_MS + 1000);
    const expired = await w.post("/acme/passkeys", late, OWNER);
    expect(expired.status).toBe(409);
    expect(await json(expired)).toMatchObject({ code: "passkey_challenge_expired", title: "The passkey step took too long" });
    w.clock.now = new Date(NOW);
    const bos = await auth.register(await opts("Bearer admin-token"));
    expect((await json(await w.post("/acme/passkeys", bos, OWNER))).code).toBe("passkey_challenge_expired");
    expect((await w.post("/acme/passkeys", { credential: { id: "x" } }, OWNER)).status).toBe(400);
    expect(await w.store.passkeys("u-ada")).toEqual([]);
  });

  it("accepts http://localhost when the deployment is development", async () => {
    const w = await world({ development: true });
    const auth = await SoftAuthenticator.create("ES256");
    const o = (await json(await w.post("/acme/passkeys/options", {}, OWNER))).publicKey as CreationOptionsJSON;
    expect((await w.post("/acme/passkeys", await auth.register(o, { origin: "http://localhost:8787" }), OWNER)).status).toBe(201);
  });
});

describe("hosted signing releases the key only after a passkey assertion for this version and root hash", () => {
  it("end to end: refused without a passkey, refused without an assertion, signed after a valid one, recorded in the header", async () => {
    const w = await world();
    const v = await built(w);
    // No signing passkey yet: Add a signing passkey first, naming the options route.
    for (const path of ["/acme/sign", "/acme/sign/options"]) {
      const r = await w.post(path, {}, OWNER);
      expect(r.status).toBe(409);
      expect(await json(r)).toMatchObject({ code: "passkey_missing", title: "Add a signing passkey first", detail: expect.stringContaining(`${OS}/acme/passkeys/options`) });
    }
    const { auth, options } = await signOptionsFor(w);
    expect(options).toMatchObject({ version: v.version, root_hash: v.root_hash, publicKey: { rpId: "trooth.co", userVerification: "required", allowCredentials: [{ type: "public-key", id: auth.id }] } });
    // No assertion: the device step did not finish, nothing is signed, and the key was never used.
    const cancelled = await w.post("/acme/sign", { version: v.version }, OWNER);
    expect(cancelled.status).toBe(400);
    expect(await json(cancelled)).toMatchObject({ code: "passkey_cancelled", title: "The passkey step did not finish" });
    expect(await w.versions.getCurrent("acme")).toBeNull();
    // The assertion: signed, and the authorization names the passkey.
    const signed = await w.post("/acme/sign", { version: v.version, assertion: await auth.assert(options.publicKey) }, OWNER);
    expect(signed.status).toBe(200);
    expect(await json(signed)).toMatchObject({ object: "semanto.signed", version: v.version, root_hash: expect.stringMatching(/^sha256:/) });
    const file = (await w.versions.getCurrent("acme"))!;
    expect(file.header.state).toBe("signed");
    const handle = (await w.store.passkeyUser("u-ada"))!.handle;
    expect(file.header.identity.authorized_by).toEqual([{ role: "owner", name: "Ada Owner", passkey: { credential_id: auth.id, user_handle: handle, checked_at: NOW.toISOString() } }]);
    expect(fromBase64Url(handle).length).toBe(32);
    expect(JSON.stringify(file.header)).not.toContain("u-ada");
    const keys = await w.store.keys("acme");
    const check = await verifyJws(file.signature!.jws, (kid) => keys.find((k) => k.public_jwk.kid === kid)?.public_jwk ?? null, { expectTyp: JWS_TYPES.semantoVersion, payload: file.header, at: NOW });
    expect(check.ok).toBe(true);
    // The stored counter moved and the last use is recorded.
    expect(await w.store.getPasskey(auth.id)).toMatchObject({ sign_count: 1, last_used_at: NOW.toISOString() });
  });

  it("refuses a replayed challenge", async () => {
    const w = await world();
    const v = await built(w);
    const { auth, options } = await signOptionsFor(w);
    // Two officers, so the first approval does not finish the signing and the replay meets an unsigned version.
    await w.store.putConfig("acme", { ...(await w.store.getConfig("acme")), signing: { officers: "two_officer" } });
    const assertion = await auth.assert(options.publicKey);
    expect((await w.post("/acme/sign", { version: v.version, assertion }, OWNER)).status).toBe(202);
    const replay = await w.post("/acme/sign", { version: v.version, assertion }, OWNER);
    expect(replay.status).toBe(409);
    expect(await json(replay)).toMatchObject({ code: "passkey_challenge_expired" });
    // A fresh assertion over the same challenge is refused too: the challenge was used.
    const again = await w.post("/acme/sign", { version: v.version, assertion: await auth.assert(options.publicKey) }, OWNER);
    expect((await json(again)).code).toBe("passkey_challenge_expired");
  });

  it("refuses a challenge issued for a different root hash", async () => {
    const w = await world();
    await built(w);
    const { auth, options } = await signOptionsFor(w);
    // The site changes and a new version is built: the passkey answer was for the old root hash.
    const next = await built(w);
    expect(next.root_hash).not.toBe(options.root_hash);
    const r = await w.post("/acme/sign", { version: next.version, assertion: await auth.assert(options.publicKey) }, OWNER);
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ code: "passkey_invalid", detail: expect.stringContaining(`not version ${next.version} with root hash ${next.root_hash}`) });
    expect(await w.versions.getCurrent("acme")).toBeNull();
  });

  it("refuses a wrong origin, a wrong rp id, a missing UV flag, a bad signature and an expired challenge, each with plain words", async () => {
    const w = await world();
    const v = await built(w);
    const attempt = async (o: Parameters<SoftAuthenticator["assert"]>[1], late = false) => {
      const { auth, options } = await signOptionsFor(w);
      const assertion = await auth.assert(options.publicKey, o);
      if (late) w.clock.now = new Date(NOW.getTime() + CHALLENGE_TTL_MS + 1);
      const r = await w.post("/acme/sign", { version: v.version, assertion }, OWNER);
      w.clock.now = new Date(NOW);
      return { status: r.status, body: await json(r) };
    };
    expect(await attempt({ origin: "https://trooth.co.evil.fixture.test" })).toMatchObject({ status: 403, body: { code: "passkey_origin_mismatch", detail: expect.stringContaining("Nothing was signed") } });
    expect(await attempt({ rpId: "acme.com" })).toMatchObject({ status: 422, body: { code: "passkey_invalid", detail: expect.stringContaining("belongs to another site") } });
    expect(await attempt({ flags: FLAGS.UP })).toMatchObject({ status: 422, body: { code: "passkey_invalid", detail: expect.stringContaining("fingerprint, face or PIN") } });
    expect(await attempt({ badSignature: true })).toMatchObject({ status: 422, body: { code: "passkey_invalid", detail: expect.stringContaining("signature does not check out") } });
    expect(await attempt({}, true)).toMatchObject({ status: 409, body: { code: "passkey_challenge_expired" } });
    expect(await w.versions.getCurrent("acme")).toBeNull();
  });

  it("refuses a sign count that goes backwards as a possible copy", async () => {
    const w = await world();
    const v = await built(w);
    const { auth, options } = await signOptionsFor(w);
    // The stored count is ahead of what this authenticator says: a copied passkey would look like this.
    await w.store.touchPasskey(auth.id, 10, false, NOW.toISOString());
    const r = await w.post("/acme/sign", { version: v.version, assertion: await auth.assert(options.publicKey, { signCount: 3 }) }, OWNER);
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ code: "passkey_counter", title: "This passkey may have been copied" });
    expect((await w.store.getPasskey(auth.id))!.sign_count).toBe(10);
    expect(await w.versions.getCurrent("acme")).toBeNull();
  });

  it("two concurrent assertions at the same count over two challenges: exactly one signs", async () => {
    const w = await world();
    const v = await built(w);
    const auth = await w.wallet.for(OWNER);
    expect((await addPasskey(w.post, "acme", OWNER, auth)).status).toBe(201);
    const o1 = (await json(await w.post("/acme/sign/options", {}, OWNER))).publicKey as RequestOptionsJSON;
    const o2 = (await json(await w.post("/acme/sign/options", {}, OWNER))).publicKey as RequestOptionsJSON;
    expect(o1.challenge).not.toBe(o2.challenge);
    // A copied passkey: both answers carry count 1, each over its own fresh challenge.
    const a1 = await auth.assert(o1, { signCount: 1 });
    const a2 = await auth.assert(o2, { signCount: 1 });
    const [r1, r2] = await Promise.all([w.post("/acme/sign", { version: v.version, assertion: a1 }, OWNER), w.post("/acme/sign", { version: v.version, assertion: a2 }, OWNER)]);
    const results = [{ status: r1.status, body: await json(r1) }, { status: r2.status, body: await json(r2) }];
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.find((r) => r.status !== 200)).toMatchObject({ status: 422, body: { code: "passkey_counter" } });
    expect((await w.versions.getCurrent("acme"))!.header.version).toBe(v.version);
    expect(await w.store.getPasskey(auth.id)).toMatchObject({ sign_count: 1 });
  });

  it("refuses a member (not owner or admin), even with a passkey", async () => {
    const w = await world();
    const v = await built(w);
    const auth = await w.wallet.for("Bearer member-token");
    expect((await addPasskey(w.post, "acme", "Bearer member-token", auth)).status).toBe(201);
    const opts = await w.post("/acme/sign/options", {}, "Bearer member-token");
    expect(opts.status).toBe(403);
    // Even an assertion made against the owner's options is refused for the member.
    const { options } = await signOptionsFor(w);
    const r = await w.post("/acme/sign", { version: v.version, assertion: await auth.assert(options.publicKey) }, "Bearer member-token");
    expect(r.status).toBe(403);
    expect((await json(r)).code).toBe("forbidden");
    expect(await w.versions.getCurrent("acme")).toBeNull();
  });

  it("refuses an assertion from someone else's passkey or another person's challenge", async () => {
    const w = await world();
    const v = await built(w);
    const ada = await signOptionsFor(w);
    const bo = await signOptionsFor(w, "Bearer admin-token");
    // Bo answers Ada's challenge with his own passkey: the challenge is not his.
    const crossed = await w.post("/acme/sign", { version: v.version, assertion: await bo.auth.assert(ada.options.publicKey) }, "Bearer admin-token");
    expect((await json(crossed)).code).toBe("passkey_challenge_expired");
    // Ada answers her own challenge with Bo's passkey: not one of hers.
    const fresh = await signOptionsFor(w);
    const foreign = await w.post("/acme/sign", { version: v.version, assertion: await bo.auth.assert(fresh.options.publicKey) }, OWNER);
    expect(await json(foreign)).toMatchObject({ code: "passkey_invalid", detail: expect.stringContaining("not one of yours") });
  });

  it("two-officer: two distinct users, each with their own assertion for the same root hash", async () => {
    const w = await world();
    await w.store.putConfig("acme", { ...(await w.store.getConfig("acme")), signing: { officers: "two_officer" } });
    await built(w);
    const post = w.post;
    const first = await passkeySign(post, "acme", OWNER, w.wallet);
    expect(first.status).toBe(202);
    // The same person through a second passkey still counts once.
    const second = await SoftAuthenticator.create("EdDSA");
    expect((await addPasskey(post, "acme", OWNER, second)).status).toBe(201);
    const o = await json(await post("/acme/sign/options", {}, OWNER));
    expect(o.publicKey.allowCredentials).toHaveLength(2);
    const twice = await post("/acme/sign", { version: o.version, assertion: await second.assert(o.publicKey) }, OWNER);
    expect(twice.status).toBe(202);
    expect((await json(twice)).approvals_missing).toBe(1);
    // The approval record keeps the internal user id for the two-officer count, beside the handle the header gets.
    expect(w.store.auths.get("acme")).toHaveLength(1);
    expect(w.store.auths.get("acme")![0]!.passkey).toMatchObject({ credential_id: second.id, user_id: "u-ada", user_handle: (await w.store.passkeyUser("u-ada"))!.handle });
    const state = await json(await w.app.request(`${OS}/acme/setup`, { headers: { authorization: OWNER } }));
    expect(state.sign.approvals).toEqual([{ name: "Ada Owner", role: "owner", at: NOW.toISOString(), passkey: true }]);
    const done = await passkeySign(post, "acme", "Bearer admin-token", w.wallet);
    expect(done.status).toBe(200);
    const by = (await w.versions.getCurrent("acme"))!.header.identity.authorized_by!;
    expect(by.map((e) => e.passkey?.user_handle)).toEqual([(await w.store.passkeyUser("u-ada"))!.handle, (await w.store.passkeyUser("u-bo"))!.handle]);
    expect(JSON.stringify(by)).not.toMatch(/u-ada|u-bo/);
  });

  it("customer custody is unchanged: no passkey step, the company signs with its own key", async () => {
    const w = await world({ custody: "customer" });
    const customer = await generateKeyPair();
    const { d: _d, ...pub } = customer.privateJwk;
    expect((await w.post("/acme/keys/rotate", { public_jwk: pub }, OWNER)).status).toBe(200);
    await built(w);
    expect((await json(await w.post("/acme/sign/options", {}, OWNER))).code).toBe("conflict");
    expect((await json(await w.post("/acme/sign", {}, OWNER))).object).toBe("semanto.signing_input");
  });
});

describe("the passkey tables in D1 (migrations/0006_passkeys.sql)", () => {
  it("keeps users, passkeys and single-use challenges, and an approval's passkey", async () => {
    const store = new D1PipelineStore(new FixtureD1().asD1(), new FixtureR2().asR2());
    const u = await store.putPasskeyUser({ user_id: "u-ada", handle: "h1", created_at: NOW.toISOString() });
    expect(await store.putPasskeyUser({ user_id: "u-ada", handle: "h2", created_at: NOW.toISOString() })).toEqual(u);
    const { passkey } = await registered("ES256");
    await store.putPasskey(passkey);
    await expect(store.putPasskey({ ...passkey, user_id: "u-bo" })).rejects.toThrow();
    expect(await store.passkeys("u-ada")).toEqual([passkey]);
    expect(await store.touchPasskey(passkey.credential_id, 7, true, NOW.toISOString())).toBe(true);
    expect(await store.getPasskey(passkey.credential_id)).toMatchObject({ sign_count: 7, backed_up: true, last_used_at: NOW.toISOString() });
    // The conditional write: the same count again, or a lower one, changes no row and answers false.
    expect(await store.touchPasskey(passkey.credential_id, 7, false, NOW.toISOString())).toBe(false);
    expect(await store.touchPasskey(passkey.credential_id, 3, false, NOW.toISOString())).toBe(false);
    expect(await store.getPasskey(passkey.credential_id)).toMatchObject({ sign_count: 7, backed_up: true });
    // Zero after zero is allowed (an authenticator without a counter).
    const { passkey: zero } = await registered("EdDSA");
    await store.putPasskey(zero);
    expect(await store.touchPasskey(zero.credential_id, 0, false, NOW.toISOString())).toBe(true);
    expect(await store.touchPasskey(zero.credential_id, 0, false, NOW.toISOString())).toBe(true);
    const c = { challenge: "c1", kind: "get" as const, trooth_id: "acme", user_id: "u-ada", version: 2, root_hash: `sha256:${"3".repeat(64)}`, created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + CHALLENGE_TTL_MS).toISOString() };
    await store.putPasskeyChallenge(c);
    expect(await store.takePasskeyChallenge("c1", "get", "acme", "u-bo")).toBeNull();
    expect(await store.takePasskeyChallenge("c1", "create", "acme", "u-ada")).toBeNull();
    expect(await store.takePasskeyChallenge("c1", "get", "acme", "u-ada")).toEqual(c);
    expect(await store.takePasskeyChallenge("c1", "get", "acme", "u-ada")).toBeNull();
    const root = `sha256:${"4".repeat(64)}`;
    const record = { role: "owner" as const, name: "Ada", since: NOW.toISOString(), subject: "trooth:user:u-ada" };
    await store.addAuthorization("acme", { record, at: NOW.toISOString(), root_hash: root });
    const pk = { credential_id: passkey.credential_id, user_id: "u-ada", user_handle: "h1", checked_at: NOW.toISOString() };
    await store.addAuthorization("acme", { record, at: NOW.toISOString(), root_hash: root, passkey: pk });
    await store.addAuthorization("acme", { record, at: NOW.toISOString(), root_hash: root });
    expect(await store.authorizations("acme", root)).toEqual([{ record, at: NOW.toISOString(), root_hash: root, passkey: pk }]);
  });
});

describe("CORS for the /os routes", () => {
  it("allows https://trooth.co and https://www.trooth.co with Vary: Origin, and http://localhost only in development", async () => {
    const prod = await world();
    const origin = async (app: World["app"], o: string | null, method = "GET") => {
      const r = await app.request(`${OS}/acme/setup`, { method, headers: { authorization: OWNER, ...(o ? { origin: o } : {}) } });
      return { allow: r.headers.get("access-control-allow-origin"), vary: r.headers.get("vary") ?? "" };
    };
    for (const method of ["GET", "OPTIONS"]) {
      expect(await origin(prod.app, "https://trooth.co", method)).toMatchObject({ allow: "https://trooth.co", vary: expect.stringContaining("Origin") });
      expect(await origin(prod.app, "https://www.trooth.co", method)).toMatchObject({ allow: "https://www.trooth.co", vary: expect.stringContaining("Origin") });
      expect((await origin(prod.app, "http://localhost:5173", method)).allow).toBe("https://trooth.co");
      expect((await origin(prod.app, "https://evil.fixture.test", method)).allow).toBe("https://trooth.co");
      expect((await origin(prod.app, null, method)).allow).toBe("https://trooth.co");
    }
    // Public routes stay open to every origin.
    expect((await prod.app.request(`${API}/acme`, { headers: { origin: "https://evil.fixture.test" } })).headers.get("access-control-allow-origin")).toBe("*");
    const dev = await world({ dashboardOrigins: [...DASHBOARD_ORIGINS, DEVELOPMENT_DASHBOARD_ORIGIN] });
    expect((await origin(dev.app, "http://localhost:5173")).allow).toBe("http://localhost:5173");
    expect((await origin(dev.app, "http://localhost:5173", "OPTIONS")).allow).toBe("http://localhost:5173");
    expect((await origin(dev.app, "http://localhost.evil.fixture.test")).allow).toBe("https://trooth.co");
  });
});

describe("Trooth-Request-Id on every response", () => {
  it("is exposed to browsers and carried by answers, problems, preflights and unknown routes", async () => {
    expect(EXPOSED_HEADERS).toContain("Trooth-Request-Id");
    const w = await world();
    const responses = [
      await w.app.request(`${OS}/acme/setup`, { headers: { authorization: OWNER } }),
      await w.app.request(`${OS}/acme/setup`),
      await w.app.request(`${OS}/acme/sign`, { method: "OPTIONS" }),
      await w.app.request(`${API}/nothing-here/at-all/really`),
      await w.app.request(`${API}/acme`),
      await w.post("/acme/sign", {}, OWNER),
    ];
    const ids = responses.map((r) => r.headers.get("trooth-request-id"));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(responses[0]!.headers.get("access-control-expose-headers")).toContain("Trooth-Request-Id");
  });
});
