// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto public log: an append-only Merkle tree of leaves in the style of
// Certificate Transparency (RFC 6962) with the tile layout and checkpoint text
// of transparency.dev (the "tlog" design, golang.org/x/mod/sumdb/tlog and
// sumdb/note) which Sigsum also uses. Every signed version, witness statement,
// receipt, offer, product record, seller attestation, recall, first publication,
// revocation and key becomes a leaf. Trooth signs each tree head with its
// witness key. Anyone can hold two tree heads and check the log never rewrote
// its past, and hold a leaf and check it was in the tree.
//
// What a reader gets from this module:
//   append(leaf)                  { index, tree_size, root }
//   getTreeHead(size)             { tree_size, root_hash, signed_at, jws }
//   inclusionProof(index, size)   sibling digests, RFC 6962 2.1.1
//   consistencyProof(from, to)    digests, RFC 6962 2.1.2
//   checkpoint(size)              the transparency.dev checkpoint text
//   Monitor                       what an outside party runs against the log

import { canonicalize } from "@/core/canonical";
import { toBase64, fromBase64, toHex, utf8, concat, bytesEqual } from "@/core/encoding";
import { digest, digestBytes, isDigest, sha256 } from "@/core/hash";
import { semantoId } from "@/core/ids";
import { JWS_TYPES, signObject, verifyJws } from "@/core/jws";
import { importPrivate, importPublic, publicKeyBytes, sign as rawSign, verify as rawVerify, type PrivateJwk, type PublicJwk } from "@/core/keys";
import { verifyConsistency, verifyInclusion } from "@/core/merkle";
import { hashLeaf, LEAF_KINDS, type LogLeaf, type LogStore, type StoredTreeHead } from "./ports";
import { consistencyFromTiles, frontierAppend, frontierRoot, inclusionFromTiles, rangeRoot } from "./tiles";

export type { LogLeaf, LeafKind, StoredTreeHead, LogStore } from "./ports";
export { MemoryLogStore, hashLeaf, leafBytes } from "./ports";

/** The signed statement. Its JWS carries typ JWS_TYPES.treeHead. */
export interface TreeHead {
  tree_size: number;
  root_hash: string;
  signed_at: string;
}

export interface AppendResult {
  index: number;
  tree_size: number;
  /** "sha256:" plus 64 hex. */
  root: string;
  /** The tree head signed for this size. */
  tree_head: StoredTreeHead;
}

/** The read-only face of a log, which the Monitor and the serve layer use. */
export interface LogReader {
  getTreeHead(treeSize: number): Promise<StoredTreeHead | null>;
  latestTreeHead(): Promise<StoredTreeHead | null>;
  inclusionProof(index: number, treeSize: number): Promise<string[]>;
  consistencyProof(from: number, to: number): Promise<string[]>;
}

/** The origin line of Trooth's checkpoint. One log, one origin, never reused. */
export const LOG_ORIGIN = "trooth.co/semanto/log/v1";

/** The name on the checkpoint signature line, as a note verifier expects it. */
export const LOG_SIGNER_NAME = "trooth.co";

export function validateLeaf(leaf: LogLeaf): string[] {
  const problems: string[] = [];
  if (!LEAF_KINDS.includes(leaf.kind)) problems.push(`kind must be one of ${LEAF_KINDS.join(", ")}`);
  if (leaf.trooth_id !== null && (typeof leaf.trooth_id !== "string" || !leaf.trooth_id)) problems.push("trooth_id must be a slug or null");
  if (typeof leaf.ref !== "string" || !leaf.ref) problems.push("ref is required");
  if (!isDigest(leaf.hash)) problems.push("hash must be sha256: plus 64 lowercase hex");
  if (typeof leaf.at !== "string" || Number.isNaN(Date.parse(leaf.at))) problems.push("at must be ISO 8601");
  return problems;
}

export const printDigest = (b: Uint8Array): string => `sha256:${toHex(b)}`;

export class TransparencyLog implements LogReader {
  constructor(
    private readonly store: LogStore,
    /** The witness key, or a function that answers it (and throws when the deployment has none, so reads still work). */
    private readonly witness: PrivateJwk | (() => PrivateJwk),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get witnessKey(): PrivateJwk {
    return typeof this.witness === "function" ? this.witness() : this.witness;
  }

  async size(): Promise<number> {
    return this.store.size();
  }

  /**
   * Append one leaf: O(log n). The new root comes from the compact range (the
   * right edge), never from rereading the leaves. Callers in production go
   * through the LogDO Durable Object so appends are serialized.
   */
  async append(leaf: LogLeaf): Promise<AppendResult> {
    const problems = validateLeaf(leaf);
    if (problems.length) throw new Error(`append: ${problems.join("; ")}`);
    const lh = await hashLeaf(leaf);
    const before = await this.store.frontier();
    const next = await frontierAppend(before, lh);
    const index = await this.store.appendLeaf(leaf, lh, next);
    if (index !== before.size) throw new Error("append: the log moved under this append (appends must be serialized)");
    const tree_size = index + 1;
    const head = await this.signHead(tree_size, printDigest(await frontierRoot(next)));
    return { index, tree_size, root: head.root_hash, tree_head: head };
  }

  /** Root over the first `treeSize` leaves: from the compact range at the current size, from the tiles for an earlier one. */
  async rootAt(treeSize: number): Promise<string> {
    const f = await this.store.frontier();
    if (treeSize < 0 || treeSize > f.size) throw new Error("rootAt: size out of range");
    if (treeSize === f.size) return printDigest(await frontierRoot(f));
    return printDigest(await rangeRoot(this.store.tiles(), 0, treeSize, treeSize));
  }

  /** Sign and store a tree head for `treeSize` (the current size when omitted). */
  async signTreeHead(treeSize?: number): Promise<StoredTreeHead> {
    const size = treeSize ?? (await this.store.size());
    return this.signHead(size, await this.rootAt(size));
  }

  private async signHead(size: number, root_hash: string): Promise<StoredTreeHead> {
    const head: TreeHead = { tree_size: size, root_hash, signed_at: this.now().toISOString() };
    const jws = await signObject(head, this.witnessKey, JWS_TYPES.treeHead, { iat: new Date(head.signed_at) });
    const stored: StoredTreeHead = { ...head, jws: jws.compact };
    await this.store.putTreeHead(stored);
    return stored;
  }

  getTreeHead(treeSize: number): Promise<StoredTreeHead | null> {
    return this.store.getTreeHead(treeSize);
  }

  latestTreeHead(): Promise<StoredTreeHead | null> {
    return this.store.latestTreeHead();
  }

  getLeaf(index: number): Promise<{ leaf: LogLeaf; leafHash: Uint8Array } | null> {
    return this.store.getLeaf(index);
  }

  async inclusionProof(index: number, treeSize: number): Promise<string[]> {
    const n = await this.store.size();
    if (treeSize > n) throw new Error("inclusionProof: tree size is beyond the log");
    if (index < 0 || index >= treeSize) throw new Error("inclusionProof: index out of range");
    return (await inclusionFromTiles(this.store.tiles(), index, treeSize)).map(printDigest);
  }

  async consistencyProof(from: number, to: number): Promise<string[]> {
    const n = await this.store.size();
    if (to > n) throw new Error("consistencyProof: tree size is beyond the log");
    if (from < 0 || from > to) throw new Error("consistencyProof: from must be at most to");
    return (await consistencyFromTiles(this.store.tiles(), from, to)).map(printDigest);
  }

  /** The checkpoint text for a published size, signed with the witness key in note form. */
  async checkpoint(treeSize?: number): Promise<string> {
    const head = treeSize === undefined ? await this.store.latestTreeHead() : await this.store.getTreeHead(treeSize);
    if (!head) throw new Error("checkpoint: no tree head for that size");
    return signCheckpoint({ origin: LOG_ORIGIN, tree_size: head.tree_size, root_hash: head.root_hash }, this.witnessKey, LOG_SIGNER_NAME);
  }
}

// ---------------------------------------------------------------- tree head verification

export async function treeHeadId(head: TreeHead): Promise<string> {
  return semantoId("smt", await digest(canonicalize({ tree_size: head.tree_size, root_hash: head.root_hash, signed_at: head.signed_at })));
}

export type TreeHeadCheck = { ok: true; head: TreeHead } | { ok: false; reason: string };

/** Check a tree head JWS: the type, the signature, and that the payload matches what was served beside it. */
export async function verifyTreeHead(stored: { tree_size: number; root_hash: string; signed_at: string; jws: string }, witnessPublic: PublicJwk): Promise<TreeHeadCheck> {
  const v = await verifyJws(stored.jws, (kid) => (kid === witnessPublic.kid ? witnessPublic : null), { expectTyp: JWS_TYPES.treeHead });
  if (!v.ok) return { ok: false, reason: `tree head signature: ${v.reason}` };
  const p = v.payload as Partial<TreeHead>;
  if (p.tree_size !== stored.tree_size || p.root_hash !== stored.root_hash || p.signed_at !== stored.signed_at) return { ok: false, reason: "tree head payload does not match the served fields" };
  if (!Number.isInteger(p.tree_size) || (p.tree_size as number) < 0 || !isDigest(p.root_hash)) return { ok: false, reason: "tree head payload is malformed" };
  return { ok: true, head: { tree_size: p.tree_size as number, root_hash: p.root_hash as string, signed_at: p.signed_at as string } };
}

/** Verify an inclusion proof given as digests. */
export async function verifyInclusionDigests(leafHash: Uint8Array, index: number, treeSize: number, proof: string[], rootHash: string): Promise<boolean> {
  if (!proof.every(isDigest) || !isDigest(rootHash)) return false;
  return verifyInclusion(leafHash, index, treeSize, proof.map(digestBytes), digestBytes(rootHash));
}

/** Verify a consistency proof given as digests. */
export async function verifyConsistencyDigests(oldSize: number, newSize: number, oldRoot: string, newRoot: string, proof: string[]): Promise<boolean> {
  if (!proof.every(isDigest) || !isDigest(oldRoot) || !isDigest(newRoot)) return false;
  return verifyConsistency(oldSize, newSize, digestBytes(oldRoot), digestBytes(newRoot), proof.map(digestBytes));
}

// ---------------------------------------------------------------- checkpoint text (transparency.dev / Sigsum)

/**
 * A checkpoint is a signed note (golang.org/x/mod/sumdb/note):
 *
 *   <origin>\n<tree size>\n<base64 root hash>\n
 *   \n
 *   — <signer name> <base64(key hash[0:4] || signature)>\n
 *
 * The signature is Ed25519 over the body (the three lines, each ending in a
 * newline). The 4-byte key hash is SHA-256(name || "\n" || 0x01 || public key)
 * truncated, the note package's Ed25519 algorithm id being 0x01. A monitor
 * built for Sigsum, Rekor or the Go checksum database reads this unchanged.
 */
export interface Checkpoint {
  origin: string;
  tree_size: number;
  /** "sha256:" plus 64 hex. */
  root_hash: string;
}

export interface CheckpointSignature {
  name: string;
  keyHash: Uint8Array;
  signature: Uint8Array;
}

const NOTE_ED25519 = 0x01;
const SIG_PREFIX = "— ";

export function checkpointBody(c: Checkpoint): string {
  if (!Number.isInteger(c.tree_size) || c.tree_size < 0) throw new Error("checkpointBody: tree size must be a non-negative integer");
  if (!isDigest(c.root_hash)) throw new Error("checkpointBody: root hash must be a digest");
  if (!c.origin || /[\n\r]/.test(c.origin)) throw new Error("checkpointBody: origin must be one line");
  return `${c.origin}\n${c.tree_size}\n${toBase64(digestBytes(c.root_hash))}\n`;
}

export async function noteKeyHash(name: string, pub: PublicJwk): Promise<Uint8Array> {
  const h = await sha256(concat(utf8(name), utf8("\n"), new Uint8Array([NOTE_ED25519]), publicKeyBytes(pub)));
  return h.slice(0, 4);
}

export async function signCheckpoint(c: Checkpoint, key: PrivateJwk, name: string): Promise<string> {
  const body = checkpointBody(c);
  const sig = await rawSign(await importPrivate(key), utf8(body));
  const kh = await noteKeyHash(name, key);
  return `${body}\n${SIG_PREFIX}${name} ${toBase64(concat(kh, sig))}\n`;
}

export function parseCheckpoint(text: string): { checkpoint: Checkpoint; body: string; signatures: CheckpointSignature[] } {
  const split = text.indexOf("\n\n");
  if (split < 0) throw new Error("parseCheckpoint: no blank line between body and signatures");
  const body = text.slice(0, split + 1);
  const lines = body.split("\n");
  if (lines.length < 4) throw new Error("parseCheckpoint: body needs origin, size and root hash lines");
  const [origin, sizeText, rootB64] = lines as [string, string, string];
  if (!/^\d+$/.test(sizeText)) throw new Error("parseCheckpoint: tree size is not a number");
  const rootBytes = fromBase64(rootB64);
  if (rootBytes.length !== 32) throw new Error("parseCheckpoint: root hash is not 32 bytes");
  const signatures: CheckpointSignature[] = [];
  for (const line of text.slice(split + 2).split("\n")) {
    if (!line) continue;
    if (!line.startsWith(SIG_PREFIX)) throw new Error("parseCheckpoint: signature line does not start with the em dash");
    const rest = line.slice(SIG_PREFIX.length);
    const sp = rest.lastIndexOf(" ");
    if (sp < 1) throw new Error("parseCheckpoint: signature line has no name");
    const blob = fromBase64(rest.slice(sp + 1));
    if (blob.length < 5) throw new Error("parseCheckpoint: signature too short");
    signatures.push({ name: rest.slice(0, sp), keyHash: blob.slice(0, 4), signature: blob.slice(4) });
  }
  return { checkpoint: { origin, tree_size: Number(sizeText), root_hash: printDigest(rootBytes) }, body, signatures };
}

/** True when a signature line by `name` with the key hash of `pub` verifies over the body. */
export async function verifyCheckpoint(text: string, name: string, pub: PublicJwk): Promise<{ ok: true; checkpoint: Checkpoint } | { ok: false; reason: string }> {
  let parsed: ReturnType<typeof parseCheckpoint>;
  try {
    parsed = parseCheckpoint(text);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const kh = await noteKeyHash(name, pub);
  const mine = parsed.signatures.filter((s) => s.name === name && bytesEqual(s.keyHash, kh));
  if (mine.length === 0) return { ok: false, reason: `no signature line by ${name} with this key` };
  const pk = await importPublic(pub);
  for (const s of mine) if (await rawVerify(pk, s.signature, utf8(parsed.body))) return { ok: true, checkpoint: parsed.checkpoint };
  return { ok: false, reason: "checkpoint signature does not verify" };
}

/** Read the body text back as the bytes that were signed (for a cosigner). */
export const checkpointBodyBytes = (text: string): Uint8Array => utf8(parseCheckpoint(text).body);

// ---------------------------------------------------------------- the Monitor

export interface KnownLeaf {
  index: number;
  /** The RFC 6962 leaf hash, as bytes or as a digest string. */
  leafHash: Uint8Array | string;
}

export interface MonitorReport {
  ok: boolean;
  /** Plain sentences. Empty when ok. */
  problems: string[];
  checked: { previous_size: number | null; current_size: number; leaves: number };
}

/**
 * What an outside party runs. Give it the witness public key, the previous
 * tree head it remembers and the current one it just fetched, plus the leaves
 * it was told about (its own versions, say). It reports a fork, a bad signature
 * or a missing leaf in plain words. It never trusts the log for the answer:
 * every proof is recomputed locally with the RFC 6962 rules.
 */
export class Monitor {
  constructor(
    private readonly log: LogReader,
    private readonly witnessPublic: PublicJwk,
  ) {}

  async check(previous: StoredTreeHead | null, current: StoredTreeHead, knownLeaves: KnownLeaf[] = []): Promise<MonitorReport> {
    const problems: string[] = [];
    const cur = await verifyTreeHead(current, this.witnessPublic);
    if (!cur.ok) problems.push(`The current tree head (size ${current.tree_size}) did not verify: ${cur.reason}.`);
    if (previous) {
      const prev = await verifyTreeHead(previous, this.witnessPublic);
      if (!prev.ok) problems.push(`The previous tree head (size ${previous.tree_size}) did not verify: ${prev.reason}.`);
      if (previous.tree_size > current.tree_size) problems.push(`The log shrank from ${previous.tree_size} to ${current.tree_size} leaves. A log must only grow.`);
      else if (previous.tree_size === current.tree_size && previous.root_hash !== current.root_hash) problems.push(`Two tree heads of size ${current.tree_size} have different roots. The log was forked.`);
      else if (previous.tree_size < current.tree_size) {
        let proof: string[] = [];
        let fetched = true;
        try {
          proof = await this.log.consistencyProof(previous.tree_size, current.tree_size);
        } catch {
          fetched = false;
        }
        const consistent = fetched && (await verifyConsistencyDigests(previous.tree_size, current.tree_size, previous.root_hash, current.root_hash, proof));
        if (!consistent) problems.push(`The tree of ${current.tree_size} leaves does not extend the tree of ${previous.tree_size} leaves. The log was forked or rewritten.`);
      }
    }
    for (const k of knownLeaves) {
      const lh = typeof k.leafHash === "string" ? digestBytes(k.leafHash) : k.leafHash;
      if (k.index >= current.tree_size) {
        problems.push(`Leaf ${k.index} is beyond the current tree of ${current.tree_size} leaves.`);
        continue;
      }
      let proof: string[] = [];
      let fetched = true;
      try {
        proof = await this.log.inclusionProof(k.index, current.tree_size);
      } catch {
        fetched = false;
      }
      const included = fetched && (await verifyInclusionDigests(lh, k.index, current.tree_size, proof, current.root_hash));
      if (!included) problems.push(`Leaf ${k.index} is not in the tree of ${current.tree_size} leaves.`);
    }
    return { ok: problems.length === 0, problems, checked: { previous_size: previous?.tree_size ?? null, current_size: current.tree_size, leaves: knownLeaves.length } };
  }
}

/** Decode a checkpoint and return the same StoredTreeHead shape so a monitor can feed it to check(). */
export function treeHeadFromCheckpoint(text: string, jws: string, signed_at: string): StoredTreeHead {
  const { checkpoint } = parseCheckpoint(text);
  return { tree_size: checkpoint.tree_size, root_hash: checkpoint.root_hash, signed_at, jws };
}

export const describeLeaf = (leaf: LogLeaf): string => `${leaf.kind} ${leaf.ref}${leaf.trooth_id ? ` for ${leaf.trooth_id}` : ""} at ${leaf.at}`;
