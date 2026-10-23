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
import type { LogLeaf, StoredTreeHead } from "../ledger/ports";
import type { ProblemCode } from "./errors";
import type { WorkspaceDomainsPort } from "../setup/workspace-domains";

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
  /** Semanto Basic: the version Trooth witnessed (not signed by the company), served while there is no signed version. */
  basic_version?: number | null;
  /**
   * When the company proved control of `domain` (the domain fixed at the
   * claim), or null. Nothing is published, signed, witnessed or served for a
   * company whose domain is not proven.
   */
  domain_proven_at?: string | null;
  /** The worker-f workspace (app_users.company_id) that claimed the company, or null. */
  os_company_id?: string | null;
}

/** Thrown when a route needs Trooth's witness key and the deployment has none (src/core/keys.ts); routes answer a 503 witness_key_missing problem. */
export { WitnessKeyMissingError } from "../core/keys";

/** True when the company proved control of its domain. */
export function isDomainProven(c: Pick<CompanyRecord, "domain_proven_at"> | null | undefined): boolean {
  return typeof c?.domain_proven_at === "string" && c.domain_proven_at.length > 0;
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
  /**
   * The version the public routes serve: the current signed version, or, for
   * a Semanto Basic company with no signed version, its witnessed record
   * (state read, Trooth's witness statement, no company signature). Null when
   * there is neither. A caller that needs a signed version checks
   * header.state === "signed".
   */
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

/** What the public log knows about one leaf: the leaf record itself (src/ledger/ports.ts LogLeaf), its hash and its path. */
export interface LogInclusion {
  log: string;
  index: number;
  tree_size: number;
  /** The leaf record, so a reader recomputes leaf_hash instead of trusting it. */
  leaf: LogLeaf;
  /** The RFC 6962 leaf hash of the canonical leaf record, printed as a digest. */
  leaf_hash: string;
  /** Root of the tree head the path proves against. */
  root_hash: string;
  /** The signed tree head, a compact JWS with typ signed-tree-head over { tree_size, root_hash, signed_at }. */
  tree_head_jws: string;
  inclusion_path: string[];
}

/** GET /public/semanto/log/proof, docs/spec/log.md. */
export interface LogInclusionProof {
  index: number;
  tree_size: number;
  leaf_hash: string;
  root_hash: string;
  path: string[];
}

/** GET /public/semanto/log/consistency, docs/spec/log.md. */
export interface LogConsistencyProof {
  from: number;
  to: number;
  old_root: string;
  new_root: string;
  path: string[];
}

/** The public log as the server reads it. src/serve/ledger-port.ts implements it over src/ledger TransparencyLog. */
export interface LogPort {
  /** Inclusion of leaf `index` against the latest tree head, or null when not yet logged. */
  getInclusion(index: number): Promise<LogInclusion | null>;
  latestTreeHead(): Promise<StoredTreeHead | null>;
  getTreeHead(treeSize: number): Promise<StoredTreeHead | null>;
  /** Inclusion of leaf `index` in the tree of `treeSize` leaves, or null when out of range. */
  inclusion(index: number, treeSize: number): Promise<LogInclusionProof | null>;
  consistency(from: number, to: number): Promise<LogConsistencyProof | null>;
  /** The checkpoint text (signed note) for a size, the latest when omitted. Null when no tree head exists. */
  checkpoint(treeSize?: number): Promise<string | null>;
  leaf(index: number): Promise<{ index: number; leaf: LogLeaf; leaf_hash: string } | null>;
}

export interface KeyPort {
  /** The company's published JWK Set, as served at /.well-known/trooth-keys.json. */
  getCompanyJwks(trooth_id: string): Promise<Jwks>;
  /** The company's hosted private key, or null when custody is with the customer. */
  getCompanySigningKey(trooth_id: string): Promise<PrivateJwk | null>;
  getWitnessKey(): Promise<PrivateJwk>;
  getWitnessPublicKeys(): Promise<Jwks>;
  /** A kid among this company's own keys only. A company signature resolves here and nowhere else. */
  resolveCompany(trooth_id: string, kid: string): Promise<PublicJwk | null>;
  /** A kid among Trooth's keys only. Witness statements, tree heads, checkpoints and revocation lists resolve here and nowhere else. */
  resolveTrooth(kid: string): Promise<PublicJwk | null>;
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
  /** The proven key id, when proof is web_bot_auth. */
  keyid?: string | null;
  read_at: string;
  /** The remote address, handed only to the receipt store, which hashes it with a daily salt and never keeps it (src/readers/receipts.ts). */
  address?: string | null;
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
  /** One queue message: a compile job, a build stage or a per-company fan-out. */
  compile(job: unknown): Promise<void>;
  /** A message that failed its last attempt (it goes to the dead letter queue next). */
  failed?(job: unknown, error: unknown): Promise<void>;
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

// ---------------------------------------------------------------- the workspace (/os) side

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/** Who is calling an /os route, as the workspace session check answered (worker-f, through the TROOTH_OS service binding). */
export interface WorkspaceAuth {
  trooth_id: string;
  role: WorkspaceRole;
  user_id: string;
  name: string;
  /** The workspace's domains on trooth.co, read through worker-f with this caller's credential (src/setup/workspace-domains.ts). Absent outside the TROOTH_OS path. */
  domains?: WorkspaceDomainsPort;
}

/** The workspace actions, each served at POST /os/semanto/{trooth_id}/{action}. */
export const WORKSPACE_ACTIONS = [
  "build",
  "sign",
  "sign/options",
  "passkeys/options",
  "passkeys",
  "gap-report",
  "monitor/run",
  "keys/rotate",
  "lei",
  "basic/claim",
  "basic/prove",
  "first-publication",
  "connectors",
  "withdraw",
  "detect",
  "competitor-report",
  "setup/look-again",
  "setup/read-again",
  "setup/choose",
  "setup/confirm",
  "setup/host",
  "setup/install-check",
  "setup/monitoring",
  "setup/save-for-later",
  "setup/resume",
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

/** What a workspace handler answers; routes.ts signs it and turns a problem into RFC 9457. */
export interface WorkspaceResult {
  status: number;
  body?: unknown;
  /** A body that is not JSON (receipts.csv), with its content type. */
  raw?: { contentType: "text/csv"; text: string };
  problem?: { code: ProblemCode; detail: string };
  /** Extra headers (Basic's Trooth-Record-State, say), set before the response is signed. */
  headers?: Record<string, string>;
}

export interface SignedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

/** A worker-f session before it is mapped to a company: what the claim routes read. */
export interface WorkspaceSession {
  os_company_id: string;
  user_id: string;
  name: string;
  /** worker-f's workspaceRole when it sends one. */
  role: WorkspaceRole | null;
  /** worker-f's app_company_profile slug, when the session answer carries companySlug. */
  company_slug: string | null;
  /** When the person signed in, when the session answer carries signedInAt. */
  signed_in_at: string | null;
  email: string | null;
  /** worker-f's companyName for the workspace, when the session answer carries one: the name Semanto gives the company. */
  company_name?: string | null;
  /** The workspace's domains on trooth.co, read through worker-f with this caller's credential (src/setup/workspace-domains.ts). */
  domains?: WorkspaceDomainsPort;
}

/** The read-only workspace routes (GET), answered by the pipeline. */
export type WorkspaceRead = "setup" | "setup/review" | "keys" | "writeback" | "receipts" | "receipts.csv" | "reports";

/** The pipeline behind the /os routes (src/pipeline.ts). */
export interface WorkspaceHandlers {
  handle(action: WorkspaceAction, ws: WorkspaceAuth, trooth_id: string, input: unknown): Promise<WorkspaceResult>;
  /** GET routes: the setup state, the review document, keys, write-back previews, receipts. */
  read?(what: WorkspaceRead, ws: WorkspaceAuth, trooth_id: string, query: Record<string, string>): Promise<WorkspaceResult>;
  /** The claim routes, for a session with no company yet: POST /os/semanto/claim, POST /os/semanto/setup/start, GET /os/semanto/setup. */
  session?(what: "claim" | "setup/start" | "setup", session: WorkspaceSession, input: unknown): Promise<WorkspaceResult>;
  /** POST /os/semanto/{id}/keys/{kid}/revoke. */
  revokeKey?(ws: WorkspaceAuth, trooth_id: string, kid: string, input: unknown): Promise<WorkspaceResult>;
  /** POST /os/semanto/{trooth_id}/commerce/catalog: authenticated by an RFC 9421 connector signature, not a workspace session. */
  catalog(trooth_id: string, request: SignedRequest): Promise<WorkspaceResult>;
}
