// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The log's hashes as tiles, and the proofs computed from them, so an append
// and a proof never read every leaf. Two pieces:
//
//   the compact range   the right edge of the tree (RFC 6962 trees are a row
//                       of perfect subtrees, largest first, one per set bit of
//                       the size; Certificate Transparency's "compact range",
//                       as in transparency-dev/merkle). An append pushes one
//                       leaf and merges equal heights, O(log n); the root is
//                       the fold from the right.
//   tiles               the transparency.dev layout (golang.org/x/mod/sumdb/
//                       tlog): level-k tiles of 256 hashes each hold the roots
//                       of perfect subtrees of 256^k leaves; a partial tile at
//                       the right edge is stored as ".p/<width>". A node of
//                       any height is read from the tile level just below it
//                       and at most 128 hashes are folded.
//
// Inclusion and consistency proofs follow RFC 6962 2.1.1 and 2.1.2 exactly:
// every left part of a split is a perfect, aligned subtree, so each hash the
// proof needs is one tile node; the right parts recurse.

import { concat } from "@/core/encoding";
import { sha256 } from "@/core/hash";
import { nodeHash } from "@/core/merkle";

export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 1 << TILE_HEIGHT; // 256 hashes per tile
export const HASH_SIZE = 32;
export const TILE_PREFIX = "semanto/log/tile";

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

/** Hash a full level-n tile down to the one entry of the level-(n+1) tile it feeds. */
export async function tileUp(hashes: Uint8Array[]): Promise<Uint8Array> {
  if (hashes.length !== TILE_WIDTH) throw new Error("tileUp: only a full tile rolls up");
  return foldPerfect(hashes);
}

async function foldPerfect(hashes: Uint8Array[]): Promise<Uint8Array> {
  let layer = hashes;
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(await nodeHash(layer[i]!, layer[i + 1]!));
    layer = next;
  }
  return layer[0]!;
}

// ---------------------------------------------------------------- the compact range

/** The right edge of a tree of `size` leaves: perfect subtree roots, largest first, with their heights. */
export interface Frontier {
  size: number;
  nodes: { height: number; hash: Uint8Array }[];
}

export const EMPTY_FRONTIER: Frontier = { size: 0, nodes: [] };

/** Append one leaf hash: O(log n) node hashes. */
export async function frontierAppend(f: Frontier, leafHash: Uint8Array): Promise<Frontier> {
  const nodes = [...f.nodes, { height: 0, hash: leafHash }];
  while (nodes.length >= 2 && nodes[nodes.length - 1]!.height === nodes[nodes.length - 2]!.height) {
    const right = nodes.pop()!;
    const left = nodes.pop()!;
    nodes.push({ height: left.height + 1, hash: await nodeHash(left.hash, right.hash) });
  }
  return { size: f.size + 1, nodes };
}

/** The RFC 6962 root from the right edge: the fold from the right. The empty tree's root is SHA-256 of nothing. */
export async function frontierRoot(f: Frontier): Promise<Uint8Array> {
  if (f.nodes.length === 0) return sha256(new Uint8Array(0));
  let r = f.nodes[f.nodes.length - 1]!.hash;
  for (let i = f.nodes.length - 2; i >= 0; i--) r = await nodeHash(f.nodes[i]!.hash, r);
  return r;
}

/** A frontier as JSON (heights and hex), for a D1 row or Durable Object storage. */
export function frontierToJson(f: Frontier): { size: number; nodes: [number, string][] } {
  return { size: f.size, nodes: f.nodes.map((n) => [n.height, [...n.hash].map((b) => b.toString(16).padStart(2, "0")).join("")]) };
}

export function frontierFromJson(j: { size: number; nodes: [number, string][] }): Frontier {
  return { size: j.size, nodes: j.nodes.map(([height, hex]) => ({ height, hash: Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16)) })) };
}

// ---------------------------------------------------------------- tiles over a bucket

/** The slice of R2 the tiles need; an in-memory map in tests. */
export interface TileBucket {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryTileBucket implements TileBucket {
  readonly map = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.map.set(key, bytes);
  }
}

export class Tiles {
  constructor(private readonly bucket: TileBucket) {}

  /** Write leaf `index` into its level-0 tile, and roll up every level that just became full. */
  async appendLeafHash(index: number, leafHash: Uint8Array): Promise<void> {
    await this.appendAt(0, index, leafHash);
  }

  private async appendAt(level: number, index: number, hash: Uint8Array): Promise<void> {
    const { tile, offset } = tileFor(index);
    const existing = offset === 0 ? new Uint8Array(0) : await this.readTile(level, tile, offset);
    const bytes = concat(existing, hash);
    await this.bucket.put(tileKey(level, tile, offset + 1), bytes);
    if (offset + 1 === TILE_WIDTH) await this.appendAt(level + 1, tile, await tileUp(splitTile(bytes)));
  }

  /** The first `width` hashes of a tile: the partial copy of that width, or the full tile once it exists. */
  async readTile(level: number, index: number, width: number): Promise<Uint8Array> {
    const bytes = (width < TILE_WIDTH ? await this.bucket.get(tileKey(level, index, width)) : null) ?? (await this.bucket.get(tileKey(level, index)));
    if (!bytes || bytes.length < width * HASH_SIZE) throw new Error(`tile ${level}/${index} width ${width} is missing`);
    return bytes.slice(0, width * HASH_SIZE);
  }

  /** Entries [from, to) of tile level `level` in a tree of `treeSize` leaves. */
  async entries(level: number, from: number, to: number, treeSize: number): Promise<Uint8Array[]> {
    const span = TILE_WIDTH ** level;
    const available = Math.floor(treeSize / span);
    if (from < 0 || to > available || from > to) throw new Error(`entries: ${from} to ${to} at level ${level} is outside a tree of ${treeSize}`);
    const out: Uint8Array[] = [];
    let i = from;
    while (i < to) {
      const { tile, offset } = tileFor(i);
      const tileEnd = Math.min(to, (tile + 1) * TILE_WIDTH);
      const width = Math.min(TILE_WIDTH, available - tile * TILE_WIDTH);
      const hashes = splitTile(await this.readTile(level, tile, width));
      for (let j = offset; j < offset + (tileEnd - i); j++) out.push(hashes[j]!);
      i = tileEnd;
    }
    return out;
  }

  /** The root of the perfect subtree of height `height` whose leftmost leaf is index * 2^height. */
  async node(height: number, index: number, treeSize: number): Promise<Uint8Array> {
    const level = Math.floor(height / TILE_HEIGHT);
    const below = height - level * TILE_HEIGHT;
    const count = 1 << below;
    const hashes = await this.entries(level, index * count, (index + 1) * count, treeSize);
    return foldPerfect(hashes);
  }
}

// ---------------------------------------------------------------- RFC 6962 from tiles

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

/** MTH(D[start:end]) in a tree of `treeSize`, from tiles. Perfect aligned ranges are one node; others split as RFC 6962 does. */
export async function rangeRoot(t: Tiles, start: number, end: number, treeSize: number): Promise<Uint8Array> {
  const n = end - start;
  if (n === 0) return sha256(new Uint8Array(0));
  if (isPow2(n) && start % n === 0) return t.node(Math.log2(n), start / n, treeSize);
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(await rangeRoot(t, start, start + k, treeSize), await rangeRoot(t, start + k, end, treeSize));
}

/** RFC 6962 2.1.1 PATH(m, D[n]) for leaf `index` in the tree of `treeSize`, from tiles. */
export async function inclusionFromTiles(t: Tiles, index: number, treeSize: number): Promise<Uint8Array[]> {
  if (index < 0 || index >= treeSize) throw new Error("inclusionFromTiles: index out of range");
  const walk = async (m: number, start: number, end: number): Promise<Uint8Array[]> => {
    const n = end - start;
    if (n <= 1) return [];
    const k = largestPowerOfTwoBelow(n);
    if (m < k) return [...(await walk(m, start, start + k)), await rangeRoot(t, start + k, end, treeSize)];
    return [...(await walk(m - k, start + k, end)), await rangeRoot(t, start, start + k, treeSize)];
  };
  return walk(index, 0, treeSize);
}

/** RFC 6962 2.1.2 PROOF(m, D[n]): the tree of `m` leaves is a prefix of the tree of `n`, from tiles. */
export async function consistencyFromTiles(t: Tiles, m: number, n: number): Promise<Uint8Array[]> {
  if (m < 0 || m > n) throw new Error("consistencyFromTiles: m out of range");
  if (m === 0 || m === n) return [];
  const sub = async (mm: number, start: number, end: number, b: boolean): Promise<Uint8Array[]> => {
    const size = end - start;
    if (mm === size) return b ? [] : [await rangeRoot(t, start, end, n)];
    const k = largestPowerOfTwoBelow(size);
    if (mm <= k) return [...(await sub(mm, start, start + k, b)), await rangeRoot(t, start + k, end, n)];
    return [...(await sub(mm - k, start + k, end, false)), await rangeRoot(t, start, start + k, n)];
  };
  return sub(m, 0, n, true);
}
