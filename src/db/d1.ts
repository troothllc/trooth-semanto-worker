// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// D1 access: one function per query against migrations/0001_semanto.sql and
// 0002_integration.sql, no SQL anywhere else. The serving layer's ports
// (D1VersionStore, D1Keys, D1Receipts, D1Settings) and the pipeline's write
// side (D1PipelineStore, D1CommerceStore, D1MonitorStore) live here. Page bodies and the
// derived files live in R2 under semanto/<trooth_id>/v<version>/; this file
// reads D1 metadata and the R2 bodies and assembles the port types. The
// SemantoFile itself is stored whole in R2 as semanto.json next to the pages,
// so the server never rebuilds a signed object from rows (what was signed is
// what is served). Follows the Cloudflare D1 client API (prepare, bind, first,
// all, run; docs 2026) and the Workers R2 bindings API.

import type { Fact, SemantoFile } from "../core/semanto";
import { versionId } from "../core/semanto";
import { estimateTokens } from "../core/tokens";
import { digest } from "../core/hash";
import { semantoId } from "../core/ids";
import type { Jwks, PrivateJwk, PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";
import { withDefaults } from "../settings/delivery";
import type { CompanyRecord, KeyPort, PageLiveState, ReceiptInput, ReceiptPort, SettingsPort, StoredPage, VersionStore, VersionSummary } from "../serve/ports";
import type { DetectionResult } from "../serve/detect";
import { openPrivateJwk, sealPrivateJwk } from "./key-seal";
import { fromBase64Url } from "../core/encoding";
import type { SemantoHeader } from "../core/semanto";
import { DEFAULT_CONFIG, type ChangeRow, type CompanyConfig, type CompanyKey, type PendingSigning, type PipelineStore, type StoredVersion, type VersionFiles } from "../pipeline-store";
import type { Authorization } from "../identity/roles";
import type { PreparedSigning } from "../identity/keys";
import type { RevocationEntry } from "../ledger/revocation";
import type { GapReport } from "../gap/report";
import type { BasicCompany } from "../basic/tier";
import type { FirstPublicationRecord } from "../basic/first-publication";
import type { CommerceStore } from "../commerce/ports";
import type { FeedCompany } from "../commerce/feeds";
import { DEFAULT_OFFER_POLICY, type Offer, type OfferPolicy, type SignedOffer } from "../commerce/offers";
import type { ProductRecord, SignedProductRecord } from "../commerce/product-record";
import type { AttestationEntry } from "../commerce/sellers";
import type { SignedRecall } from "../commerce/recalls";
import type { StorePort as MonitorStorePort } from "../monitor/ports";
import type { Alert, AlertRow, MonitorRun } from "../monitor/types";
import { runToRow } from "../monitor/consistency";
import { alertFromRow, alertToRow } from "../monitor/alerts";

// ------------------------------------------------------------ row shapes

interface CompanyRow {
  trooth_id: string;
  domain: string;
  org: string;
  tier: "basic" | "full";
  legal_name: string | null;
  lei: string | null;
  current_version: number | null;
  custody: "hosted" | "customer" | null;
}

interface VersionRow {
  trooth_id: string;
  version: number;
  state: SemantoFile["header"]["state"];
  built_at: string;
  signed_at: string | null;
  withdrawn_at: string | null;
  root_hash: string;
  page_count: number;
  fact_count: number;
  ledger_index: number | null;
}

interface PageRow {
  page_id: string;
  version: number;
  url: string;
  title: string;
  hash: string;
  source_hash: string;
  bytes: number;
  tokens: number;
  original_tokens: number;
  witnessed_at: string;
  lang: string | null;
  part_n: number | null;
  part_of: number | null;
  status: number;
  noindex: number;
  nosnippet: number;
  canonical: string | null;
  robots_blocked: number;
  manifest_index: number;
}

interface KeyRow {
  kid: string;
  public_jwk: string;
  custody: "hosted" | "customer";
  nbf: string | null;
  exp: string | null;
  revoked_at: string | null;
}

interface ChangeStateRow {
  raw_hash: string | null;
  checked_at: string;
}

// ------------------------------------------------------------ R2 keys

export const r2Key = {
  file: (trooth_id: string, version: number) => `semanto/${trooth_id}/v${version}/semanto.json`,
  page: (trooth_id: string, version: number, page_id: string) => `semanto/${trooth_id}/v${version}/pages/${page_id}.md`,
  jsonld: (trooth_id: string, version: number) => `semanto/${trooth_id}/v${version}/facts.jsonld`,
  llms: (trooth_id: string, version: number) => `semanto/${trooth_id}/v${version}/llms.txt`,
  llmsFull: (trooth_id: string, version: number) => `semanto/${trooth_id}/v${version}/llms-full.txt`,
  sitemap: (trooth_id: string, version: number) => `semanto/${trooth_id}/v${version}/sitemap.md`,
  /** The company's hosted private key, encrypted at rest by the identity module; this layer only reads it through KeyPort. */
  hostedKey: (trooth_id: string, kid: string) => `keys/${trooth_id}/${kid}.jwk`,
};

// ------------------------------------------------------------ companies

export async function selectCompany(db: D1Database, trooth_id: string): Promise<CompanyRecord | null> {
  const row = await db
    .prepare(
      `SELECT c.trooth_id, c.domain, c.org, c.tier, c.legal_name, c.lei, c.current_version,
              COALESCE((SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1), c.custody) AS custody
       FROM semanto_companies c WHERE c.trooth_id = ?1`,
    )
    .bind(trooth_id)
    .first<CompanyRow>();
  return row ? toCompany(row) : null;
}

export async function selectCompanyByDomain(db: D1Database, domain: string): Promise<CompanyRecord | null> {
  const row = await db
    .prepare(
      `SELECT c.trooth_id, c.domain, c.org, c.tier, c.legal_name, c.lei, c.current_version,
              COALESCE((SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1), c.custody) AS custody
       FROM semanto_companies c WHERE c.domain = ?1`,
    )
    .bind(domain)
    .first<CompanyRow>();
  return row ? toCompany(row) : null;
}

function toCompany(r: CompanyRow): CompanyRecord {
  return {
    trooth_id: r.trooth_id,
    domain: r.domain,
    org: r.org,
    tier: r.tier,
    ...(r.legal_name ? { legal_name: r.legal_name } : {}),
    ...(r.lei ? { lei: r.lei } : {}),
    current_version: r.current_version,
    custody: r.custody ?? "customer",
  };
}

// ------------------------------------------------------------ versions

export async function selectVersion(db: D1Database, trooth_id: string, version: number): Promise<VersionRow | null> {
  return db
    .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 AND version = ?2`)
    .bind(trooth_id, version)
    .first<VersionRow>();
}

export async function selectCurrentSignedVersion(db: D1Database, trooth_id: string): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT v.trooth_id, v.version, v.state, v.built_at, v.signed_at, v.withdrawn_at, v.root_hash, v.page_count, v.fact_count, v.ledger_index
       FROM semanto_versions v JOIN semanto_companies c ON c.trooth_id = v.trooth_id AND c.current_version = v.version
       WHERE v.trooth_id = ?1 AND v.state = 'signed'`,
    )
    .bind(trooth_id)
    .first<VersionRow>();
}

export async function selectVersions(db: D1Database, trooth_id: string): Promise<VersionSummary[]> {
  const { results } = await db
    .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 ORDER BY version DESC`)
    .bind(trooth_id)
    .all<VersionRow>();
  return results.map((r) => ({
    version: r.version,
    version_id: versionId(r.root_hash),
    state: r.state,
    built_at: r.built_at,
    signed_at: r.signed_at,
    withdrawn_at: r.withdrawn_at,
    root_hash: r.root_hash,
    page_count: r.page_count,
    fact_count: r.fact_count,
  }));
}

export async function selectSignedAt(db: D1Database, trooth_id: string, version: number): Promise<string | null> {
  const row = await db.prepare(`SELECT signed_at FROM semanto_versions WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, version).first<{ signed_at: string | null }>();
  return row?.signed_at ?? null;
}

// ------------------------------------------------------------ pages

export async function selectPage(db: D1Database, trooth_id: string, version: number, page_id: string): Promise<PageRow | null> {
  return db
    .prepare(
      `SELECT page_id, version, url, title, hash, source_hash, bytes, tokens, original_tokens, witnessed_at, lang, part_n, part_of, status, noindex, nosnippet, canonical, robots_blocked, manifest_index
       FROM semanto_pages WHERE trooth_id = ?1 AND version = ?2 AND page_id = ?3`,
    )
    .bind(trooth_id, version, page_id)
    .first<PageRow>();
}

export async function selectPageByUrl(db: D1Database, trooth_id: string, version: number, url: string): Promise<PageRow | null> {
  return db
    .prepare(
      `SELECT page_id, version, url, title, hash, source_hash, bytes, tokens, original_tokens, witnessed_at, lang, part_n, part_of, status, noindex, nosnippet, canonical, robots_blocked, manifest_index
       FROM semanto_pages WHERE trooth_id = ?1 AND version = ?2 AND url = ?3 AND (part_n IS NULL OR part_n = 1)`,
    )
    .bind(trooth_id, version, url)
    .first<PageRow>();
}

/** The live state of a page: behind when the change monitor saw a raw hash different from the signed source hash after the signature. */
export async function selectPageLiveState(db: D1Database, trooth_id: string, url: string, source_hash: string, signed_at: string | null): Promise<PageLiveState> {
  const row = await db.prepare(`SELECT raw_hash, checked_at FROM semanto_change_state WHERE trooth_id = ?1 AND url = ?2`).bind(trooth_id, url).first<ChangeStateRow>();
  if (!row || !row.raw_hash) return "unknown";
  if (signed_at && row.checked_at < signed_at) return "unknown";
  return row.raw_hash === source_hash ? "current" : "behind";
}

// ------------------------------------------------------------ facts

interface FactRow {
  fact_id: string;
  key: string;
  statement: string;
  value_json: string | null;
  provenance: Fact["provenance"];
  evidence_url: string;
  evidence_anchor: string | null;
  evidence_source: string | null;
  witnessed_at: string;
  schema_type: string | null;
  schema_property: string | null;
}

export async function selectFacts(db: D1Database, trooth_id: string, version: number): Promise<Fact[]> {
  const { results } = await db
    .prepare(`SELECT fact_id, key, statement, value_json, provenance, evidence_url, evidence_anchor, evidence_source, witnessed_at, schema_type, schema_property FROM semanto_facts WHERE trooth_id = ?1 AND version = ?2 ORDER BY fact_id`)
    .bind(trooth_id, version)
    .all<FactRow>();
  return results.map((r) => ({
    id: r.fact_id,
    key: r.key,
    statement: r.statement,
    ...(r.value_json !== null ? { value: JSON.parse(r.value_json) as Fact["value"] } : {}),
    provenance: r.provenance,
    evidence: {
      url: r.evidence_url,
      witnessed_at: r.witnessed_at,
      ...(r.evidence_anchor ? { anchor: r.evidence_anchor } : {}),
      ...(r.evidence_source ? { source: r.evidence_source } : {}),
    },
    ...(r.schema_type && r.schema_property ? { schema: { type: r.schema_type, property: r.schema_property } } : {}),
  }));
}

// ------------------------------------------------------------ keys

export async function selectCompanyKeys(db: D1Database, trooth_id: string): Promise<Jwks> {
  const { results } = await db.prepare(`SELECT kid, public_jwk, custody, nbf, exp, revoked_at FROM semanto_keys WHERE trooth_id = ?1 ORDER BY created_at`).bind(trooth_id).all<KeyRow>();
  return {
    keys: results.map((r) => {
      const jwk = JSON.parse(r.public_jwk) as PublicJwk;
      return { ...jwk, ...(r.nbf ? { nbf: r.nbf } : {}), ...(r.exp ? { exp: r.exp } : {}), ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}) };
    }),
  };
}

export async function selectKeyByKid(db: D1Database, kid: string): Promise<(PublicJwk & { trooth_id: string; custody: "hosted" | "customer" }) | null> {
  const r = await db.prepare(`SELECT trooth_id, kid, public_jwk, custody, nbf, exp, revoked_at FROM semanto_keys WHERE kid = ?1`).bind(kid).first<KeyRow & { trooth_id: string }>();
  if (!r) return null;
  const jwk = JSON.parse(r.public_jwk) as PublicJwk;
  return { ...jwk, ...(r.nbf ? { nbf: r.nbf } : {}), ...(r.exp ? { exp: r.exp } : {}), ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}), trooth_id: r.trooth_id, custody: r.custody };
}

export async function selectHostedKid(db: D1Database, trooth_id: string): Promise<string | null> {
  const r = await db.prepare(`SELECT kid FROM semanto_keys WHERE trooth_id = ?1 AND custody = 'hosted' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(trooth_id).first<{ kid: string }>();
  return r?.kid ?? null;
}

// ------------------------------------------------------------ settings and detection

export async function selectSettings(db: D1Database, trooth_id: string): Promise<DeliverySettings | null> {
  const r = await db.prepare(`SELECT settings_json FROM semanto_settings WHERE trooth_id = ?1`).bind(trooth_id).first<{ settings_json: string }>();
  return r ? withDefaults(JSON.parse(r.settings_json) as Partial<DeliverySettings>) : null;
}

export async function upsertSettings(db: D1Database, trooth_id: string, settings: DeliverySettings, now: string): Promise<void> {
  await db
    .prepare(`INSERT INTO semanto_settings (trooth_id, settings_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(trooth_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`)
    .bind(trooth_id, JSON.stringify(settings), now)
    .run();
}

export async function upsertHostDetection(db: D1Database, trooth_id: string, d: DetectionResult): Promise<void> {
  await db
    .prepare(
      `INSERT INTO semanto_host_detection (trooth_id, host, cloudflare_markdown, well_known_served, dns_pointer, checked_at, details_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(trooth_id) DO UPDATE SET host = excluded.host, cloudflare_markdown = excluded.cloudflare_markdown, well_known_served = excluded.well_known_served, dns_pointer = excluded.dns_pointer, checked_at = excluded.checked_at, details_json = excluded.details_json`,
    )
    .bind(trooth_id, d.host, d.cloudflare_markdown ? 1 : 0, d.well_known_served.semanto && d.well_known_served.keys ? 1 : 0, d.dns_pointer ? 1 : 0, d.checked_at, JSON.stringify(d))
    .run();
}

export async function selectHostDetection(db: D1Database, trooth_id: string): Promise<DetectionResult | null> {
  const r = await db.prepare(`SELECT details_json FROM semanto_host_detection WHERE trooth_id = ?1`).bind(trooth_id).first<{ details_json: string }>();
  return r ? (JSON.parse(r.details_json) as DetectionResult) : null;
}

// ------------------------------------------------------------ receipts

export async function insertReadReceipt(db: D1Database, id: string, r: ReceiptInput, ip_hash: string | null): Promise<void> {
  await db
    .prepare(`INSERT INTO semanto_read_receipts (id, trooth_id, version, page_id, representation, agent_key_url, agent_keyid, proof, read_at, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)`)
    .bind(id, r.trooth_id, r.version, r.page_id, r.representation, r.agent_key_url, r.proof, r.read_at, ip_hash)
    .run();
}

// ------------------------------------------------------------ port implementations over D1 and R2

async function r2Bytes(store: R2Bucket, key: string): Promise<Uint8Array | null> {
  const obj = await store.get(key);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

export class D1VersionStore implements VersionStore {
  constructor(
    private db: D1Database,
    private store: R2Bucket,
  ) {}

  getCompany(trooth_id: string): Promise<CompanyRecord | null> {
    return selectCompany(this.db, trooth_id);
  }
  getCompanyByDomain(domain: string): Promise<CompanyRecord | null> {
    return selectCompanyByDomain(this.db, domain);
  }
  async getCurrent(trooth_id: string): Promise<SemantoFile | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    return v ? this.readFile(trooth_id, v.version) : null;
  }
  async getVersion(trooth_id: string, version: number): Promise<SemantoFile | null> {
    const v = await selectVersion(this.db, trooth_id, version);
    return v ? this.readFile(trooth_id, version) : null;
  }
  listVersions(trooth_id: string): Promise<VersionSummary[]> {
    return selectVersions(this.db, trooth_id);
  }
  async getPage(trooth_id: string, page_id: string): Promise<StoredPage | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    if (!v) return null;
    const row = await selectPage(this.db, trooth_id, v.version, page_id);
    return row ? this.assemblePage(trooth_id, v, row) : null;
  }
  async getPageByUrl(trooth_id: string, url: string): Promise<StoredPage | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    if (!v) return null;
    const row = await selectPageByUrl(this.db, trooth_id, v.version, url);
    return row ? this.assemblePage(trooth_id, v, row) : null;
  }
  async getFacts(trooth_id: string): Promise<Fact[] | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    return v ? selectFacts(this.db, trooth_id, v.version) : null;
  }
  async getJsonLd(trooth_id: string): Promise<Uint8Array | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    return v ? r2Bytes(this.store, r2Key.jsonld(trooth_id, v.version)) : null;
  }
  async getLlms(trooth_id: string, kind: "llms" | "llms-full" | "sitemap"): Promise<Uint8Array | null> {
    const v = await selectCurrentSignedVersion(this.db, trooth_id);
    if (!v) return null;
    const key = kind === "llms" ? r2Key.llms : kind === "llms-full" ? r2Key.llmsFull : r2Key.sitemap;
    return r2Bytes(this.store, key(trooth_id, v.version));
  }

  private async readFile(trooth_id: string, version: number): Promise<SemantoFile | null> {
    const b = await r2Bytes(this.store, r2Key.file(trooth_id, version));
    return b ? (JSON.parse(new TextDecoder().decode(b)) as SemantoFile) : null;
  }

  private async assemblePage(trooth_id: string, v: VersionRow, row: PageRow): Promise<StoredPage | null> {
    const bytes = await r2Bytes(this.store, r2Key.page(trooth_id, v.version, row.page_id));
    if (!bytes) return null;
    const live = await selectPageLiveState(this.db, trooth_id, row.url, row.source_hash, v.signed_at);
    return {
      bytes,
      version: v.version,
      original_tokens: row.original_tokens || estimateTokens(""),
      live,
      entry: {
        id: row.page_id,
        url: row.url,
        title: row.title,
        hash: row.hash,
        source_hash: row.source_hash,
        bytes: row.bytes,
        tokens: row.tokens,
        witnessed_at: row.witnessed_at,
        ...(row.lang ? { lang: row.lang } : {}),
        ...(row.part_n && row.part_of ? { part: { n: row.part_n, of: row.part_of } } : {}),
        status: row.status,
        index: { noindex: row.noindex === 1, nosnippet: row.nosnippet === 1, canonical: row.canonical, robots_blocked: row.robots_blocked === 1 },
      },
    };
  }
}

export class D1Keys implements KeyPort {
  constructor(
    private db: D1Database,
    private store: R2Bucket,
    private witness: PrivateJwk,
    /** HOSTED_KEY_SEAL_SECRET; hosted keys are stored sealed (src/db/key-seal.ts) and opened only with it. */
    private sealSecret?: string,
  ) {}
  getCompanyJwks(trooth_id: string): Promise<Jwks> {
    return selectCompanyKeys(this.db, trooth_id);
  }
  async getCompanySigningKey(trooth_id: string): Promise<PrivateJwk | null> {
    // Sealed at rest with AES-256-GCM (src/db/key-seal.ts). Without the seal
    // secret nothing opens and responses are witness-signed.
    const kid = await selectHostedKid(this.db, trooth_id);
    if (!kid) return null;
    const b = await r2Bytes(this.store, r2Key.hostedKey(trooth_id, kid));
    if (!b) return null;
    return openPrivateJwk(b, this.sealSecret);
  }
  async getWitnessKey(): Promise<PrivateJwk> {
    return this.witness;
  }
  async getWitnessPublicKeys(): Promise<Jwks> {
    const { d: _d, ...pub } = this.witness;
    return { keys: [pub] };
  }
  async resolve(_trooth_id: string | null, kid: string): Promise<PublicJwk | null> {
    if (kid === this.witness.kid) {
      const { d: _d, ...pub } = this.witness;
      return pub;
    }
    const k = await selectKeyByKid(this.db, kid);
    if (!k) return null;
    const { trooth_id: _t, custody: _c, ...jwk } = k;
    return jwk;
  }
}

export class D1Receipts implements ReceiptPort {
  constructor(private db: D1Database) {}
  async record(input: ReceiptInput): Promise<void> {
    const id = semantoId("smd", await digest(JSON.stringify(input)));
    await insertReadReceipt(this.db, id, input, null);
  }
}

export class D1Settings implements SettingsPort {
  constructor(private db: D1Database) {}
  get(trooth_id: string): Promise<DeliverySettings | null> {
    return selectSettings(this.db, trooth_id);
  }
  put(trooth_id: string, settings: DeliverySettings): Promise<void> {
    return upsertSettings(this.db, trooth_id, settings, new Date().toISOString());
  }
}

// ------------------------------------------------------------ the pipeline's write side (src/pipeline-store.ts)

interface ConfigRow {
  config_json: string;
}

async function r2Put(store: R2Bucket, key: string, bytes: Uint8Array | string, contentType: string): Promise<void> {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  await store.put(key, body as unknown as ArrayBuffer, { httpMetadata: { contentType } });
}

/** The kid in a compact JWS's protected header. */
function kidOf(jws: string): string {
  try {
    const h = JSON.parse(new TextDecoder().decode(fromBase64Url(jws.split(".")[0] ?? ""))) as { kid?: string };
    return h.kid ?? "";
  } catch {
    return "";
  }
}

export class D1PipelineStore implements PipelineStore {
  constructor(
    private db: D1Database,
    private store: R2Bucket,
    /** HOSTED_KEY_SEAL_SECRET: hosted private keys are written sealed, never in the clear. */
    private sealSecret?: string,
  ) {}

  getCompany(trooth_id: string): Promise<CompanyRecord | null> {
    return selectCompany(this.db, trooth_id);
  }

  async putCompany(c: CompanyRecord): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO semanto_companies (trooth_id, domain, org, tier, legal_name, lei, custody, current_version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)
         ON CONFLICT(trooth_id) DO UPDATE SET domain = excluded.domain, org = excluded.org, tier = excluded.tier, legal_name = excluded.legal_name, lei = excluded.lei, custody = excluded.custody, updated_at = excluded.updated_at`,
      )
      .bind(c.trooth_id, c.domain, c.org, c.tier, c.legal_name ?? null, c.lei ?? null, c.custody, now)
      .run();
  }

  async listCompanies(which: "signed" | "all"): Promise<CompanyRecord[]> {
    const where = which === "signed" ? "WHERE c.current_version IS NOT NULL" : "";
    const { results } = await this.db
      .prepare(
        `SELECT c.trooth_id, c.domain, c.org, c.tier, c.legal_name, c.lei, c.current_version,
                COALESCE((SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1), c.custody) AS custody
         FROM semanto_companies c ${where} ORDER BY c.trooth_id`,
      )
      .all<CompanyRow>();
    return results.map(toCompany);
  }

  async getConfig(trooth_id: string): Promise<CompanyConfig> {
    const r = await this.db.prepare(`SELECT config_json FROM semanto_company_config WHERE trooth_id = ?1`).bind(trooth_id).first<ConfigRow>();
    return r ? { ...structuredClone(DEFAULT_CONFIG), ...(JSON.parse(r.config_json) as Partial<CompanyConfig>) } : structuredClone(DEFAULT_CONFIG);
  }

  async putConfig(trooth_id: string, config: CompanyConfig): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_company_config (trooth_id, config_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(trooth_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .bind(trooth_id, JSON.stringify(config), new Date().toISOString())
      .run();
  }

  private async readStored(trooth_id: string, row: VersionRow): Promise<StoredVersion | null> {
    const b = await r2Bytes(this.store, r2Key.file(trooth_id, row.version));
    if (!b) return null;
    const file = JSON.parse(new TextDecoder().decode(b)) as SemantoFile;
    const { results } = await this.db.prepare(`SELECT page_id, original_tokens FROM semanto_pages WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, row.version).all<{ page_id: string; original_tokens: number }>();
    const original_tokens: Record<string, number> = {};
    for (const r of results) original_tokens[r.page_id] = r.original_tokens;
    const bodies: Record<string, Uint8Array> = {};
    for (const p of file.header.pages_manifest) {
      const body = await r2Bytes(this.store, r2Key.page(trooth_id, row.version, p.id));
      if (body) bodies[p.id] = body;
    }
    return { file, bodies, original_tokens, signed_at: row.signed_at };
  }

  async latestVersion(trooth_id: string): Promise<StoredVersion | null> {
    const row = await this.db
      .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(trooth_id)
      .first<VersionRow>();
    return row ? this.readStored(trooth_id, row) : null;
  }

  async getVersion(trooth_id: string, version: number): Promise<StoredVersion | null> {
    const row = await selectVersion(this.db, trooth_id, version);
    return row ? this.readStored(trooth_id, row) : null;
  }

  async saveBuilt(trooth_id: string, v: StoredVersion, files: VersionFiles): Promise<void> {
    const f = v.file;
    const h = f.header;
    const n = h.version;
    await r2Put(this.store, r2Key.file(trooth_id, n), JSON.stringify(f), "application/json");
    for (const [id, body] of Object.entries(v.bodies)) await r2Put(this.store, r2Key.page(trooth_id, n, id), body, "text/markdown; charset=utf-8");
    await r2Put(this.store, r2Key.llms(trooth_id, n), files.llms.llmsTxt, "text/markdown; charset=utf-8");
    await r2Put(this.store, r2Key.llmsFull(trooth_id, n), files.llms.llmsFull, "text/markdown; charset=utf-8");
    await r2Put(this.store, r2Key.sitemap(trooth_id, n), files.llms.sitemapMd, "text/markdown; charset=utf-8");
    await r2Put(this.store, r2Key.jsonld(trooth_id, n), files.jsonld, "application/ld+json");
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT OR REPLACE INTO semanto_versions (trooth_id, version, supersedes, state, built_at, not_before, not_after, root_hash, pages_root, facts_root, tiers_json, page_count, fact_count)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(trooth_id, n, h.supersedes, h.state, h.built_at, h.not_before, h.not_after, f.root_hash, h.pages_root, h.facts_root, JSON.stringify(h.tiers), h.pages_manifest.length, f.facts.length),
    ];
    h.pages_manifest.forEach((p, i) => {
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO semanto_pages (trooth_id, version, page_id, url, title, hash, source_hash, bytes, tokens, original_tokens, witnessed_at, lang, part_n, part_of, status, noindex, nosnippet, canonical, robots_blocked, manifest_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
          )
          .bind(trooth_id, n, p.id, p.url, p.title, p.hash, p.source_hash, p.bytes, p.tokens, v.original_tokens[p.id] ?? p.original_tokens ?? 0, p.witnessed_at, p.lang ?? null, p.part?.n ?? null, p.part?.of ?? null, p.status, p.index.noindex ? 1 : 0, p.index.nosnippet ? 1 : 0, p.index.canonical, p.index.robots_blocked ? 1 : 0, i),
      );
    });
    for (const fact of f.facts) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR REPLACE INTO semanto_facts (trooth_id, version, fact_id, key, statement, value_json, provenance, evidence_url, evidence_anchor, evidence_source, witnessed_at, schema_type, schema_property)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          )
          .bind(trooth_id, n, fact.id, fact.key, fact.statement, fact.value === undefined ? null : JSON.stringify(fact.value), fact.provenance, fact.evidence.url, fact.evidence.anchor ?? null, fact.evidence.source ?? null, fact.evidence.witnessed_at, fact.schema?.type ?? null, fact.schema?.property ?? null),
      );
    }
    await this.db.batch(statements);
  }

  async markSigned(trooth_id: string, file: SemantoFile, signed_at: string): Promise<void> {
    const n = file.header.version;
    await r2Put(this.store, r2Key.file(trooth_id, n), JSON.stringify(file), "application/json");
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE semanto_versions SET state = 'signed', signed_at = ?3, root_hash = ?4, signature_jws = ?5, signature_kid = ?6, witness_jws = ?7, witness_kid = ?8, witnessed_at = ?9, ledger_index = ?10, ledger_tree_size = ?11, ledger_tree_head = ?12
           WHERE trooth_id = ?1 AND version = ?2`,
        )
        .bind(trooth_id, n, signed_at, file.root_hash, file.signature?.jws ?? null, file.signature?.kid ?? null, file.witness?.jws ?? null, file.witness?.kid ?? null, file.witness?.at ?? null, file.ledger?.index ?? null, file.ledger?.tree_size ?? null, file.ledger?.tree_head ?? null),
      this.db.prepare(`UPDATE semanto_companies SET current_version = ?2, updated_at = ?3 WHERE trooth_id = ?1`).bind(trooth_id, n, signed_at),
    ]);
  }

  async changeState(trooth_id: string): Promise<Record<string, ChangeRow>> {
    const { results } = await this.db.prepare(`SELECT url, etag, last_modified, raw_hash, lastmod, checked_at FROM semanto_change_state WHERE trooth_id = ?1`).bind(trooth_id).all<ChangeRow & { url: string }>();
    const out: Record<string, ChangeRow> = {};
    for (const r of results) out[r.url] = { etag: r.etag, last_modified: r.last_modified, raw_hash: r.raw_hash, lastmod: r.lastmod ?? null, checked_at: r.checked_at };
    return out;
  }

  async putChangeState(trooth_id: string, url: string, row: ChangeRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO semanto_change_state (trooth_id, url, etag, last_modified, raw_hash, lastmod, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(trooth_id, url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, raw_hash = excluded.raw_hash, lastmod = excluded.lastmod, checked_at = excluded.checked_at`,
      )
      .bind(trooth_id, url, row.etag, row.last_modified, row.raw_hash, row.lastmod ?? null, row.checked_at)
      .run();
  }

  async authorizations(trooth_id: string, root_hash: string): Promise<Authorization[]> {
    const { results } = await this.db.prepare(`SELECT record_json, at, root_hash FROM semanto_authorizations WHERE trooth_id = ?1 AND root_hash = ?2 ORDER BY at`).bind(trooth_id, root_hash).all<{ record_json: string; at: string; root_hash: string }>();
    return results.map((r) => ({ record: JSON.parse(r.record_json) as Authorization["record"], at: r.at, root_hash: r.root_hash }));
  }

  async addAuthorization(trooth_id: string, a: Authorization): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO semanto_authorizations (trooth_id, root_hash, subject, record_json, at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(trooth_id, a.root_hash, a.record.subject, JSON.stringify(a.record), a.at)
      .run();
  }

  async clearAuthorizations(trooth_id: string, root_hash: string): Promise<void> {
    await this.db.prepare(`DELETE FROM semanto_authorizations WHERE trooth_id = ?1 AND root_hash = ?2`).bind(trooth_id, root_hash).run();
  }

  async pending(trooth_id: string, version: number): Promise<PendingSigning | null> {
    const r = await this.db.prepare(`SELECT kid, header_json, prepared_json, created_at FROM semanto_pending_signatures WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, version).first<{ kid: string; header_json: string; prepared_json: string; created_at: string }>();
    return r ? { trooth_id, version, kid: r.kid, header: JSON.parse(r.header_json) as SemantoHeader, prepared: JSON.parse(r.prepared_json) as PreparedSigning, created_at: r.created_at } : null;
  }

  async putPending(p: PendingSigning): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_pending_signatures (trooth_id, version, kid, header_json, prepared_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(p.trooth_id, p.version, p.kid, JSON.stringify(p.header), JSON.stringify(p.prepared), p.created_at)
      .run();
  }

  async clearPending(trooth_id: string, version: number): Promise<void> {
    await this.db.prepare(`DELETE FROM semanto_pending_signatures WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, version).run();
  }

  async keys(trooth_id: string): Promise<CompanyKey[]> {
    const { results } = await this.db.prepare(`SELECT kid, public_jwk, custody, nbf, exp, revoked_at, created_at FROM semanto_keys WHERE trooth_id = ?1 ORDER BY created_at`).bind(trooth_id).all<KeyRow & { created_at: string }>();
    return results.map((r) => {
      const jwk = JSON.parse(r.public_jwk) as PublicJwk;
      return { public_jwk: { ...jwk, ...(r.nbf ? { nbf: r.nbf } : {}), ...(r.exp ? { exp: r.exp } : {}), ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}) }, custody: r.custody, created_at: r.created_at };
    });
  }

  async putKey(trooth_id: string, key: CompanyKey, privateJwk: PrivateJwk | null): Promise<void> {
    if (privateJwk) {
      if (!this.sealSecret) throw new Error("HOSTED_KEY_SEAL_SECRET is not set; a hosted key is never stored in the clear.");
      await r2Put(this.store, r2Key.hostedKey(trooth_id, key.public_jwk.kid), await sealPrivateJwk(privateJwk, this.sealSecret), "application/json");
    }
    const { nbf, exp, revoked_at, ...pub } = key.public_jwk;
    await this.db
      .prepare(
        `INSERT INTO semanto_keys (kid, trooth_id, public_jwk, custody, nbf, exp, revoked_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(kid) DO UPDATE SET public_jwk = excluded.public_jwk, nbf = excluded.nbf, exp = excluded.exp, revoked_at = excluded.revoked_at`,
      )
      .bind(key.public_jwk.kid, trooth_id, JSON.stringify(pub), key.custody, nbf ?? null, exp ?? null, revoked_at ?? null, key.created_at)
      .run();
  }

  async connectorKeys(trooth_id: string): Promise<PublicJwk[]> {
    const { results } = await this.db.prepare(`SELECT public_jwk FROM semanto_connector_keys WHERE trooth_id = ?1 AND revoked_at IS NULL`).bind(trooth_id).all<{ public_jwk: string }>();
    return results.map((r) => JSON.parse(r.public_jwk) as PublicJwk);
  }

  async putConnectorKey(trooth_id: string, jwk: PublicJwk, source: string, created_at: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_connector_keys (kid, trooth_id, public_jwk, source, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)`)
      .bind(jwk.kid, trooth_id, JSON.stringify(jwk), source, created_at)
      .run();
  }

  async revocations(trooth_id: string | null): Promise<RevocationEntry[]> {
    const q = trooth_id === null ? this.db.prepare(`SELECT kind, ref, reason, revoked_at FROM semanto_revocations ORDER BY revoked_at`) : this.db.prepare(`SELECT kind, ref, reason, revoked_at FROM semanto_revocations WHERE trooth_id = ?1 ORDER BY revoked_at`).bind(trooth_id);
    const { results } = await q.all<RevocationEntry>();
    return results;
  }

  async putRevocationList(trooth_id: string | null, jws: string, issued_at: string): Promise<void> {
    await this.db.prepare(`INSERT INTO semanto_revocation_lists (trooth_id, jws, issued_at) VALUES (?1, ?2, ?3)`).bind(trooth_id, jws, issued_at).run();
  }

  async saveGapReport(report: GapReport): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_gap_reports (id, trooth_id, kind, ran_at, report_json) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(report.id, report.trooth_id, report.kind, report.ran_at, JSON.stringify(report))
      .run();
  }

  async getBasic(trooth_id: string): Promise<BasicCompany | null> {
    const r = await this.db.prepare(`SELECT state_json FROM semanto_basic WHERE trooth_id = ?1`).bind(trooth_id).first<{ state_json: string }>();
    return r ? (JSON.parse(r.state_json) as BasicCompany) : null;
  }

  async putBasic(c: BasicCompany): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_basic (trooth_id, state_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(trooth_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .bind(c.trooth_id, JSON.stringify(c), new Date().toISOString())
      .run();
  }

  async putFirstPublication(r: FirstPublicationRecord): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_first_publications (trooth_id, record_id, url, content_hash, witnessed_at, jws, log_index) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(r.record.trooth_id, r.record.id, r.record.url, r.record.content_hash, r.record.witnessed_at, r.jws, r.log?.index ?? null)
      .run();
  }

  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await r2Put(this.store, key, bytes, contentType);
  }
}

// ------------------------------------------------------------ commerce (src/commerce/ports.ts) over semanto_products, semanto_offers, semanto_sellers, semanto_recalls

export class D1CommerceStore implements CommerceStore {
  constructor(
    private db: D1Database,
    private policy: OfferPolicy = DEFAULT_OFFER_POLICY,
  ) {}

  /** Answered from the company rows by withCompanies (src/pipeline.ts). */
  async company(_trooth_id: string): Promise<FeedCompany | null> {
    return null;
  }
  async offerPolicy(_trooth_id: string): Promise<OfferPolicy> {
    return this.policy;
  }
  async records(trooth_id: string): Promise<SignedProductRecord[]> {
    const { results } = await this.db.prepare(`SELECT record_json, jws FROM semanto_products WHERE trooth_id = ?1 AND withdrawn_at IS NULL AND jws IS NOT NULL ORDER BY sku`).bind(trooth_id).all<{ record_json: string; jws: string }>();
    return results.map((r) => ({ record: JSON.parse(r.record_json) as ProductRecord, jws: r.jws, kid: kidOf(r.jws) }));
  }
  async record(trooth_id: string, record_id: string): Promise<SignedProductRecord | null> {
    const r = await this.db.prepare(`SELECT record_json, jws FROM semanto_products WHERE trooth_id = ?1 AND record_id = ?2 AND jws IS NOT NULL`).bind(trooth_id, record_id).first<{ record_json: string; jws: string }>();
    return r ? { record: JSON.parse(r.record_json) as ProductRecord, jws: r.jws, kid: kidOf(r.jws) } : null;
  }
  async offers(trooth_id: string, sku?: string): Promise<SignedOffer[]> {
    const q = sku === undefined ? this.db.prepare(`SELECT offer_json, jws FROM semanto_offers WHERE trooth_id = ?1 ORDER BY as_of`).bind(trooth_id) : this.db.prepare(`SELECT offer_json, jws FROM semanto_offers WHERE trooth_id = ?1 AND sku = ?2 ORDER BY as_of`).bind(trooth_id, sku);
    const { results } = await q.all<{ offer_json: string; jws: string }>();
    return results.map((r) => ({ offer: JSON.parse(r.offer_json) as Offer, jws: r.jws, kid: kidOf(r.jws) }));
  }
  async attestations(brand_trooth_id: string): Promise<AttestationEntry[]> {
    const { results } = await this.db.prepare(`SELECT attestation_json, withdrawn_at FROM semanto_sellers WHERE trooth_id = ?1`).bind(brand_trooth_id).all<{ attestation_json: string; withdrawn_at: string | null }>();
    return results.map((r) => ({ attestation: JSON.parse(r.attestation_json) as AttestationEntry["attestation"], ...(r.withdrawn_at ? { withdrawn_at: r.withdrawn_at } : {}) }));
  }
  async recalls(trooth_id: string): Promise<SignedRecall[]> {
    const { results } = await this.db.prepare(`SELECT notice_json, jws FROM semanto_recalls WHERE trooth_id = ?1 ORDER BY issued_at`).bind(trooth_id).all<{ notice_json: string; jws: string }>();
    return results.map((r) => ({ notice: JSON.parse(r.notice_json) as SignedRecall["notice"], jws: r.jws, kid: kidOf(r.jws) }));
  }
  async putRecord(trooth_id: string, s: SignedProductRecord): Promise<void> {
    const r = s.record;
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_products (trooth_id, record_id, product_id, variant_id, gtin, sku, record_json, jws, signed_at, not_after, withdrawn_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`)
      .bind(trooth_id, r.id, r.product_id, r.variant_id ?? null, r.gtin ?? null, r.sku, JSON.stringify(r), s.jws, new Date().toISOString(), r.not_after ?? null)
      .run();
  }
  async putOffer(trooth_id: string, s: SignedOffer): Promise<void> {
    const o = s.offer;
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_offers (trooth_id, offer_id, sku, variant_id, offer_json, jws, as_of, not_after) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(trooth_id, o.id, o.sku, o.variant_id ?? null, JSON.stringify(o), s.jws, o.as_of, o.not_after)
      .run();
  }
  async putAttestation(brand_trooth_id: string, entry: AttestationEntry): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_sellers (trooth_id, attestation_id, seller_domain, attestation_json, jws, not_after, withdrawn_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)`)
      .bind(brand_trooth_id, entry.attestation.id, entry.attestation.seller_domain, JSON.stringify(entry.attestation), entry.attestation.not_after ?? null, entry.withdrawn_at ?? null)
      .run();
  }
  async putRecall(trooth_id: string, s: SignedRecall): Promise<void> {
    await this.db
      .prepare(`INSERT OR REPLACE INTO semanto_recalls (trooth_id, notice_id, notice_json, jws, issued_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(trooth_id, s.notice.id, JSON.stringify(s.notice), s.jws, s.notice.issued_at)
      .run();
  }
}

// ------------------------------------------------------------ monitor runs and alerts (src/monitor/ports.ts StorePort)

export class D1MonitorStore implements MonitorStorePort {
  constructor(private db: D1Database) {}
  async saveRun(run: MonitorRun): Promise<void> {
    const r = runToRow(run);
    await this.db.prepare(`INSERT OR REPLACE INTO semanto_monitor_runs (id, trooth_id, ran_at, surfaces_json, mismatches_json, indexability_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(r.id, r.trooth_id, r.ran_at, r.surfaces_json, r.mismatches_json, r.indexability_json).run();
  }
  async openAlerts(trooth_id: string): Promise<Alert[]> {
    const { results } = await this.db.prepare(`SELECT id, trooth_id, kind, message, detail_json, created_at, sent_at, resolved_at FROM semanto_alerts WHERE trooth_id = ?1 AND resolved_at IS NULL`).bind(trooth_id).all<AlertRow>();
    return results.map(alertFromRow);
  }
  async saveAlerts(alerts: Alert[]): Promise<void> {
    if (!alerts.length) return;
    await this.db.batch(
      alerts.map((a) => {
        const r = alertToRow(a);
        return this.db.prepare(`INSERT OR IGNORE INTO semanto_alerts (id, trooth_id, kind, message, detail_json, created_at, sent_at, resolved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(r.id, r.trooth_id, r.kind, r.message, r.detail_json, r.created_at, r.sent_at, r.resolved_at);
      }),
    );
  }
  async sentSince(trooth_id: string, sinceIso: string): Promise<number> {
    const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM semanto_alerts WHERE trooth_id = ?1 AND sent_at IS NOT NULL AND sent_at >= ?2`).bind(trooth_id, sinceIso).first<{ n: number }>();
    return r?.n ?? 0;
  }
  async markSent(ids: string[], atIso: string): Promise<void> {
    if (!ids.length) return;
    await this.db.batch(ids.map((id) => this.db.prepare(`UPDATE semanto_alerts SET sent_at = ?2 WHERE id = ?1`).bind(id, atIso)));
  }
  async resolveAlerts(ids: string[], atIso: string): Promise<void> {
    if (!ids.length) return;
    await this.db.batch(ids.map((id) => this.db.prepare(`UPDATE semanto_alerts SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL`).bind(id, atIso)));
  }
}

// ------------------------------------------------------------ read receipts through src/readers (hashing the address with the daily salt)

export { D1ReceiptStore } from "../readers/ports";
