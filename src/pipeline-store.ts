// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The write side of the platform, as the pipeline (src/pipeline.ts) needs it:
// companies and their settings for signing, monitoring and the gap report,
// built and signed versions with their page bodies, change-detection state,
// approvals and pending customer signatures, keys, connector keys,
// revocations, Basic state, first publications and stored blobs. The serving
// layer reads the same data through its own VersionStore and KeyPort. This
// file holds the interface and the in-memory implementation the tests use; the
// D1 and R2 implementation is D1PipelineStore in src/db/d1.ts (the only place
// SQL lives). Hexagonal ports and adapters, as everywhere in this Worker.

import type { Fact, SemantoFile, SemantoHeader } from "./core/semanto";
import { versionId } from "./core/semanto";
import type { PrivateJwk, PublicJwk } from "./core/keys";
import type { Authorization, SigningPolicy } from "./identity/roles";
import type { Custody, PreparedSigning } from "./identity/keys";
import type { AvailableSurfaces } from "./monitor/run";
import type { QuestionKind } from "./gap/prompts";
import type { GapReport } from "./gap/report";
import type { RevocationEntry } from "./ledger/revocation";
import type { BasicCompany } from "./basic/tier";
import type { FirstPublicationRecord } from "./basic/first-publication";
import type { CompanyRecord } from "./serve/ports";
import type { MemoryVersionStore } from "./serve/memory-ports";

/** Per-company settings the pipeline reads. Delivery settings live in SettingsPort. */
export interface CompanyConfig {
  /** single for most companies; two_officer when the enterprise workspace asks for dual control. */
  signing: SigningPolicy;
  /** The surfaces the company connected, for the monitor. */
  surfaces: AvailableSurfaces;
  /** Who gets the plain-language alerts. */
  alert_emails: string[];
  gap: { kinds: QuestionKind[]; products: string[]; competitor?: { name: string; domain: string }; service?: string };
  /** public_record facts from registries (GLEIF), added to every build. */
  public_record_facts: Fact[];
}

export const DEFAULT_CONFIG: CompanyConfig = {
  signing: { officers: "single" },
  surfaces: { live_pages: true, robots: true },
  alert_emails: [],
  gap: { kinds: ["b2b"], products: [] },
  public_record_facts: [],
};

export interface StoredVersion {
  file: SemantoFile;
  /** Markdown bytes by page id, exactly as hashed. */
  bodies: Record<string, Uint8Array>;
  /** Token estimate of each page's source HTML, by page id, for x-original-tokens. */
  original_tokens: Record<string, number>;
  signed_at: string | null;
}

export interface VersionFiles {
  llms: { llmsTxt: string; llmsFull: string; sitemapMd: string };
  /** facts.jsonld bytes. */
  jsonld: Uint8Array;
}

export interface ChangeRow {
  etag: string | null;
  last_modified: string | null;
  /** Digest of the raw HTML the last check received. */
  raw_hash: string | null;
  lastmod?: string | null;
  checked_at: string;
}

export interface PendingSigning {
  trooth_id: string;
  version: number;
  /** The exact header the company signs (state signed, authorized_by filled). */
  header: SemantoHeader;
  prepared: PreparedSigning;
  kid: string;
  created_at: string;
}

export interface CompanyKey {
  public_jwk: PublicJwk;
  custody: Custody;
  created_at: string;
}

export interface PipelineStore {
  getCompany(trooth_id: string): Promise<CompanyRecord | null>;
  /** Insert or update the company row (domain, org, tier, legal name, LEI). current_version and custody are managed by markSigned and putKey. */
  putCompany(company: CompanyRecord): Promise<void>;
  /** Companies with a current signed version ("signed") or every company ("all"). */
  listCompanies(which: "signed" | "all"): Promise<CompanyRecord[]>;
  getConfig(trooth_id: string): Promise<CompanyConfig>;
  putConfig(trooth_id: string, config: CompanyConfig): Promise<void>;

  /** The newest version in any state, with its bodies. */
  latestVersion(trooth_id: string): Promise<StoredVersion | null>;
  getVersion(trooth_id: string, version: number): Promise<StoredVersion | null>;
  /** Store a freshly built version (state read) with its bodies and derived files. */
  saveBuilt(trooth_id: string, v: StoredVersion, files: VersionFiles): Promise<void>;
  /** Replace the version with its signed form and make it the company's current version. */
  markSigned(trooth_id: string, file: SemantoFile, signed_at: string): Promise<void>;

  changeState(trooth_id: string): Promise<Record<string, ChangeRow>>;
  putChangeState(trooth_id: string, url: string, row: ChangeRow): Promise<void>;

  authorizations(trooth_id: string, root_hash: string): Promise<Authorization[]>;
  addAuthorization(trooth_id: string, a: Authorization): Promise<void>;
  clearAuthorizations(trooth_id: string, root_hash: string): Promise<void>;
  pending(trooth_id: string, version: number): Promise<PendingSigning | null>;
  putPending(p: PendingSigning): Promise<void>;
  clearPending(trooth_id: string, version: number): Promise<void>;

  keys(trooth_id: string): Promise<CompanyKey[]>;
  /** Insert or replace a key by kid. A hosted key's private half is stored sealed; a customer key never has one. The newest key sets the company's custody. */
  putKey(trooth_id: string, key: CompanyKey, privateJwk: PrivateJwk | null): Promise<void>;
  connectorKeys(trooth_id: string): Promise<PublicJwk[]>;
  putConnectorKey(trooth_id: string, jwk: PublicJwk, source: string, created_at: string): Promise<void>;

  revocations(trooth_id: string | null): Promise<RevocationEntry[]>;
  putRevocationList(trooth_id: string | null, jws: string, issued_at: string): Promise<void>;

  saveGapReport(report: GapReport): Promise<void>;
  getBasic(trooth_id: string): Promise<BasicCompany | null>;
  putBasic(c: BasicCompany): Promise<void>;
  putFirstPublication(r: FirstPublicationRecord): Promise<void>;
  /** Raw bytes kept beside the records (RFC 3161 tokens, revocation lists). R2 in the Worker. */
  putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

// ---------------------------------------------------------------- in memory

/**
 * The in-memory store. It writes through to a MemoryVersionStore so the
 * serving routes read exactly what the pipeline built and signed, the way D1
 * and R2 are shared in the Worker.
 */
export class MemoryPipelineStore implements PipelineStore {
  readonly configs = new Map<string, CompanyConfig>();
  readonly change = new Map<string, Record<string, ChangeRow>>();
  readonly auths = new Map<string, Authorization[]>();
  readonly pendings = new Map<string, PendingSigning>();
  readonly companyKeys = new Map<string, CompanyKey[]>();
  readonly privateKeys = new Map<string, PrivateJwk>();
  readonly connectors = new Map<string, { jwk: PublicJwk; source: string; created_at: string }[]>();
  readonly revocationEntries: { trooth_id: string | null; entry: RevocationEntry }[] = [];
  readonly revocationLists: { trooth_id: string | null; jws: string; issued_at: string }[] = [];
  readonly gapReports: GapReport[] = [];
  readonly basics = new Map<string, BasicCompany>();
  readonly firstPublications: FirstPublicationRecord[] = [];
  readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly files = new Map<string, VersionFiles>();

  constructor(readonly versions: MemoryVersionStore) {}

  async getCompany(trooth_id: string): Promise<CompanyRecord | null> {
    return this.versions.companies.get(trooth_id)?.record ?? null;
  }
  async putCompany(company: CompanyRecord): Promise<void> {
    const c = this.versions.companies.get(company.trooth_id);
    if (c) {
      c.record = { ...company, current_version: c.record.current_version, custody: c.record.custody };
      return;
    }
    this.versions.add({ record: { ...company }, versions: new Map(), live: new Map(), jwks: { keys: [] }, hostedKey: null });
  }
  async listCompanies(which: "signed" | "all"): Promise<CompanyRecord[]> {
    const all = [...this.versions.companies.values()].map((c) => c.record);
    return which === "all" ? all : all.filter((r) => r.current_version !== null);
  }
  async getConfig(trooth_id: string): Promise<CompanyConfig> {
    return this.configs.get(trooth_id) ?? structuredClone(DEFAULT_CONFIG);
  }
  async putConfig(trooth_id: string, config: CompanyConfig): Promise<void> {
    this.configs.set(trooth_id, config);
  }

  private stored(trooth_id: string, version: number): StoredVersion | null {
    const v = this.versions.companies.get(trooth_id)?.versions.get(version);
    if (!v) return null;
    return { file: v.file, bodies: Object.fromEntries(v.pages), original_tokens: Object.fromEntries(v.original_tokens), signed_at: v.signed_at };
  }
  async latestVersion(trooth_id: string): Promise<StoredVersion | null> {
    const c = this.versions.companies.get(trooth_id);
    if (!c || c.versions.size === 0) return null;
    return this.stored(trooth_id, Math.max(...c.versions.keys()));
  }
  async getVersion(trooth_id: string, version: number): Promise<StoredVersion | null> {
    return this.stored(trooth_id, version);
  }
  async saveBuilt(trooth_id: string, v: StoredVersion, files: VersionFiles): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    if (!c) throw new Error(`saveBuilt: no company ${trooth_id}`);
    c.versions.set(v.file.header.version, {
      file: v.file,
      pages: new Map(Object.entries(v.bodies)),
      original_tokens: new Map(Object.entries(v.original_tokens)),
      signed_at: v.signed_at,
      withdrawn_at: null,
      jsonld: files.jsonld,
      llms: new TextEncoder().encode(files.llms.llmsTxt),
      llms_full: new TextEncoder().encode(files.llms.llmsFull),
      sitemap: new TextEncoder().encode(files.llms.sitemapMd),
    });
    this.files.set(`${trooth_id}/${v.file.header.version}`, files);
  }
  async markSigned(trooth_id: string, file: SemantoFile, signed_at: string): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    const v = c?.versions.get(file.header.version);
    if (!c || !v) throw new Error(`markSigned: no version ${file.header.version} for ${trooth_id}`);
    v.file = file;
    v.signed_at = signed_at;
    c.record = { ...c.record, current_version: file.header.version };
  }

  async changeState(trooth_id: string): Promise<Record<string, ChangeRow>> {
    return { ...(this.change.get(trooth_id) ?? {}) };
  }
  async putChangeState(trooth_id: string, url: string, row: ChangeRow): Promise<void> {
    const m = this.change.get(trooth_id) ?? {};
    m[url] = row;
    this.change.set(trooth_id, m);
    // The serving layer reads "behind" from the same state (src/db/d1.ts selectPageLiveState does this in the Worker).
    const c = this.versions.companies.get(trooth_id);
    if (c && c.record.current_version !== null) {
      const cur = c.versions.get(c.record.current_version);
      for (const p of cur?.file.header.pages_manifest ?? []) {
        if (p.url !== url || !row.raw_hash) continue;
        c.live.set(p.id, row.raw_hash === p.source_hash ? "current" : "behind");
      }
    }
  }

  async authorizations(trooth_id: string, root_hash: string): Promise<Authorization[]> {
    return (this.auths.get(trooth_id) ?? []).filter((a) => a.root_hash === root_hash);
  }
  async addAuthorization(trooth_id: string, a: Authorization): Promise<void> {
    this.auths.set(trooth_id, [...(this.auths.get(trooth_id) ?? []), a]);
  }
  async clearAuthorizations(trooth_id: string, root_hash: string): Promise<void> {
    this.auths.set(trooth_id, (this.auths.get(trooth_id) ?? []).filter((a) => a.root_hash !== root_hash));
  }
  async pending(trooth_id: string, version: number): Promise<PendingSigning | null> {
    return this.pendings.get(`${trooth_id}/${version}`) ?? null;
  }
  async putPending(p: PendingSigning): Promise<void> {
    this.pendings.set(`${p.trooth_id}/${p.version}`, p);
  }
  async clearPending(trooth_id: string, version: number): Promise<void> {
    this.pendings.delete(`${trooth_id}/${version}`);
  }

  async keys(trooth_id: string): Promise<CompanyKey[]> {
    return [...(this.companyKeys.get(trooth_id) ?? [])];
  }
  async putKey(trooth_id: string, key: CompanyKey, privateJwk: PrivateJwk | null): Promise<void> {
    const list = (this.companyKeys.get(trooth_id) ?? []).filter((k) => k.public_jwk.kid !== key.public_jwk.kid);
    list.push(key);
    this.companyKeys.set(trooth_id, list);
    if (privateJwk) this.privateKeys.set(key.public_jwk.kid, privateJwk);
    const c = this.versions.companies.get(trooth_id);
    if (!c) return;
    c.jwks = { keys: list.map((k) => k.public_jwk) };
    const newest = [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0]!;
    c.record = { ...c.record, custody: newest.custody };
    const hosted = list.filter((k) => k.custody === "hosted" && !k.public_jwk.revoked_at && !k.public_jwk.exp).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    c.hostedKey = hosted ? (this.privateKeys.get(hosted.public_jwk.kid) ?? null) : null;
  }
  async connectorKeys(trooth_id: string): Promise<PublicJwk[]> {
    return (this.connectors.get(trooth_id) ?? []).map((c) => c.jwk);
  }
  async putConnectorKey(trooth_id: string, jwk: PublicJwk, source: string, created_at: string): Promise<void> {
    const list = (this.connectors.get(trooth_id) ?? []).filter((c) => c.jwk.kid !== jwk.kid);
    list.push({ jwk, source, created_at });
    this.connectors.set(trooth_id, list);
  }

  async revocations(trooth_id: string | null): Promise<RevocationEntry[]> {
    return this.revocationEntries.filter((r) => trooth_id === null || r.trooth_id === trooth_id).map((r) => r.entry);
  }
  async putRevocationList(trooth_id: string | null, jws: string, issued_at: string): Promise<void> {
    this.revocationLists.push({ trooth_id, jws, issued_at });
  }
  async saveGapReport(report: GapReport): Promise<void> {
    this.gapReports.push(report);
  }
  async getBasic(trooth_id: string): Promise<BasicCompany | null> {
    return this.basics.get(trooth_id) ?? null;
  }
  async putBasic(c: BasicCompany): Promise<void> {
    this.basics.set(c.trooth_id, c);
  }
  async putFirstPublication(r: FirstPublicationRecord): Promise<void> {
    this.firstPublications.push(r);
  }
  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.blobs.set(key, { bytes, contentType });
  }

  /** The smv_ id of a stored version, for tests. */
  versionIdOf(trooth_id: string, version: number): string | null {
    const v = this.versions.companies.get(trooth_id)?.versions.get(version);
    return v ? versionId(v.file.root_hash) : null;
  }
}
