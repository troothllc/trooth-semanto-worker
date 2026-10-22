// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// In-memory implementation of the serving ports, for tests and local runs.
// Holds whole SemantoFile objects plus page bytes; no network, no runtime.

import type { Fact, SemantoFile } from "../core/semanto";
import { versionId } from "../core/semanto";
import { utf8 } from "../core/encoding";
import { leafHash, inclusionProof, rootFromLeafHashes } from "../core/merkle";
import { toHex } from "../core/encoding";
import { signObject, JWS_TYPES } from "../core/jws";
import { toPublic, type Jwks, type PrivateJwk, type PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";
import type { CompanyRecord, JobPort, KeyPort, LogInclusion, LogPort, PageLiveState, Ports, ReceiptInput, ReceiptPort, ServeConfig, SettingsPort, StoredPage, VersionStore, VersionSummary } from "./ports";

export interface MemoryVersion {
  file: SemantoFile;
  /** page_id to markdown bytes. */
  pages: Map<string, Uint8Array>;
  /** page_id to token estimate of the source HTML. */
  original_tokens: Map<string, number>;
  signed_at: string | null;
  withdrawn_at: string | null;
  jsonld?: Uint8Array;
  llms?: Uint8Array;
  llms_full?: Uint8Array;
  sitemap?: Uint8Array;
}

export interface MemoryCompany {
  record: CompanyRecord;
  versions: Map<number, MemoryVersion>;
  /** page_id to live state. Absent means current. */
  live: Map<string, PageLiveState>;
  jwks: Jwks;
  hostedKey: PrivateJwk | null;
}

export class MemoryVersionStore implements VersionStore {
  companies = new Map<string, MemoryCompany>();

  add(c: MemoryCompany): void {
    this.companies.set(c.record.trooth_id, c);
  }

  private current(trooth_id: string): MemoryVersion | null {
    const c = this.companies.get(trooth_id);
    if (!c || c.record.current_version === null) return null;
    const v = c.versions.get(c.record.current_version);
    return v && v.file.header.state === "signed" ? v : null;
  }

  async getCompany(trooth_id: string): Promise<CompanyRecord | null> {
    return this.companies.get(trooth_id)?.record ?? null;
  }
  async getCompanyByDomain(domain: string): Promise<CompanyRecord | null> {
    for (const c of this.companies.values()) if (c.record.domain === domain) return c.record;
    return null;
  }
  async getCurrent(trooth_id: string): Promise<SemantoFile | null> {
    return this.current(trooth_id)?.file ?? null;
  }
  async getVersion(trooth_id: string, version: number): Promise<SemantoFile | null> {
    return this.companies.get(trooth_id)?.versions.get(version)?.file ?? null;
  }
  async listVersions(trooth_id: string): Promise<VersionSummary[]> {
    const c = this.companies.get(trooth_id);
    if (!c) return [];
    return [...c.versions.values()]
      .sort((a, b) => b.file.header.version - a.file.header.version)
      .map((v) => ({
        version: v.file.header.version,
        version_id: versionId(v.file.root_hash),
        state: v.file.header.state,
        built_at: v.file.header.built_at,
        signed_at: v.signed_at,
        withdrawn_at: v.withdrawn_at,
        root_hash: v.file.root_hash,
        page_count: v.file.header.pages_manifest.length,
        fact_count: v.file.facts.length,
      }));
  }
  async getPage(trooth_id: string, page_id: string): Promise<StoredPage | null> {
    const c = this.companies.get(trooth_id);
    const v = this.current(trooth_id);
    if (!c || !v) return null;
    const entry = v.file.header.pages_manifest.find((p) => p.id === page_id);
    const bytes = v.pages.get(page_id);
    if (!entry || !bytes) return null;
    return { bytes, entry, version: v.file.header.version, original_tokens: v.original_tokens.get(page_id) ?? 0, live: c.live.get(page_id) ?? "current" };
  }
  async getPageByUrl(trooth_id: string, url: string): Promise<StoredPage | null> {
    const v = this.current(trooth_id);
    const entry = v?.file.header.pages_manifest.find((p) => p.url === url);
    return entry ? this.getPage(trooth_id, entry.id) : null;
  }
  async getFacts(trooth_id: string): Promise<Fact[] | null> {
    return this.current(trooth_id)?.file.facts ?? null;
  }
  async getJsonLd(trooth_id: string): Promise<Uint8Array | null> {
    return this.current(trooth_id)?.jsonld ?? null;
  }
  async getLlms(trooth_id: string, kind: "llms" | "llms-full" | "sitemap"): Promise<Uint8Array | null> {
    const v = this.current(trooth_id);
    if (!v) return null;
    return (kind === "llms" ? v.llms : kind === "llms-full" ? v.llms_full : v.sitemap) ?? null;
  }
  signedAt(trooth_id: string, version: number): string | null {
    return this.companies.get(trooth_id)?.versions.get(version)?.signed_at ?? null;
  }
}

/** A small in-memory log: leaves are the RFC 6962 leaf hashes of root_hash text, tree heads signed by the witness key. */
export class MemoryLog implements LogPort {
  leaves: Uint8Array[] = [];
  constructor(
    private witness: PrivateJwk,
    private logUrl: string,
  ) {}

  async append(root_hash: string): Promise<number> {
    this.leaves.push(await leafHash(utf8(root_hash)));
    return this.leaves.length - 1;
  }

  async getInclusion(index: number): Promise<LogInclusion | null> {
    if (index < 0 || index >= this.leaves.length) return null;
    const tree_size = this.leaves.length;
    const root = `sha256:${toHex(await rootFromLeafHashes(this.leaves))}`;
    const signed_at = new Date(0).toISOString();
    const head = await signObject({ tree_size, root_hash: root, signed_at }, this.witness, JWS_TYPES.treeHead, { iat: new Date(0) });
    const path = (await inclusionProof(this.leaves, index)).map((p) => `sha256:${toHex(p)}`);
    return { log: this.logUrl, index, tree_size, leaf_hash: `sha256:${toHex(this.leaves[index]!)}`, root_hash: root, tree_head_jws: head.compact, inclusion_path: path };
  }
}

export class MemoryKeys implements KeyPort {
  constructor(
    private store: MemoryVersionStore,
    private witness: PrivateJwk,
  ) {}
  async getCompanyJwks(trooth_id: string): Promise<Jwks> {
    return this.store.companies.get(trooth_id)?.jwks ?? { keys: [] };
  }
  async getCompanySigningKey(trooth_id: string): Promise<PrivateJwk | null> {
    const c = this.store.companies.get(trooth_id);
    return c && c.record.custody === "hosted" ? c.hostedKey : null;
  }
  async getWitnessKey(): Promise<PrivateJwk> {
    return this.witness;
  }
  async getWitnessPublicKeys(): Promise<Jwks> {
    return { keys: [toPublic(this.witness)] };
  }
  async resolve(trooth_id: string | null, kid: string): Promise<PublicJwk | null> {
    if (kid === this.witness.kid) return toPublic(this.witness);
    if (trooth_id) {
      const k = this.store.companies.get(trooth_id)?.jwks.keys.find((x) => x.kid === kid);
      if (k) return k;
    }
    for (const c of this.store.companies.values()) {
      const k = c.jwks.keys.find((x) => x.kid === kid);
      if (k) return k;
    }
    return null;
  }
}

export class MemoryReceipts implements ReceiptPort {
  recorded: ReceiptInput[] = [];
  async record(input: ReceiptInput): Promise<void> {
    this.recorded.push(input);
  }
}

export class MemorySettings implements SettingsPort {
  map = new Map<string, DeliverySettings>();
  async get(trooth_id: string): Promise<DeliverySettings | null> {
    return this.map.get(trooth_id) ?? null;
  }
  async put(trooth_id: string, settings: DeliverySettings): Promise<void> {
    this.map.set(trooth_id, settings);
  }
}

export class MemoryJobs implements JobPort {
  calls: string[] = [];
  async hourlyChangeDetection(): Promise<void> {
    this.calls.push("hourly");
  }
  async nightlyCheckpoint(): Promise<void> {
    this.calls.push("nightly");
  }
  async weeklyGapReports(): Promise<void> {
    this.calls.push("weekly");
  }
  async compile(job: unknown): Promise<void> {
    this.calls.push(`compile:${JSON.stringify(job)}`);
  }
}

export const TEST_CONFIG: ServeConfig = {
  public_api_base: "https://api.trooth.co/public/semanto",
  network_base: "https://trooth.co/network/company",
  ledger_url: "https://api.trooth.co/public/semanto/log",
};

export function memoryPorts(store: MemoryVersionStore, witness: PrivateJwk, opts: { now?: () => Date; config?: ServeConfig } = {}): Ports & { receipts: MemoryReceipts; settings: MemorySettings; jobs: MemoryJobs; log: MemoryLog } {
  const config = opts.config ?? TEST_CONFIG;
  return {
    versions: store,
    log: new MemoryLog(witness, config.ledger_url),
    keys: new MemoryKeys(store, witness),
    receipts: new MemoryReceipts(),
    settings: new MemorySettings(),
    jobs: new MemoryJobs(),
    config,
    now: opts.now ?? (() => new Date()),
  };
}
