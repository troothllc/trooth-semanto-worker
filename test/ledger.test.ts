// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/ledger: the public log, the checkpoint text, the monitor,
// RFC 3161 time stamps and the revocation states. Every company here is a
// fixture (Acme Inc, acme.com).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, toPublic } from "@/core/keys";
import { JWS_TYPES, verifyJws } from "@/core/jws";
import { digestBytes, isDigest } from "@/core/hash";
import { toBase64, toHex, fromBase64 } from "@/core/encoding";
import { leafHash as merkleLeafHash, rootFromLeafHashes, verifyInclusion, verifyConsistency } from "@/core/merkle";
import {
  TransparencyLog,
  MemoryLogStore,
  Monitor,
  hashLeaf,
  leafBytes,
  verifyTreeHead,
  verifyInclusionDigests,
  verifyConsistencyDigests,
  parseCheckpoint,
  signCheckpoint,
  verifyCheckpoint,
  checkpointBody,
  treeHeadId,
  LOG_ORIGIN,
  LOG_SIGNER_NAME,
  type LogLeaf,
} from "@/ledger/log";
import { MemoryFetch } from "@/ledger/ports";
import { tileKey, tileFor, splitTile, tileUp, TILE_WIDTH } from "@/ledger/store-d1";
import {
  buildTimeStampRequest,
  decodeTimeStampRequest,
  parseTimeStampResponse,
  buildTestTimeStampResponse,
  timestampTreeHead,
  derRead,
  derChildren,
  derOid,
  derOidToString,
  derInteger,
  derIntegerToNumber,
  derGeneralizedTime,
  parseGeneralizedTime,
  prepareCosignatureLeaf,
  acceptCosignature,
  cosignatureMessage,
  OID_SHA256,
} from "@/ledger/timestamp";
import { importPrivate, sign as rawSign } from "@/core/keys";
import { stateOf, signRevocationList, verifyRevocationList, supersedesChain, keyState, revocationLeaf, REVOCATION_LIST_TTL_MS, type VersionRef, type RevocationEntry } from "@/ledger/revocation";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ledger/fixture-leaves.json", import.meta.url), "utf8")) as { leaves: LogLeaf[] };
const FIXED = new Date("2026-10-22T12:00:00.000Z");

async function newLog(now: () => Date = () => FIXED) {
  const kp = await generateKeyPair();
  const store = new MemoryLogStore();
  return { log: new TransparencyLog(store, kp.privateJwk, now), store, pub: kp.publicJwk, priv: kp.privateJwk };
}

describe("the public log (RFC 6962 over canonical leaves)", () => {
  it("appends leaves, grows the tree size and signs a tree head for every size", async () => {
    const { log, pub } = await newLog();
    const results = [];
    for (const leaf of fixture.leaves) results.push(await log.append(leaf));
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results.map((r) => r.tree_size)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of results) {
      expect(isDigest(r.root)).toBe(true);
      const head = await log.getTreeHead(r.tree_size);
      expect(head?.root_hash).toBe(r.root);
      const v = await verifyTreeHead(head!, pub);
      expect(v.ok).toBe(true);
      const typed = await verifyJws(head!.jws, () => pub, { expectTyp: JWS_TYPES.treeHead });
      expect(typed.ok).toBe(true);
      const wrong = await verifyJws(head!.jws, () => pub, { expectTyp: JWS_TYPES.witness });
      expect(wrong).toEqual({ ok: false, reason: "wrong_type" });
    }
    expect(await treeHeadId(results[9]!.tree_head)).toMatch(/^smt_[a-z2-7]{26}$/);
  });

  it("computes the same root as src/core/merkle.ts over the leaf bytes", async () => {
    const { log } = await newLog();
    for (const leaf of fixture.leaves) await log.append(leaf);
    const hashes = await Promise.all(fixture.leaves.map((l) => merkleLeafHash(leafBytes(l))));
    const expected = `sha256:${toHex(await rootFromLeafHashes(hashes))}`;
    expect((await log.latestTreeHead())!.root_hash).toBe(expected);
    expect(await log.rootAt(10)).toBe(expected);
    expect(await log.rootAt(3)).toBe(`sha256:${toHex(await rootFromLeafHashes(hashes.slice(0, 3)))}`);
  });

  it("inclusion proofs verify with core merkle for every leaf and every size, and fail for the wrong leaf", async () => {
    const { log } = await newLog();
    for (const leaf of fixture.leaves) await log.append(leaf);
    for (let size = 1; size <= fixture.leaves.length; size++) {
      const head = (await log.getTreeHead(size))!;
      for (let i = 0; i < size; i++) {
        const proof = await log.inclusionProof(i, size);
        const lh = await hashLeaf(fixture.leaves[i]!);
        expect(await verifyInclusionDigests(lh, i, size, proof, head.root_hash)).toBe(true);
        expect(await verifyInclusion(lh, i, size, proof.map(digestBytes), digestBytes(head.root_hash))).toBe(true);
        if (size > 1) {
          const other = await hashLeaf(fixture.leaves[(i + 1) % size]!);
          expect(await verifyInclusionDigests(other, i, size, proof, head.root_hash)).toBe(false);
        }
      }
    }
    await expect(log.inclusionProof(3, 2)).rejects.toThrow();
    await expect(log.inclusionProof(0, 99)).rejects.toThrow();
  });

  it("consistency proofs verify between every pair of sizes", async () => {
    const { log } = await newLog();
    for (const leaf of fixture.leaves) await log.append(leaf);
    for (let m = 1; m <= 10; m++) {
      for (let n = m; n <= 10; n++) {
        const a = (await log.getTreeHead(m))!;
        const b = (await log.getTreeHead(n))!;
        const proof = await log.consistencyProof(m, n);
        expect(await verifyConsistencyDigests(m, n, a.root_hash, b.root_hash, proof)).toBe(true);
        expect(await verifyConsistency(m, n, digestBytes(a.root_hash), digestBytes(b.root_hash), proof.map(digestBytes))).toBe(true);
      }
    }
  });

  it("refuses a malformed leaf", async () => {
    const { log } = await newLog();
    await expect(log.append({ ...fixture.leaves[0]!, hash: "sha256:short" })).rejects.toThrow(/hash/);
    await expect(log.append({ ...fixture.leaves[0]!, kind: "something" as LogLeaf["kind"] })).rejects.toThrow(/kind/);
  });
});

describe("checkpoint text (transparency.dev / Sigsum note form)", () => {
  it("round trips and verifies with the witness key, and fails with another key or a changed byte", async () => {
    const { log, pub } = await newLog();
    for (const leaf of fixture.leaves.slice(0, 5)) await log.append(leaf);
    const text = await log.checkpoint();
    const lines = text.split("\n");
    expect(lines[0]).toBe(LOG_ORIGIN);
    expect(lines[1]).toBe("5");
    expect(fromBase64(lines[2]!).length).toBe(32);
    expect(lines[3]).toBe("");
    expect(lines[4]).toMatch(/^— trooth\.co [A-Za-z0-9+/=]+$/);
    const parsed = parseCheckpoint(text);
    expect(parsed.checkpoint.tree_size).toBe(5);
    expect(parsed.checkpoint.root_hash).toBe((await log.getTreeHead(5))!.root_hash);
    expect(parsed.signatures[0]!.keyHash.length).toBe(4);
    expect(parsed.signatures[0]!.signature.length).toBe(64);
    expect(checkpointBody(parsed.checkpoint)).toBe(parsed.body);
    const ok = await verifyCheckpoint(text, LOG_SIGNER_NAME, pub);
    expect(ok.ok).toBe(true);
    const other = await generateKeyPair();
    expect((await verifyCheckpoint(text, LOG_SIGNER_NAME, other.publicJwk)).ok).toBe(false);
    const tampered = text.replace("\n5\n", "\n6\n");
    expect((await verifyCheckpoint(tampered, LOG_SIGNER_NAME, pub)).ok).toBe(false);
  });

  it("parses a foreign checkpoint fixture and reports its signer without accepting it", async () => {
    const text = readFileSync(new URL("./fixtures/ledger/fixture-checkpoint-foreign.txt", import.meta.url), "utf8");
    const parsed = parseCheckpoint(text);
    expect(parsed.checkpoint.origin).toBe("example.org/fixture-log/v1");
    expect(parsed.checkpoint.tree_size).toBe(42);
    expect(parsed.signatures[0]!.name).toBe("example.org");
    const kp = await generateKeyPair();
    expect((await verifyCheckpoint(text, "example.org", kp.publicJwk)).ok).toBe(false);
  });

  it("signCheckpoint produces a body a plain Ed25519 verifier can check", async () => {
    const kp = await generateKeyPair();
    const root = `sha256:${"ab".repeat(32)}`;
    const text = await signCheckpoint({ origin: "acme.example/fixture", tree_size: 7, root_hash: root }, kp.privateJwk, "acme.example");
    expect(text.startsWith(`acme.example/fixture\n7\n${toBase64(digestBytes(root))}\n\n`)).toBe(true);
    expect((await verifyCheckpoint(text, "acme.example", kp.publicJwk)).ok).toBe(true);
  });
});

describe("the Monitor", () => {
  it("passes a log that only grows and includes the leaves it was told about", async () => {
    const { log, pub } = await newLog();
    const first = await log.append(fixture.leaves[0]!);
    for (const leaf of fixture.leaves.slice(1, 6)) await log.append(leaf);
    const prev = (await log.getTreeHead(1))!;
    const cur = (await log.getTreeHead(6))!;
    const report = await new Monitor(log, pub).check(prev, cur, [{ index: first.index, leafHash: await hashLeaf(fixture.leaves[0]!) }]);
    expect(report).toEqual({ ok: true, problems: [], checked: { previous_size: 1, current_size: 6, leaves: 1 } });
  });

  it("detects a forked log: a tree head of a log that rewrote a leaf is not consistent with the one before", async () => {
    const kp = await generateKeyPair();
    const honest = new TransparencyLog(new MemoryLogStore(), kp.privateJwk, () => FIXED);
    const forked = new TransparencyLog(new MemoryLogStore(), kp.privateJwk, () => FIXED);
    for (const leaf of fixture.leaves.slice(0, 4)) {
      await honest.append(leaf);
      await forked.append(leaf);
    }
    const remembered = (await honest.getTreeHead(4))!;
    // The forked log rewrites leaf 2 and continues.
    const forkedStore = new MemoryLogStore();
    const forkedLog = new TransparencyLog(forkedStore, kp.privateJwk, () => FIXED);
    for (const [i, leaf] of fixture.leaves.slice(0, 6).entries()) await forkedLog.append(i === 2 ? { ...leaf, hash: `sha256:${"f".repeat(64)}` } : leaf);
    const forkedHead = (await forkedLog.getTreeHead(6))!;
    const report = await new Monitor(forkedLog, kp.publicJwk).check(remembered, forkedHead, []);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/forked or rewritten/);
    // Same size, different root is also a fork.
    const sameSize = (await forkedLog.getTreeHead(4))!;
    const r2 = await new Monitor(forkedLog, kp.publicJwk).check(remembered, sameSize, []);
    expect(r2.problems[0]).toMatch(/forked/);
  });

  it("detects a tree head signed by another key, a shrinking log and a missing leaf", async () => {
    const { log, pub } = await newLog();
    for (const leaf of fixture.leaves.slice(0, 5)) await log.append(leaf);
    const other = await generateKeyPair();
    const cur = (await log.getTreeHead(5))!;
    const bad = await new Monitor(log, other.publicJwk).check(null, cur, []);
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]).toMatch(/did not verify/);
    const shrink = await new Monitor(log, pub).check(cur, (await log.getTreeHead(3))!, []);
    expect(shrink.problems[0]).toMatch(/shrank/);
    const missing = await new Monitor(log, pub).check(null, cur, [{ index: 1, leafHash: `sha256:${"0".repeat(64)}` }]);
    expect(missing.problems[0]).toMatch(/Leaf 1 is not in the tree of 5 leaves/);
  });
});

describe("tile layout (store-d1 pure parts)", () => {
  it("names tiles the way tlog does and rolls a full tile up to one hash", async () => {
    expect(tileKey(0, 0)).toBe("semanto/log/tile/0/0");
    expect(tileKey(1, 3, 17)).toBe("semanto/log/tile/1/3.p/17");
    expect(tileFor(0)).toEqual({ tile: 0, offset: 0 });
    expect(tileFor(255)).toEqual({ tile: 0, offset: 255 });
    expect(tileFor(256)).toEqual({ tile: 1, offset: 0 });
    const hashes: Uint8Array[] = [];
    for (let i = 0; i < TILE_WIDTH; i++) hashes.push(await merkleLeafHash(new Uint8Array([i])));
    const up = await tileUp(hashes);
    expect(toHex(up)).toBe(toHex(await rootFromLeafHashes(hashes)));
    const bytes = new Uint8Array(TILE_WIDTH * 32);
    hashes.forEach((h, i) => bytes.set(h, i * 32));
    expect(splitTile(bytes).length).toBe(TILE_WIDTH);
    expect(toHex(splitTile(bytes)[5]!)).toBe(toHex(hashes[5]!));
  });
});

describe("RFC 3161 time stamps", () => {
  const root = `sha256:${"3c".repeat(32)}`;
  const nonce = new Uint8Array([0x9a, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

  it("builds a TimeStampReq whose DER decodes back to version 1, SHA-256, the root hash, the nonce and certReq true", () => {
    const req = buildTimeStampRequest(root, nonce);
    expect(req.der[0]).toBe(0x30);
    const top = derRead(req.der);
    expect(top.end).toBe(req.der.length);
    const children = derChildren(top);
    expect(children.map((c) => c.tag)).toEqual([0x02, 0x30, 0x02, 0x01]);
    const [alg, hashed] = derChildren(children[1]!);
    const [oid, nul] = derChildren(alg!);
    expect(derOidToString(oid!.content)).toBe(OID_SHA256);
    expect(nul!.tag).toBe(0x05);
    expect(toHex(hashed!.content)).toBe("3c".repeat(32));
    // The nonce's top bit is set so DER adds a leading zero byte.
    expect(toHex(children[2]!.content)).toBe("009a01020304050607");
    expect(children[3]!.content[0]).toBe(0xff);
    const decoded = decodeTimeStampRequest(req.der);
    expect(decoded).toEqual({ version: 1, hash_oid: OID_SHA256, imprint: root, nonce_hex: "9a01020304050607", cert_req: true });
    expect(req.nonce_hex).toBe("9a01020304050607");
    const random = buildTimeStampRequest(root);
    expect(random.nonce_hex).toMatch(/^[0-9a-f]{16}$/);
    expect(random.nonce_hex).not.toBe(req.nonce_hex);
  });

  it("DER helpers round trip oids, integers and GeneralizedTime", () => {
    expect(derOidToString(derRead(derOid("1.2.840.113549.1.9.16.1.4")).content)).toBe("1.2.840.113549.1.9.16.1.4");
    expect(derIntegerToNumber(derRead(derInteger(0)).content)).toBe(0);
    expect(derIntegerToNumber(derRead(derInteger(300)).content)).toBe(300);
    expect(toHex(derInteger(128))).toBe("02020080");
    const t = new Date("2026-10-22T12:34:56.000Z");
    expect(parseGeneralizedTime(derRead(derGeneralizedTime(t)).content)).toBe("2026-10-22T12:34:56.000Z");
  });

  it("parses a granted response, extracts genTime and the imprint, and rejects a mismatched imprint or nonce", () => {
    const gen = new Date("2026-10-22T12:00:05.000Z");
    const resp = buildTestTimeStampResponse({ imprint: root, nonce, genTime: gen, serial: 77 });
    const ok = parseTimeStampResponse(resp, { imprint: root, nonce_hex: "9a01020304050607" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.token.gen_time).toBe("2026-10-22T12:00:05.000Z");
      expect(ok.token.imprint).toBe(root);
      expect(ok.token.nonce_hex).toBe("9a01020304050607");
      expect(ok.token.serial_hex).toBe("4d");
      expect(ok.token.status).toBe("granted");
      expect(ok.token.signature_checked).toBe(false);
      expect(ok.token.token[0]).toBe(0x30);
    }
    const otherRoot = `sha256:${"4d".repeat(32)}`;
    const mismatch = parseTimeStampResponse(resp, { imprint: otherRoot });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/imprint/);
    const badNonce = parseTimeStampResponse(resp, { imprint: root, nonce_hex: "0000000000000001" });
    expect(badNonce.ok).toBe(false);
    if (!badNonce.ok) expect(badNonce.reason).toMatch(/nonce/);
    const rejected = parseTimeStampResponse(buildTestTimeStampResponse({ imprint: root, genTime: gen, status: 2 }), { imprint: root });
    expect(rejected).toMatchObject({ ok: false, status: "rejection" });
    expect(parseTimeStampResponse(new Uint8Array([0x04, 0x01, 0x00]), { imprint: root }).ok).toBe(false);
  });

  it("round trips through the fetch port and refuses a TSA that answers for another hash", async () => {
    const head = { tree_size: 5, root_hash: root, signed_at: FIXED.toISOString() };
    const gen = new Date("2026-10-22T12:00:09.000Z");
    const tsa = new MemoryFetch((_url, init) => {
      expect(init.method).toBe("POST");
      expect(init.headers["content-type"]).toBe("application/timestamp-query");
      const req = decodeTimeStampRequest(init.body!);
      return { status: 200, headers: { "content-type": "application/timestamp-reply" }, body: buildTestTimeStampResponse({ imprint: req.imprint, nonce: fromHexNonce(req.nonce_hex!), genTime: gen }) };
    });
    const r = await timestampTreeHead(head, "https://tsa.example/tsr", tsa);
    expect(r.ok).toBe(true);
    expect(r.token?.gen_time).toBe("2026-10-22T12:00:09.000Z");
    expect(r.token_key).toBe("semanto/log/tsa/5.tsr");
    const liar = new MemoryFetch(() => ({ status: 200, body: buildTestTimeStampResponse({ imprint: `sha256:${"00".repeat(32)}`, genTime: gen }) }));
    const bad = await timestampTreeHead(head, "https://tsa.example/tsr", liar);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/imprint/);
    const down = new MemoryFetch(() => ({ status: 503, body: "" }));
    expect((await timestampTreeHead(head, "https://tsa.example/tsr", down)).reason).toMatch(/503/);
  });

  it("prepares a cosignature leaf for a second log and accepts a valid cosignature only", async () => {
    const head = { tree_size: 5, root_hash: root, signed_at: FIXED.toISOString() };
    const prepared = await prepareCosignatureLeaf(head);
    expect(prepared.leaf.kind).toBe("witness_cosignature");
    expect(prepared.leaf.checkpoint_body).toBe(`${LOG_ORIGIN}\n5\n${toBase64(digestBytes(root))}\n`);
    expect(prepared.leaf.tree_head_id).toMatch(/^smt_/);
    expect(isDigest(prepared.hash)).toBe(true);
    const witness = await generateKeyPair();
    const t = 1_792_000_000;
    const sig = await rawSign(await importPrivate(witness.privateJwk), cosignatureMessage(prepared.leaf.checkpoint_body, t));
    const accepted = await acceptCosignature(prepared.leaf.checkpoint_body, { name: "witness.example", key: witness.publicJwk }, sig, t);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.line).toMatch(/^— witness\.example [A-Za-z0-9+/=]+$/);
    const wrongTime = await acceptCosignature(prepared.leaf.checkpoint_body, { name: "witness.example", key: witness.publicJwk }, sig, t + 1);
    expect(wrongTime.ok).toBe(false);
  });
});

function fromHexNonce(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("validity and revocation", () => {
  const v3: VersionRef = { trooth_id: "acme", id: "smv_cccccccccccccccccccccccccc", version: 3, supersedes: 2, state: "signed", not_before: "2026-10-01T00:00:00.000Z", not_after: "2027-10-01T00:00:00.000Z" };
  const v2: VersionRef = { ...v3, id: "smv_bbbbbbbbbbbbbbbbbbbbbbbbbb", version: 2, supersedes: 1 };
  const v1: VersionRef = { ...v3, id: "smv_aaaaaaaaaaaaaaaaaaaaaaaaaa", version: 1, supersedes: null };
  const now = new Date("2026-10-22T00:00:00.000Z");

  it("returns each of the five states with a plain sentence", () => {
    expect(stateOf(v3, now, [], 3)).toMatchObject({ state: "current", sentence: "Version 3 is the current signed version." });
    expect(stateOf(v2, now, [], 3)).toMatchObject({ state: "superseded" });
    expect(stateOf(v2, now, [], { version: 3, chain: [2, 1] }).state).toBe("superseded");
    expect(stateOf(v1, now, [], { version: 3, chain: [2] })).toMatchObject({ state: "behind" });
    expect(stateOf(v3, new Date("2026-09-01T00:00:00.000Z"), [], 3)).toMatchObject({ state: "behind", sentence: "Version 3 is not valid yet. It starts on 2026-10-01." });
    expect(stateOf(v3, new Date("2028-01-01T00:00:00.000Z"), [], 3)).toMatchObject({ state: "expired" });
    const rev: RevocationEntry = { kind: "version", ref: v3.id, reason: "Prices on the plans page were wrong.", revoked_at: "2026-10-20T00:00:00.000Z" };
    const w = stateOf(v3, now, [rev], 3);
    expect(w.state).toBe("withdrawn");
    expect(w.sentence).toBe("Version 3 was withdrawn on 2026-10-20. Prices on the plans page were wrong.");
    expect(w.revocation).toEqual(rev);
    expect(stateOf({ ...v3, state: "withdrawn" }, now, [], 3).state).toBe("withdrawn");
    // A revocation dated in the future does not count yet; withdrawal beats expiry.
    expect(stateOf(v3, now, [{ ...rev, revoked_at: "2026-11-01T00:00:00.000Z" }], 3).state).toBe("current");
    expect(stateOf(v3, new Date("2028-01-01T00:00:00.000Z"), [rev], 3).state).toBe("withdrawn");
  });

  it("builds the supersedes chain from a set of versions", () => {
    expect(supersedesChain([v1, v2, v3])).toEqual({ version: 3, chain: [2, 1] });
    expect(supersedesChain([v1, { ...v3, supersedes: null }])).toEqual({ version: 3, chain: [] });
    expect(supersedesChain([])).toBeNull();
  });

  it("signs a revocation list with a 24 hour window, verifies it, and calls a stale list stale", async () => {
    const kp = await generateKeyPair();
    const issued = new Date("2026-10-22T00:00:00.000Z");
    const entries: RevocationEntry[] = [
      { kind: "key", ref: "kid-fixture", reason: "Laptop lost.", revoked_at: "2026-10-21T00:00:00.000Z" },
      { kind: "version", ref: v1.id, reason: "Replaced.", revoked_at: "2026-10-20T00:00:00.000Z" },
    ];
    const { list, jws } = await signRevocationList(entries, "acme", kp.privateJwk, issued);
    expect(list.next_update).toBe(new Date(issued.getTime() + REVOCATION_LIST_TTL_MS).toISOString());
    expect(list.revocations[0]!.ref).toBe(v1.id);
    const typed = await verifyJws(jws, () => kp.publicJwk, { expectTyp: JWS_TYPES.revocation, at: issued });
    expect(typed.ok).toBe(true);
    const fresh = await verifyRevocationList(jws, kp.publicJwk, new Date("2026-10-22T12:00:00.000Z"));
    expect(fresh.ok).toBe(true);
    const stale = await verifyRevocationList(jws, kp.publicJwk, new Date("2026-10-23T00:00:01.000Z"));
    expect(stale).toMatchObject({ ok: false, reason: "stale" });
    if (!stale.ok) expect(stale.sentence).toMatch(/Treat it as missing, not as empty/);
    const early = await verifyRevocationList(jws, kp.publicJwk, new Date("2026-10-21T00:00:00.000Z"));
    expect(early).toMatchObject({ ok: false, reason: "not_yet_valid" });
    const other = await generateKeyPair();
    expect((await verifyRevocationList(jws, other.publicJwk, issued)).ok).toBe(false);
    const leaf = await revocationLeaf(entries[0]!, "acme");
    expect(leaf).toMatchObject({ kind: "revocation", trooth_id: "acme", ref: "kid-fixture", at: "2026-10-21T00:00:00.000Z" });
    expect(isDigest(leaf.hash)).toBe(true);
  });

  it("describes key validity in words", async () => {
    const kp = await generateKeyPair();
    const key = { ...toPublic(kp.privateJwk), nbf: "2026-01-01T00:00:00.000Z", exp: "2027-01-01T00:00:00.000Z" };
    expect(keyState(key, [], now).state).toBe("valid");
    expect(keyState(key, [], new Date("2025-01-01T00:00:00.000Z")).state).toBe("not_yet_valid");
    expect(keyState(key, [], new Date("2027-06-01T00:00:00.000Z")).state).toBe("expired");
    expect(keyState(key, [{ kind: "key", ref: key.kid, reason: "Lost.", revoked_at: "2026-10-01T00:00:00.000Z" }], now)).toMatchObject({ state: "revoked" });
  });
});
