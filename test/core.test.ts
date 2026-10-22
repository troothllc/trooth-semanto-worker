import { describe, it, expect } from "vitest";
import { canonicalize } from "@/core/canonical";
import { digest, sha256Hex } from "@/core/hash";
import { toHex, fromHex, toBase64Url, fromBase64Url, utf8 } from "@/core/encoding";
import { root, leafHash, inclusionProof, verifyInclusion, consistencyProof, verifyConsistency, rootFromLeafHashes } from "@/core/merkle";
import { generateKeyPair, thumbprint, keyValidAt, parseDnsKeyRecords, dnsKeyRecord } from "@/core/keys";
import { signObject, verifyJws, JWS_TYPES } from "@/core/jws";
import { signMessage, verifyMessage, contentDigest, verifyContentDigest, signatureBase, parseSignatureInput, SEMANTO_RESPONSE_COMPONENTS } from "@/core/httpsig";
import { negotiate, parseAccept, representationFromPath } from "@/core/negotiate";
import { semantoId, isSemantoId, isTroothId } from "@/core/ids";
import { validate, verifyStructure, factId, pagesRoot, factsRoot, tierHash, rootHash, SCHEMA_URL, type SemantoFile, type Fact } from "@/core/semanto";

describe("encoding", () => {
  it("round trips hex and base64url", () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromHex(toHex(b))).toEqual(b);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(toBase64Url(utf8("hello"))).toBe("aGVsbG8");
  });
});

describe("RFC 8785 canonical JSON", () => {
  it("sorts keys by UTF-16 code units and prints the shortest numbers", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], "é": 2, A: 3 })).toBe('{"A":3,"a":[true,null,"x"],"b":1,"é":2}');
    expect(canonicalize({ n: 1e21, m: 1.5, z: -0 })).toBe('{"m":1.5,"n":1e+21,"z":0}');
    expect(canonicalize({ s: "line\nbreak\t\"q\"\\" })).toBe('{"s":"line\\nbreak\\t\\"q\\"\\\\"}');
  });
  it("drops undefined members and rejects non-finite numbers", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });
});

describe("sha256", () => {
  it("matches the known digest of the empty string", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await digest("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("RFC 6962 Merkle tree", () => {
  const leaves = ["", "\x00", "\x10", "\x20\x21", "\x30\x31", "\x40\x41\x42\x43", "\x50\x51\x52\x53\x54\x55\x56\x57", "\x60\x61\x62\x63\x64\x65\x66\x67\x68\x69\x6a\x6b\x6c\x6d\x6e\x6f"].map((s) =>
    Uint8Array.from(s, (c) => c.charCodeAt(0)),
  );
  // Known roots from the Certificate Transparency test vectors (RFC 6962 reference implementations).
  const knownRoots = [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
  ];
  it("reproduces the CT known roots for 1 to 8 leaves", async () => {
    for (let n = 1; n <= 8; n++) expect(toHex(await root(leaves.slice(0, n)))).toBe(knownRoots[n - 1]);
    expect(toHex(await root([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("inclusion proofs verify for every leaf of every tree size, and fail when tampered", async () => {
    for (let n = 1; n <= 8; n++) {
      const hashed = await Promise.all(leaves.slice(0, n).map(leafHash));
      const r = await rootFromLeafHashes(hashed);
      for (let i = 0; i < n; i++) {
        const proof = await inclusionProof(hashed, i);
        expect(await verifyInclusion(hashed[i]!, i, n, proof, r)).toBe(true);
        const other = hashed[(i + 1) % n]!;
        if (n > 1) expect(await verifyInclusion(other, i, n, proof, r)).toBe(false);
      }
    }
  });
  it("consistency proofs verify between every pair of sizes", async () => {
    const hashed = await Promise.all(leaves.map(leafHash));
    for (let m = 1; m <= 8; m++) {
      for (let n = m; n <= 8; n++) {
        const oldRoot = await rootFromLeafHashes(hashed.slice(0, m));
        const newRoot = await rootFromLeafHashes(hashed.slice(0, n));
        const proof = await consistencyProof(hashed.slice(0, n), m);
        expect(await verifyConsistency(m, n, oldRoot, newRoot, proof)).toBe(true);
        if (n > m) expect(await verifyConsistency(m, n, newRoot, oldRoot, proof)).toBe(false);
      }
    }
  });
});

describe("keys and JWS", () => {
  it("generates Ed25519 keys with RFC 7638 thumbprints and signs canonical JSON", async () => {
    const { publicJwk, privateJwk } = await generateKeyPair();
    expect(publicJwk.kid).toBe(await thumbprint(publicJwk));
    expect(publicJwk.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const payload = { root_hash: await digest("x"), version: 3 };
    const jws = await signObject(payload, privateJwk, JWS_TYPES.semantoVersion, { iat: new Date("2026-10-22T00:00:00Z") });
    const ok = await verifyJws(jws.compact, (kid) => (kid === publicJwk.kid ? publicJwk : null), { expectTyp: JWS_TYPES.semantoVersion });
    expect(ok.ok).toBe(true);
    const det = await verifyJws(jws.detached, () => publicJwk, { payload, expectTyp: JWS_TYPES.semantoVersion });
    expect(det.ok).toBe(true);
    const wrong = await verifyJws(jws.detached, () => publicJwk, { payload: { ...payload, version: 4 } });
    expect(wrong).toEqual({ ok: false, reason: "bad_signature" });
    const typ = await verifyJws(jws.compact, () => publicJwk, { expectTyp: JWS_TYPES.witness });
    expect(typ).toEqual({ ok: false, reason: "wrong_type" });
    const unknown = await verifyJws(jws.compact, () => null);
    expect(unknown).toEqual({ ok: false, reason: "unknown_key" });
  });
  it("enforces statement validity windows and key revocation", async () => {
    const { publicJwk, privateJwk } = await generateKeyPair();
    const jws = await signObject({ a: 1 }, privateJwk, "t", { nbf: new Date("2026-01-01T00:00:00Z"), exp: new Date("2026-02-01T00:00:00Z") });
    expect((await verifyJws(jws.compact, () => publicJwk, { at: new Date("2025-12-31T00:00:00Z") })).ok).toBe(false);
    expect((await verifyJws(jws.compact, () => publicJwk, { at: new Date("2026-01-15T00:00:00Z") })).ok).toBe(true);
    expect((await verifyJws(jws.compact, () => publicJwk, { at: new Date("2026-03-01T00:00:00Z") })).ok).toBe(false);
    expect(keyValidAt({ ...publicJwk, revoked_at: "2026-06-01T00:00:00Z" }, new Date("2026-07-01T00:00:00Z"))).toEqual({ ok: false, reason: "revoked" });
    expect(keyValidAt({ ...publicJwk, exp: "2026-06-01T00:00:00Z" }, new Date("2026-05-01T00:00:00Z"))).toEqual({ ok: true });
  });
  it("reads DNS key records", () => {
    const kid = "a".repeat(43);
    expect(parseDnsKeyRecords([`"${dnsKeyRecord(kid)}"`, "v=spf1 -all"])).toEqual([kid]);
  });
});

describe("RFC 9421 HTTP message signatures", () => {
  it("builds the signature base in the RFC's form", () => {
    const base = signatureBase(
      { kind: "request", method: "post", url: "https://example.com/foo?param=Value&Pet=dog", headers: { "Content-Type": "application/json", Host: "example.com" } },
      ["@method", "@authority", "@path", "content-type"],
      { created: 1618884473, keyid: "test-key-ed25519" },
    );
    expect(base).toBe(
      '"@method": POST\n"@authority": example.com\n"@path": /foo\n"content-type": application/json\n"@signature-params": ("@method" "@authority" "@path" "content-type");created=1618884473;keyid="test-key-ed25519"',
    );
  });
  it("signs a Semanto response and verifies it, and a changed body fails", async () => {
    const { publicJwk, privateJwk } = await generateKeyPair();
    const body = "# Security at Acme\n\nEvery employee account uses multi-factor authentication.\n";
    const headers: Record<string, string> = {
      "content-type": "text/markdown; charset=utf-8",
      "content-digest": await contentDigest(body),
      "trooth-semanto-version": "smv_abcdefghijklmnopqrstuvwxyz",
      "trooth-page-hash": await digest(body),
    };
    const signed = await signMessage({ kind: "response", status: 200, headers }, privateJwk, { components: [...SEMANTO_RESPONSE_COMPONENTS], created: 1760000000, ttlSeconds: 300, tag: "trooth-semanto" });
    const all: Record<string, string> = { ...headers, ...signed };
    const v = await verifyMessage({ kind: "response", status: 200, headers: all }, { resolveKey: (k) => (k === publicJwk.kid ? publicJwk : null), required: ["@status", "content-digest"], tag: "trooth-semanto", now: 1760000010 });
    expect(v.ok).toBe(true);
    expect(await verifyContentDigest(all["content-digest"]!, body)).toBe(true);
    expect(await verifyContentDigest(all["content-digest"]!, body + " ")).toBe(false);
    const tampered = await verifyMessage({ kind: "response", status: 200, headers: { ...all, "trooth-page-hash": await digest("other") } }, { resolveKey: () => publicJwk, now: 1760000010 });
    expect(tampered).toEqual({ ok: false, reason: "bad_signature" });
    const late = await verifyMessage({ kind: "response", status: 200, headers: all }, { resolveKey: () => publicJwk, now: 1760000400 });
    expect(late).toEqual({ ok: false, reason: "expired" });
    const parsed = parseSignatureInput(signed["Signature-Input"]);
    expect(parsed.sig1!.params.tag).toBe("trooth-semanto");
    expect(parsed.sig1!.components).toEqual([...SEMANTO_RESPONSE_COMPONENTS]);
  });
  it("verifies a Web Bot Auth request and rejects one without the tag or the agent header", async () => {
    const { publicJwk, privateJwk } = await generateKeyPair();
    const req = { kind: "request" as const, method: "GET", url: "https://acme.com/security", headers: { "signature-agent": '"https://agent.example"', host: "acme.com" } };
    const sig = await signMessage(req, privateJwk, { components: ["@authority", "signature-agent"], created: 1760000000, ttlSeconds: 60, tag: "web-bot-auth", nonce: "n1" });
    const good = await verifyMessage({ ...req, headers: { ...req.headers, ...sig } }, { resolveKey: () => publicJwk, required: ["@authority", "signature-agent"], tag: "web-bot-auth", now: 1760000001 });
    expect(good.ok).toBe(true);
    const noTag = await signMessage(req, privateJwk, { components: ["@authority", "signature-agent"], created: 1760000000 });
    const bad = await verifyMessage({ ...req, headers: { ...req.headers, ...noTag } }, { resolveKey: () => publicJwk, tag: "web-bot-auth", now: 1760000001 });
    expect(bad).toEqual({ ok: false, reason: "wrong_tag" });
    const other = await verifyMessage({ ...req, url: "https://other.example/security", headers: { ...req.headers, ...sig } }, { resolveKey: () => publicJwk, tag: "web-bot-auth", now: 1760000001 });
    expect(other).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("content negotiation", () => {
  const offered = ["html", "markdown", "jsonld"] as const;
  it("matches Cloudflare's documented outcomes", () => {
    expect(negotiate("text/markdown", [...offered])).toBe("markdown");
    expect(negotiate("text/markdown, text/html;q=0.9", [...offered])).toBe("markdown");
    expect(negotiate("text/*", [...offered])).toBe("html");
    expect(negotiate("text/*", ["markdown", "html"])).toBe("markdown");
    expect(negotiate("*/*", [...offered])).toBe("html");
    expect(negotiate(null, [...offered])).toBe("html");
    expect(negotiate("application/ld+json", [...offered])).toBe("jsonld");
    expect(negotiate("text/html;q=0.8, text/markdown;q=0.9, */*;q=0.1", [...offered])).toBe("markdown");
    expect(negotiate("text/markdown;q=0", [...offered])).toBe("html");
  });
  it("parses q values and reads format suffixes", () => {
    expect(parseAccept("text/html;q=0.5, text/markdown")).toHaveLength(2);
    expect(representationFromPath("/security.md")).toEqual({ rep: "markdown", basePath: "/security" });
    expect(representationFromPath("/security/index.md")).toEqual({ rep: "markdown", basePath: "/security/" });
    expect(representationFromPath("/facts.jsonld")).toEqual({ rep: "jsonld", basePath: "/" });
    expect(representationFromPath("/about")).toEqual({ rep: null, basePath: "/about" });
  });
});

describe("ids", () => {
  it("makes content-addressed ids", async () => {
    const id = semantoId("smv", await digest("x"));
    expect(id).toMatch(/^smv_[a-z2-7]{26}$/);
    expect(isSemantoId(id, "smv")).toBe(true);
    expect(isSemantoId(id, "smp")).toBe(false);
    expect(isTroothId("acme")).toBe(true);
    expect(isTroothId("Acme")).toBe(false);
  });
});

describe("Semanto file structure", () => {
  it("validates, hashes and detects tampering", async () => {
    const md = utf8("# Security\n\nEvery employee account uses multi-factor authentication.\n");
    const page = {
      id: semantoId("smp", await digest(md)),
      url: "https://acme.com/security",
      title: "Security",
      hash: await digest(md),
      source_hash: await digest("<html>"),
      bytes: md.length,
      tokens: 20,
      witnessed_at: "2026-10-22T12:00:00Z",
      status: 200,
      index: { noindex: false, nosnippet: false, canonical: null, robots_blocked: false },
    };
    const factBody: Omit<Fact, "id"> = {
      key: "security.mfa",
      statement: "Acme requires multi-factor authentication for every employee account.",
      provenance: "declared",
      evidence: { url: "https://acme.com/security", witnessed_at: "2026-10-22T12:00:00Z" },
    };
    const fact: Fact = { id: await factId(factBody), ...factBody };
    const facts = [fact];
    const controls = { say_it_this_way: { company: "Acme" }, when_unknown: "Say that Acme has not published this.", access_policy: "open" as const, content_signals: { "ai-train": true, search: true, "ai-input": true } };
    const header = {
      schema: SCHEMA_URL as typeof SCHEMA_URL,
      contract: 1 as const,
      org: "Acme Inc",
      trooth_id: "acme",
      domains: ["acme.com"],
      profile: "https://trooth.co/network/company/acme",
      version: 1,
      supersedes: null,
      built_at: "2026-10-22T12:00:00Z",
      state: "signed" as const,
      not_before: "2026-10-22T12:00:00Z",
      not_after: null,
      witness_meaning: "Witnessed means Trooth observed it, with a source and a date, not that it is true" as const,
      tiers: [
        { name: "facts" as const, tokens: 30, hash: await tierHash(facts) },
        { name: "controls" as const, tokens: 10, hash: await tierHash(controls) },
        { name: "pages" as const, tokens: 20, hash: await tierHash([page]) },
        { name: "question_map" as const, tokens: 0, hash: await tierHash([]) },
        { name: "documents" as const, tokens: 0, hash: await tierHash([]) },
        { name: "products" as const, tokens: 0, hash: await tierHash([]) },
      ],
      pages_root: await pagesRoot([page]),
      facts_root: await factsRoot(facts),
      pages_manifest: [page],
      identity: { domain: "acme.com", trooth_id: "acme", key_binding: { jwks_url: "https://acme.com/.well-known/trooth-keys.json", dns_record: true } },
    };
    const file: SemantoFile = {
      header,
      facts,
      controls,
      question_map: [],
      documents: [],
      products: [],
      root_hash: await rootHash(header),
      signature: { alg: "EdDSA", kid: "k", jws: "x..y", key: "https://acme.com/.well-known/trooth-keys.json#k" },
      witness: null,
      ledger: null,
    };
    expect(validate(file)).toEqual([]);
    expect(await verifyStructure(file, async () => md)).toEqual([]);
    const tampered = structuredClone(file);
    tampered.facts[0]!.statement = "Acme requires nothing.";
    const issues = await verifyStructure(tampered);
    expect(issues.map((i) => i.path)).toContain("header.facts_root");
    expect(issues.map((i) => i.path)).toContain(`facts.${fact.id}`);
    const wrongBytes = await verifyStructure(file, async () => utf8("changed"));
    expect(wrongBytes.map((i) => i.path)).toContain("pages.https://acme.com/security");
    const unsigned = structuredClone(file);
    unsigned.signature = null;
    expect(validate(unsigned).map((i) => i.path)).toContain("signature");
  });
});
