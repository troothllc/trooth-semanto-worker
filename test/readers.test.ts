// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/readers: Web Bot Auth verification and read receipts.
// The agent directory at https://agent.fixtureagent.com is a fixture (a
// plainly fictional public name: the SSRF guard refuses reserved names such as
// .example, so the fixture uses a .com name); the company is Acme Inc (acme).

import { describe, it, expect } from "vitest";
import { generateKeyPair, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { signMessage, contentDigest } from "@/core/httpsig";
import { verifyJws, JWS_TYPES } from "@/core/jws";
import { MemoryHttp, MemoryKeyCache, MemoryNonceStore, MemoryReceiptStore } from "@/readers/ports";
import { verifyWebBotAuth, parseSignatureAgent, directoryUrl, directoryDisplayName, fetchDirectory, DIRECTORY_PATH, type WebBotAuthDeps } from "@/readers/webbotauth";
import { makeReceipt, recordRead, hashIp, ipHashSalt, utcDay, signDailyDigest, verifyDailyDigest, summarize, dashboardRows, receiptsCsv, RECEIPT_RETENTION_DAYS, benchmark, BENCHMARK_MIN_COMPANIES, type Receipt } from "@/readers/receipts";

const NOW_S = 1_792_000_000; // a fixed unix time
const AGENT = "https://agent.fixtureagent.com";
const DIR = `${AGENT}${DIRECTORY_PATH}`;
const TARGET = "https://acme.com/pricing";

async function agentKeys(signDirectory: boolean): Promise<{ priv: PrivateJwk; pub: PublicJwk; body: string; headers: Record<string, string> }> {
  const kp = await generateKeyPair();
  const body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: kp.publicJwk.x, kid: kp.publicJwk.kid, alg: "EdDSA", use: "sig" }] });
  const headers: Record<string, string> = { "content-type": "application/http-message-signatures-directory+json", "cache-control": "max-age=600" };
  if (signDirectory) {
    const cd = await contentDigest(body);
    const signed = await signMessage({ kind: "response", status: 200, url: DIR, headers: { "content-digest": cd } }, kp.privateJwk, {
      label: "binding",
      components: ["@authority", "content-digest"],
      created: NOW_S - 100,
      ttlSeconds: 86400,
      tag: "http-message-signatures-directory",
    });
    headers["content-digest"] = cd;
    headers["signature-input"] = signed["Signature-Input"];
    headers["signature"] = signed.Signature;
  }
  return { priv: kp.privateJwk, pub: kp.publicJwk, body, headers };
}

function deps(dirBody: string, dirHeaders: Record<string, string>, now = NOW_S): WebBotAuthDeps & { http: MemoryHttp; nonces: MemoryNonceStore } {
  const http = new MemoryHttp({ [DIR]: { status: 200, headers: dirHeaders, body: dirBody } });
  return { http, cache: new MemoryKeyCache(), nonces: new MemoryNonceStore(), now: () => now };
}

async function signedRequest(priv: PrivateJwk, opts: { created?: number; ttl?: number; nonce?: string | null; tag?: string | null; components?: string[]; agent?: string } = {}) {
  const headers: Record<string, string> = { "signature-agent": `"${opts.agent ?? AGENT}"`, accept: "text/markdown" };
  const signed = await signMessage({ kind: "request", method: "GET", url: TARGET, headers }, priv, {
    components: opts.components ?? ["@authority", "signature-agent"],
    created: opts.created ?? NOW_S - 5,
    ttlSeconds: opts.ttl ?? 60,
    ...(opts.nonce === null ? {} : { nonce: opts.nonce ?? "nonce-fixture-1" }),
    ...(opts.tag === null ? {} : { tag: opts.tag ?? "web-bot-auth" }),
  });
  return { method: "GET", url: TARGET, headers: { ...headers, ...signed } };
}

describe("Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol-00)", () => {
  it("parses Signature-Agent as a structured-field string holding an https URL", () => {
    expect(parseSignatureAgent(`"${AGENT}"`)).toEqual({ ok: true, url: `${AGENT}/` });
    expect(parseSignatureAgent(`${AGENT}/keys.json`)).toEqual({ ok: true, url: `${AGENT}/keys.json` });
    expect(parseSignatureAgent('"http://agent.fixtureagent.com"')).toMatchObject({ ok: false, reason: "signature_agent_not_https" });
    expect(parseSignatureAgent('"not a url"')).toMatchObject({ ok: false });
    expect(parseSignatureAgent(null)).toMatchObject({ ok: false, reason: "no_signature_agent" });
    expect(directoryUrl(`${AGENT}/`)).toBe(DIR);
    // The directory is always the well-known path on the origin: a requester's path and query are dropped.
    expect(directoryUrl(`${AGENT}/keys.json?x=1`)).toBe(DIR);
  });

  it("proves a valid signed request and reports the directory url and keyid, nothing else", async () => {
    const a = await agentKeys(true);
    const d = deps(a.body, a.headers);
    const req = await signedRequest(a.priv);
    const r = await verifyWebBotAuth(req, d);
    expect(r).toEqual({ proven: true, agent_key_url: `${AGENT}/`, keyid: a.pub.kid, directory_signed: true });
    expect(d.http.calls).toEqual([DIR]);
    // The directory is cached; a second request with a new nonce does not refetch.
    const r2 = await verifyWebBotAuth(await signedRequest(a.priv, { nonce: "nonce-fixture-2" }), d);
    expect(r2.proven).toBe(true);
    expect(d.http.calls.length).toBe(1);
  });

  it("proves with an unsigned directory and says so", async () => {
    const a = await agentKeys(false);
    const r = await verifyWebBotAuth(await signedRequest(a.priv), deps(a.body, a.headers));
    expect(r).toMatchObject({ proven: true, directory_signed: false });
  });

  it("refuses a replayed nonce inside the window", async () => {
    const a = await agentKeys(true);
    const d = deps(a.body, a.headers);
    const req = await signedRequest(a.priv);
    expect((await verifyWebBotAuth(req, d)).proven).toBe(true);
    const again = await verifyWebBotAuth(req, d);
    expect(again).toMatchObject({ proven: false, reason: "replayed_nonce" });
    // A signature without a nonce is refused before any key is fetched.
    const noNonce = await verifyWebBotAuth(await signedRequest(a.priv, { nonce: null }), d);
    expect(noNonce).toMatchObject({ proven: false, reason: "missing_nonce" });
  });

  it("refuses a missing tag, a wrong tag, and missing components", async () => {
    const a = await agentKeys(true);
    const d = deps(a.body, a.headers);
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { tag: null }), d)).toMatchObject({ proven: false, reason: "missing_tag" });
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { tag: "something-else" }), d)).toMatchObject({ proven: false, reason: "missing_tag" });
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { components: ["@authority"] }), d)).toMatchObject({ proven: false, reason: "missing_component" });
    expect(d.http.calls.length).toBe(0);
  });

  it("refuses an expired signature, one that is too old, one from the future, and one with a long expiry", async () => {
    const a = await agentKeys(true);
    const d = deps(a.body, a.headers);
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { created: NOW_S - 120, ttl: 60 }), d)).toMatchObject({ proven: false, reason: "expired" });
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { created: NOW_S - 400, ttl: 1000 }), d)).toMatchObject({ proven: false, reason: "expires_too_far" });
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { created: NOW_S - 310, ttl: 350 }), d)).toMatchObject({ proven: false, reason: "too_old" });
    expect(await verifyWebBotAuth(await signedRequest(a.priv, { created: NOW_S + 120, ttl: 60 }), d)).toMatchObject({ proven: false, reason: "not_yet_valid" });
    // Inside the skew it still passes.
    expect((await verifyWebBotAuth(await signedRequest(a.priv, { created: NOW_S + 30, ttl: 60 }), d)).proven).toBe(true);
  });

  it("a User-Agent string alone never proves anything", async () => {
    const a = await agentKeys(true);
    const d = deps(a.body, a.headers);
    const r = await verifyWebBotAuth({ method: "GET", url: TARGET, headers: { "user-agent": "ChatGPT-User/1.0 (+https://openai.com/bot)", "signature-agent": `"${AGENT}"` } }, d);
    expect(r).toMatchObject({ proven: false, reason: "no_signature" });
    expect(directoryDisplayName(null, "none")).toBe("unproven reader");
    expect(directoryDisplayName(`${AGENT}/`, "none")).toBe("unproven reader");
    expect(directoryDisplayName(`${AGENT}/`, "web_bot_auth")).toBe("agent.fixtureagent.com");
    // Audit finding 16: no operator name is shown before its documentation is checked; the host name stands.
    expect(directoryDisplayName("https://chatgpt.com/", "web_bot_auth")).toBe("chatgpt.com");
    expect(directoryDisplayName("https://agent.fixtureagent.com/", "web_bot_auth", { "https://agent.fixtureagent.com": "Fixture Agent" })).toBe("Fixture Agent");
  });

  it("refuses a key that is not in the directory, a bad signature, and a directory with a bad self-signature", async () => {
    const a = await agentKeys(true);
    const other = await generateKeyPair();
    const d = deps(a.body, a.headers);
    expect(await verifyWebBotAuth(await signedRequest(other.privateJwk), d)).toMatchObject({ proven: false, reason: "unknown_key" });
    const req = await signedRequest(a.priv);
    const tampered = { ...req, url: "https://evil.example/pricing" };
    expect(await verifyWebBotAuth(tampered, d)).toMatchObject({ proven: false, reason: "bad_signature" });
    const badDir = deps(`${a.body} `, a.headers);
    expect(await verifyWebBotAuth(await signedRequest(a.priv), badDir)).toMatchObject({ proven: false, reason: "directory_signature_failed" });
    const down = { ...deps(a.body, a.headers), http: new MemoryHttp({}) };
    expect(await verifyWebBotAuth(await signedRequest(a.priv), down)).toMatchObject({ proven: false, reason: "directory_unreachable" });
    const dir = await fetchDirectory(AGENT, d);
    expect(dir.ok && dir.directory.keys[0]!.kid).toBe(a.pub.kid);
  });
});

describe("read receipts", () => {
  const SECRET = "fixture-secret-at-least-16-chars";
  const T1 = new Date("2026-10-22T10:00:00.000Z");
  const T2 = new Date("2026-10-23T10:00:00.000Z");

  it("hashes the address with a salt that rotates every UTC day and never keeps the raw address", async () => {
    const h1 = await hashIp("203.0.113.7", SECRET, T1);
    const h1b = await hashIp("203.0.113.7", SECRET, new Date("2026-10-22T23:59:59.000Z"));
    const h2 = await hashIp("203.0.113.7", SECRET, T2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h1b);
    expect(h1).not.toBe(h2);
    expect(await hashIp("203.0.113.8", SECRET, T1)).not.toBe(h1);
    expect(await hashIp("2001:DB8::1%eth0", SECRET, T1)).toBe(await hashIp("2001:db8::1", SECRET, T1));
    expect(utcDay(T1)).toBe("2026-10-22");
    const s1 = await ipHashSalt(SECRET, "2026-10-22");
    const s2 = await ipHashSalt(SECRET, "2026-10-23");
    expect(s1).not.toEqual(s2);
    await expect(ipHashSalt("short", "2026-10-22")).rejects.toThrow();
    const receipt = await makeReceipt({ trooth_id: "acme", version: 3, page_id: "smp_aaaaaaaaaaaaaaaaaaaaaaaaaa", representation: "markdown", auth: null, read_at: T1, address: "203.0.113.7" }, SECRET);
    expect(JSON.stringify(receipt)).not.toContain("203.0.113.7");
    expect(receipt.ip_hash).toBe(h1);
    expect(receipt.id).toMatch(/^smd_[a-z2-7]{26}$/);
    expect(receipt).toMatchObject({ proof: "none", agent_key_url: null, keyid: null });
    expect(Object.keys(receipt).sort()).toEqual(["agent_key_url", "id", "ip_hash", "keyid", "page_id", "proof", "read_at", "representation", "trooth_id", "version"]);
  });

  async function sample(): Promise<Receipt[]> {
    const store = new MemoryReceiptStore();
    const proven = { proven: true as const, agent_key_url: "https://agent.example/", keyid: "k1", directory_signed: true };
    const failed = { proven: false as const, reason: "bad_signature" as const, sentence: "The signature did not verify." };
    const p1 = "smp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const p2 = "smp_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    await recordRead({ trooth_id: "acme", version: 3, page_id: p1, representation: "markdown", auth: proven, read_at: T1, address: "203.0.113.7" }, SECRET, store);
    await recordRead({ trooth_id: "acme", version: 3, page_id: p2, representation: "markdown", auth: proven, read_at: new Date(T1.getTime() + 1000), address: "203.0.113.7" }, SECRET, store);
    await recordRead({ trooth_id: "acme", version: 3, page_id: p1, representation: "html", auth: failed, read_at: new Date(T1.getTime() + 2000), address: "203.0.113.9" }, SECRET, store);
    await recordRead({ trooth_id: "acme", version: 3, page_id: p1, representation: "jsonld", auth: null, read_at: new Date(T1.getTime() + 3000), address: "198.51.100.2" }, SECRET, store);
    await recordRead({ trooth_id: "acme", version: 3, page_id: p1, representation: "markdown", auth: proven, read_at: T2, address: "203.0.113.7" }, SECRET, store);
    await recordRead({ trooth_id: "globex", version: 1, page_id: p1, representation: "markdown", auth: proven, read_at: T1, address: "203.0.113.7" }, SECRET, store);
    return store.list("acme", "2026-10-22T00:00:00.000Z", "2026-10-24T00:00:00.000Z");
  }

  it("signs a daily digest per company that verifies and counts by agent and page", async () => {
    const rows = await sample();
    const kp = await generateKeyPair();
    const { digest, jws } = await signDailyDigest("acme", "2026-10-22", rows, kp.privateJwk, T2);
    expect(digest).toMatchObject({ trooth_id: "acme", day: "2026-10-22", total: 4, proven: 2, unproven: 2 });
    expect(digest.by_agent).toEqual([
      { agent_key_url: "https://agent.example/", proof: "web_bot_auth", count: 2 },
      { agent_key_url: null, proof: "none", count: 2 },
    ]);
    expect(digest.by_page[0]).toEqual({ page_id: "smp_aaaaaaaaaaaaaaaaaaaaaaaaaa", count: 3 });
    expect(digest.receipt_ids.length).toBe(4);
    const typed = await verifyJws(jws, () => kp.publicJwk, { expectTyp: JWS_TYPES.readReceipt, at: T2 });
    expect(typed.ok).toBe(true);
    const v = await verifyDailyDigest(jws, kp.publicJwk, T2);
    expect(v.ok && v.digest.total).toBe(4);
    const other = await generateKeyPair();
    expect((await verifyDailyDigest(jws, other.publicJwk, T2)).ok).toBe(false);
    expect(summarize("acme", "2026-10-23", rows).total).toBe(1);
    expect(JSON.stringify(digest)).not.toMatch(/203\.0\.113|198\.51\.100/);
  });

  it("shows named agents only behind a proven signature; everything else is one unproven reader", async () => {
    const rows = await sample();
    const view = dashboardRows(rows);
    expect(view).toEqual([
      { reader: "agent.example", agent_key_url: "https://agent.example/", proof: "web_bot_auth", reads: 3, pages: 2, last_read_at: T2.toISOString() },
      { reader: "unproven reader", agent_key_url: null, proof: "none", reads: 2, pages: 1, last_read_at: "2026-10-22T10:00:03.000Z" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/203\.0\.113|198\.51\.100/);
  });

  it("exports CSV with one row per receipt, never an address and never the address hash", async () => {
    const rows = await sample();
    const csv = receiptsCsv(rows);
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("id,trooth_id,version,page_id,representation,agent_key_url,keyid,proof,read_at,count");
    expect(lines.length).toBe(1 + rows.length);
    expect(lines[1]).toMatch(/^smd_[a-z2-7]{26},acme,3,smp_aaaaaaaaaaaaaaaaaaaaaaaaaa,markdown,https:\/\/agent\.example\/,k1,web_bot_auth,2026-10-22T10:00:00\.000Z,1$/);
    expect(csv).not.toMatch(/203\.0\.113|198\.51\.100/);
    for (const r of rows) expect(csv).not.toContain(r.ip_hash);
    expect(receiptsCsv([{ ...rows[0]!, keyid: '=cmd|"x"' }])).toContain("\"'=cmd|\"\"x\"\"\"");
  });

  it("keeps receipts 30 days: prune deletes older rows, at most the limit, and keeps the rest", async () => {
    const store = new MemoryReceiptStore();
    const old = { ...(await sample())[0]!, id: "smd_old", read_at: "2026-09-01T00:00:00.000Z" };
    const older = { ...old, id: "smd_older", read_at: "2026-08-01T00:00:00.000Z" };
    const fresh = { ...old, id: "smd_fresh", read_at: "2026-10-20T00:00:00.000Z" };
    for (const r of [old, older, fresh]) await store.put(r);
    expect(RECEIPT_RETENTION_DAYS).toBe(30);
    expect(await store.prune("2026-09-22T00:00:00.000Z", 1)).toBe(1);
    expect(await store.prune("2026-09-22T00:00:00.000Z", 10)).toBe(1);
    expect(store.rows.map((r) => r.id)).toEqual(["smd_fresh"]);
  });

  it("publishes the network benchmark only for cells with at least 20 companies, naming proven readers by host", async () => {
    const store = new MemoryReceiptStore();
    const base = (await sample())[0]!;
    for (let i = 0; i < 25; i++) await store.put({ ...base, id: `smd_p${i}`, trooth_id: `co${i}`, proof: "web_bot_auth", agent_key_url: "https://agent.example/.well-known/http-message-signatures-directory", representation: "markdown", read_at: "2026-10-10T00:00:00.000Z", count: 2 });
    for (let i = 0; i < 3; i++) await store.put({ ...base, id: `smd_r${i}`, trooth_id: `co${i}`, proof: "web_bot_auth", agent_key_url: "https://rare.example/dir", representation: "markdown", read_at: "2026-10-10T00:00:00.000Z" });
    for (let i = 0; i < 21; i++) await store.put({ ...base, id: `smd_u${i}`, trooth_id: `co${i}`, proof: "none", agent_key_url: "https://claimed.example/", representation: "jsonld", read_at: "2026-10-10T00:00:00.000Z" });
    const b = benchmark(await store.aggregate("2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z"), "2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z");
    expect(BENCHMARK_MIN_COMPANIES).toBe(20);
    expect(b.cells).toEqual([
      { reader: "agent.example", agent_key_url: "https://agent.example/.well-known/http-message-signatures-directory", proof: "web_bot_auth", representation: "markdown", reads: 50, companies: 25 },
      { reader: "unproven readers", agent_key_url: null, proof: "none", representation: "jsonld", reads: 21, companies: 21 },
    ]);
    expect(b.suppressed).toEqual({ cells: 1, reads: 3 });
    expect(b.license.name).toBe("CC BY 4.0");
    expect(JSON.stringify(b)).not.toContain("claimed.example");
    expect(JSON.stringify(b)).not.toContain("rare.example");
  });
});
