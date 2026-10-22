// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Ports for Semanto Basic. Domain proof reads DNS TXT and a well-known file
// (the two methods Google Search Console, Let's Encrypt ACME dns-01 and
// http-01, RFC 8555, and Bluesky handle proof all use). The record builder is
// the compiler in src/compiler, behind an interface so Basic can be tested
// without it. The log port is the ledger in src/ledger, likewise.

export interface DomainProofPort {
  /** TXT records at the name, each as one string, quotes removed. Empty when none. */
  dnsTxt(name: string): Promise<string[]>;
  /** The body of an https GET, or null when the status was not 200. */
  fetchText(url: string): Promise<string | null>;
}

export interface BuiltRecord {
  version: number;
  root_hash: string;
  page_count: number;
  fact_count: number;
  built_at: string;
  /** True once Trooth's witness statement for this version is signed and logged (witness-only finalize). */
  witnessed?: boolean;
}

/** The compiler, as Basic sees it: build from the public site, state "read". */
export interface RecordBuilderPort {
  build(domain: string, trooth_id: string): Promise<BuiltRecord>;
}

export interface LogLeaf {
  kind: "first_publication";
  trooth_id: string;
  ref: string;
  hash: string;
  at: string;
}

export interface LogAppendResult {
  index: number;
  tree_size: number;
}

/** The public log, as Basic sees it: append one leaf and learn where it sits. */
export interface LogPort {
  append(leaf: LogLeaf): Promise<LogAppendResult>;
}

/** A site read for Content Signals drift: robots.txt and the response headers of the home page. */
export interface SiteSignalsPort {
  robotsTxt(domain: string): Promise<string | null>;
  homeHeaders(domain: string): Promise<Record<string, string>>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ------------------------------------------------------------------ in-memory versions for tests

export function memoryDomainProof(opts: { txt?: Record<string, string[]>; files?: Record<string, string> } = {}): DomainProofPort {
  return {
    async dnsTxt(name) {
      return opts.txt?.[name.toLowerCase()] ?? [];
    },
    async fetchText(url) {
      return opts.files?.[url] ?? null;
    },
  };
}

export function memoryLog(): LogPort & { leaves: LogLeaf[] } {
  const leaves: LogLeaf[] = [];
  return {
    leaves,
    async append(leaf) {
      leaves.push(leaf);
      return { index: leaves.length - 1, tree_size: leaves.length };
    },
  };
}
