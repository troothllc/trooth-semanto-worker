// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ports for the ledger: where leaves and tree heads are kept, and how the
// outside world is reached. Logic in this folder takes plain values; the
// in-memory implementations here are what the tests use, and the D1 and R2
// implementation in store-d1.ts follows the same shape. The split follows
// the transparency.dev "tlog" layout: a sequence of leaf hashes, tiles of
// hashes for readers, and one signed tree head per published size.

import { leafHash as merkleLeafHash } from "@/core/merkle";
import { utf8 } from "@/core/encoding";
import { canonicalize } from "@/core/canonical";
import { EMPTY_FRONTIER, MemoryTileBucket, Tiles, type Frontier } from "./tiles";

/** What a log leaf says. Every field is plain text; `hash` is "sha256:" plus 64 hex. */
export type LeafKind =
  | "semanto_version"
  | "witness"
  | "receipt"
  | "offer"
  | "product_record"
  | "seller_attestation"
  | "recall"
  | "first_publication"
  | "revocation"
  | "key"
  | "erasure";

export interface LogLeaf {
  kind: LeafKind;
  /** The company the leaf is about, or null for Trooth's own entries (keys, tree heads of other logs). */
  trooth_id: string | null;
  /** An smx_ id, or a kid for a key leaf. */
  ref: string;
  /** The digest of the thing being logged. */
  hash: string;
  /** ISO 8601 UTC, when the leaf was made. */
  at: string;
}

export const LEAF_KINDS: readonly LeafKind[] = [
  "semanto_version",
  "witness",
  "receipt",
  "offer",
  "product_record",
  "seller_attestation",
  "recall",
  "first_publication",
  "revocation",
  "key",
  "erasure",
];

/** The canonical bytes of a leaf: RFC 8785 JSON. The leaf hash is RFC 6962 SHA-256(0x00 || bytes). */
export function leafBytes(leaf: LogLeaf): Uint8Array {
  return utf8(canonicalize(leaf));
}

export async function hashLeaf(leaf: LogLeaf): Promise<Uint8Array> {
  return merkleLeafHash(leafBytes(leaf));
}

/** A tree head as stored and served. `jws` is the compact JWS over { tree_size, root_hash, signed_at }. */
export interface StoredTreeHead {
  tree_size: number;
  /** "sha256:" plus 64 hex. */
  root_hash: string;
  signed_at: string;
  jws: string;
  /** Set when an RFC 3161 token was obtained for this head. */
  tsa_token_key?: string | null;
  tsa_time?: string | null;
}

export interface LogStore {
  /** Number of leaves in the log. */
  size(): Promise<number>;
  /** The compact range (right edge) at the current size, so an append is O(log n). */
  frontier(): Promise<Frontier>;
  /**
   * Append one leaf with its precomputed hash and the frontier after it, and
   * return its index (which is the size before the append). Appends must be
   * serialized (the LogDO Durable Object in production, src/ledger/log-do.ts).
   */
  appendLeaf(leaf: LogLeaf, leafHash: Uint8Array, next: Frontier): Promise<number>;
  /** The 256-hash tiles every proof is computed from. */
  tiles(): Tiles;
  /** Leaf hashes for indexes [from, to). For audits and backfills, never on the append or proof path. */
  leafHashes(from: number, to: number): Promise<Uint8Array[]>;
  /** One leaf by index, or null. */
  getLeaf(index: number): Promise<{ leaf: LogLeaf; leafHash: Uint8Array } | null>;
  putTreeHead(head: StoredTreeHead): Promise<void>;
  getTreeHead(treeSize: number): Promise<StoredTreeHead | null>;
  latestTreeHead(): Promise<StoredTreeHead | null>;
}

/** The in-memory store the tests use. Nothing here touches a Cloudflare binding. */
export class MemoryLogStore implements LogStore {
  private leaves: { leaf: LogLeaf; leafHash: Uint8Array }[] = [];
  private heads = new Map<number, StoredTreeHead>();
  private edge: Frontier = EMPTY_FRONTIER;
  readonly bucket = new MemoryTileBucket();
  private readonly tileSet = new Tiles(this.bucket);

  async size(): Promise<number> {
    return this.leaves.length;
  }
  async frontier(): Promise<Frontier> {
    return this.edge;
  }
  async appendLeaf(leaf: LogLeaf, leafHash: Uint8Array, next: Frontier): Promise<number> {
    const index = this.leaves.length;
    if (next.size !== index + 1) throw new Error("appendLeaf: the frontier is not for this append (appends must be serialized)");
    this.leaves.push({ leaf, leafHash });
    await this.tileSet.appendLeafHash(index, leafHash);
    this.edge = next;
    return index;
  }
  tiles(): Tiles {
    return this.tileSet;
  }
  async leafHashes(from: number, to: number): Promise<Uint8Array[]> {
    if (from < 0 || to > this.leaves.length || from > to) throw new Error("leafHashes: range out of bounds");
    return this.leaves.slice(from, to).map((x) => x.leafHash);
  }
  async getLeaf(index: number): Promise<{ leaf: LogLeaf; leafHash: Uint8Array } | null> {
    return this.leaves[index] ?? null;
  }
  async putTreeHead(head: StoredTreeHead): Promise<void> {
    this.heads.set(head.tree_size, head);
  }
  async getTreeHead(treeSize: number): Promise<StoredTreeHead | null> {
    return this.heads.get(treeSize) ?? null;
  }
  async latestTreeHead(): Promise<StoredTreeHead | null> {
    let best: StoredTreeHead | null = null;
    for (const h of this.heads.values()) if (!best || h.tree_size > best.tree_size) best = h;
    return best;
  }
}

/** A minimal fetch port: the time-stamp authority and other logs are reached through it, never through global fetch. */
export interface FetchPort {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
}

/** An in-memory fetch port that answers from a table of handlers, for tests. */
export class MemoryFetch implements FetchPort {
  readonly calls: { url: string; method: string; headers: Record<string, string>; body: Uint8Array | null }[] = [];
  constructor(private readonly handler: (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array | null }) => Promise<{ status: number; headers?: Record<string, string>; body: Uint8Array | string }> | { status: number; headers?: Record<string, string>; body: Uint8Array | string }) {}
  async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string } = {}) {
    const body = init.body === undefined ? null : typeof init.body === "string" ? utf8(init.body) : init.body;
    const call = { url, method: init.method ?? "GET", headers: init.headers ?? {}, body };
    this.calls.push(call);
    const r = await this.handler(url, call);
    return { status: r.status, headers: r.headers ?? {}, body: typeof r.body === "string" ? utf8(r.body) : r.body };
  }
}

/** The fetch port used in the Worker, over the platform fetch. */
export function platformFetch(f: typeof fetch = fetch): FetchPort {
  return {
    async fetch(url, init = {}) {
      const res = await f(url, { method: init.method ?? "GET", headers: init.headers, body: init.body as BodyInit | undefined });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}
