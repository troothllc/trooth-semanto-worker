// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Merkle tree Semanto uses for a version's pages and facts, and the Ledger
// uses for its append-only log: RFC 6962 (Certificate Transparency) hashing,
// so inclusion proofs and consistency proofs are the ones every CT verifier
// already understands.
//
//   leaf hash   MTH({d}) = SHA-256(0x00 || d)
//   node hash   MTH(D)   = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n])), k the
//                          largest power of two smaller than n
//   empty tree  MTH({})  = SHA-256()
//
// An inclusion proof for leaf i in a tree of n leaves is the list of sibling
// hashes from the leaf to the root. A consistency proof shows a tree of n
// leaves is a prefix of a later tree of m leaves. Both are verified offline.

import { concat, bytesEqual } from "./encoding";
import { sha256 } from "./hash";

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export async function leafHash(data: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(LEAF, data));
}

export async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(NODE, left, right));
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Root over already-hashed leaves (each from leafHash). */
export async function rootFromLeafHashes(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0]!;
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(await rootFromLeafHashes(leaves.slice(0, k)), await rootFromLeafHashes(leaves.slice(k)));
}

export async function root(leafData: Uint8Array[]): Promise<Uint8Array> {
  return rootFromLeafHashes(await Promise.all(leafData.map(leafHash)));
}

/** RFC 6962 2.1.1 PATH(m, D[n]). */
export async function inclusionProof(leaves: Uint8Array[], index: number): Promise<Uint8Array[]> {
  if (index < 0 || index >= leaves.length) throw new Error("inclusionProof: index out of range");
  return path(leaves, index);
}

async function path(leaves: Uint8Array[], m: number): Promise<Uint8Array[]> {
  const n = leaves.length;
  if (n <= 1) return [];
  const k = largestPowerOfTwoBelow(n);
  if (m < k) return [...(await path(leaves.slice(0, k), m)), await rootFromLeafHashes(leaves.slice(k))];
  return [...(await path(leaves.slice(k), m - k)), await rootFromLeafHashes(leaves.slice(0, k))];
}

/** RFC 6962 2.1.3: recompute the root from a leaf hash and its proof. */
export async function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: Uint8Array[], expectedRoot: Uint8Array): Promise<boolean> {
  if (index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      while (!(fn % 2 === 1 || fn === 0)) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(r, expectedRoot);
}

/** RFC 6962 2.1.2 PROOF(m, D[n]): the old tree (first m leaves) is a prefix of the new one. */
export async function consistencyProof(leaves: Uint8Array[], m: number): Promise<Uint8Array[]> {
  const n = leaves.length;
  if (m < 0 || m > n) throw new Error("consistencyProof: m out of range");
  if (m === 0 || m === n) return [];
  return subproof(leaves, m, true);
}

async function subproof(leaves: Uint8Array[], m: number, b: boolean): Promise<Uint8Array[]> {
  const n = leaves.length;
  if (m === n) return b ? [] : [await rootFromLeafHashes(leaves)];
  const k = largestPowerOfTwoBelow(n);
  if (m <= k) return [...(await subproof(leaves.slice(0, k), m, b)), await rootFromLeafHashes(leaves.slice(k))];
  return [...(await subproof(leaves.slice(k), m - k, false)), await rootFromLeafHashes(leaves.slice(0, k))];
}

/** RFC 6962 2.1.4.2: the old root is a prefix of the new root. */
export async function verifyConsistency(oldSize: number, newSize: number, oldRoot: Uint8Array, newRoot: Uint8Array, proof: Uint8Array[]): Promise<boolean> {
  if (oldSize > newSize) return false;
  if (oldSize === newSize) return proof.length === 0 && bytesEqual(oldRoot, newRoot);
  if (oldSize === 0) return proof.length === 0;
  const isPow2 = (oldSize & (oldSize - 1)) === 0;
  const p = isPow2 ? [oldRoot, ...proof] : [...proof];
  if (p.length === 0) return false;
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = p[0]!;
  let sr = p[0]!;
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (!(fn % 2 === 1 || fn === 0)) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(fr, oldRoot) && bytesEqual(sr, newRoot);
}
