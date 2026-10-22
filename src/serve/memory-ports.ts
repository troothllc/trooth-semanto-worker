// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// In-memory implementation of the serving ports, for tests and local runs.
// Holds whole SemantoFile objects plus page bytes; no network, no runtime.
// The log is the real ledger over its in-memory store, so tests exercise the
// same leaf format and proofs the Worker serves.

import type { Fact, SemantoFile } from "../core/semanto";
import { versionId } from "../core/semanto";
import { TransparencyLog } from "../ledger/log";
import { MemoryLogStore } from "../ledger/ports";
import { LedgerLogPort } from "./ledger-port";
import { toPublic, type Jwks, type PrivateJwk, type PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";
import type { CompanyRecord, JobPort, KeyPort, PageLiveState, Ports, ReceiptInput, ReceiptPort, ServeConfig, SettingsPort, StoredPage, VersionStore, VersionSummary } from "./ports";

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
    if (!c) return null;
    if (c.record.current_version !== null) {
      const v = c.versions.get(c.record.current_version);
      if (v && v.file.header.state === "signed") return v;
    }
    // Semanto Basic: the witnessed record, while there is no signed version.
    if (c.record.basic_version !== undefined && c.record.basic_version !== null) {
      const v = c.versions.get(c.record.basic_version);
      if (v && v.file.header.state === "read" && v.file.witness) return v;
    }
    return null;
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

/** The in-memory public log: src/ledger TransparencyLog over MemoryLogStore, with the ledger's leaf records and tree heads signed by the witness key. */
export class MemoryLog extends LedgerLogPort {
  constructor(
    witness: PrivateJwk,
    logUrl: string,
    now: () => Date = () => new Date(),
    readonly store: MemoryLogStore = new MemoryLogStore(),
  ) {
    super(new TransparencyLog(store, witness, now), logUrl);
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
  async resolveCompany(trooth_id: string, kid: string): Promise<PublicJwk | null> {
    return this.store.companies.get(trooth_id)?.jwks.keys.find((x) => x.kid === kid) ?? null;
  }
  async resolveTrooth(kid: string): Promise<PublicJwk | null> {
    return kid === this.witness.kid ? toPublic(this.witness) : null;
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
    log: new MemoryLog(witness, config.ledger_url, opts.now ?? (() => new Date())),
    keys: new MemoryKeys(store, witness),
    receipts: new MemoryReceipts(),
    settings: new MemorySettings(),
    jobs: new MemoryJobs(),
    config,
    now: opts.now ?? (() => new Date()),
  };
}
