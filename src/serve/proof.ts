// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The per-page proof: everything a reader needs to check one page offline
// against the signed version and Trooth's public log. Inclusion proofs are
// RFC 6962 (Certificate Transparency) over the manifest's page hashes in
// manifest order, so any CT verifier's code checks them. verifyProof
// recomputes every step from the proof and the page bytes alone; it is the
// reference the verifier kit (verifier/) follows. The one-call verify endpoint
// answers matches, differs, unknown_url or not_signed, never a verdict about
// the company.

import { digest, digestBytes, isDigest } from "../core/hash";
import { toHex } from "../core/encoding";
import { leafHash, inclusionProof, verifyInclusion } from "../core/merkle";
import { verifyJws, JWS_TYPES } from "../core/jws";
import { rootHash as computeRootHash, versionId, type SemantoFile, type SemantoHeader } from "../core/semanto";
import type { PublicJwk } from "../core/keys";
import { hashLeaf, type LogLeaf } from "../ledger/ports";
import type { LogInclusion, VersionStore } from "./ports";
import { stripBehindNotice } from "./errors";

export interface PageProof {
  object: "semanto.proof";
  page_id: string;
  page_hash: string;
  version: number;
  version_id: string;
  pages_root: string;
  inclusion: { index: number; size: number; path: string[] };
  root_hash: string;
  signed_at: string | null;
  witnessed_at: string | null;
  /** The company's JWS over the version header (typ semanto-version). */
  signature: string | null;
  /** Trooth's JWS over { root_hash, witnessed_at } (typ witness-statement). */
  witness: string | null;
  ledger: {
    log: string;
    index: number;
    tree_size: number;
    /** The log's leaf record for this version: { kind: "semanto_version", trooth_id, ref: version_id, hash: root_hash, at }. */
    leaf: LogLeaf;
    leaf_hash: string;
    root_hash: string;
    tree_head_jws: string;
    inclusion_path: string[];
  } | null;
}

const hex = (b: Uint8Array) => `sha256:${toHex(b)}`;

/** Build the proof for one page of a version. Null when the page is not in the manifest. */
export async function buildPageProof(file: SemantoFile, page_id: string, log: LogInclusion | null, signed_at: string | null = null): Promise<PageProof | null> {
  const manifest = file.header.pages_manifest;
  const index = manifest.findIndex((p) => p.id === page_id);
  if (index < 0) return null;
  const entry = manifest[index]!;
  // inclusionProof takes leaf hashes (RFC 6962 2.1.1 PATH over MTH leaves), the same leaves pagesRoot folds.
  const leaves = await Promise.all(manifest.map((p) => leafHash(digestBytes(p.hash))));
  const path = (await inclusionProof(leaves, index)).map(hex);
  return {
    object: "semanto.proof",
    page_id: entry.id,
    page_hash: entry.hash,
    version: file.header.version,
    version_id: versionId(file.root_hash),
    pages_root: file.header.pages_root,
    inclusion: { index, size: manifest.length, path },
    root_hash: file.root_hash,
    signed_at,
    witnessed_at: file.witness?.at ?? null,
    signature: file.signature?.jws ?? null,
    witness: file.witness?.jws ?? null,
    ledger: log
      ? {
          log: log.log,
          index: log.index,
          tree_size: log.tree_size,
          leaf: log.leaf,
          leaf_hash: log.leaf_hash,
          root_hash: log.root_hash,
          tree_head_jws: log.tree_head_jws,
          inclusion_path: log.inclusion_path,
        }
      : null,
  };
}

export type CheckResult = "ok" | "failed" | "not_checked";

export interface ProofVerification {
  ok: boolean;
  checks: {
    page_hash: CheckResult;
    inclusion: CheckResult;
    header: CheckResult;
    signature: CheckResult;
    witness: CheckResult;
    ledger_leaf: CheckResult;
    ledger_inclusion: CheckResult;
    ledger_tree_head: CheckResult;
  };
  failures: string[];
}

export interface VerifyProofOptions {
  /** The version header, when the reader fetched it; lets the proof be tied to root_hash and the company signature be checked. */
  header?: SemantoHeader;
  /** Resolve a kid to a public key: the company's JWKS and Trooth's witness keys. Without it, signatures are not checked. */
  resolveKey?: (kid: string) => Promise<PublicJwk | null> | PublicJwk | null;
  at?: Date;
}

/**
 * Recompute everything offline. A check is "not_checked" only when the input
 * it needs was not given; any check that runs and fails makes ok false.
 */
export async function verifyProof(proof: PageProof, pageBytes: Uint8Array, opts: VerifyProofOptions = {}): Promise<ProofVerification> {
  const checks: ProofVerification["checks"] = {
    page_hash: "not_checked",
    inclusion: "not_checked",
    header: "not_checked",
    signature: "not_checked",
    witness: "not_checked",
    ledger_leaf: "not_checked",
    ledger_inclusion: "not_checked",
    ledger_tree_head: "not_checked",
  };
  const failures: string[] = [];
  const fail = (k: keyof typeof checks, why: string) => {
    checks[k] = "failed";
    failures.push(why);
  };

  if (proof.object !== "semanto.proof" || !isDigest(proof.page_hash) || !isDigest(proof.pages_root) || !isDigest(proof.root_hash)) {
    fail("page_hash", "the proof is not a semanto.proof with full digests");
    return { ok: false, checks, failures };
  }

  const bytes = stripBehindNotice(pageBytes);
  if ((await digest(bytes)) === proof.page_hash) checks.page_hash = "ok";
  else fail("page_hash", "the page bytes do not hash to page_hash");

  try {
    const leaf = await leafHash(digestBytes(proof.page_hash));
    const path = proof.inclusion.path.map(digestBytes);
    const good = await verifyInclusion(leaf, proof.inclusion.index, proof.inclusion.size, path, digestBytes(proof.pages_root));
    if (good) checks.inclusion = "ok";
    else fail("inclusion", "the inclusion path does not reach pages_root");
  } catch {
    fail("inclusion", "the inclusion proof is malformed");
  }

  if (opts.header) {
    const h = opts.header;
    const entry = h.pages_manifest[proof.inclusion.index];
    const rh = await computeRootHash(h);
    if (h.pages_root === proof.pages_root && rh === proof.root_hash && entry?.id === proof.page_id && entry.hash === proof.page_hash && h.version === proof.version) checks.header = "ok";
    else fail("header", "the header does not bind this page to root_hash");
  }

  if (opts.resolveKey) {
    if (proof.signature && opts.header) {
      const r = await verifyJws(proof.signature, opts.resolveKey, { expectTyp: JWS_TYPES.semantoVersion, payload: opts.header, at: opts.at });
      if (r.ok) checks.signature = "ok";
      else fail("signature", `the company signature did not verify: ${r.reason}`);
    }
    if (proof.witness && proof.witnessed_at) {
      const r = await verifyJws(proof.witness, opts.resolveKey, {
        expectTyp: JWS_TYPES.witness,
        payload: { root_hash: proof.root_hash, witnessed_at: proof.witnessed_at },
        at: opts.at,
      });
      if (r.ok) checks.witness = "ok";
      else fail("witness", `the witness statement did not verify: ${r.reason}`);
    }
  }

  if (proof.ledger) {
    const l = proof.ledger;
    try {
      // The ledger's leaf: the canonical leaf record hashes to leaf_hash, and it is this version's semanto_version leaf.
      const leaf = l.leaf;
      const recomputed = leaf ? hex(await hashLeaf(leaf)) : null;
      if (!leaf) fail("ledger_leaf", "the proof carries no log leaf record");
      else if (recomputed !== l.leaf_hash) fail("ledger_leaf", "the log leaf record does not hash to leaf_hash");
      else if (leaf.kind !== "semanto_version") fail("ledger_leaf", "the log leaf is not a semanto_version leaf");
      else if (leaf.hash !== proof.root_hash) fail("ledger_leaf", "the log leaf names a different root_hash");
      else checks.ledger_leaf = "ok";
    } catch {
      fail("ledger_leaf", "the log leaf record is malformed");
    }
    try {
      const path = l.inclusion_path.map(digestBytes);
      const good = await verifyInclusion(digestBytes(l.leaf_hash), l.index, l.tree_size, path, digestBytes(l.root_hash));
      if (good) checks.ledger_inclusion = "ok";
      else fail("ledger_inclusion", "the log inclusion path does not reach the tree head");
    } catch {
      fail("ledger_inclusion", "the log inclusion proof is malformed");
    }
    if (opts.resolveKey) {
      const r = await verifyJws(l.tree_head_jws, opts.resolveKey, { expectTyp: JWS_TYPES.treeHead, at: opts.at });
      const p = r.ok ? (r.payload as { tree_size?: number; root_hash?: string }) : null;
      if (r.ok && p && p.tree_size === l.tree_size && p.root_hash === l.root_hash) checks.ledger_tree_head = "ok";
      else fail("ledger_tree_head", r.ok ? "the signed tree head names a different tree" : `the signed tree head did not verify: ${r.reason}`);
    }
  }

  return { ok: failures.length === 0, checks, failures };
}

// ---------------------------------------------------------------- one-call verify

export type VerifyStatus = "matches" | "differs" | "unknown_url" | "not_signed";

export interface VerifyAnswer {
  object: "semanto.verify";
  status: VerifyStatus;
  url: string;
  hash: string;
  version: number | null;
  version_id: string | null;
  signed_at: string | null;
  signer: { kid: string; domain: string; lei?: string } | null;
  /** The signed hash, so a reader that got "differs" can see what was signed. */
  signed_hash: string | null;
  proof_url: string | null;
}

/** Given a url and a hash, find the page in the current signed version and compare. */
export async function verifyUrl(store: VersionStore, publicApiBase: string, url: string, hash: string, signedAt: (trooth_id: string, version: number) => Promise<string | null>): Promise<VerifyAnswer> {
  const empty = (status: VerifyStatus): VerifyAnswer => ({ object: "semanto.verify", status, url, hash, version: null, version_id: null, signed_at: null, signer: null, signed_hash: null, proof_url: null });
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return empty("unknown_url");
  }
  const company = await store.getCompanyByDomain(u.hostname.toLowerCase());
  if (!company) return empty("unknown_url");
  const file = await store.getCurrent(company.trooth_id);
  if (!file || file.header.state !== "signed" || !file.signature) return empty("not_signed");
  const entry = file.header.pages_manifest.find((p) => p.url === url || p.url === u.href);
  if (!entry) return empty("unknown_url");
  const vid = versionId(file.root_hash);
  return {
    object: "semanto.verify",
    status: entry.hash === hash ? "matches" : "differs",
    url,
    hash,
    version: file.header.version,
    version_id: vid,
    signed_at: await signedAt(company.trooth_id, file.header.version),
    signer: { kid: file.signature.kid, domain: file.header.identity.domain, ...(file.header.identity.lei ? { lei: file.header.identity.lei } : {}) },
    signed_hash: entry.hash,
    proof_url: `${publicApiBase}/${company.trooth_id}/pages/${entry.id}/proof`,
  };
}
