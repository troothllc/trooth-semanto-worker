// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for the serving layer: negotiation (Cloudflare's documented table),
// the response headers and their RFC 9421 signature, ETag and 304, markdown
// problems, offline proofs, the verify endpoint, the same-content guarantee
// and user-agent independence, receipts, and host detection.

import { describe, it, expect, beforeAll } from "vitest";
import { negotiateRoute } from "@/serve/negotiate-route";
import { buildResponse, EXPOSED_HEADERS, ifNoneMatchMatches } from "@/serve/headers";
import { problem, problemMarkdown, renderProblem, behindNotice, stripBehindNotice } from "@/serve/errors";
import { buildPageProof, verifyProof, verifyUrl, type PageProof } from "@/serve/proof";
import { createApp, runQueue, runScheduled } from "@/serve/routes";
import { htmlToText, markdownToText, sentences } from "@/serve/represent";
import { detectHost, classifyHost, parseDohTxt, type DetectPorts, type FetchResult } from "@/serve/detect";
import { verifyMessage, verifyContentDigest, parseSignatureInput } from "@/core/httpsig";
import { utf8, fromUtf8 } from "@/core/encoding";
import { digest } from "@/core/hash";
import { versionId } from "@/core/semanto";
import { toPublic } from "@/core/keys";
import { buildEstate, ACME_PAGES, FIXED_NOW, readFixture, type Estate } from "./fixtures/serve/fixture";

let estate: Estate;
let app: ReturnType<typeof createApp>;
const BASE = "https://api.trooth.co/public/semanto";

beforeAll(async () => {
  estate = await buildEstate();
  app = createApp({ ports: estate.ports, authorize: async (req) => req.headers.get("authorization") === "Bearer fixture-token" });
});

const get = (path: string, headers: Record<string, string> = {}) => app.request(`${BASE}${path}`, { headers });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const headerMap = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k !== "date") out[k] = v;
  });
  return out;
};
const homeId = () => estate.acme.entries[0]!.id;

describe("negotiation follows the documented table", () => {
  const cases: [string | null, string][] = [
    ["text/markdown", "markdown"],
    ["text/markdown, text/html;q=0.9", "markdown"],
    ["text/*", "markdown"],
    ["*/*", "html"],
    [null, "html"],
    ["text/html", "html"],
    ["application/ld+json", "jsonld"],
    ["text/html, application/ld+json;q=0.8", "html"],
  ];
  for (const [accept, rep] of cases) {
    it(`Accept ${accept ?? "(none)"} gives ${rep}`, () => {
      expect(negotiateRoute("/about", accept).rep).toBe(rep);
    });
  }
  it("a path suffix forces the format whatever Accept says", () => {
    expect(negotiateRoute("/about.md", "*/*")).toEqual({ rep: "markdown", basePath: "/about", forcedByPath: true });
    expect(negotiateRoute("/about/index.md", null)).toEqual({ rep: "markdown", basePath: "/about/", forcedByPath: true });
    expect(negotiateRoute("/about.jsonld", "text/html")).toEqual({ rep: "jsonld", basePath: "/about", forcedByPath: true });
    expect(negotiateRoute("/facts.jsonld", "text/markdown")).toEqual({ rep: "jsonld", basePath: "/", forcedByPath: true });
  });
});

describe("headers on a served page", () => {
  it("carries every field and the signature verifies with the company's published key", async () => {
    const r = await get(`/acme-inc/pages/${homeId()}`, { accept: "text/markdown" });
    expect(r.status).toBe(200);
    const h = r.headers;
    const entry = estate.acme.entries[0]!;
    expect(h.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(h.get("vary")).toBe("Accept");
    expect(h.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(h.get("etag")).toBe(`"${entry.hash}"`);
    expect(h.get("x-markdown-tokens")).toBe(String(entry.tokens));
    expect(Number(h.get("x-original-tokens"))).toBeGreaterThan(0);
    expect(h.get("trooth-contract")).toBe("1");
    expect(h.get("trooth-semanto-version")).toBe(versionId(estate.acme.file.root_hash));
    expect(h.get("trooth-page-hash")).toBe(entry.hash);
    expect(h.get("content-signal")).toBe("ai-train=no, search=yes, ai-input=yes");
    expect(h.get("access-control-allow-origin")).toBe("*");
    for (const name of EXPOSED_HEADERS) expect(h.get("access-control-expose-headers")).toContain(name);
    expect(h.get("trooth-signed-by")).toBeNull();
    const link = h.get("link")!;
    expect(link).toContain(`<${entry.url}>; rel="canonical"`);
    expect(link).toContain(`<${BASE}/acme-inc/pages/${entry.id}.md>; rel="alternate"; type="text/markdown"`);
    expect(link).toContain(`<${BASE}/acme-inc/pages/${entry.id}.jsonld>; rel="alternate"; type="application/ld+json"`);
    expect(link).toContain(`<https://acme.com/.well-known/trooth.semanto>; rel="https://trooth.co/rel/semanto"`);
    expect(link).toContain(`<https://trooth.co/network/company/acme-inc>; rel="https://trooth.co/rel/trust-profile"`);
    expect(link).toContain(`<${BASE}/acme-inc/pages/${entry.id}/proof>; rel="https://trooth.co/rel/proof"`);
    expect(link).toContain(`<${BASE}/acme-inc/keys>; rel="https://trooth.co/rel/keys"`);

    const body = new Uint8Array(await r.arrayBuffer());
    expect(body).toEqual(estate.acme.pages.get(entry.id));
    expect(await verifyContentDigest(h.get("content-digest"), body)).toBe(true);
    const v = await verifyMessage({ kind: "response", status: 200, headers: h }, {
      resolveKey: (kid) => (kid === estate.companyPublic.kid ? estate.companyPublic : null),
      required: ["@status", "content-type", "content-digest", "trooth-semanto-version", "trooth-page-hash"],
      tag: "trooth-semanto",
      now: Math.floor(FIXED_NOW.getTime() / 1000) + 10,
    });
    expect(v.ok).toBe(true);
    const si = parseSignatureInput(h.get("signature-input")!);
    const params = Object.values(si)[0]!.params;
    // The signature lives as long as a cache may serve the response: max-age 300 plus stale-while-revalidate 3600.
    expect(params.expires! - params.created).toBe(3900);
    expect(params.tag).toBe("trooth-semanto");
  });

  it("signs with the witness key and says so when the company holds its own key", async () => {
    const r = await get(`/beta-ltd`, { accept: "application/json" });
    expect(r.status).toBe(409);
    expect(r.headers.get("trooth-signed-by")).toBe("witness");
    const body = new Uint8Array(await r.arrayBuffer());
    const v = await verifyMessage({ kind: "response", status: 409, headers: r.headers }, { resolveKey: (kid) => (kid === estate.witnessPublic.kid ? estate.witnessPublic : null), tag: "trooth-semanto", now: Math.floor(FIXED_NOW.getTime() / 1000) });
    expect(v.ok).toBe(true);
    expect(await verifyContentDigest(r.headers.get("content-digest"), body)).toBe(true);
  });

  it("answers 304 with the same headers and no body when If-None-Match matches", async () => {
    const first = await get(`/acme-inc/pages/${homeId()}`, { accept: "text/markdown" });
    const etag = first.headers.get("etag")!;
    const r = await get(`/acme-inc/pages/${homeId()}`, { accept: "text/markdown", "if-none-match": etag });
    expect(r.status).toBe(304);
    expect(await r.text()).toBe("");
    for (const name of ["etag", "trooth-page-hash", "trooth-semanto-version", "link", "content-digest", "vary", "cache-control", "content-signal"]) expect(r.headers.get(name)).toBe(first.headers.get(name));
    const v = await verifyMessage({ kind: "response", status: 304, headers: r.headers }, { resolveKey: () => estate.companyPublic, tag: "trooth-semanto", now: Math.floor(FIXED_NOW.getTime() / 1000) });
    expect(v.ok).toBe(true);
    expect(ifNoneMatchMatches(`W/${etag}, "other"`, etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
    const miss = await get(`/acme-inc/pages/${homeId()}`, { accept: "text/markdown", "if-none-match": '"sha256:0000000000000000000000000000000000000000000000000000000000000000"' });
    expect(miss.status).toBe(200);
  });

  it("a browser asking for html is sent to the company's page, never given markdown", async () => {
    const r = await get(`/acme-inc/pages/${homeId()}`, { accept: "*/*" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://acme.com/");
    const r2 = await get(`/acme-inc/pages/${homeId()}.md`, { accept: "*/*" });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("buildResponse answers 304 only for a 200", async () => {
    const key = estate.witness;
    const body = utf8("x");
    const etag = `"${await digest(body)}"`;
    const p = await buildResponse({ status: 404, rep: "json", body, version_id: null, signer: { key, by: "witness" }, now: FIXED_NOW }, { ifNoneMatch: etag });
    expect(p.status).toBe(404);
    expect(p.body).not.toBeNull();
  });
});

describe("problems", () => {
  it("render as markdown with the front matter when the reader accepts text/markdown", async () => {
    const r = await get(`/acme-inc/pages/smp_aaaaaaaaaaaaaaaaaaaaaaaaaa`, { accept: "text/markdown" });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await r.text();
    expect(text.startsWith("---\nerror_code: page_not_found\nhttp_status: 404\nretryable: false\n")).toBe(true);
    expect(text).toContain("## What happened");
    expect(text).toContain("## What you should do");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("signature")).toBeTruthy();
  });
  it("render as RFC 9457 JSON otherwise, with code, retryable, next_action and terminal", async () => {
    const r = await get(`/nope`, { accept: "application/json" });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("application/problem+json");
    const p = await body(r);
    expect(p.code).toBe("semanto_not_found");
    expect(p.type).toBe("https://trooth.co/problems/semanto_not_found");
    expect(typeof p.retryable).toBe("boolean");
    expect(typeof p.next_action).toBe("string");
    expect(typeof p.terminal).toBe("boolean");
  });
  it("covers every code with the right status, and rate_limited carries retry_after", () => {
    expect(problem("semanto_not_found").status).toBe(404);
    expect(problem("semanto_not_signed").status).toBe(409);
    expect(problem("semanto_version_not_found").status).toBe(404);
    expect(problem("page_not_found").status).toBe(404);
    expect(problem("page_behind").status).toBe(200);
    expect(problem("semanto_withdrawn").status).toBe(410);
    expect(problem("invalid_trooth_id").status).toBe(400);
    expect(problem("unsupported_contract_version").status).toBe(406);
    const rl = problem("rate_limited", { retry_after: 30 });
    expect(rl.status).toBe(429);
    expect(problemMarkdown(rl)).toContain("retry_after: 30\n");
    expect(renderProblem(rl, "text/*").rep).toBe("markdown");
    expect(renderProblem(rl, null).rep).toBe("problem_json");
  });
  it("answers the version routes with the right problem", async () => {
    expect((await get(`/acme-inc/versions/1`)).status).toBe(410);
    expect((await get(`/acme-inc/versions/9`)).status).toBe(404);
    expect((await get(`/acme-inc/versions/2`)).status).toBe(200);
    expect((await get(`/Not_Valid`)).status).toBe(400);
    expect((await get(`/acme-inc`, { "trooth-contract": "2" })).status).toBe(406);
    const list = await body(get(`/acme-inc/versions`));
    expect(list.current).toBe(2);
    expect(list.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });
  it("serves the last signed bytes marked behind when the live page changed", async () => {
    const id = estate.acme.entries[1]!.id;
    estate.store.companies.get("acme-inc")!.live.set(id, "behind");
    try {
      const r = await get(`/acme-inc/pages/${id}`, { accept: "text/markdown" });
      expect(r.status).toBe(200);
      expect(r.headers.get("trooth-semanto-state")).toBe("behind");
      expect(r.headers.get("warning")).toBeNull();
      const body = new Uint8Array(await r.arrayBuffer());
      const text = fromUtf8(body);
      expect(text.startsWith("---\ntrooth_state: behind\n")).toBe(true);
      expect(text).toContain("what_happened:");
      // Trooth-Page-Hash is the digest of the bytes served; the signed page's hash travels in Trooth-Signed-Page-Hash.
      expect(r.headers.get("trooth-page-hash")).toBe(await digest(body));
      expect(r.headers.get("trooth-signed-page-hash")).toBe(estate.acme.entries[1]!.hash);
      expect(stripBehindNotice(body)).toEqual(estate.acme.pages.get(id));
      expect(await digest(stripBehindNotice(body))).toBe(estate.acme.entries[1]!.hash);
      expect(behindNotice("2026-10-01T10:00:00.000Z", "smv_x")).toContain("trooth_signed_at: 2026-10-01T10:00:00.000Z");
    } finally {
      estate.store.companies.get("acme-inc")!.live.delete(id);
    }
  });
});

describe("proofs", () => {
  it("verify offline against the page bytes, the header, the keys and the log, and fail on a changed byte", async () => {
    for (const entry of estate.acme.entries) {
      const r = await get(`/acme-inc/pages/${entry.id}/proof`);
      expect(r.status).toBe(200);
      const proof = (await body(r)) as PageProof;
      expect(proof.object).toBe("semanto.proof");
      expect(proof.inclusion.size).toBe(3);
      expect(proof.ledger).not.toBeNull();
      const bytes = estate.acme.pages.get(entry.id)!;
      const keys = { resolveCompanyKey: (kid: string) => (kid === estate.companyPublic.kid ? estate.companyPublic : null), resolveTroothKey: (kid: string) => (kid === estate.witnessPublic.kid ? estate.witnessPublic : null) };
      const ok = await verifyProof(proof, bytes, { header: estate.acme.file.header, ...keys, at: FIXED_NOW });
      expect(ok.failures).toEqual([]);
      expect(ok.ok).toBe(true);
      expect(Object.values(ok.checks).every((c) => c === "ok")).toBe(true);

      const changed = new Uint8Array(bytes);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      const bad = await verifyProof(proof, changed, { header: estate.acme.file.header, ...keys, at: FIXED_NOW });
      expect(bad.ok).toBe(false);
      expect(bad.checks.page_hash).toBe("failed");
      expect(bad.checks.inclusion).toBe("ok");

      const tampered = { ...proof, inclusion: { ...proof.inclusion, index: (proof.inclusion.index + 1) % 3 } };
      const bad2 = await verifyProof(tampered, bytes);
      expect(bad2.checks.inclusion).toBe("failed");
    }
  });
  it("is strict: with the bytes alone the hashes check out but the result is not ok, and nothing missing is skipped silently", async () => {
    const entry = estate.acme.entries[2]!;
    const proof = await buildPageProof(estate.acme.file, entry.id, null);
    const v = await verifyProof(proof!, estate.acme.pages.get(entry.id)!);
    expect(v.ok).toBe(false);
    expect(v.checks.page_hash).toBe("ok");
    expect(v.checks.inclusion).toBe("ok");
    expect(v.checks.header).toBe("absent");
    expect(v.checks.signature).toBe("not_checked");
    expect(v.checks.ledger_inclusion).toBe("absent");
    expect(await buildPageProof(estate.acme.file, "smp_aaaaaaaaaaaaaaaaaaaaaaaaaa", null)).toBeNull();
  });
  it("fails the witness check when a different key is offered", async () => {
    const entry = estate.acme.entries[0]!;
    const proof = (await buildPageProof(estate.acme.file, entry.id, null))!;
    const wrong = toPublic(estate.companyKey);
    const v = await verifyProof(proof, estate.acme.pages.get(entry.id)!, { resolveTroothKey: () => ({ ...wrong, kid: estate.witnessPublic.kid }) });
    expect(v.checks.witness).toBe("failed");
  });
});

describe("the verify endpoint", () => {
  it("answers matches, differs, unknown_url and not_signed", async () => {
    const entry = estate.acme.entries[1]!;
    const q = (url: string, hash: string) => body(get(`/verify?url=${encodeURIComponent(url)}&hash=${encodeURIComponent(hash)}`));
    const m = await q(entry.url, entry.hash);
    expect(m.status).toBe("matches");
    expect(m.version).toBe(2);
    expect(m.signed_at).toBe("2026-10-01T10:00:00.000Z");
    expect(m.signer).toEqual({ kid: estate.companyPublic.kid, domain: "acme.com" });
    expect(m.proof_url).toBe(`${BASE}/acme-inc/pages/${entry.id}/proof`);
    const d = await q(entry.url, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    expect(d.status).toBe("differs");
    expect(d.signed_hash).toBe(entry.hash);
    expect((await q("https://acme.com/not-a-page", entry.hash)).status).toBe("unknown_url");
    expect((await q("https://nobody.example/", entry.hash)).status).toBe("unknown_url");
    expect((await q("not a url", entry.hash)).status).toBe("unknown_url");
    expect((await q("https://beta.example/pricing", entry.hash)).status).toBe("not_signed");
    const direct = await verifyUrl(estate.store, BASE, entry.url, entry.hash, async () => null);
    expect(direct.status).toBe("matches");
  });
});

describe("the same-content guarantee", () => {
  it("every sentence of the markdown is in the HTML text and the JSON-LD text, and the other way round", async () => {
    for (const [i, page] of ACME_PAGES.entries()) {
      const entry = estate.acme.entries[i]!;
      const md = sentences(markdownToText(page.markdown));
      const html = sentences(htmlToText(page.html));
      expect(md.length).toBeGreaterThan(0);
      for (const s of md) expect(html).toContain(s);
      for (const s of html) expect(md).toContain(s);
      const r = await get(`/acme-inc/pages/${entry.id}`, { accept: "application/ld+json" });
      expect(r.headers.get("content-type")).toBe("application/ld+json");
      const ld = await body(r);
      expect(ld["@type"]).toBe("WebPage");
      expect(ld.url).toBe(entry.url);
      const ldSentences = sentences(ld.text);
      for (const s of md) expect(ldSentences).toContain(s);
      for (const s of ldSentences) expect(md).toContain(s);
    }
  });
  it("two readers with different user agents and the same Accept get identical bytes and headers", async () => {
    const path = `/acme-inc/pages/${homeId()}`;
    const a = await get(path, { accept: "text/markdown", "user-agent": "Mozilla/5.0 (fixture browser)" });
    const b = await get(path, { accept: "text/markdown", "user-agent": "ClaudeBot/1.0 (fixture agent)" });
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array(await b.arrayBuffer()));
    expect(headerMap(a.headers)).toEqual(headerMap(b.headers));
    const c = await get(`${path}.jsonld`, { "user-agent": "curl/8" });
    const d = await get(`${path}.jsonld`, { "user-agent": "GPTBot" });
    expect(await c.text()).toBe(await d.text());
  });
});

describe("the other public routes", () => {
  it("serves the semanto object by Accept", async () => {
    const j = await get(`/acme-inc`);
    expect(j.headers.get("content-type")).toBe("application/json");
    const jBytes = new Uint8Array(await j.clone().arrayBuffer());
    expect(j.headers.get("trooth-page-hash")).toBe(await digest(jBytes));
    expect(j.headers.get("trooth-signed-page-hash")).toBeNull();
    const file = await body(j);
    expect(file.root_hash).toBe(estate.acme.file.root_hash);
    const m = await get(`/acme-inc`, { accept: "text/markdown" });
    expect(m.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await m.text();
    for (const p of ACME_PAGES) expect(text).toContain(p.url);
    const l = await get(`/acme-inc`, { accept: "application/ld+json" });
    expect(l.headers.get("content-type")).toBe("application/ld+json");
  });
  it("serves facts.jsonld, llms.txt, llms-full.txt, sitemap.md, keys and the well-known documents", async () => {
    const facts = await body(get(`/acme-inc/facts.jsonld`));
    expect(facts["trooth:facts"]).toHaveLength(3);
    expect(facts["trooth:facts"].every((f: { "trooth:provenance": string }) => f["trooth:provenance"] === "declared")).toBe(true);
    for (const p of ["/acme-inc/llms.txt", "/acme-inc/llms-full.txt", "/acme-inc/sitemap.md"]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(r.headers.get("x-markdown-tokens")).toBeTruthy();
    }
    const site = await (await get(`/acme-inc/sitemap.md`)).text();
    for (const e of estate.acme.entries) expect(site).toContain(e.hash);
    const keys = await body(get(`/acme-inc/keys`));
    expect(keys.keys[0].kid).toBe(estate.companyPublic.kid);
    expect(keys.keys[0].d).toBeUndefined();
    const wk = await body(get(`/acme-inc/.well-known/trooth.semanto`));
    expect(wk.object).toBe("trooth.semanto");
    expect(wk.version_id).toBe(versionId(estate.acme.file.root_hash));
    const wkk = await body(get(`/acme-inc/.well-known/trooth-keys.json`));
    expect(wkk).toEqual(keys);
  });
  it("tells an adapter what to do for a path on the company's domain", async () => {
    const r = await body(get(`/acme-inc/resolve?path=/about&accept=text/markdown`));
    expect(r.action).toBe("serve_semanto");
    expect(r.page_id).toBe(estate.acme.entries[1]!.id);
    const h = await body(get(`/acme-inc/resolve?path=/about&accept=*/*`));
    expect(h.action).toBe("passthrough");
    const u = await body(get(`/acme-inc/resolve?path=/unsigned.md`));
    expect(u.serve).toBe("problem");
  });
  it("stores validated settings for an authorized workspace and refuses others", async () => {
    const payload = JSON.stringify({ host: "cloudflare", where: { trooth_hosted: true, own_domain: true }, markdown_source: "semanto_then_cloudflare_for_unsigned" });
    const no = await app.request(`https://api.trooth.co/os/semanto/acme-inc/settings`, { method: "POST", body: payload, headers: { "content-type": "application/json" } });
    expect(no.status).toBe(401);
    const ok = await app.request(`https://api.trooth.co/os/semanto/acme-inc/settings`, { method: "POST", body: payload, headers: { "content-type": "application/json", authorization: "Bearer fixture-token" } });
    expect(ok.status).toBe(200);
    expect((await body(ok)).markdown_source).toBe("semanto_then_cloudflare_for_unsigned");
    const bad = await app.request(`https://api.trooth.co/os/semanto/acme-inc/settings`, { method: "POST", body: JSON.stringify({ host: "vercel", markdown_source: "cloudflare_format_semanto_proof_only" }), headers: { authorization: "Bearer fixture-token" } });
    expect(bad.status).toBe(422);
    expect((await body(bad)).issues[0].path).toBe("markdown_source");
    const read = await app.request(`https://api.trooth.co/os/semanto/acme-inc/settings`, { headers: { authorization: "Bearer fixture-token" } });
    expect((await body(read)).host).toBe("cloudflare");
    await estate.ports.settings.put("acme-inc", (await estate.ports.settings.get("acme-inc"))!);
  });
  it("answers CORS preflight", async () => {
    const r = await app.request(`${BASE}/acme-inc`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("receipts and background handlers", () => {
  it("records a receipt with the representation, the page and the Signature-Agent presence, never a user agent", async () => {
    const before = estate.ports.receipts.recorded.length;
    await get(`/acme-inc/pages/${homeId()}`, { accept: "text/markdown", "signature-agent": '"https://agent.example"', "user-agent": "fixture-agent/1" });
    await new Promise((r) => setTimeout(r, 5));
    const rec = estate.ports.receipts.recorded.slice(before);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ trooth_id: "acme-inc", version: 2, page_id: homeId(), representation: "markdown", agent_key_url: '"https://agent.example"', proof: "none", read_at: FIXED_NOW.toISOString() });
    expect(JSON.stringify(rec[0])).not.toContain("fixture-agent");
  });
  it("marks a receipt web_bot_auth only when the readers module proved the key", async () => {
    const proven = createApp({ ports: estate.ports, readers: { verify: async () => ({ agent_key_url: "https://agent.example/keys", proven: true }) } });
    const before = estate.ports.receipts.recorded.length;
    await proven.request(`${BASE}/acme-inc/facts.jsonld`);
    await new Promise((r) => setTimeout(r, 5));
    expect(estate.ports.receipts.recorded[before]).toMatchObject({ representation: "jsonld", proof: "web_bot_auth", agent_key_url: "https://agent.example/keys" });
  });
  it("routes crons and queue messages to the job port", async () => {
    await runScheduled(estate.ports, "15 * * * *");
    await runScheduled(estate.ports, "30 1 * * *");
    await runScheduled(estate.ports, "0 6 * * 1");
    let acked = 0;
    await runQueue(estate.ports, [{ body: { trooth_id: "acme-inc" }, ack: () => acked++, retry: () => undefined }]);
    expect(estate.ports.jobs.calls).toEqual(["hourly", "nightly", "weekly", 'compile:{"trooth_id":"acme-inc"}']);
    expect(acked).toBe(1);
  });
  it("rate limits through the hook with Retry-After", async () => {
    const limited = createApp({ ports: estate.ports, rateLimit: async () => ({ allowed: false, retry_after: 12 }) });
    const r = await limited.request(`${BASE}/acme-inc`, { headers: { accept: "text/markdown" } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("12");
    expect(await r.text()).toContain("retry_after: 12");
  });
});

describe("host detection", () => {
  function fixtureFetch(table: Record<string, FetchResult | null>): DetectPorts["fetch"] {
    return async (url, init) => {
      const key = `${init.headers["accept"] ?? ""} ${url}`;
      for (const [k, v] of Object.entries(table)) if (key.endsWith(k) || key === k) return v;
      return null;
    };
  }
  const json = (name: string) => JSON.parse(readFixture(name)) as { status: number; headers: Record<string, string>; body: string };
  const res = (f: { status: number; headers: Record<string, string>; body: string }): FetchResult => ({ status: f.status, headers: f.headers, body: utf8(f.body) });

  it("recognizes Cloudflare's converter by x-markdown-tokens and flags the double-markdown conflict", async () => {
    const cf = json("fixture-cloudflare-markdown-response.json");
    const semanto = utf8('{"object":"trooth.semanto"}');
    const keys = utf8('{"keys":[]}');
    const ports: DetectPorts = {
      fetch: fixtureFetch({
        "text/markdown https://acme.com/": res(cf),
        "text/html https://acme.com/": { status: 200, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "fixture-ORD" }, body: utf8("<html></html>") },
        "https://acme.com/.well-known/trooth.semanto": { status: 200, headers: {}, body: semanto },
        "https://acme.com/.well-known/trooth-keys.json": { status: 200, headers: {}, body: utf8('{"keys":[ ]}') },
      }),
      dnsTxt: async (name) => (name === "_trooth.acme.com" ? ["v=trooth1; kid=fixturekidfixturekidfixturekidfixturekidfix"] : []),
      networkCopy: { semanto, keys },
    };
    const d = await detectHost("acme.com", ports, FIXED_NOW);
    expect(d.host).toBe("cloudflare");
    expect(d.cloudflare_markdown).toBe(true);
    expect(d.conflicts.map((c) => c.kind)).toEqual(["double_markdown"]);
    expect(d.suggested_markdown_source).toBe("semanto_then_cloudflare_for_unsigned");
    expect(d.well_known_served).toEqual({ semanto: true, keys: true });
    expect(d.well_known_matches).toEqual({ semanto: true, keys: false });
    expect(d.dns_pointer).toBe(true);
    expect(d.checked_at).toBe(FIXED_NOW.toISOString());
  });
  it("recognizes Vercel and suggests semanto_only with no conflict", async () => {
    const v = json("fixture-vercel-response.json");
    const d = await detectHost("acme.com", { fetch: fixtureFetch({ "text/html https://acme.com/": res(v), "text/markdown https://acme.com/": res(v) }), dnsTxt: async () => [], networkCopy: { semanto: utf8(""), keys: utf8("") } }, FIXED_NOW);
    expect(d.host).toBe("vercel");
    expect(d.cloudflare_markdown).toBe(false);
    expect(d.conflicts).toEqual([]);
    expect(d.suggested_markdown_source).toBe("semanto_only");
    expect(d.well_known_served).toEqual({ semanto: false, keys: false });
    expect(d.dns_pointer).toBe(false);
  });
  it("classifies the other hosts from their headers", () => {
    expect(classifyHost({ "x-nf-request-id": "x" }, "").host).toBe("netlify");
    expect(classifyHost({ "x-served-by": "cache-iad-kiad7000-IAD, cache-fastly" }, "").host).toBe("fastly");
    expect(classifyHost({ "x-akamai-transformed": "9" }, "").host).toBe("akamai");
    expect(classifyHost({ server: "gcore" }, "").host).toBe("gcore");
    expect(classifyHost({ server: "nginx/1.27" }, "").host).toBe("nginx");
    expect(classifyHost({ server: "Apache/2.4" }, "").host).toBe("apache");
    expect(classifyHost({}, '<meta name="generator" content="WordPress 6.8">').host).toBe("wordpress");
    expect(classifyHost({}, "").host).toBe("unknown");
    expect(parseDohTxt({ Answer: [{ type: 16, data: '"v=trooth1; kid=abc"' }, { type: 1, data: "1.2.3.4" }] })).toEqual(["v=trooth1; kid=abc"]);
  });
});
