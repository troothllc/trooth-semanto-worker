// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The LogStore over D1 and R2, following migrations/0001_semanto.sql
// (semanto_log, semanto_tree_heads) and the transparency.dev tile layout
// (golang.org/x/mod/sumdb/tlog, "tiles" of 256 hashes): level-0 tiles hold
// leaf hashes, level-n tiles hold the hashes of the nodes one level up. Tiles
// are written to R2 at semanto/log/tile/<level>/<index> as 32-byte records so
// a monitor can download the tree in fixed-size pieces without asking the
// database. D1 holds one row per leaf and one row per signed tree head.
//
// This file needs a Cloudflare runtime and is not covered by the Node tests;
// the pure logic it shares with the memory store (tile math) is tested.

import { fromHex, toHex, concat, fromUtf8 } from "@/core/encoding";
import { nodeHash } from "@/core/merkle";
import { leafBytes, type LogLeaf, type LogStore, type StoredTreeHead } from "./ports";

export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 1 << TILE_HEIGHT; // 256 hashes per tile
export const HASH_SIZE = 32;
export const TILE_PREFIX = "semanto/log/tile";
/** The canonical leaf JSON, one object per leaf, so a reader can recompute the leaf hash. */
export const LEAF_PREFIX = "semanto/log/leaf";
export const leafKey = (index: number): string => `${LEAF_PREFIX}/${index}`;

/** The R2 key for a tile. A partial tile (fewer than 256 hashes) carries ".p/<width>" as tlog does. */
export function tileKey(level: number, index: number, width: number = TILE_WIDTH): string {
  const base = `${TILE_PREFIX}/${level}/${index}`;
  return width === TILE_WIDTH ? base : `${base}.p/${width}`;
}

/** Which level-0 tile holds leaf `index`, and the offset inside it. */
export function tileFor(index: number): { tile: number; offset: number } {
  return { tile: Math.floor(index / TILE_WIDTH), offset: index % TILE_WIDTH };
}

/** Split a tile's bytes into hashes. */
export function splitTile(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length % HASH_SIZE !== 0) throw new Error("splitTile: not a whole number of hashes");
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += HASH_SIZE) out.push(bytes.slice(i, i + HASH_SIZE));
  return out;
}

/** Hash a full level-n tile down to the 256 entries of the level-(n+1) tile it feeds, one entry per 256 leaves. */
export async function tileUp(hashes: Uint8Array[]): Promise<Uint8Array> {
  if (hashes.length !== TILE_WIDTH) throw new Error("tileUp: only a full tile rolls up");
  let layer = hashes;
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(await nodeHash(layer[i]!, layer[i + 1]!));
    layer = next;
  }
  return layer[0]!;
}

interface LogRow {
  idx: number;
  leaf_hash: string;
  kind: string;
  trooth_id: string | null;
  ref: string;
  appended_at: string;
}

interface HeadRow {
  tree_size: number;
  root_hash: string;
  signed_at: string;
  jws: string;
  tsa_token_key: string | null;
  tsa_time: string | null;
}

export class D1LogStore implements LogStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  async size(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM semanto_log").first<{ n: number }>();
    return row?.n ?? 0;
  }

  async appendLeaf(leaf: LogLeaf, leafHash: Uint8Array): Promise<number> {
    // The index is the current size. D1 runs one statement at a time per
    // binding; a Durable Object in front of the log serializes appends in
    // production (a founder step noted in the report).
    const idx = await this.size();
    await this.db
      .prepare("INSERT INTO semanto_log (idx, leaf_hash, kind, trooth_id, ref, appended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(idx, toHex(leafHash), leaf.kind, leaf.trooth_id, leaf.ref, leaf.at)
      .run();
    await this.bucket.put(leafKey(idx), leafBytes(leaf) as unknown as ArrayBuffer, { httpMetadata: { contentType: "application/json" } });
    await this.writeLeafTile(idx, leafHash);
    return idx;
  }

  /** Rewrite the level-0 tile that holds `idx`, then roll up any level above that just became full. */
  private async writeLeafTile(idx: number, leafHash: Uint8Array): Promise<void> {
    const { tile, offset } = tileFor(idx);
    const existing = offset === 0 ? new Uint8Array(0) : await this.readTileBytes(0, tile, offset);
    const bytes = concat(existing, leafHash);
    const width = offset + 1;
    await this.bucket.put(tileKey(0, tile, width), bytes as unknown as ArrayBuffer);
    if (width === TILE_WIDTH) {
      // Drop the partial-width copies once the full tile exists, then roll up.
      await this.rollUp(0, tile, splitTile(bytes));
    }
  }

  private async rollUp(level: number, index: number, hashes: Uint8Array[]): Promise<void> {
    const up = await tileUp(hashes);
    const parentLevel = level + 1;
    const { tile, offset } = tileFor(index);
    const existing = offset === 0 ? new Uint8Array(0) : await this.readTileBytes(parentLevel, tile, offset);
    const bytes = concat(existing, up);
    await this.bucket.put(tileKey(parentLevel, tile, offset + 1), bytes as unknown as ArrayBuffer);
    if (offset + 1 === TILE_WIDTH) await this.rollUp(parentLevel, tile, splitTile(bytes));
  }

  private async readTileBytes(level: number, index: number, width: number): Promise<Uint8Array> {
    const obj = (await this.bucket.get(tileKey(level, index, width))) ?? (await this.bucket.get(tileKey(level, index)));
    if (!obj) throw new Error(`tile ${level}/${index} width ${width} is missing from R2`);
    const all = new Uint8Array(await obj.arrayBuffer());
    return all.slice(0, width * HASH_SIZE);
  }

  async leafHashes(from: number, to: number): Promise<Uint8Array[]> {
    if (from > to) throw new Error("leafHashes: from must be at most to");
    const rows = await this.db.prepare("SELECT idx, leaf_hash FROM semanto_log WHERE idx >= ?1 AND idx < ?2 ORDER BY idx").bind(from, to).all<Pick<LogRow, "idx" | "leaf_hash">>();
    const out = rows.results.map((r) => fromHex(r.leaf_hash));
    if (out.length !== to - from) throw new Error("leafHashes: the log has a gap");
    return out;
  }

  async getLeaf(index: number): Promise<{ leaf: LogLeaf; leafHash: Uint8Array } | null> {
    const r = await this.db.prepare("SELECT idx, leaf_hash, kind, trooth_id, ref, appended_at FROM semanto_log WHERE idx = ?1").bind(index).first<LogRow>();
    if (!r) return null;
    const obj = await this.bucket.get(leafKey(index));
    if (!obj) throw new Error(`leaf ${index} body is missing from R2`);
    const leaf = JSON.parse(fromUtf8(new Uint8Array(await obj.arrayBuffer()))) as LogLeaf;
    return { leaf, leafHash: fromHex(r.leaf_hash) };
  }

  async putTreeHead(head: StoredTreeHead): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO semanto_tree_heads (tree_size, root_hash, signed_at, jws, tsa_token_key, tsa_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(head.tree_size, head.root_hash, head.signed_at, head.jws, head.tsa_token_key ?? null, head.tsa_time ?? null)
      .run();
  }

  async getTreeHead(treeSize: number): Promise<StoredTreeHead | null> {
    const r = await this.db.prepare("SELECT tree_size, root_hash, signed_at, jws, tsa_token_key, tsa_time FROM semanto_tree_heads WHERE tree_size = ?1").bind(treeSize).first<HeadRow>();
    return r ? { ...r } : null;
  }

  async latestTreeHead(): Promise<StoredTreeHead | null> {
    const r = await this.db.prepare("SELECT tree_size, root_hash, signed_at, jws, tsa_token_key, tsa_time FROM semanto_tree_heads ORDER BY tree_size DESC LIMIT 1").first<HeadRow>();
    return r ? { ...r } : null;
  }
}
