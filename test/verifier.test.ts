// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Runs the standalone JavaScript verifier (verifier/js/verify.mjs, which
// imports nothing from src/core) against every shared test vector in
// verifier/test-vectors/v1, positive and negative, and cross-checks its
// hashing against src/core so the two implementations cannot drift apart.
// The Python and Go verifiers run the same vectors in their own test files.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalize } from "@/core/canonical";
import { pagesRoot, factsRoot, rootHash, type SemantoFile } from "@/core/semanto";
import { utf8 } from "@/core/encoding";
import * as V from "../verifier/js/verify.mjs";

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "verifier", "test-vectors", "v1");
const readJson = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const keys = readJson("keys.json");
const manifest = readJson("manifest.json") as { files: string[] };

interface Vector {
  kind: string;
  now?: string;
  now_epoch?: number;
  expect: { ok: boolean; reason?: string; state?: string; keyid?: string; agent?: string; version_id?: string };
  [k: string]: unknown;
}

/** One dispatcher per vector kind, shared with the CLI's reading of the files. */
async function run(v: Vector): Promise<{ ok: boolean; reason?: string | null; state?: string; keyid?: string | null; agent?: string; version_id?: string | null }> {
  const semanto = readJson("semanto.json");
  switch (v.kind) {
    case "semanto-file": {
      const pages = readJson("pages.json").by_url as Record<string, string>;
      return V.verifySemanto(v.file, pages, keys, { now: v.now });
    }
    case "page-proof":
      return V.verifyPageProof(v.proof, v.page_markdown as string, keys, { now: v.now, header: v.header });
    case "response": {
      const r = v.response as { status: number; headers: Record<string, string>; body: string };
      return V.verifyResponse(r.status, r.headers, r.body, keys, { now: v.now_epoch });
    }
    case "web-bot-auth-request": {
      const r = v.request as { method: string; url: string; headers: Record<string, string> };
      return V.verifyWebBotAuthRequest(r.method, r.url, r.headers, keys, { now: v.now_epoch });
    }
    case "offer":
      return V.verifyOffer(v.jws as string, keys, { now: v.now });
    case "witness":
      return V.verifyJws(v.jws as string, V.keyResolver(keys), { expectTyp: V.JWS_TYPES.witness, payload: v.payload, at: new Date(v.now!) });
    case "revocations": {
      const l = await V.verifyRevocationList(v.jws as string, keys, { now: v.now });
      return { ok: l.ok, reason: l.ok ? null : l.reason, state: V.stateOf(semanto.file, new Date(v.now!), l.ok ? l.payload : null) };
    }
    case "log": {
      const incl = await V.verifyInclusionInLog(v.inclusion as never);
      const cons = await V.verifyConsistency(v.consistency as never);
      const heads = v.tree_heads as Record<string, { payload: unknown; jws: string }>;
      const th3 = await V.verifyTreeHead(heads["3"]!, keys, { now: v.now });
      const th5 = await V.verifyTreeHead(heads["5"]!, keys, { now: v.now });
      const cp = await V.verifyCheckpoint(v.checkpoint as string, keys, v.origin as string);
      const ok = incl && cons && th3.ok && th5.ok && cp.ok && cp.root_hash === (v.inclusion as { root_hash: string }).root_hash;
      return { ok, reason: ok ? null : "log_check_failed" };
    }
    case "pages":
      return { ok: true };
    default:
      throw new Error(`unknown vector kind ${v.kind}`);
  }
}

describe("verifier test vectors (JavaScript)", () => {
  const files = manifest.files.filter((f) => f !== "keys.json");
  for (const name of files) {
    it(`${name} concludes what the vector expects`, async () => {
      const v = readJson(name) as Vector;
      const r = await run(v);
      expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(v.expect.ok);
      if (v.expect.reason) expect(r.reason).toBe(v.expect.reason);
      if (v.expect.state) expect(r.state).toBe(v.expect.state);
      if (v.expect.keyid) expect(r.keyid).toBe(v.expect.keyid);
      if (v.expect.agent) expect(r.agent).toBe(v.expect.agent);
      if (v.expect.version_id) expect(r.version_id).toBe(v.expect.version_id);
    });
  }

  it("lists every vector file in the manifest and every negative has a reason or a state", () => {
    const onDisk = [...readdirSync(DIR).filter((f) => f.endsWith(".json")), ...readdirSync(join(DIR, "negative")).map((f) => `negative/${f}`)].filter((f) => f !== "manifest.json");
    expect(onDisk.sort()).toEqual([...manifest.files].sort());
    for (const f of manifest.files.filter((x) => x.startsWith("negative/"))) {
      const v = readJson(f) as Vector;
      expect(Boolean(v.expect.reason) || v.expect.state === "withdrawn").toBe(true);
    }
  });

  it("hashes exactly as src/core does (no drift between the Worker and the standalone verifier)", async () => {
    const file = readJson("semanto.json").file as SemantoFile;
    expect(V.canonicalize(file.header)).toBe(canonicalize(file.header));
    expect(await V.rootHash(file.header)).toBe(await rootHash(file.header));
    expect(await V.pagesRoot(file.header.pages_manifest)).toBe(await pagesRoot(file.header.pages_manifest));
    expect(await V.factsRoot(file.facts)).toBe(await factsRoot(file.facts));
    expect(V.canonicalize({ b: 1, a: [true, null, "x"], "é": 2, A: 3 })).toBe('{"A":3,"a":[true,null,"x"],"b":1,"é":2}');
    expect(V.canonicalize({ s: "line\nbreak\t\"q\"\\" })).toBe('{"s":"line\\nbreak\\t\\"q\\"\\\\"}');
  });

  it("reproduces the RFC 6962 known roots", async () => {
    const leaves = ["", "\x00", "\x10", "\x20\x21", "\x30\x31", "\x40\x41\x42\x43", "\x50\x51\x52\x53\x54\x55\x56\x57", "\x60\x61\x62\x63\x64\x65\x66\x67\x68\x69\x6a\x6b\x6c\x6d\x6e\x6f"].map((s) => Uint8Array.from(s, (c) => c.charCodeAt(0)));
    const hashed: Uint8Array[] = [];
    for (const l of leaves) hashed.push(await V.leafHash(l));
    expect(V.toHex(await V.rootFromLeafHashes(hashed))).toBe("5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328");
    expect(V.toHex(await V.rootFromLeafHashes(hashed.slice(0, 3)))).toBe("aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77");
  });

  it("the page proof fails when the proof path is swapped and when the header is edited", async () => {
    const v = readJson("page-proof.json");
    const swapped = structuredClone(v.proof);
    swapped.inclusion.path.reverse();
    const r1 = await V.verifyPageProof(swapped, v.page_markdown, keys, { now: v.now, header: v.header });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("pages_root_mismatch");
    const edited = structuredClone(v.header);
    edited.org = "Acme Incorporated";
    const r2 = await V.verifyPageProof(v.proof, v.page_markdown, keys, { now: v.now, header: edited });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("root_hash_mismatch");
    const wrongLeaf = structuredClone(v.proof);
    wrongLeaf.ledger.leaf.hash = await V.digest("another root");
    const r3 = await V.verifyPageProof(wrongLeaf, v.page_markdown, keys, { now: v.now, header: v.header });
    expect(r3.reason).toBe("log_leaf_mismatch");
    const noHeader = await V.verifyPageProof(v.proof, v.page_markdown, keys, { now: v.now });
    expect(noHeader.ok).toBe(true);
    expect(noHeader.checks.find((c) => c.name === "header")?.detail).toContain("not checked");
  });

  it("a signed response with the body changed fails on Content-Digest, and the wrong tag is refused", async () => {
    const v = readJson("response.json");
    const r = v.response;
    const changed = await V.verifyResponse(r.status, r.headers, r.body + " ", keys, { now: v.now_epoch });
    expect(changed.ok).toBe(false);
    expect(changed.reason).toBe("content_digest_mismatch");
    const wrongTag = await V.verifyResponse(r.status, r.headers, r.body, keys, { now: v.now_epoch, tag: "web-bot-auth" });
    expect(wrongTag.reason).toBe("wrong_tag");
    const noSig = { ...r.headers };
    delete noSig.Signature;
    expect((await V.verifyResponse(r.status, noSig, r.body, keys, { now: v.now_epoch })).reason).toBe("no_signature");
  });

  it("stateOf reads validity windows and revocations", () => {
    const file = readJson("semanto.json").file;
    expect(V.stateOf(file, new Date("2026-10-22T12:00:10Z"))).toBe("current");
    expect(V.stateOf(file, new Date("2026-10-01T00:00:00Z"))).toBe("behind");
    expect(V.stateOf(file, new Date("2027-03-01T00:00:00Z"))).toBe("expired");
    const smv = V.versionId(file.root_hash);
    expect(V.stateOf(file, new Date("2026-10-22T12:00:10Z"), { revocations: [{ kind: "version", ref: smv, revoked_at: "2026-10-22T12:00:05Z" }] })).toBe("withdrawn");
    expect(V.stateOf(file, new Date("2026-10-22T12:00:10Z"), { revocations: [{ kind: "version", ref: smv, revoked_at: "2026-10-23T00:00:00Z" }] })).toBe("current");
    expect(V.stateOf(file, new Date("2026-10-22T12:00:10Z"), null, 2)).toBe("superseded");
    expect(V.stateOf({ ...file, header: { ...file.header, state: "confirmed" }, signature: null }, new Date())).toBe("unsigned");
  });

  it("the CLI verifies the vector file offline and exits non-zero on a tampered one", () => {
    const cli = join(ROOT, "verifier", "js", "cli.mjs");
    const good = spawnSync(process.execPath, [cli, "file", join(DIR, "semanto.json"), "--pages", join(DIR, "pages"), "--keys", join(DIR, "keys.json")], { encoding: "utf8" });
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain("Every check passed.");
    expect(good.stdout).toContain("3 of 3 pages were given");
    const bad = spawnSync(process.execPath, [cli, "file", join(DIR, "negative", "fact-tampered.json"), "--keys", join(DIR, "keys.json")], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL facts_root");
    const tamperedPage = spawnSync(process.execPath, [cli, "file", join(DIR, "semanto.json"), "--pages", join(ROOT, "test", "fixtures", "verifier", "tampered-pages"), "--keys", join(DIR, "keys.json")], { encoding: "utf8" });
    expect(tamperedPage.status).toBe(1);
    expect(tamperedPage.stdout).toContain("FAIL page_bytes");
  });

  it("the Web Bot Auth request fails for another authority", async () => {
    const v = readJson("web-bot-auth-request.json");
    const r = v.request;
    const other = await V.verifyWebBotAuthRequest(r.method, "https://other.example/security", r.headers, keys, { now: v.now_epoch });
    expect(other.ok).toBe(false);
    expect(other.ok ? null : other.reason).toBe("bad_signature");
  });

  it("the vectors contain no banned words and no ellipses", () => {
    const text = manifest.files.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n") + readFileSync(join(DIR, "README.md"), "utf8");
    expect(text).not.toMatch(/…|\.\.\./);
    expect(text).not.toMatch(/\b(verified|certified|score)\b/i);
    const bytes = utf8(text);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
