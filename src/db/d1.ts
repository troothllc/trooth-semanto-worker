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
import { toPublic, WitnessKeyMissingError, type Jwks, type PrivateJwk, type PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";
import { withDefaults } from "../settings/delivery";
import type { CompanyRecord, KeyPort, PageLiveState, ReceiptInput, ReceiptPort, SettingsPort, StoredPage, VersionStore, VersionSummary } from "../serve/ports";
import { pageLiveState } from "../serve/ports";
import type { DetectionResult } from "../serve/detect";
import { openPrivateJwk, sealPrivateJwk } from "./key-seal";
import { fromBase64Url } from "../core/encoding";
import type { SemantoHeader } from "../core/semanto";
import { DEFAULT_CONFIG, type ChangeRow, type CompanyConfig, type CompanyKey, type PendingSigning, type PipelineStore, type StoredVersion, type VersionFiles, type VersionHead } from "../pipeline-store";
import type { Authorization } from "../identity/roles";
import type { PasskeyChallenge, PasskeyJwk, PasskeyUser, StoredPasskey } from "../identity/webauthn";
import type { PreparedSigning } from "../identity/keys";
import type { RevocationEntry } from "../ledger/revocation";
import type { GapReport } from "../gap/report";
import type { BasicCompany, ProofMethod } from "../basic/tier";
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
import type { BuildRow, BuildStagingPort, StagedFetch, StagedItem, StagedRender } from "../compiler/stream";
import type { SetupRecord } from "../setup/state";

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
  domain_proven_at: string | null;
  os_company_id: string | null;
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

/** The company columns every company read selects; custody is the newest unrevoked key's, else the row's. */
const COMPANY_COLUMNS = `c.trooth_id, c.domain, c.org, c.tier, c.legal_name, c.lei, c.current_version, c.basic_version, c.domain_proven_at, c.os_company_id,
              COALESCE((SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL AND k.pending = 0 ORDER BY k.created_at DESC LIMIT 1), c.custody) AS custody`;

export async function selectCompanyByOsCompany(db: D1Database, os_company_id: string): Promise<CompanyRecord | null> {
  const row = await db.prepare(`SELECT ${COMPANY_COLUMNS} FROM semanto_companies c WHERE c.os_company_id = ?1`).bind(os_company_id).first<CompanyRow>();
  return row ? toCompany(row) : null;
}

export async function selectCompany(db: D1Database, trooth_id: string): Promise<CompanyRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${COMPANY_COLUMNS} FROM semanto_companies c WHERE c.trooth_id = ?1`,
    )
    .bind(trooth_id)
    .first<CompanyRow>();
  return row ? toCompany(row) : null;
}

export async function selectCompanyByDomain(db: D1Database, domain: string): Promise<CompanyRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${COMPANY_COLUMNS} FROM semanto_companies c WHERE c.domain = ?1`,
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
    basic_version: (r as CompanyRow & { basic_version?: number | null }).basic_version ?? null,
    domain_proven_at: r.domain_proven_at ?? null,
    os_company_id: r.os_company_id ?? null,
  };
}

// ------------------------------------------------------------ versions

export async function selectVersion(db: D1Database, trooth_id: string, version: number): Promise<VersionRow | null> {
  return db
    .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 AND version = ?2`)
    .bind(trooth_id, version)
    .first<VersionRow>();
}

/**
 * The version the public routes serve: the current signed version, or, for a
 * Semanto Basic company with no signed version, its witnessed record.
 */
export async function selectServedVersion(db: D1Database, trooth_id: string): Promise<VersionRow | null> {
  return (
    (await selectCurrentSignedVersion(db, trooth_id)) ??
    (await db
      .prepare(
        `SELECT v.trooth_id, v.version, v.state, v.built_at, v.signed_at, v.withdrawn_at, v.root_hash, v.page_count, v.fact_count, v.ledger_index
         FROM semanto_versions v JOIN semanto_companies c ON c.trooth_id = v.trooth_id AND c.basic_version = v.version
         WHERE v.trooth_id = ?1 AND v.state = 'read' AND v.witness_jws IS NOT NULL`,
      )
      .bind(trooth_id)
      .first<VersionRow>())
  );
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
export async function selectPageLiveState(db: D1Database, trooth_id: string, url: string, source_hash: string, signed_at: string | null, built_at?: string): Promise<PageLiveState> {
  const row = await db.prepare(`SELECT raw_hash, checked_at FROM semanto_change_state WHERE trooth_id = ?1 AND url = ?2`).bind(trooth_id, url).first<ChangeStateRow>();
  return pageLiveState(row, source_hash, signed_at, built_at);
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
  // A key staged as next (pending = 1) is published but never signs before its rotation is confirmed.
  const r = await db.prepare(`SELECT kid FROM semanto_keys WHERE trooth_id = ?1 AND custody = 'hosted' AND revoked_at IS NULL AND pending = 0 ORDER BY created_at DESC LIMIT 1`).bind(trooth_id).first<{ kid: string }>();
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
    const v = await selectServedVersion(this.db, trooth_id);
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
    const v = await selectServedVersion(this.db, trooth_id);
    if (!v) return null;
    const row = await selectPage(this.db, trooth_id, v.version, page_id);
    return row ? this.assemblePage(trooth_id, v, row) : null;
  }
  async getPageByUrl(trooth_id: string, url: string): Promise<StoredPage | null> {
    const v = await selectServedVersion(this.db, trooth_id);
    if (!v) return null;
    const row = await selectPageByUrl(this.db, trooth_id, v.version, url);
    return row ? this.assemblePage(trooth_id, v, row) : null;
  }
  async getFacts(trooth_id: string): Promise<Fact[] | null> {
    const v = await selectServedVersion(this.db, trooth_id);
    return v ? selectFacts(this.db, trooth_id, v.version) : null;
  }
  async getJsonLd(trooth_id: string): Promise<Uint8Array | null> {
    const v = await selectServedVersion(this.db, trooth_id);
    return v ? r2Bytes(this.store, r2Key.jsonld(trooth_id, v.version)) : null;
  }
  async getLlms(trooth_id: string, kind: "llms" | "llms-full" | "sitemap"): Promise<Uint8Array | null> {
    const v = await selectServedVersion(this.db, trooth_id);
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
    const live = await selectPageLiveState(this.db, trooth_id, row.url, row.source_hash, v.signed_at, v.built_at);
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
    /** Trooth's witness key, or null on a deployment that has none yet (a 503 problem wherever it is needed). */
    private witnessKey: PrivateJwk | null,
    /** HOSTED_KEY_SEAL_SECRET; hosted keys are stored sealed (src/db/key-seal.ts) and opened only with it. */
    private sealSecret?: string,
    /** Earlier witness public keys, still served with their exp or revoked_at (TROOTH_WITNESS_PREVIOUS_KEYS). */
    private previousWitness: PublicJwk[] = [],
  ) {}
  private get witness(): PrivateJwk {
    if (!this.witnessKey) throw new WitnessKeyMissingError();
    return this.witnessKey;
  }
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
    const current = this.witnessKey ? [toPublic(this.witnessKey)] : [];
    return { keys: [...current, ...this.previousWitness.filter((k) => !current.some((c) => c.kid === k.kid))] };
  }
  /** This company's keys only: a key that belongs to another company, or Trooth's witness key, is not returned. */
  async resolveCompany(trooth_id: string, kid: string): Promise<PublicJwk | null> {
    const k = await selectKeyByKid(this.db, kid);
    if (!k || k.trooth_id !== trooth_id) return null;
    const { trooth_id: _t, custody: _c, ...jwk } = k;
    return jwk;
  }
  /** Trooth's witness keys only, the earlier ones included (each judged at the signature's iat by the verifier). */
  async resolveTrooth(kid: string): Promise<PublicJwk | null> {
    return (await this.getWitnessPublicKeys()).keys.find((k) => k.kid === kid) ?? null;
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

interface PasskeyRow {
  credential_id: string;
  user_id: string;
  trooth_id: string;
  public_jwk: string;
  alg: number;
  sign_count: number;
  transports: string;
  backup_eligible: number;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

function passkeyFromRow(r: PasskeyRow): StoredPasskey {
  return {
    credential_id: r.credential_id,
    user_id: r.user_id,
    trooth_id: r.trooth_id,
    public_jwk: JSON.parse(r.public_jwk) as PasskeyJwk,
    alg: r.alg as StoredPasskey["alg"],
    sign_count: r.sign_count,
    transports: JSON.parse(r.transports) as string[],
    backup_eligible: r.backup_eligible === 1,
    backed_up: r.backed_up === 1,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  };
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
        `INSERT INTO semanto_companies (trooth_id, domain, org, tier, legal_name, lei, custody, current_version, os_company_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?9, ?8, ?8)
         ON CONFLICT(trooth_id) DO UPDATE SET org = excluded.org, tier = excluded.tier, legal_name = excluded.legal_name, lei = excluded.lei, custody = excluded.custody, updated_at = excluded.updated_at`,
      )
      .bind(c.trooth_id, c.domain, c.org, c.tier, c.legal_name ?? null, c.lei ?? null, c.custody, now, c.os_company_id ?? null)
      .run();
  }

  async listCompanies(which: "signed" | "all"): Promise<CompanyRecord[]> {
    const where = which === "signed" ? "WHERE c.current_version IS NOT NULL" : "";
    const { results } = await this.db
      .prepare(`SELECT ${COMPANY_COLUMNS} FROM semanto_companies c ${where} ORDER BY c.trooth_id`)
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

  // The file and the token counts, read together; never the page bodies, which this used to read one at a time
  // (135 sequential R2 reads made each passkey request and each signing take five to eight seconds, 2026-10-24).
  private async readStored(trooth_id: string, row: VersionRow): Promise<VersionHead | null> {
    const [b, { results }] = await Promise.all([
      r2Bytes(this.store, r2Key.file(trooth_id, row.version)),
      this.db.prepare(`SELECT page_id, original_tokens FROM semanto_pages WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, row.version).all<{ page_id: string; original_tokens: number }>(),
    ]);
    if (!b) return null;
    const file = JSON.parse(new TextDecoder().decode(b)) as SemantoFile;
    const original_tokens: Record<string, number> = {};
    for (const r of results) original_tokens[r.page_id] = r.original_tokens;
    return { file, original_tokens, signed_at: row.signed_at };
  }

  async latestVersion(trooth_id: string): Promise<VersionHead | null> {
    const row = await this.db
      .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(trooth_id)
      .first<VersionRow>();
    return row ? this.readStored(trooth_id, row) : null;
  }

  async getVersion(trooth_id: string, version: number): Promise<VersionHead | null> {
    const row = await selectVersion(this.db, trooth_id, version);
    return row ? this.readStored(trooth_id, row) : null;
  }

  async saveBuilt(trooth_id: string, v: StoredVersion, files: VersionFiles): Promise<void> {
    const n = v.file.header.version;
    for (const [id, body] of Object.entries(v.bodies)) await r2Put(this.store, r2Key.page(trooth_id, n, id), body, "text/markdown; charset=utf-8");
    await this.writeVersion(trooth_id, v.file, files, v.original_tokens);
  }

  /** A streamed build: the page bodies are in R2 already (putBody); write the file, the derived files and the rows. */
  async saveAssembled(trooth_id: string, file: SemantoFile, files: VersionFiles): Promise<void> {
    await this.writeVersion(trooth_id, file, files, {});
  }

  async putBody(trooth_id: string, version: number, page_id: string, bytes: Uint8Array): Promise<void> {
    await r2Put(this.store, r2Key.page(trooth_id, version, page_id), bytes, "text/markdown; charset=utf-8");
  }

  getBody(trooth_id: string, version: number, page_id: string): Promise<Uint8Array | null> {
    return r2Bytes(this.store, r2Key.page(trooth_id, version, page_id));
  }

  private async writeVersion(trooth_id: string, f: SemantoFile, files: VersionFiles, original_tokens: Record<string, number>): Promise<void> {
    const h = f.header;
    const n = h.version;
    await Promise.all([
      r2Put(this.store, r2Key.file(trooth_id, n), JSON.stringify(f), "application/json"),
      r2Put(this.store, r2Key.llms(trooth_id, n), files.llms.llmsTxt, "text/markdown; charset=utf-8"),
      files.llms.llmsFull !== null ? r2Put(this.store, r2Key.llmsFull(trooth_id, n), files.llms.llmsFull, "text/markdown; charset=utf-8") : Promise.resolve(),
      r2Put(this.store, r2Key.sitemap(trooth_id, n), files.llms.sitemapMd, "text/markdown; charset=utf-8"),
      r2Put(this.store, r2Key.jsonld(trooth_id, n), files.jsonld, "application/ld+json"),
    ]);
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
          .bind(trooth_id, n, p.id, p.url, p.title, p.hash, p.source_hash, p.bytes, p.tokens, original_tokens[p.id] ?? p.original_tokens ?? 0, p.witnessed_at, p.lang ?? null, p.part?.n ?? null, p.part?.of ?? null, p.status, p.index.noindex ? 1 : 0, p.index.nosnippet ? 1 : 0, p.index.canonical, p.index.robots_blocked ? 1 : 0, i),
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
    // D1 batches of 100 statements: the version row goes first, so pages and facts never point at a missing version.
    for (let i = 0; i < statements.length; i += 100) await this.db.batch(statements.slice(i, i + 100));
  }

  async markWitnessed(trooth_id: string, file: SemantoFile, witnessed_at: string): Promise<void> {
    const n = file.header.version;
    await r2Put(this.store, r2Key.file(trooth_id, n), JSON.stringify(file), "application/json");
    await this.db.batch([
      this.db
        .prepare(`UPDATE semanto_versions SET witness_jws = ?3, witness_kid = ?4, witnessed_at = ?5 WHERE trooth_id = ?1 AND version = ?2 AND state = 'read'`)
        .bind(trooth_id, n, file.witness?.jws ?? null, file.witness?.kid ?? null, witnessed_at),
      this.db.prepare(`UPDATE semanto_companies SET basic_version = ?2, updated_at = ?3 WHERE trooth_id = ?1`).bind(trooth_id, n, witnessed_at),
    ]);
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
    const { results } = await this.db.prepare(`SELECT url, etag, last_modified, raw_hash, lastmod, checked_at, prev_change_at FROM semanto_change_state WHERE trooth_id = ?1`).bind(trooth_id).all<ChangeRow & { url: string }>();
    const out: Record<string, ChangeRow> = {};
    for (const r of results) out[r.url] = { etag: r.etag, last_modified: r.last_modified, raw_hash: r.raw_hash, lastmod: r.lastmod ?? null, checked_at: r.checked_at, prev_change_at: r.prev_change_at ?? null };
    return out;
  }

  private changeStateStatement(trooth_id: string, url: string, row: ChangeRow): D1PreparedStatement {
    // prev_change_at survives a write that does not carry one (a build's rows), so a live page stays live.
    return this.db
      .prepare(
        `INSERT INTO semanto_change_state (trooth_id, url, etag, last_modified, raw_hash, lastmod, checked_at, prev_change_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(trooth_id, url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, raw_hash = excluded.raw_hash, lastmod = excluded.lastmod, checked_at = excluded.checked_at, prev_change_at = COALESCE(excluded.prev_change_at, semanto_change_state.prev_change_at)`,
      )
      .bind(trooth_id, url, row.etag, row.last_modified, row.raw_hash, row.lastmod ?? null, row.checked_at, row.prev_change_at ?? null);
  }
  async putChangeState(trooth_id: string, url: string, row: ChangeRow): Promise<void> {
    await this.changeStateStatement(trooth_id, url, row).run();
  }
  /** Every page's row after a build, 100 statements to a batch instead of one round trip each. */
  async putChangeStates(trooth_id: string, rows: (ChangeRow & { url: string })[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 100) await this.db.batch(rows.slice(i, i + 100).map((r) => this.changeStateStatement(trooth_id, r.url, r)));
  }

  async authorizations(trooth_id: string, root_hash: string): Promise<Authorization[]> {
    const { results } = await this.db.prepare(`SELECT record_json, at, root_hash, passkey_json FROM semanto_authorizations WHERE trooth_id = ?1 AND root_hash = ?2 ORDER BY at`).bind(trooth_id, root_hash).all<{ record_json: string; at: string; root_hash: string; passkey_json: string | null }>();
    return results.map((r) => ({ record: JSON.parse(r.record_json) as Authorization["record"], at: r.at, root_hash: r.root_hash, ...(r.passkey_json ? { passkey: JSON.parse(r.passkey_json) as NonNullable<Authorization["passkey"]> } : {}) }));
  }

  async addAuthorization(trooth_id: string, a: Authorization): Promise<void> {
    // A later approval with a passkey assertion replaces an earlier one without; one without never replaces one with.
    await this.db
      .prepare(
        `INSERT INTO semanto_authorizations (trooth_id, root_hash, subject, record_json, at, passkey_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(trooth_id, root_hash, subject) DO UPDATE SET record_json = excluded.record_json, at = excluded.at, passkey_json = excluded.passkey_json WHERE excluded.passkey_json IS NOT NULL`,
      )
      .bind(trooth_id, a.root_hash, a.record.subject, JSON.stringify(a.record), a.at, a.passkey ? JSON.stringify(a.passkey) : null)
      .run();
  }

  async clearAuthorizations(trooth_id: string, root_hash: string): Promise<void> {
    await this.db.prepare(`DELETE FROM semanto_authorizations WHERE trooth_id = ?1 AND root_hash = ?2`).bind(trooth_id, root_hash).run();
  }

  async passkeyUser(user_id: string): Promise<PasskeyUser | null> {
    return await this.db.prepare(`SELECT user_id, handle, created_at FROM semanto_passkey_users WHERE user_id = ?1`).bind(user_id).first<PasskeyUser>();
  }

  async putPasskeyUser(u: PasskeyUser): Promise<PasskeyUser> {
    await this.db.prepare(`INSERT OR IGNORE INTO semanto_passkey_users (user_id, handle, created_at) VALUES (?1, ?2, ?3)`).bind(u.user_id, u.handle, u.created_at).run();
    return (await this.passkeyUser(u.user_id)) ?? u;
  }

  async passkeys(user_id: string): Promise<StoredPasskey[]> {
    const { results } = await this.db.prepare(`SELECT * FROM semanto_passkeys WHERE user_id = ?1 ORDER BY created_at, credential_id`).bind(user_id).all<PasskeyRow>();
    return results.map(passkeyFromRow);
  }

  async getPasskey(credential_id: string): Promise<StoredPasskey | null> {
    const r = await this.db.prepare(`SELECT * FROM semanto_passkeys WHERE credential_id = ?1`).bind(credential_id).first<PasskeyRow>();
    return r ? passkeyFromRow(r) : null;
  }

  async putPasskey(p: StoredPasskey): Promise<void> {
    // No OR IGNORE and no upsert: a credential id already on file is a constraint error, never a replacement.
    await this.db
      .prepare(
        `INSERT INTO semanto_passkeys (credential_id, user_id, trooth_id, public_jwk, alg, sign_count, transports, backup_eligible, backed_up, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(p.credential_id, p.user_id, p.trooth_id, JSON.stringify(p.public_jwk), p.alg, p.sign_count, JSON.stringify(p.transports), p.backup_eligible ? 1 : 0, p.backed_up ? 1 : 0, p.created_at, p.last_used_at)
      .run();
  }

  async touchPasskey(credential_id: string, sign_count: number, backed_up: boolean, at: string): Promise<boolean> {
    // One conditional statement: the count only moves forward (or stays at zero for a counter-less authenticator).
    // RETURNING tells whether a row changed; no row means another assertion at this count was used first.
    const r = await this.db
      .prepare(`UPDATE semanto_passkeys SET sign_count = ?2, backed_up = ?3, last_used_at = ?4 WHERE credential_id = ?1 AND (sign_count < ?2 OR (sign_count = 0 AND ?2 = 0)) RETURNING credential_id`)
      .bind(credential_id, sign_count, backed_up ? 1 : 0, at)
      .first<{ credential_id: string }>();
    return r !== null;
  }

  async putPasskeyChallenge(c: PasskeyChallenge): Promise<void> {
    // Expired challenges are swept on the way in, so the table stays small.
    await this.db.batch([
      this.db.prepare(`DELETE FROM semanto_webauthn_challenges WHERE expires_at < ?1`).bind(c.created_at),
      this.db
        .prepare(`INSERT INTO semanto_webauthn_challenges (challenge, kind, trooth_id, user_id, version, root_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(c.challenge, c.kind, c.trooth_id, c.user_id, c.version, c.root_hash, c.created_at, c.expires_at),
    ]);
  }

  async takePasskeyChallenge(challenge: string, kind: PasskeyChallenge["kind"], trooth_id: string, user_id: string): Promise<PasskeyChallenge | null> {
    // One statement: the row is removed and answered at once, so two requests cannot both use it.
    return await this.db
      .prepare(`DELETE FROM semanto_webauthn_challenges WHERE challenge = ?1 AND kind = ?2 AND trooth_id = ?3 AND user_id = ?4 RETURNING challenge, kind, trooth_id, user_id, version, root_hash, created_at, expires_at`)
      .bind(challenge, kind, trooth_id, user_id)
      .first<PasskeyChallenge>();
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
    const { results } = await this.db.prepare(`SELECT kid, public_jwk, custody, nbf, exp, revoked_at, created_at, pending FROM semanto_keys WHERE trooth_id = ?1 ORDER BY created_at`).bind(trooth_id).all<KeyRow & { created_at: string; pending: number }>();
    return results.map((r) => {
      const jwk = JSON.parse(r.public_jwk) as PublicJwk;
      return { public_jwk: { ...jwk, ...(r.nbf ? { nbf: r.nbf } : {}), ...(r.exp ? { exp: r.exp } : {}), ...(r.revoked_at ? { revoked_at: r.revoked_at } : {}) }, custody: r.custody, created_at: r.created_at, ...(r.pending ? { next: true } : {}) };
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
        `INSERT INTO semanto_keys (kid, trooth_id, public_jwk, custody, nbf, exp, revoked_at, created_at, pending) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(kid) DO UPDATE SET public_jwk = excluded.public_jwk, nbf = excluded.nbf, exp = excluded.exp, revoked_at = excluded.revoked_at, pending = excluded.pending`,
      )
      .bind(key.public_jwk.kid, trooth_id, JSON.stringify(pub), key.custody, nbf ?? null, exp ?? null, revoked_at ?? null, key.created_at, key.next ? 1 : 0)
      .run();
  }

  async connectorKeys(trooth_id: string): Promise<PublicJwk[]> {
    const { results } = await this.db.prepare(`SELECT public_jwk FROM semanto_connector_keys WHERE trooth_id = ?1 AND revoked_at IS NULL`).bind(trooth_id).all<{ public_jwk: string }>();
    return results.map((r) => JSON.parse(r.public_jwk) as PublicJwk);
  }

  async ownerUserId(trooth_id: string): Promise<string | null> {
    const r = await this.db.prepare(`SELECT os_owner_user_id FROM semanto_companies WHERE trooth_id = ?1`).bind(trooth_id).first<{ os_owner_user_id: string | null }>();
    return r?.os_owner_user_id ?? null;
  }

  async registerOwner(trooth_id: string, user_id: string): Promise<void> {
    await this.db.prepare(`UPDATE semanto_companies SET os_owner_user_id = ?2 WHERE trooth_id = ?1 AND os_owner_user_id IS NULL`).bind(trooth_id, user_id).run();
  }

  /** Insert only: a kid on file (any company, revoked or not) is never replaced, so a race can neither move a key to another company nor clear its revocation. */
  async putConnectorKey(trooth_id: string, jwk: PublicJwk, source: string, created_at: string, label: string | null = null): Promise<boolean> {
    const r = await this.db
      .prepare(`INSERT INTO semanto_connector_keys (kid, trooth_id, public_jwk, source, created_at, revoked_at, label) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6) ON CONFLICT(kid) DO NOTHING RETURNING kid`)
      .bind(jwk.kid, trooth_id, JSON.stringify(jwk), source, created_at, label)
      .first<{ kid: string }>();
    return r !== null;
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

  async gapReportsSince(trooth_id: string, since: string): Promise<{ kind: string; ran_at: string }[]> {
    const { results } = await this.db.prepare(`SELECT kind, ran_at FROM semanto_gap_reports WHERE trooth_id = ?1 AND ran_at >= ?2 ORDER BY ran_at`).bind(trooth_id, since).all<{ kind: string; ran_at: string }>();
    return results;
  }

  async latestGapReport(trooth_id: string): Promise<GapReport | null> {
    const r = await this.db.prepare(`SELECT report_json FROM semanto_gap_reports WHERE trooth_id = ?1 ORDER BY ran_at DESC LIMIT 1`).bind(trooth_id).first<{ report_json: string }>();
    return r ? (JSON.parse(r.report_json) as GapReport) : null;
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
      .prepare(`INSERT OR REPLACE INTO semanto_first_publications (trooth_id, record_id, url, content_hash, witnessed_at, jws, log_index, record_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(r.record.trooth_id, r.record.id, r.record.url, r.record.content_hash, r.record.witnessed_at, r.jws, r.log?.index ?? null, JSON.stringify(r))
      .run();
  }

  async getFirstPublication(record_id: string): Promise<FirstPublicationRecord | null> {
    const row = await this.db.prepare(`SELECT record_json FROM semanto_first_publications WHERE record_id = ?1`).bind(record_id).first<{ record_json: string | null }>();
    return row?.record_json ? (JSON.parse(row.record_json) as FirstPublicationRecord) : null;
  }

  getCompanyByDomain(domain: string): Promise<CompanyRecord | null> {
    return selectCompanyByDomain(this.db, domain);
  }

  getCompanyByOsCompany(os_company_id: string): Promise<CompanyRecord | null> {
    return selectCompanyByOsCompany(this.db, os_company_id);
  }

  async linkOsCompany(trooth_id: string, os_company_id: string): Promise<void> {
    await this.db.prepare(`UPDATE semanto_companies SET os_company_id = ?2, updated_at = ?3 WHERE trooth_id = ?1 AND os_company_id IS NULL`).bind(trooth_id, os_company_id, new Date().toISOString()).run();
  }

  async markDomainProven(trooth_id: string, at: string, method: ProofMethod): Promise<void> {
    await this.db.prepare(`UPDATE semanto_companies SET domain_proven_at = ?2, domain_proof_method = ?3, updated_at = ?2 WHERE trooth_id = ?1 AND domain_proven_at IS NULL`).bind(trooth_id, at, method).run();
  }

  async getSetup(trooth_id: string): Promise<SetupRecord | null> {
    const r = await this.db.prepare(`SELECT state_json FROM semanto_setup WHERE trooth_id = ?1`).bind(trooth_id).first<{ state_json: string }>();
    return r ? (JSON.parse(r.state_json) as SetupRecord) : null;
  }

  async putSetup(record: SetupRecord): Promise<void> {
    await this.db
      .prepare(`INSERT INTO semanto_setup (trooth_id, state_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(trooth_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .bind(record.trooth_id, JSON.stringify(record), new Date().toISOString())
      .run();
  }

  async latestFile(trooth_id: string): Promise<{ file: SemantoFile; signed_at: string | null } | null> {
    const row = await this.db
      .prepare(`SELECT trooth_id, version, state, built_at, signed_at, withdrawn_at, root_hash, page_count, fact_count, ledger_index FROM semanto_versions WHERE trooth_id = ?1 ORDER BY version DESC LIMIT 1`)
      .bind(trooth_id)
      .first<VersionRow>();
    if (!row) return null;
    const file = await this.getFile(trooth_id, row.version);
    return file ? { file, signed_at: row.signed_at } : null;
  }

  async getFile(trooth_id: string, version: number): Promise<SemantoFile | null> {
    const b = await r2Bytes(this.store, r2Key.file(trooth_id, version));
    return b ? (JSON.parse(new TextDecoder().decode(b)) as SemantoFile) : null;
  }

  async withdrawVersion(trooth_id: string, version: number, at: string): Promise<void> {
    const file = await this.getFile(trooth_id, version);
    if (!file) throw new Error(`withdrawVersion: no version ${version} for ${trooth_id}`);
    await r2Put(this.store, r2Key.file(trooth_id, version), JSON.stringify({ ...file, header: { ...file.header, state: "withdrawn" } }), "application/json");
    await this.db.batch([
      this.db.prepare(`UPDATE semanto_versions SET state = 'withdrawn', withdrawn_at = ?3 WHERE trooth_id = ?1 AND version = ?2`).bind(trooth_id, version, at),
      // The newest earlier signed version that is not withdrawn becomes current, or none.
      this.db
        .prepare(
          `UPDATE semanto_companies SET current_version = (SELECT MAX(v.version) FROM semanto_versions v WHERE v.trooth_id = ?1 AND v.version < ?2 AND v.state = 'signed'), updated_at = ?3
           WHERE trooth_id = ?1 AND current_version = ?2`,
        )
        .bind(trooth_id, version, at),
      this.db.prepare(`UPDATE semanto_companies SET basic_version = NULL, updated_at = ?3 WHERE trooth_id = ?1 AND basic_version = ?2`).bind(trooth_id, version, at),
    ]);
  }

  async putRevocation(trooth_id: string, entry: RevocationEntry, log_index: number): Promise<void> {
    await this.db.prepare(`INSERT INTO semanto_revocations (trooth_id, kind, ref, reason, revoked_at, log_index) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(trooth_id, entry.kind, entry.ref, entry.reason, entry.revoked_at, log_index).run();
  }

  async getRevocationList(trooth_id: string | null): Promise<{ jws: string; issued_at: string } | null> {
    const q =
      trooth_id === null
        ? this.db.prepare(`SELECT jws, issued_at FROM semanto_revocation_lists WHERE trooth_id IS NULL ORDER BY id DESC LIMIT 1`)
        : this.db.prepare(`SELECT jws, issued_at FROM semanto_revocation_lists WHERE trooth_id = ?1 ORDER BY id DESC LIMIT 1`).bind(trooth_id);
    return q.first<{ jws: string; issued_at: string }>();
  }

  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await r2Put(this.store, key, bytes, contentType);
  }

  async eraseCompany(trooth_id: string): Promise<{ rows: number; objects: number }> {
    let objects = 0;
    const builds = await this.db.prepare("SELECT build_id FROM semanto_builds WHERE trooth_id = ?1").bind(trooth_id).all<{ build_id: string }>();
    const buildIds = builds.results.map((b) => b.build_id);
    for (const id of buildIds) objects += await r2DeletePrefix(this.store, `semanto/builds/${id}/`);
    objects += await r2DeletePrefix(this.store, `semanto/${trooth_id}/`);
    // The sealed private keys: once these go, nothing signed with them can be signed again (crypto-shredding).
    objects += await r2DeletePrefix(this.store, `keys/${trooth_id}/`);
    const statements: D1PreparedStatement[] = [];
    for (const id of buildIds) for (const t of ERASE_BUILD_TABLES) statements.push(this.db.prepare(`DELETE FROM ${t} WHERE build_id = ?1`).bind(id));
    for (const t of ERASE_COMPANY_TABLES) statements.push(this.db.prepare(`DELETE FROM ${t} WHERE trooth_id = ?1`).bind(trooth_id));
    let rows = 0;
    for (let i = 0; i < statements.length; i += 50) {
      const res = await this.db.batch(statements.slice(i, i + 50));
      for (const r of res) rows += r.meta?.changes ?? 0;
    }
    return { rows, objects };
  }
}

/**
 * The tables an erasure empties for a company, children before parents. Kept: semanto_log (the append-only
 * transparency log; deleting a leaf would break every later proof), semanto_revocations and
 * semanto_revocation_lists (ids and hashes, so copies elsewhere still check as revoked). test/erasure.test.ts
 * holds this list against the migrations: a new table with trooth_id must be named here or in ERASE_KEPT.
 */
export const ERASE_COMPANY_TABLES = [
  "semanto_writeback_items",
  "semanto_writeback_runs",
  "semanto_recall_events",
  "semanto_seller_lists",
  "semanto_credentials",
  "semanto_connect_sessions",
  "semanto_google_connections",
  "semanto_google_states",
  "semanto_alert_addresses",
  "semanto_key_rotations",
  "semanto_audit",
  "semanto_webauthn_challenges",
  "semanto_passkeys",
  "semanto_builds",
  "semanto_setup",
  "semanto_basic",
  "semanto_connector_keys",
  "semanto_pending_signatures",
  "semanto_authorizations",
  "semanto_company_config",
  "semanto_change_state",
  "semanto_first_publications",
  "semanto_gap_reports",
  "semanto_recalls",
  "semanto_sellers",
  "semanto_offers",
  "semanto_products",
  "semanto_alerts",
  "semanto_monitor_runs",
  "semanto_read_receipts",
  "semanto_host_detection",
  "semanto_settings",
  "semanto_facts",
  "semanto_pages",
  "semanto_versions",
  "semanto_keys",
  "semanto_companies",
] as const;
export const ERASE_BUILD_TABLES = ["semanto_build_fetched", "semanto_build_items", "semanto_build_rendered"] as const;
export const ERASE_KEPT = ["semanto_log", "semanto_revocations", "semanto_revocation_lists"] as const;

/** Delete every object under a prefix, 1000 at a time; returns how many went. */
async function r2DeletePrefix(store: R2Bucket, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await store.delete(keys);
    n += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

// ------------------------------------------------------------ a build in queue messages (src/compiler/stream.ts)

interface BuildDbRow {
  build_id: string;
  trooth_id: string;
  version: number;
  reason: string;
  held: number;
  status: BuildRow["status"];
  job_json: string;
  found: number;
  fetched: number;
  planned: number;
  rendered: number;
  state_json: string | null;
  error: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  checked?: number | null;
  rendering_started_at?: string | null;
}

const toBuild = (r: BuildDbRow): BuildRow => ({
  build_id: r.build_id,
  trooth_id: r.trooth_id,
  version: r.version,
  reason: r.reason,
  held: r.held === 1,
  status: r.status,
  job: JSON.parse(r.job_json) as BuildRow["job"],
  found: r.found,
  fetched: r.fetched,
  planned: r.planned,
  rendered: r.rendered,
  state: r.state_json ? (JSON.parse(r.state_json) as BuildRow["state"]) : null,
  error: r.error,
  requested_at: r.requested_at,
  started_at: r.started_at,
  finished_at: r.finished_at,
  checked: r.checked ?? 0,
  rendering_started_at: r.rendering_started_at ?? null,
});

/** Build staging over D1 rows (migrations/0005_audit_fixes.sql) and R2 bodies under semanto/builds/<build_id>/. */
export class D1BuildStaging implements BuildStagingPort {
  constructor(
    private db: D1Database,
    private store: R2Bucket,
  ) {}
  async createBuild(b: BuildRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO semanto_builds (build_id, trooth_id, version, reason, held, status, job_json, found, fetched, planned, rendered, state_json, error, requested_at, started_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .bind(b.build_id, b.trooth_id, b.version, b.reason, b.held ? 1 : 0, b.status, JSON.stringify(b.job), b.found, b.fetched, b.planned, b.rendered, b.state ? JSON.stringify(b.state) : null, b.error, b.requested_at, b.started_at, b.finished_at)
      .run();
  }
  async getBuild(build_id: string): Promise<BuildRow | null> {
    const r = await this.db.prepare(`SELECT * FROM semanto_builds WHERE build_id = ?1`).bind(build_id).first<BuildDbRow>();
    return r ? toBuild(r) : null;
  }
  async updateBuild(build_id: string, patch: Partial<Omit<BuildRow, "build_id" | "trooth_id" | "job">>): Promise<void> {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      cols.push(`${col} = ?${vals.length + 2}`);
      vals.push(v);
    };
    if (patch.version !== undefined) set("version", patch.version);
    if (patch.reason !== undefined) set("reason", patch.reason);
    if (patch.held !== undefined) set("held", patch.held ? 1 : 0);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.found !== undefined) set("found", patch.found);
    if (patch.fetched !== undefined) set("fetched", patch.fetched);
    if (patch.planned !== undefined) set("planned", patch.planned);
    if (patch.rendered !== undefined) set("rendered", patch.rendered);
    if (patch.state !== undefined) set("state_json", patch.state ? JSON.stringify(patch.state) : null);
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.requested_at !== undefined) set("requested_at", patch.requested_at);
    if (patch.started_at !== undefined) set("started_at", patch.started_at);
    if (patch.finished_at !== undefined) set("finished_at", patch.finished_at);
    if (patch.checked !== undefined) set("checked", patch.checked);
    if (patch.rendering_started_at !== undefined) set("rendering_started_at", patch.rendering_started_at);
    if (!cols.length) return;
    await this.db.prepare(`UPDATE semanto_builds SET ${cols.join(", ")} WHERE build_id = ?1`).bind(build_id, ...vals).run();
  }
  async latestBuild(trooth_id: string): Promise<BuildRow | null> {
    const r = await this.db.prepare(`SELECT * FROM semanto_builds WHERE trooth_id = ?1 ORDER BY requested_at DESC, rowid DESC LIMIT 1`).bind(trooth_id).first<BuildDbRow>();
    return r ? toBuild(r) : null;
  }
  async putRaw(build_id: string, url: string, bytes: Uint8Array): Promise<string> {
    const key = `semanto/builds/${build_id}/raw/${await digest(url)}`;
    await r2Put(this.store, key, bytes, "text/html");
    return key;
  }
  getRaw(key: string): Promise<Uint8Array | null> {
    return r2Bytes(this.store, key);
  }
  async putFetched(build_id: string, row: StagedFetch): Promise<void> {
    await this.db.prepare(`INSERT OR REPLACE INTO semanto_build_fetched (build_id, url, row_json) VALUES (?1, ?2, ?3)`).bind(build_id, row.url, JSON.stringify(row)).run();
  }
  async listFetched(build_id: string): Promise<StagedFetch[]> {
    const { results } = await this.db.prepare(`SELECT row_json FROM semanto_build_fetched WHERE build_id = ?1`).bind(build_id).all<{ row_json: string }>();
    return results.map((r) => JSON.parse(r.row_json) as StagedFetch);
  }
  async getFetched(build_id: string, url: string): Promise<StagedFetch | null> {
    const r = await this.db.prepare(`SELECT row_json FROM semanto_build_fetched WHERE build_id = ?1 AND url = ?2`).bind(build_id, url).first<{ row_json: string }>();
    return r ? (JSON.parse(r.row_json) as StagedFetch) : null;
  }
  async putItems(build_id: string, items: StagedItem[]): Promise<void> {
    const st = items.map((i) => this.db.prepare(`INSERT OR REPLACE INTO semanto_build_items (build_id, seq, item_json) VALUES (?1, ?2, ?3)`).bind(build_id, i.seq, JSON.stringify(i)));
    for (let k = 0; k < st.length; k += 100) await this.db.batch(st.slice(k, k + 100));
  }
  async itemsSlice(build_id: string, from: number, to: number): Promise<StagedItem[]> {
    const { results } = await this.db.prepare(`SELECT item_json FROM semanto_build_items WHERE build_id = ?1 AND seq >= ?2 AND seq < ?3 ORDER BY seq`).bind(build_id, from, to).all<{ item_json: string }>();
    return results.map((r) => JSON.parse(r.item_json) as StagedItem);
  }
  async putRendered(build_id: string, r: StagedRender): Promise<void> {
    await this.db.prepare(`INSERT OR REPLACE INTO semanto_build_rendered (build_id, seq, row_json) VALUES (?1, ?2, ?3)`).bind(build_id, r.seq, JSON.stringify(r)).run();
  }
  async countRendered(build_id: string): Promise<number> {
    const r = await this.db.prepare(`SELECT count(*) AS n FROM semanto_build_rendered WHERE build_id = ?1`).bind(build_id).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async claimAssemble(build_id: string, nowIso: string, staleMs: number): Promise<boolean> {
    const stale = new Date(Date.parse(nowIso) - staleMs).toISOString();
    const r = await this.db
      .prepare(`UPDATE semanto_builds SET status = 'assembling', assemble_claimed_at = ?2 WHERE build_id = ?1 AND (status = 'rendering' OR (status = 'assembling' AND (assemble_claimed_at IS NULL OR assemble_claimed_at < ?3)))`)
      .bind(build_id, nowIso, stale)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  async listRendered(build_id: string): Promise<StagedRender[]> {
    const { results } = await this.db.prepare(`SELECT row_json FROM semanto_build_rendered WHERE build_id = ?1 ORDER BY seq`).bind(build_id).all<{ row_json: string }>();
    return results.map((r) => JSON.parse(r.row_json) as StagedRender);
  }
  async clear(build_id: string): Promise<void> {
    const fetched = await this.listFetched(build_id);
    const bucket = this.store as R2Bucket & { delete?: (keys: string | string[]) => Promise<void> };
    if (bucket.delete) for (let i = 0; i < fetched.length; i += 1000) await bucket.delete(fetched.slice(i, i + 1000).map((f) => f.raw_key));
    await this.db.batch([
      this.db.prepare(`DELETE FROM semanto_build_fetched WHERE build_id = ?1`).bind(build_id),
      this.db.prepare(`DELETE FROM semanto_build_items WHERE build_id = ?1`).bind(build_id),
      this.db.prepare(`DELETE FROM semanto_build_rendered WHERE build_id = ?1`).bind(build_id),
    ]);
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
  async removeOffers(trooth_id: string, sku: string): Promise<number> {
    const { results } = await this.db.prepare(`DELETE FROM semanto_offers WHERE trooth_id = ?1 AND sku = ?2 RETURNING offer_id`).bind(trooth_id, sku).all<{ offer_id: string }>();
    return results.length;
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
