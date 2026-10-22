// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The serving layer's view of the public log, over src/ledger TransparencyLog
// and whatever LogStore backs it (MemoryLogStore in tests, D1LogStore over D1
// and R2 in the Worker). The ledger owns the leaf format (canonical JSON of
// { kind, trooth_id, ref, hash, at }, RFC 8785) and the RFC 6962 hashing;
// this adapter only reshapes its answers into the documents docs/spec/log.md
// states, so the routes, the page proofs and the verifier kits read one format.

import { printDigest, type AppendResult, type TransparencyLog } from "../ledger/log";
import type { LogLeaf, StoredTreeHead } from "../ledger/ports";
import type { LogConsistencyProof, LogInclusion, LogInclusionProof, LogPort } from "./ports";

export class LedgerLogPort implements LogPort {
  constructor(
    readonly ledger: TransparencyLog,
    private readonly logUrl: string,
  ) {}

  /** Append a leaf; the ledger signs a tree head for the new size. */
  append(leaf: LogLeaf): Promise<AppendResult> {
    return this.ledger.append(leaf);
  }

  latestTreeHead(): Promise<StoredTreeHead | null> {
    return this.ledger.latestTreeHead();
  }

  getTreeHead(treeSize: number): Promise<StoredTreeHead | null> {
    return this.ledger.getTreeHead(treeSize);
  }

  async getInclusion(index: number): Promise<LogInclusion | null> {
    const head = await this.ledger.latestTreeHead();
    if (!head || !Number.isInteger(index) || index < 0 || index >= head.tree_size) return null;
    const stored = await this.ledger.getLeaf(index);
    if (!stored) return null;
    const path = await this.ledger.inclusionProof(index, head.tree_size);
    return {
      log: this.logUrl,
      index,
      tree_size: head.tree_size,
      leaf: stored.leaf,
      leaf_hash: printDigest(stored.leafHash),
      root_hash: head.root_hash,
      tree_head_jws: head.jws,
      inclusion_path: path,
    };
  }

  async inclusion(index: number, treeSize: number): Promise<LogInclusionProof | null> {
    const size = await this.ledger.size();
    if (!Number.isInteger(index) || !Number.isInteger(treeSize) || treeSize < 1 || treeSize > size || index < 0 || index >= treeSize) return null;
    const stored = await this.ledger.getLeaf(index);
    if (!stored) return null;
    const root_hash = (await this.ledger.getTreeHead(treeSize))?.root_hash ?? (await this.ledger.rootAt(treeSize));
    return { index, tree_size: treeSize, leaf_hash: printDigest(stored.leafHash), root_hash, path: await this.ledger.inclusionProof(index, treeSize) };
  }

  async consistency(from: number, to: number): Promise<LogConsistencyProof | null> {
    const size = await this.ledger.size();
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 1 || from > to || to > size) return null;
    const old_root = (await this.ledger.getTreeHead(from))?.root_hash ?? (await this.ledger.rootAt(from));
    const new_root = (await this.ledger.getTreeHead(to))?.root_hash ?? (await this.ledger.rootAt(to));
    return { from, to, old_root, new_root, path: await this.ledger.consistencyProof(from, to) };
  }

  async checkpoint(treeSize?: number): Promise<string | null> {
    const head = treeSize === undefined ? await this.ledger.latestTreeHead() : await this.ledger.getTreeHead(treeSize);
    if (!head) return null;
    return this.ledger.checkpoint(head.tree_size);
  }

  async leaf(index: number): Promise<{ index: number; leaf: LogLeaf; leaf_hash: string } | null> {
    if (!Number.isInteger(index) || index < 0) return null;
    const stored = await this.ledger.getLeaf(index);
    return stored ? { index, leaf: stored.leaf, leaf_hash: printDigest(stored.leafHash) } : null;
  }
}
