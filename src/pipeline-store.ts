// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The write side of the platform, as the pipeline (src/pipeline.ts) needs it:
// companies and their settings for signing, monitoring and the gap report,
// built and signed versions with their page bodies, change-detection state,
// approvals and pending customer signatures, passkeys and their single-use
// challenges (src/identity/webauthn.ts), keys, connector keys,
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
import type { PasskeyChallenge, PasskeyUser, StoredPasskey } from "./identity/webauthn";
import type { AvailableSurfaces } from "./monitor/run";
import type { MerchantCenterTarget } from "./monitor/writeback";
import type { QuestionKind } from "./gap/prompts";
import type { GapReport } from "./gap/report";
import type { RevocationEntry } from "./ledger/revocation";
import type { BasicCompany } from "./basic/tier";
import type { FirstPublicationRecord } from "./basic/first-publication";
import type { CompanyRecord } from "./serve/ports";
import type { BodyPort } from "./compiler/stream";
import type { SetupRecord } from "./setup/state";
import type { MemoryVersionStore } from "./serve/memory-ports";

/** Per-company settings the pipeline reads. Delivery settings live in SettingsPort. */
export interface CompanyConfig {
  /** single for most companies; two_officer when the enterprise workspace asks for dual control. */
  signing: SigningPolicy;
  /** The surfaces the company connected, for the monitor. */
  surfaces: AvailableSurfaces;
  /** Who gets the plain-language alerts. */
  alert_emails: string[];
  gap: { kinds: QuestionKind[]; products: string[]; competitor?: { name: string; domain: string }; service?: string; /** The owner's own questions (setup step 9), asked with every report. */ questions?: string[] };
  /** public_record facts from registries (GLEIF), added to every build. */
  public_record_facts: Fact[];
  /** Write-back targets the company connected (GET /os/semanto/{id}/writeback previews against them). */
  writeback?: { merchant_center?: MerchantCenterTarget; business_profile_location?: string };
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
  /** llmsFull is null when every page together is too large to hold; the route then builds it from the pages. */
  llms: { llmsTxt: string; llmsFull: string | null; sitemapMd: string };
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

export interface PipelineStore extends BodyPort {
  getCompany(trooth_id: string): Promise<CompanyRecord | null>;
  getCompanyByDomain(domain: string): Promise<CompanyRecord | null>;
  /** The company a worker-f workspace claimed (semanto_companies.os_company_id). */
  getCompanyByOsCompany(os_company_id: string): Promise<CompanyRecord | null>;
  /** Link a company to the worker-f workspace that claimed it. Never moves an existing link. */
  linkOsCompany(trooth_id: string, os_company_id: string): Promise<void>;
  /** Record the domain proof against the company's own domain. */
  markDomainProven(trooth_id: string, at: string, method: "dns_txt" | "well_known"): Promise<void>;
  getSetup(trooth_id: string): Promise<SetupRecord | null>;
  putSetup(record: SetupRecord): Promise<void>;
  /** The newest version's file without its page bodies, and when it was signed. */
  latestFile(trooth_id: string): Promise<{ file: SemantoFile; signed_at: string | null } | null>;
  /** One version's file without its page bodies. */
  getFile(trooth_id: string, version: number): Promise<SemantoFile | null>;
  /** Store a version assembled from a streamed build; its page bodies were written already with putBody. */
  saveAssembled(trooth_id: string, file: SemantoFile, files: VersionFiles): Promise<void>;
  /** Withdraw a version: state withdrawn, withdrawn_at set; when it was current, the newest earlier signed version that is not withdrawn becomes current, or none. */
  withdrawVersion(trooth_id: string, version: number, at: string): Promise<void>;
  /** Append a revocation entry with its log leaf index. */
  putRevocation(trooth_id: string, entry: RevocationEntry, log_index: number): Promise<void>;
  /** The newest signed revocation list for a company (or for everyone with null). */
  getRevocationList(trooth_id: string | null): Promise<{ jws: string; issued_at: string } | null>;
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
  /** Semanto Basic: replace the version with its witnessed form (state read, no company signature) and serve it as the Basic record. */
  markWitnessed(trooth_id: string, file: SemantoFile, witnessed_at: string): Promise<void>;

  changeState(trooth_id: string): Promise<Record<string, ChangeRow>>;
  putChangeState(trooth_id: string, url: string, row: ChangeRow): Promise<void>;

  authorizations(trooth_id: string, root_hash: string): Promise<Authorization[]>;
  addAuthorization(trooth_id: string, a: Authorization): Promise<void>;
  clearAuthorizations(trooth_id: string, root_hash: string): Promise<void>;
  pending(trooth_id: string, version: number): Promise<PendingSigning | null>;
  putPending(p: PendingSigning): Promise<void>;
  clearPending(trooth_id: string, version: number): Promise<void>;

  /** The WebAuthn user handle for a workspace user, or null before their first passkey options. */
  passkeyUser(user_id: string): Promise<PasskeyUser | null>;
  /** Store the user handle unless one exists; answers the one stored. */
  putPasskeyUser(u: PasskeyUser): Promise<PasskeyUser>;
  /** A person's passkeys, oldest first. */
  passkeys(user_id: string): Promise<StoredPasskey[]>;
  /** One passkey by its credential id, whoever owns it. */
  getPasskey(credential_id: string): Promise<StoredPasskey | null>;
  /** Insert a new passkey. A credential id already on file is never replaced. */
  putPasskey(p: StoredPasskey): Promise<void>;
  /**
   * After an assertion: the new signature count, the backup state and when it
   * was used, in one conditional write. The row changes only when the new
   * count is larger than the stored one, or both are zero (an authenticator
   * without a counter, W3C WebAuthn Level 3, 6.1.1). False when nothing
   * changed: another assertion at that count won, a possible copy.
   */
  touchPasskey(credential_id: string, sign_count: number, backed_up: boolean, at: string): Promise<boolean>;
  putPasskeyChallenge(c: PasskeyChallenge): Promise<void>;
  /**
   * Remove and answer the challenge when it is this kind, for this company and
   * this user. Single use: a second take of the same challenge answers null.
   * Expiry is the caller's check (the row is removed either way).
   */
  takePasskeyChallenge(challenge: string, kind: PasskeyChallenge["kind"], trooth_id: string, user_id: string): Promise<PasskeyChallenge | null>;

  keys(trooth_id: string): Promise<CompanyKey[]>;
  /** Insert or replace a key by kid. A hosted key's private half is stored sealed; a customer key never has one. The newest key sets the company's custody. */
  putKey(trooth_id: string, key: CompanyKey, privateJwk: PrivateJwk | null): Promise<void>;
  connectorKeys(trooth_id: string): Promise<PublicJwk[]>;
  putConnectorKey(trooth_id: string, jwk: PublicJwk, source: string, created_at: string): Promise<void>;
  /** The worker-f user registered as the company's owner (semanto_companies.os_owner_user_id), or null. */
  ownerUserId(trooth_id: string): Promise<string | null>;
  /** Register the owner when there is none yet (the first to create or claim the company). Never replaces an owner. */
  registerOwner(trooth_id: string, user_id: string): Promise<void>;

  revocations(trooth_id: string | null): Promise<RevocationEntry[]>;
  putRevocationList(trooth_id: string | null, jws: string, issued_at: string): Promise<void>;

  saveGapReport(report: GapReport): Promise<void>;
  getBasic(trooth_id: string): Promise<BasicCompany | null>;
  putBasic(c: BasicCompany): Promise<void>;
  putFirstPublication(r: FirstPublicationRecord): Promise<void>;
  /** One first-publication record by its smb_ id, with its JWS, leaf and log position. */
  getFirstPublication(record_id: string): Promise<FirstPublicationRecord | null>;
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
  readonly passkeyUsers = new Map<string, PasskeyUser>();
  readonly passkeyRows = new Map<string, StoredPasskey>();
  readonly passkeyChallenges = new Map<string, PasskeyChallenge>();
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
  readonly setups = new Map<string, SetupRecord>();
  /** Bodies written by a streamed build before the version is assembled, by trooth_id/version/page_id. */
  readonly pendingBodies = new Map<string, Uint8Array>();

  constructor(readonly versions: MemoryVersionStore) {}

  async getCompany(trooth_id: string): Promise<CompanyRecord | null> {
    return this.versions.companies.get(trooth_id)?.record ?? null;
  }
  async getCompanyByDomain(domain: string): Promise<CompanyRecord | null> {
    for (const c of this.versions.companies.values()) if (c.record.domain === domain) return c.record;
    return null;
  }
  async getCompanyByOsCompany(os_company_id: string): Promise<CompanyRecord | null> {
    for (const c of this.versions.companies.values()) if (c.record.os_company_id === os_company_id) return c.record;
    return null;
  }
  async linkOsCompany(trooth_id: string, os_company_id: string): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    if (c && !c.record.os_company_id) c.record = { ...c.record, os_company_id };
  }
  async markDomainProven(trooth_id: string, at: string, _method: "dns_txt" | "well_known"): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    if (c && !c.record.domain_proven_at) c.record = { ...c.record, domain_proven_at: at };
  }
  async getSetup(trooth_id: string): Promise<SetupRecord | null> {
    const r = this.setups.get(trooth_id);
    return r ? structuredClone(r) : null;
  }
  async putSetup(record: SetupRecord): Promise<void> {
    this.setups.set(record.trooth_id, structuredClone(record));
  }
  async latestFile(trooth_id: string): Promise<{ file: SemantoFile; signed_at: string | null } | null> {
    const c = this.versions.companies.get(trooth_id);
    if (!c || c.versions.size === 0) return null;
    const v = c.versions.get(Math.max(...c.versions.keys()))!;
    return { file: v.file, signed_at: v.signed_at };
  }
  async getFile(trooth_id: string, version: number): Promise<SemantoFile | null> {
    return this.versions.companies.get(trooth_id)?.versions.get(version)?.file ?? null;
  }
  async putBody(trooth_id: string, version: number, page_id: string, bytes: Uint8Array): Promise<void> {
    this.pendingBodies.set(`${trooth_id}/${version}/${page_id}`, bytes.slice());
  }
  async getBody(trooth_id: string, version: number, page_id: string): Promise<Uint8Array | null> {
    const pending = this.pendingBodies.get(`${trooth_id}/${version}/${page_id}`);
    if (pending) return pending.slice();
    return this.versions.companies.get(trooth_id)?.versions.get(version)?.pages.get(page_id)?.slice() ?? null;
  }
  async saveAssembled(trooth_id: string, file: SemantoFile, files: VersionFiles): Promise<void> {
    const n = file.header.version;
    const bodies: Record<string, Uint8Array> = {};
    const original_tokens: Record<string, number> = {};
    for (const p of file.header.pages_manifest) {
      const b = await this.getBody(trooth_id, n, p.id);
      if (!b) throw new Error(`saveAssembled: no body for ${p.id}`);
      bodies[p.id] = b;
      original_tokens[p.id] = p.original_tokens ?? 0;
      this.pendingBodies.delete(`${trooth_id}/${n}/${p.id}`);
    }
    await this.saveBuilt(trooth_id, { file, bodies, original_tokens, signed_at: null }, files);
  }
  async withdrawVersion(trooth_id: string, version: number, at: string): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    const v = c?.versions.get(version);
    if (!c || !v) throw new Error(`withdrawVersion: no version ${version} for ${trooth_id}`);
    v.file = { ...v.file, header: { ...v.file.header, state: "withdrawn" } };
    v.withdrawn_at = at;
    if (c.record.current_version === version) {
      const earlier = [...c.versions.values()].filter((x) => x.file.header.version < version && x.file.header.state === "signed").sort((a, b) => b.file.header.version - a.file.header.version)[0];
      c.record = { ...c.record, current_version: earlier ? earlier.file.header.version : null };
    }
    if (c.record.basic_version === version) c.record = { ...c.record, basic_version: null };
  }
  async putRevocation(trooth_id: string, entry: RevocationEntry, _log_index: number): Promise<void> {
    this.revocationEntries.push({ trooth_id, entry });
  }
  async getRevocationList(trooth_id: string | null): Promise<{ jws: string; issued_at: string } | null> {
    const list = this.revocationLists.filter((r) => r.trooth_id === trooth_id);
    const last = list[list.length - 1];
    return last ? { jws: last.jws, issued_at: last.issued_at } : null;
  }
  async putCompany(company: CompanyRecord): Promise<void> {
    const c = this.versions.companies.get(company.trooth_id);
    if (c) {
      c.record = { ...company, current_version: c.record.current_version, custody: c.record.custody, basic_version: c.record.basic_version ?? null, domain_proven_at: c.record.domain_proven_at ?? company.domain_proven_at ?? null, os_company_id: c.record.os_company_id ?? company.os_company_id ?? null };
      return;
    }
    this.versions.add({ record: { domain_proven_at: null, os_company_id: null, ...company }, versions: new Map(), live: new Map(), jwks: { keys: [] }, hostedKey: null });
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
      ...(files.llms.llmsFull !== null ? { llms_full: new TextEncoder().encode(files.llms.llmsFull) } : {}),
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
  async markWitnessed(trooth_id: string, file: SemantoFile, _witnessed_at: string): Promise<void> {
    const c = this.versions.companies.get(trooth_id);
    const v = c?.versions.get(file.header.version);
    if (!c || !v) throw new Error(`markWitnessed: no version ${file.header.version} for ${trooth_id}`);
    v.file = file;
    c.record = { ...c.record, basic_version: file.header.version };
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
  /** One approval per person per root hash, as D1 keeps it: a later one with a passkey replaces one without, never the other way. */
  async addAuthorization(trooth_id: string, a: Authorization): Promise<void> {
    const list = this.auths.get(trooth_id) ?? [];
    const i = list.findIndex((x) => x.root_hash === a.root_hash && x.record.subject === a.record.subject);
    if (i < 0) this.auths.set(trooth_id, [...list, a]);
    else if (a.passkey) this.auths.set(trooth_id, list.map((x, j) => (j === i ? a : x)));
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

  async passkeyUser(user_id: string): Promise<PasskeyUser | null> {
    return this.passkeyUsers.get(user_id) ?? null;
  }
  async putPasskeyUser(u: PasskeyUser): Promise<PasskeyUser> {
    const have = this.passkeyUsers.get(u.user_id);
    if (have) return have;
    this.passkeyUsers.set(u.user_id, u);
    return u;
  }
  async passkeys(user_id: string): Promise<StoredPasskey[]> {
    return [...this.passkeyRows.values()].filter((p) => p.user_id === user_id).map((p) => ({ ...p }));
  }
  async getPasskey(credential_id: string): Promise<StoredPasskey | null> {
    const p = this.passkeyRows.get(credential_id);
    return p ? { ...p } : null;
  }
  async putPasskey(p: StoredPasskey): Promise<void> {
    if (this.passkeyRows.has(p.credential_id)) throw new Error("passkey: the credential id is already on file");
    this.passkeyRows.set(p.credential_id, { ...p });
  }
  async touchPasskey(credential_id: string, sign_count: number, backed_up: boolean, at: string): Promise<boolean> {
    // Check and write with no await between them, the in-memory form of the conditional UPDATE.
    const p = this.passkeyRows.get(credential_id);
    if (!p || !(p.sign_count < sign_count || (p.sign_count === 0 && sign_count === 0))) return false;
    this.passkeyRows.set(credential_id, { ...p, sign_count, backed_up, last_used_at: at });
    return true;
  }
  async putPasskeyChallenge(c: PasskeyChallenge): Promise<void> {
    this.passkeyChallenges.set(c.challenge, { ...c });
  }
  async takePasskeyChallenge(challenge: string, kind: PasskeyChallenge["kind"], trooth_id: string, user_id: string): Promise<PasskeyChallenge | null> {
    const c = this.passkeyChallenges.get(challenge);
    if (!c || c.kind !== kind || c.trooth_id !== trooth_id || c.user_id !== user_id) return null;
    this.passkeyChallenges.delete(challenge);
    return c;
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
  readonly owners = new Map<string, string>();
  async ownerUserId(trooth_id: string): Promise<string | null> {
    return this.owners.get(trooth_id) ?? null;
  }
  async registerOwner(trooth_id: string, user_id: string): Promise<void> {
    if (!this.owners.has(trooth_id)) this.owners.set(trooth_id, user_id);
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
  }  async getFirstPublication(record_id: string): Promise<FirstPublicationRecord | null> {
    return this.firstPublications.find((r) => r.record.id === record_id) ?? null;
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
