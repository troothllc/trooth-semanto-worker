// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// D1 access for the serving layer: one function per query against
// migrations/0001_semanto.sql, no SQL anywhere else. Page bodies and the
// derived files live in R2 under semanto/<trooth_id>/v<version>/; this file
// reads D1 metadata and the R2 bodies and assembles the port types. The
// SemantoFile itself is stored whole in R2 as semanto.json next to the pages,
// so the server never rebuilds a signed object from rows (what was signed is
// what is served). Follows the Cloudflare D1 client API (prepare, bind, first,
// all, run; docs 2026) and the Workers R2 bindings API.

import type { Fact, SemantoFile } from "../core/semanto";
import { versionId } from "../core/semanto";
import { estimateTokens } from "../core/tokens";
import { digest, digestBytes } from "../core/hash";
import { inclusionProof } from "../core/merkle";
import { toHex } from "../core/encoding";
import { semantoId } from "../core/ids";
import type { Jwks, PrivateJwk, PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";
import { withDefaults } from "../settings/delivery";
import type { CompanyRecord, KeyPort, LogInclusion, LogPort, PageLiveState, ReceiptInput, ReceiptPort, SettingsPort, StoredPage, VersionStore, VersionSummary } from "../serve/ports";
import type { DetectionResult } from "../serve/detect";

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
  treeHead: (tree_size: number) => `log/heads/${tree_size}.jws`,
};

// ------------------------------------------------------------ companies

export async function selectCompany(db: D1Database, trooth_id: string): Promise<CompanyRecord | null> {
  const row = await db
    .prepare(
      `SELECT c.trooth_id, c.domain, c.org, c.tier, c.legal_name, c.lei, c.current_version,
              (SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1) AS custody
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
              (SELECT k.custody FROM semanto_keys k WHERE k.trooth_id = c.trooth_id AND k.revoked_at IS NULL ORDER BY k.created_at DESC LIMIT 1) AS custody
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

// ------------------------------------------------------------ log

interface LogRow {
  idx: number;
  leaf_hash: string;
}
interface TreeHeadRow {
  tree_size: number;
  root_hash: string;
  jws: string;
}

export async function selectLatestTreeHead(db: D1Database): Promise<TreeHeadRow | null> {
  return db.prepare(`SELECT tree_size, root_hash, jws FROM semanto_tree_heads ORDER BY tree_size DESC LIMIT 1`).first<TreeHeadRow>();
}

export async function selectLogLeaves(db: D1Database, tree_size: number): Promise<LogRow[]> {
  const { results } = await db.prepare(`SELECT idx, leaf_hash FROM semanto_log WHERE idx < ?1 ORDER BY idx`).bind(tree_size).all<LogRow>();
  return results;
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
  ) {}
  getCompanyJwks(trooth_id: string): Promise<Jwks> {
    return selectCompanyKeys(this.db, trooth_id);
  }
  async getCompanySigningKey(trooth_id: string): Promise<PrivateJwk | null> {
    // The identity module owns key custody and encryption at rest. Until it is
    // wired, no hosted private key is read and responses are witness-signed.
    const kid = await selectHostedKid(this.db, trooth_id);
    if (!kid) return null;
    const b = await r2Bytes(this.store, r2Key.hostedKey(trooth_id, kid));
    if (!b) return null;
    try {
      const jwk = JSON.parse(new TextDecoder().decode(b)) as PrivateJwk;
      return jwk.d ? jwk : null;
    } catch {
      return null;
    }
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

export class D1Log implements LogPort {
  constructor(private db: D1Database, private logUrl: string) {}
  async getInclusion(index: number): Promise<LogInclusion | null> {
    // The ledger module computes paths from its tiles. This skeleton reads the
    // rows and leaves the path to the ledger's own function once wired.
    const head = await selectLatestTreeHead(this.db);
    if (!head || index >= head.tree_size) return null;
    const leaves = await selectLogLeaves(this.db, head.tree_size);
    const leaf = leaves.find((l) => l.idx === index);
    if (!leaf) return null;
    const path = (await inclusionProof(leaves.map((l) => digestBytes(l.leaf_hash)), index)).map((p) => `sha256:${toHex(p)}`);
    return { log: this.logUrl, index, tree_size: head.tree_size, leaf_hash: leaf.leaf_hash, root_hash: head.root_hash, tree_head_jws: head.jws, inclusion_path: path };
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
