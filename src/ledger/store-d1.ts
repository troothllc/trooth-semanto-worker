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
// The compact range (src/ledger/tiles.ts) lives in semanto_log_frontier, so an
// append is O(log n) and never reads every leaf; proofs are computed from the
// tiles. This file needs a Cloudflare runtime and is not covered by the Node
// tests; the tile and frontier logic it shares with the memory store is.

import { fromHex, toHex, fromUtf8 } from "@/core/encoding";
import { leafBytes, type LogLeaf, type LogStore, type StoredTreeHead } from "./ports";
import { EMPTY_FRONTIER, frontierAppend, frontierFromJson, frontierToJson, Tiles, type Frontier, type TileBucket } from "./tiles";

export { TILE_HEIGHT, TILE_WIDTH, HASH_SIZE, TILE_PREFIX, tileKey, tileFor, splitTile, tileUp } from "./tiles";

/** The canonical leaf JSON, one object per leaf, so a reader can recompute the leaf hash. */
export const LEAF_PREFIX = "semanto/log/leaf";
export const leafKey = (index: number): string => `${LEAF_PREFIX}/${index}`;

/** R2 behind the TileBucket slice. */
export function r2TileBucket(bucket: R2Bucket): TileBucket {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async put(key, bytes) {
      await bucket.put(key, bytes as unknown as ArrayBuffer);
    },
  };
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
  ) {
    this.tileSet = new Tiles(r2TileBucket(bucket));
  }

  private readonly tileSet: Tiles;

  async size(): Promise<number> {
    return (await this.frontier()).size;
  }

  /**
   * The compact range from semanto_log_frontier (migrations/0004). A log that
   * predates the table is backfilled once from its leaf rows.
   */
  async frontier(): Promise<Frontier> {
    const row = await this.db.prepare("SELECT size, nodes FROM semanto_log_frontier WHERE id = 1").first<{ size: number; nodes: string }>();
    if (row) return frontierFromJson({ size: row.size, nodes: JSON.parse(row.nodes) as [number, string][] });
    const count = (await this.db.prepare("SELECT COUNT(*) AS n FROM semanto_log").first<{ n: number }>())?.n ?? 0;
    let f = EMPTY_FRONTIER;
    for (const h of count ? await this.leafHashes(0, count) : []) f = await frontierAppend(f, h);
    await this.putFrontier(f);
    return f;
  }

  private async putFrontier(f: Frontier): Promise<void> {
    const j = frontierToJson(f);
    await this.db.prepare("INSERT OR REPLACE INTO semanto_log_frontier (id, size, nodes) VALUES (1, ?1, ?2)").bind(j.size, JSON.stringify(j.nodes)).run();
  }

  async appendLeaf(leaf: LogLeaf, leafHash: Uint8Array, next: Frontier): Promise<number> {
    // The index is the frontier's size before the append. Appends go through
    // the LogDO Durable Object (src/ledger/log-do.ts), which runs one at a
    // time; the primary key on idx refuses a second leaf at one index.
    const idx = next.size - 1;
    const j = frontierToJson(next);
    await this.bucket.put(leafKey(idx), leafBytes(leaf) as unknown as ArrayBuffer, { httpMetadata: { contentType: "application/json" } });
    await this.tileSet.appendLeafHash(idx, leafHash);
    await this.db.batch([
      this.db.prepare("INSERT INTO semanto_log (idx, leaf_hash, kind, trooth_id, ref, appended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(idx, toHex(leafHash), leaf.kind, leaf.trooth_id, leaf.ref, leaf.at),
      this.db.prepare("INSERT OR REPLACE INTO semanto_log_frontier (id, size, nodes) VALUES (1, ?1, ?2)").bind(j.size, JSON.stringify(j.nodes)),
    ]);
    return idx;
  }

  tiles(): Tiles {
    return this.tileSet;
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
