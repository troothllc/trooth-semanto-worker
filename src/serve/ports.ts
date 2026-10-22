// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The ports the serving layer needs from the rest of the platform: where
// signed versions and page bytes come from, how an inclusion proof against the
// public log is fetched, which keys sign responses, and where a read receipt
// goes. Handlers depend on these interfaces only (hexagonal ports and adapters,
// Cockburn 2005). src/serve/memory-ports.ts implements them for tests; the
// coordinator wires the compiler, ledger, identity and readers modules behind
// them at integration.

import type { SemantoFile, PageEntry, Fact } from "../core/semanto";
import type { Jwks, PrivateJwk, PublicJwk } from "../core/keys";
import type { DeliverySettings } from "../settings/delivery";

/** One company row, the subset the server reads. */
export interface CompanyRecord {
  trooth_id: string;
  domain: string;
  org: string;
  tier: "basic" | "full";
  legal_name?: string;
  lei?: string;
  current_version: number | null;
  /** Who holds the signing key. Hosted means Trooth signs responses with the company's key; customer means the witness key signs. */
  custody: "hosted" | "customer";
}

/** A line in the versions list. */
export interface VersionSummary {
  version: number;
  version_id: string;
  state: SemantoFile["header"]["state"];
  built_at: string;
  signed_at: string | null;
  withdrawn_at: string | null;
  root_hash: string;
  page_count: number;
  fact_count: number;
}

/** Whether the live page still matches the last signed bytes. */
export type PageLiveState = "current" | "behind" | "unknown";

export interface StoredPage {
  /** The markdown bytes exactly as signed. */
  bytes: Uint8Array;
  entry: PageEntry;
  /** The version the page belongs to. */
  version: number;
  /** Token estimate of the HTML the page was rendered from, for x-original-tokens. */
  original_tokens: number;
  live: PageLiveState;
}

export interface VersionStore {
  getCompany(trooth_id: string): Promise<CompanyRecord | null>;
  getCompanyByDomain(domain: string): Promise<CompanyRecord | null>;
  /** The current signed version, or null when there is none. */
  getCurrent(trooth_id: string): Promise<SemantoFile | null>;
  getVersion(trooth_id: string, version: number): Promise<SemantoFile | null>;
  listVersions(trooth_id: string): Promise<VersionSummary[]>;
  /** A page of the current signed version by its smp_ id. */
  getPage(trooth_id: string, page_id: string): Promise<StoredPage | null>;
  /** A page of the current signed version by its canonical url. */
  getPageByUrl(trooth_id: string, url: string): Promise<StoredPage | null>;
  getFacts(trooth_id: string): Promise<Fact[] | null>;
  /** The facts.jsonld bytes of the current version. */
  getJsonLd(trooth_id: string): Promise<Uint8Array | null>;
  /** llms.txt, llms-full.txt and sitemap.md bytes of the current version. */
  getLlms(trooth_id: string, kind: "llms" | "llms-full" | "sitemap"): Promise<Uint8Array | null>;
}

/** What the public log knows about one leaf. */
export interface LogInclusion {
  log: string;
  index: number;
  tree_size: number;
  /** The leaf hash as the log computed it (RFC 6962 leaf hash, printed as a digest). */
  leaf_hash: string;
  /** Root of the tree head the path proves against. */
  root_hash: string;
  /** The signed tree head, a compact JWS with typ signed-tree-head over { tree_size, root_hash, signed_at }. */
  tree_head_jws: string;
  inclusion_path: string[];
}

export interface LogPort {
  /** Inclusion of leaf `index` against the latest tree head, or null when not yet logged. */
  getInclusion(index: number): Promise<LogInclusion | null>;
}

export interface KeyPort {
  /** The company's published JWK Set, as served at /.well-known/trooth-keys.json. */
  getCompanyJwks(trooth_id: string): Promise<Jwks>;
  /** The company's hosted private key, or null when custody is with the customer. */
  getCompanySigningKey(trooth_id: string): Promise<PrivateJwk | null>;
  getWitnessKey(): Promise<PrivateJwk>;
  getWitnessPublicKeys(): Promise<Jwks>;
  /** Resolve a kid across the company's keys and Trooth's witness keys. */
  resolve(trooth_id: string | null, kid: string): Promise<PublicJwk | null>;
}

/** What a read receipt records: the representation, the page and whether the reader proved a key directory. Never a user agent string. */
export interface ReceiptInput {
  trooth_id: string;
  version: number | null;
  page_id: string | null;
  representation: "markdown" | "jsonld" | "json";
  /** The Signature-Agent header value, a key directory url, when the request carried one. */
  agent_key_url: string | null;
  proof: "web_bot_auth" | "none";
  read_at: string;
}

export interface ReceiptPort {
  record(input: ReceiptInput): Promise<void>;
}

export interface SettingsPort {
  get(trooth_id: string): Promise<DeliverySettings | null>;
  put(trooth_id: string, settings: DeliverySettings): Promise<void>;
}

/** Background work the scheduled and queue handlers hand to other modules. The coordinator fills these. */
export interface JobPort {
  hourlyChangeDetection(): Promise<void>;
  nightlyCheckpoint(): Promise<void>;
  weeklyGapReports(): Promise<void>;
  compile(job: unknown): Promise<void>;
}

export interface ServeConfig {
  /** https://api.trooth.co/public/semanto */
  public_api_base: string;
  /** https://trooth.co/network/company */
  network_base: string;
  /** https://api.trooth.co/public/semanto/log */
  ledger_url: string;
}

export interface Ports {
  versions: VersionStore;
  log: LogPort;
  keys: KeyPort;
  receipts: ReceiptPort;
  settings: SettingsPort;
  jobs: JobPort;
  config: ServeConfig;
  /** The clock, injectable so tests get stable signatures. */
  now(): Date;
}
