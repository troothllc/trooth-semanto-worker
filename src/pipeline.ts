// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The pipeline: the modules wired into one flow, behind the ports.
//
//   compile    src/compiler discover, fetch and build (incremental when a
//              previous version exists); bodies and metadata stored; state read
//   sign       hosted custody signs with the company key (src/identity/keys.ts)
//              only after a fresh passkey assertion for the exact version and
//              root hash (W3C WebAuthn Level 3, 7.2; src/pipeline-passkeys.ts);
//              customer custody gets the exact signing input and returns the
//              signature, which is assembled and checked; the two-officer rule
//              (src/identity/roles.ts) applies when the company asks for it;
//              then Trooth's witness statement, the semanto_version and
//              witness leaves in the public log (src/ledger), the signed tree
//              head, an RFC 3161 timestamp when a TSA is configured; state
//              signed
//   workspace  build, gap report (src/gap), monitor run (src/monitor), key
//              rotation, LEI lookup (src/identity/lei.ts), Basic claim and
//              proof (src/basic/tier.ts), first publication
//              (src/basic/first-publication.ts), connector keys
//   catalog    a commerce connector's signed catalog (RFC 9421, tag
//              trooth-connector) becomes signed product records and offers
//              (src/commerce)
//   scheduled  hourly change detection, nightly tree head, timestamp and
//              revocation list, weekly gap reports
//   readers    Web Bot Auth (src/readers/webbotauth.ts) behind the receipt
//              middleware and read receipts stored through src/readers/receipts.ts
//   authorize  workspace sessions checked by worker-f through the TROOTH_OS
//              service binding; denied by default
//
// Every step returns plain values; the Worker entry (src/index.ts) builds the
// D1, R2, KV and fetch ports and hands them in. Nothing here judges a company:
// it builds, signs, witnesses, logs and compares.

import type { CompaniesMessage, CompileJob, QueueMessage, StageMessage } from "./env";
import { utf8, fromBase64Url } from "./core/encoding";
import { canonicalize } from "./core/canonical";
import { digest } from "./core/hash";
import { estimateTokens } from "./core/tokens";
import { JWS_TYPES, signObject } from "./core/jws";
import { importPrivate, sign as rawSign, toPublic, WitnessKeyMissingError, type PrivateJwk, type PublicJwk } from "./core/keys";
import { parseSignatureInput, verifyContentDigest, verifyMessage } from "./core/httpsig";
import { factsRoot, rootHash, tierHash, versionId, type Fact, type Identity, type SemantoFile, type SemantoHeader } from "./core/semanto";
import { Fetcher, ChangeDetector, contentHash, type FetcherOptions } from "./compiler/fetch";
import { generateJsonLd } from "./compiler/jsonld";
import { extract } from "./compiler/extract";
import { registrableDomain } from "./compiler/url";
import { MemoryBuildStaging, runAssemble, runDiscover, runRender, type AssembledBuild, type BuildJob, type BuildRow, type BuildStagingPort, type StreamDeps } from "./compiler/stream";
import type { HttpPort as SiteHttpPort, Resolver } from "./compiler/ports";
import { assembleJws, acceptCustomerPublicKey, bindingStatus, checkAssembledJws, createHostedKey, currentKey, jwksUrl, revokeKey as revokeKeyJwk, rotateHostedKey, versionSigningInput, ROTATION_OVERLAP_MS } from "./identity/keys";
import { mayBeSigned, roleFromWorkspace, type PasskeyApproval } from "./identity/roles";
import { compareLegalName, leiFacts, lookupLei } from "./identity/lei";
import { dohDns, type HttpPort as IdentityHttpPort } from "./identity/ports";
import { treeHeadId, type LogStore } from "./ledger/log";
import type { LogLeaf } from "./ledger/ports";
import { timestampTreeHead } from "./ledger/timestamp";
import type { FetchPort as LedgerFetchPort } from "./ledger/ports";
import { keyState, revocationLeaf, signRevocationList, type RevocationEntry } from "./ledger/revocation";
import { type WebBotAuthDeps, type WebBotAuthResult } from "./readers/webbotauth";
import { proveReader, type ForwardingContext, type ReaderProof } from "./readers/forwarded";
import { dashboardRows, dayBounds, receiptsCsv, recordRead, signDailyDigest, utcDay, RECEIPT_PRUNE_LIMIT, RECEIPT_RETENTION_DAYS } from "./readers/receipts";
import type { NonceStore, ReceiptStore } from "./readers/ports";
import { runMonitor, type AvailableSurfaces } from "./monitor/run";
import { jsonLdBlocks } from "./monitor/html";
import type { ClockPort, EmailPort, FetchPort as MonitorFetchPort, StorePort as MonitorStorePort, TokenPort } from "./monitor/ports";
import type { Offer as MonitorOffer, Product as MonitorProduct, SignedRecord } from "./monitor/types";
import { allPayloads, type WritebackContext } from "./monitor/writeback";
import { questionsFor, type QuestionKind, type QuestionParams } from "./gap/prompts";
import type { ProviderAdapter } from "./gap/providers";
import { renderGapReportMarkdown, runGapReport, WEEKLY_RUN } from "./gap/report";
import { buildCompetitorView, MAX_COMPETITORS, renderCompetitorMarkdown, runCompetitorQuestions } from "./gap/competitor";
import { basicHeaders, basicResponse, cleanDomain, SETUP_STEPS, type BasicCompany } from "./basic/tier";
import { createFirstPublication, exportDisputeStatement } from "./basic/first-publication";
import { checkContentSignalsDrift } from "./basic/content-signals";
import { formatMinor, parseMinor, signOffer, type Availability, type OfferInput } from "./commerce/offers";
import { isValidGtin, signProductRecord, type ProductRecordInput, type VariantAxes } from "./commerce/product-record";
import type { CommerceStore } from "./commerce/ports";
import type { FeedCompany } from "./commerce/feeds";
import type { SignedOffer } from "./commerce/offers";
import type { SignedProductRecord } from "./commerce/product-record";
import { DEFAULT_SETTINGS } from "./settings/delivery";
import { detectHost } from "./serve/detect";
import { wellKnownSemanto } from "./serve/represent";
import { isDomainProven, type CompanyRecord, type JobPort, type KeyPort, type ReceiptInput, type ReceiptPort, type ServeConfig, type SettingsPort, type SignedRequest, type VersionStore, type WorkspaceAction, type WorkspaceAuth, type WorkspaceHandlers, type WorkspaceRead, type WorkspaceResult, type WorkspaceRole, type WorkspaceSession } from "./serve/ports";
import type { LedgerLogPort } from "./serve/ledger-port";
import { PROBLEMS, SessionUnavailable, type ProblemCode } from "./serve/errors";
import type { ChangeRow, PipelineStore, VersionHead } from "./pipeline-store";
import { isLivePage } from "./pipeline-store";
import type { SetupDnsPort } from "./setup/ports";
import { DOMAINS_PROOF_HEADER, troothOsWorkspaceDomains } from "./setup/workspace-domains";
import { ensureSetup, syncDomainProof, setupAction, setupAfterBuild, setupReview, setupSession, setupState, stampStep } from "./pipeline-setup";
import { checkSigningAssertion, passkeyOptions, registerPasskey, signOptions } from "./pipeline-passkeys";
import { webauthnConfig, type WebAuthnConfig } from "./identity/webauthn";
export type { WebBotAuthResult };

export const CONNECTOR_TAG = "trooth-connector";
/** The crons fan out one queue message per this many companies. */
export const COMPANIES_PER_MESSAGE = 25;
/** Companies whose revocation lists one queue message re-signs each night (one signature and two writes each). */
export const REVOCATIONS_PER_MESSAGE = 100;
/** The Watch page's Ask now queues a gap report at most once in this window after the newest report. */
export const GAP_ASK_NOW_GAP_MS = 10 * 60 * 1000;
/** The answer while Watch what AI says is off (PipelineDeps.gapReports). */
export const GAP_REPORTS_OFF = "Watch what AI says is not available yet. It will return as a paid feature.";
/** Ask now: at most this many reports per company in any 24 hours, weekly ones included (the spending cap). */
export const GAP_REPORTS_PER_DAY = 6;
/** The most questions one report asks (built-in and the owner's own together): the spending cap per report. */
export const GAP_MAX_QUESTIONS = 40;
/** The most products a shopping report asks about. */
export const GAP_MAX_PRODUCTS = 10;

/** A source outside Trooth (a registry, the company's site, a provider) gave no usable answer. */
export class UpstreamError extends Error {}
/** The largest catalog the connector route reads; a larger body is a 413 problem. */
export const CATALOG_MAX_BYTES = 5 * 1024 * 1024;
/** What the dashboard and the sign answer say about the two-officer rule while workspaces have one account. */
export const TWO_OFFICER_NOTE =
  "Two-officer signing needs two different people with their own accounts. Your workspace has one account today, so a version cannot be signed until a second person joins (team seats). Turn two-officer signing off in Settings to sign with one approval.";
export const CONNECTOR_COMPONENTS = ["@method", "@target-uri", "content-digest", "content-type"] as const;
/** How old a connector signature may be, the same window Web Bot Auth uses. */
export const CONNECTOR_MAX_AGE_SECONDS = 300;

export interface PipelineDeps {
  store: PipelineStore;
  /** The serving view of the same data: the current signed file and the response keys. */
  versions: VersionStore;
  keys: KeyPort;
  settings: SettingsPort;
  log: LedgerLogPort;
  /** The log's own store, to note an RFC 3161 token on a tree head row. */
  logStore: LogStore;
  commerce: CommerceStore;
  config: ServeConfig;
  now(): Date;
  /** The company's public site, read by the compiler (SSRF guards apply in src/compiler/fetch.ts). */
  site: { http: SiteHttpPort; resolve?: Resolver; fetcher?: FetcherOptions };
  monitor: { fetch: MonitorFetchPort; store: MonitorStorePort; email?: EmailPort; tokens?: TokenPort; from?: string; actionUrl?: string };
  identity: { http: IdentityHttpPort };
  /** RFC 3161 time-stamp authority, when TSA_URL is set. */
  tsa?: { url: string; fetch: LedgerFetchPort };
  /** The gap report's providers (src/gap/providers.ts allAdapters with the Env keys in the Worker). */
  gapAdapters(): ProviderAdapter[];
  /**
   * Watch what AI says (gap reports, the competitor report, Ask now and the weekly job) runs only when this is true.
   * Off in production (src/index.ts) until it returns as a paid feature (founder, 2026-10-29): every report asks paid
   * AI providers, and the platform is free for now. The code stays built and tested.
   */
  gapReports?: boolean;
  /** The compile queue: compile jobs, build stages and the cron fan-out. Without it, they run inline. */
  enqueue?: (job: QueueMessage) => Promise<void>;
  /** False in production: without a queue, a build is refused instead of run inside a request. */
  inlineBuilds?: boolean;
  /** Where a build is kept while it runs (D1 and R2 in the Worker). In memory when absent. */
  staging?: BuildStagingPort;
  /** DNS over HTTPS lookups (host detection reads TXT records through it). Setup has no DNS proof of its own: a domain is proven on trooth.co (src/setup/workspace-domains.ts). */
  setupDns?: SetupDnsPort;
  /** One GET to the company's own site through the SSRF guard: host detection and the install check. */
  siteProbe?: (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array } | null>;
  /** Read receipts, for the digest and the CSV export. */
  receiptStore?: ReceiptStore;
  /** Random bytes, injectable for tests. */
  random?: (n: number) => Uint8Array;
  /** Atomic nonce claims for the connector catalog route (the NonceDO Durable Object in the Worker). */
  nonces?: NonceStore;
  /** Where a failed step's exception goes, with its request id. Never to the client. */
  logError?: (request_id: string, action: string, error: unknown) => void;
  /** The WebAuthn relying party (src/identity/webauthn.ts webauthnConfig): rp id trooth.co and the trooth.co origins by default. */
  webauthn?: WebAuthnConfig;
  /** The last signed request per connector kid on the catalog route (time and result), which the connection test reads (src/os/connectors.ts). */
  connectorSeen?: (kid: string, at: string, result: "ok" | "signature_failed") => Promise<void>;
  /** After a build is stored: the version's images and PDFs, for the credential jobs (src/os/credentials.ts). */
  afterAssembled?: (trooth_id: string, file: SemantoFile) => Promise<void>;
  /** A queue message of a kind the workspace contract owns (writeback, recall_event, credential); attempts is the queue's count. */
  consumeOs?: (message: Record<string, unknown>, attempts: number) => Promise<boolean>;
  /** The same kinds on their last failed attempt. */
  consumeOsFailed?: (message: Record<string, unknown>, e: unknown) => Promise<boolean>;
}

export interface CompileSummary {
  trooth_id: string;
  version: number;
  version_id: string;
  root_hash: string;
  state: "read";
  pages: number;
  facts: number;
  coverage: { found: number; read: number; left_out: { url: string; reason: string }[]; changed: string[]; removed: string[] };
}

const iso = (d: Date) => d.toISOString();
const ok = (status: number, body: unknown, headers?: Record<string, string>): WorkspaceResult => ({ status, body, ...(headers ? { headers } : {}) });
const problem = (code: ProblemCode, detail: string): WorkspaceResult => ({ status: 0, problem: { code, detail } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** Signing, keys, LEI, settings and connectors: owner or admin. */
const mayAdminister = (role: WorkspaceRole) => role === "owner" || role === "admin";
/** Building and running reports: owner, admin or member. A viewer may only read. */
const mayOperate = (role: WorkspaceRole) => role === "owner" || role === "admin" || role === "member";
const VIEWER_ONLY = "A workspace viewer can read but cannot start a build or a report. Ask an owner, admin or member.";

/** Re-hash a file after facts or header fields change: facts_root, the facts tier and root_hash follow src/core/semanto.ts. */
export async function rehashFile(file: SemantoFile, changes: { facts?: Fact[]; identity?: Partial<Identity> }): Promise<SemantoFile> {
  const facts = changes.facts ?? file.facts;
  const tiers = await Promise.all(
    file.header.tiers.map(async (t) => (t.name === "facts" ? { ...t, tokens: estimateTokens(JSON.stringify(facts)), hash: await tierHash(facts) } : t)),
  );
  const header: SemantoHeader = { ...file.header, tiers, facts_root: await factsRoot(facts), identity: { ...file.header.identity, ...(changes.identity ?? {}) } };
  return { ...file, header, facts, root_hash: await rootHash(header) };
}

export class Pipeline implements WorkspaceHandlers {
  readonly staging: BuildStagingPort;
  constructor(readonly d: PipelineDeps) {
    this.staging = d.staging ?? new MemoryBuildStaging();
  }

  /** The relying party passkeys are checked against. */
  webauthn(): WebAuthnConfig {
    return this.d.webauthn ?? webauthnConfig();
  }

  random(n: number): Uint8Array {
    if (this.d.random) return this.d.random(n);
    return crypto.getRandomValues(new Uint8Array(n));
  }

  fetcher(): Fetcher {
    return new Fetcher({ http: this.d.site.http, clock: { now: () => this.d.now() }, ...(this.d.site.resolve ? { resolve: this.d.site.resolve } : {}) }, this.d.site.fetcher ?? {});
  }

  // ---------------------------------------------------------------- compile: a build in queue messages (src/compiler/stream.ts)

  private streamDeps(): StreamDeps {
    return {
      staging: this.staging,
      bodies: this.d.store,
      fetcher: this.fetcher(),
      now: () => this.d.now(),
      previousFile: (trooth_id, version) => this.d.store.getFile(trooth_id, version),
    };
  }

  /** Create the build row for a job. The domain is the company's, fixed at the claim; a job never names another. */
  async startBuild(job: CompileJob): Promise<string> {
    const company = await this.d.store.getCompany(job.trooth_id);
    if (!company) throw new Error(`compile: no company ${job.trooth_id}`);
    const latest = await this.d.store.latestFile(company.trooth_id);
    const lastBuild = await this.staging.latestBuild(company.trooth_id);
    const version = Math.max(latest?.file.header.version ?? 0, lastBuild && lastBuild.status !== "failed" && lastBuild.status !== "done" ? lastBuild.version : 0) + 1;
    const settings = (await this.d.settings.get(company.trooth_id)) ?? DEFAULT_SETTINGS;
    const requested_at = iso(this.d.now());
    const identity: Identity = {
      domain: company.domain,
      trooth_id: company.trooth_id,
      ...(company.legal_name ? { legal_name: company.legal_name } : {}),
      ...(company.lei ? { lei: company.lei } : {}),
      key_binding: { jwks_url: jwksUrl(company.domain), dns_record: false },
    };
    const build_id = `b_${[...this.random(12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const buildJob: BuildJob = {
      trooth_id: company.trooth_id,
      version,
      supersedes: company.current_version,
      previous_version: latest ? latest.file.header.version : null,
      reason: job.reason,
      ...(job.changed_urls ? { changed_urls: job.changed_urls } : {}),
      org: company.org,
      identity,
      profile: `${this.d.config.network_base}/${company.trooth_id}`,
      controls: { content_signals: settings.content_signals },
      requested_at,
    };
    await this.staging.createBuild({ build_id, trooth_id: company.trooth_id, version, reason: job.reason, held: !isDomainProven(company), status: "queued", job: buildJob, found: 0, fetched: 0, planned: 0, rendered: 0, state: null, error: null, requested_at, started_at: null, finished_at: null });
    return build_id;
  }

  /** Run one build stage. Answers the messages that follow it: every render batch after discovery, assembly after the batch that completes the set, none after assembly. */
  async runStage(msg: StageMessage): Promise<StageMessage[]> {
    this.staging.beginInvocation?.();
    try {
      if (msg.stage === "discover") return await runDiscover(msg.build_id, this.streamDeps());
      if (msg.stage === "render") {
        const next = await runRender(msg, this.streamDeps());
        return next ? [next] : [];
      }
      const assembled = await runAssemble(msg.build_id, this.streamDeps());
      if (assembled) await this.finishBuild(assembled);
      return [];
    } catch (e) {
      if (this.inlineStage) await this.failBuild(msg.build_id, e);
      throw e;
    }
  }
  private inlineStage = false;

  /** Every stage of a build in this invocation, in order (tests, development, and a deployment without a queue). */
  private async runChain(first: StageMessage): Promise<void> {
    const pending: StageMessage[] = [first];
    while (pending.length) pending.push(...(await this.runStage(pending.shift()!)));
  }

  /** Mark a build failed with plain words; the setup screen shows them. */
  async failBuild(build_id: string, e: unknown): Promise<void> {
    const id = this.requestId();
    if (this.d.logError) this.d.logError(id, "build", e);
    await this.staging.updateBuild(build_id, { status: "failed", error: `Semanto could not finish reading the site. Try again, or check that the site opens in a browser. Request id ${id}.`, finished_at: iso(this.d.now()) });
  }

  /** Store the assembled version, the change state, and run what follows a build (promotion, the setup email). */
  private async finishBuild(a: AssembledBuild): Promise<void> {
    const trooth_id = a.build.trooth_id;
    const config = await this.d.store.getConfig(trooth_id);
    let file = a.file;
    if (config.public_record_facts.length) {
      const have = new Set(file.facts.map((f) => f.id));
      file = await rehashFile(file, { facts: [...file.facts, ...config.public_record_facts.filter((f) => !have.has(f.id))] });
    }
    const jsonld = generateJsonLd(file, { troothProfileUrl: a.build.job.profile });
    await this.d.store.saveAssembled(trooth_id, file, { llms: a.llms, jsonld: utf8(JSON.stringify(jsonld.graph)) });
    await this.d.store.putChangeStates(trooth_id, a.changeRows.map((r) => ({ url: r.url, etag: r.etag, last_modified: r.last_modified, raw_hash: r.raw_hash, lastmod: r.lastmod, checked_at: r.checked_at })));
    const state = { ...a.build.state!, result: { root_hash: file.root_hash, pages: file.header.pages_manifest.length, facts: file.facts.length, receipt: a.receipt } };
    await this.staging.updateBuild(a.build.build_id, { status: "done", finished_at: iso(this.d.now()), state, found: a.receipt.found, rendered: a.build.planned });
    await this.staging.clear(a.build.build_id);
    if (this.d.afterAssembled) await this.d.afterAssembled(trooth_id, file);
    await this.afterBuild(a.build.build_id);
  }

  /**
   * After a build: a version read before the proof stays held (stored, never
   * served or witnessed). Once the domain is proven, a Basic company's newest
   * read version is witnessed and served marked witnessed-not-signed. The
   * owner is emailed when a long setup read finishes.
   */
  async afterBuild(build_id: string): Promise<void> {
    const build = await this.staging.getBuild(build_id);
    if (!build || build.status !== "done") return;
    const company = await this.d.store.getCompany(build.trooth_id);
    if (!company) return;
    if (isDomainProven(company)) await this.promote(company, build);
    await setupAfterBuild(this, build);
  }

  /** The proof promotes a read: a Basic company's version is witnessed; a full-tier version is simply ready to review and sign. */
  async promote(company: CompanyRecord, build: BuildRow): Promise<void> {
    if (build.held) await this.staging.updateBuild(build.build_id, { held: false });
    if (company.tier !== "basic") return;
    const stored = await this.d.store.getVersion(company.trooth_id, build.version);
    if (!stored || stored.file.header.state !== "read" || stored.file.witness) return;
    await this.witnessOnly(company.trooth_id, stored);
  }

  /** Inline: every stage in this invocation, for tests and development without a queue. */
  async compile(job: CompileJob): Promise<CompileSummary> {
    const build_id = await this.startBuild(job);
    this.inlineStage = true;
    try {
      await this.runChain({ kind: "stage", stage: "discover", build_id });
    } finally {
      this.inlineStage = false;
    }
    return this.summaryOf(build_id);
  }

  async summaryOf(build_id: string): Promise<CompileSummary> {
    const b = (await this.staging.getBuild(build_id))!;
    const r = b.state!.result!;
    return {
      trooth_id: b.trooth_id,
      version: b.version,
      version_id: versionId(r.root_hash),
      root_hash: r.root_hash,
      state: "read",
      pages: r.pages,
      facts: r.facts,
      coverage: { found: r.receipt.found, read: r.receipt.read, left_out: r.receipt.left_out, changed: r.receipt.changed, removed: r.receipt.removed },
    };
  }

  /** Queue a build (the first stage message) when the queue is bound; otherwise run it inline. Answers the build id. */
  async queueBuild(job: CompileJob): Promise<string> {
    if (this.d.enqueue) {
      const build_id = await this.startBuild(job);
      await this.d.enqueue({ kind: "stage", stage: "discover", build_id });
      return build_id;
    }
    if (this.d.inlineBuilds === false) throw new Error("No compile queue is bound in this deployment.");
    const build_id = await this.startBuild(job);
    this.inlineStage = true;
    try {
      await this.runChain({ kind: "stage", stage: "discover", build_id });
    } catch {
      // failBuild has recorded the failure; the setup state shows it.
    } finally {
      this.inlineStage = false;
    }
    return build_id;
  }

  /** One queue message: a compile job, a build stage, or a fan-out of companies. */
  async consume(message: unknown, attempts = 1): Promise<void> {
    if (!isRecord(message)) throw new Error("queue: the message is not an object");
    if (this.d.consumeOs && (await this.d.consumeOs(message, attempts))) return;
    if (message.kind === "stage") {
      const next = await this.runStage(message as unknown as StageMessage);
      if (this.d.enqueue) await Promise.all(next.map((m) => this.d.enqueue!(m)));
      else for (const m of next) await this.runChain(m);
      return;
    }
    if (message.kind === "companies") {
      const m = message as unknown as CompaniesMessage;
      if (m.job === "changes") await this.checkCompanyChanges(m.trooth_ids);
      else if (m.job === "gap" && this.d.gapReports) await this.gapReportsFor(m.trooth_ids, m.started_at);
      else if (m.job === "revocations") await this.resignRevocationsFor(m.trooth_ids);
      // Any other job (the retired "proof" job of a message queued before one signup) is acknowledged and dropped.
      return;
    }
    if (typeof message.trooth_id !== "string") throw new Error("compile: the message is not a CompileJob");
    const job = message as unknown as CompileJob;
    if (this.d.enqueue) {
      const build_id = await this.startBuild(job);
      await this.d.enqueue({ kind: "stage", stage: "discover", build_id });
    } else await this.compile(job);
  }

  /** A message that failed its last attempt: a build stage marks its build failed. */
  async consumeFailed(message: unknown, e: unknown): Promise<void> {
    if (isRecord(message) && this.d.consumeOsFailed && (await this.d.consumeOsFailed(message, e))) return;
    if (isRecord(message) && message.kind === "stage" && typeof message.build_id === "string") await this.failBuild(message.build_id, e);
    // A per-company job that used every attempt (its companies' revocation lists, for one, would expire): say so in the logs.
    if (isRecord(message) && message.kind === "companies") console.error(JSON.stringify({ alert: "companies_job_failed", job: message.job, companies: Array.isArray(message.trooth_ids) ? message.trooth_ids.length : 0, error: e instanceof Error ? e.message : String(e) }));
  }

  // ---------------------------------------------------------------- workspace actions

  /** A short id a person can quote to support; the exception it names is logged, never sent. */
  requestId(): string {
    return [...this.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  failed(action: string, e: unknown): WorkspaceResult {
    const id = this.requestId();
    if (this.d.logError) this.d.logError(id, action, e);
    else console.error(`semanto ${action} failed, request ${id}:`, e);
    if (e instanceof WitnessKeyMissingError) return { status: 0, problem: { code: "witness_key_missing", detail: PROBLEMS.witness_key_missing.what_happened }, headers: { "Trooth-Request-Id": id } };
    const message = e instanceof Error ? e.message : "";
    // A missing secret is this deployment's state, not an outside source failing.
    const code: ProblemCode = /HOSTED_KEY_SEAL_SECRET|No compile queue/.test(message) ? "conflict" : e instanceof UpstreamError ? "upstream_unavailable" : "internal_error";
    return { status: 0, problem: { code, detail: `The step did not finish. Quote request id ${id} to Trooth support.` }, headers: { "Trooth-Request-Id": id } };
  }

  async handle(action: WorkspaceAction, ws: WorkspaceAuth, trooth_id: string, input: unknown): Promise<WorkspaceResult> {
    const body = isRecord(input) ? input : {};
    try {
      switch (action) {
        case "build":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.build(trooth_id);
        case "sign":
          return await this.sign(ws, trooth_id, body);
        case "sign/options":
          return await signOptions(this, ws, trooth_id, body);
        case "passkeys/options":
          return await passkeyOptions(this, ws, trooth_id);
        case "passkeys":
          return await registerPasskey(this, ws, trooth_id, body);
        case "gap-report":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          if (!this.d.gapReports) return problem("feature_unavailable", GAP_REPORTS_OFF);
          return await this.gapReport(trooth_id, body);
        case "monitor/run":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.monitorRun(trooth_id, body);
        case "keys/rotate":
          return await this.rotateKeys(ws, trooth_id, body);
        case "lei":
          return await this.lei(ws, trooth_id, body);
        case "basic/claim":
          return await this.basicClaim(ws, trooth_id, body);
        case "basic/prove":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.basicProve(ws, trooth_id);
        case "first-publication":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.firstPublication(trooth_id, body);
        case "connectors":
          return await this.addConnector(ws, trooth_id, body);
        case "withdraw":
          return await this.withdraw(ws, trooth_id, body);
        case "erase":
          return await this.erase(ws, trooth_id, body);
        case "detect":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.detect(trooth_id);
        case "competitor-report":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          if (!this.d.gapReports) return problem("feature_unavailable", GAP_REPORTS_OFF);
          return await this.competitorReport(trooth_id, body);
        default:
          return await setupAction(this, action, ws, trooth_id, body);
      }
    } catch (e) {
      return this.failed(action, e);
    }
  }

  async read(what: WorkspaceRead, ws: WorkspaceAuth, trooth_id: string, query: Record<string, string>): Promise<WorkspaceResult> {
    try {
      switch (what) {
        case "setup":
          return ok(200, await setupState(this, trooth_id, { live: true, user_id: ws.user_id, ...(ws.domains ? { domains: ws.domains } : {}) }));
        case "setup/review":
          return await setupReview(this, trooth_id);
        case "keys":
          return await this.keysRead(trooth_id);
        case "writeback":
          return await this.writebackPreview(trooth_id);
        case "receipts":
          return await this.receiptsDigest(trooth_id, query.day);
        case "receipts.csv":
          return await this.receiptsCsvRead(trooth_id, query.from, query.to);
        case "reports":
          // Off (production): no stored report is served (blueprint A2/A3).
          if (!this.d.gapReports) return problem("feature_unavailable", GAP_REPORTS_OFF);
          return ok(200, { object: "semanto.reports", trooth_id, gap: await this.d.store.latestGapReport(trooth_id) });
      }
    } catch (e) {
      return this.failed(what, e);
    }
  }

  async session(what: "claim" | "setup/start" | "setup", s: WorkspaceSession, input: unknown): Promise<WorkspaceResult> {
    try {
      return await setupSession(this, what, s, isRecord(input) ? input : {});
    } catch (e) {
      return this.failed(what, e);
    }
  }

  private async build(trooth_id: string): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet. Claim the domain first.");
    if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first. A version for publication is built only after the proof.`);
    const job: CompileJob = { trooth_id, domain: company.domain, reason: "manual", requested_at: iso(this.d.now()) };
    if (this.d.enqueue) {
      await this.d.enqueue(job);
      return ok(202, { object: "semanto.build_queued", trooth_id, requested_at: job.requested_at });
    }
    return ok(200, { object: "semanto.build", ...(await this.compile(job)) });
  }

  // ---------------------------------------------------------------- sign

  private async sign(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", `A workspace ${ws.role} cannot sign. Ask an owner or admin.`);
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first. Nothing is signed or witnessed before the proof.`);
    const v = typeof body.version === "number" ? await this.d.store.getVersion(trooth_id, body.version) : await this.d.store.latestVersion(trooth_id);
    if (!v) return problem("conflict", "Nothing has been built yet. Build a version first.");
    const state = v.file.header.state;
    if (state === "signed") return problem("conflict", `Version ${v.file.header.version} is already signed.`);
    if (state === "withdrawn") return problem("conflict", `Version ${v.file.header.version} was withdrawn.`);
    const now = this.d.now();

    // Customer custody, second call: the signature over the signing input given earlier.
    if (typeof body.signature === "string") {
      const pending = await this.d.store.pending(trooth_id, v.file.header.version);
      if (!pending) return problem("conflict", "There is no signing input waiting for this version. Ask for one first (POST without a signature).");
      let sig: Uint8Array;
      try {
        sig = fromBase64Url(body.signature);
      } catch {
        return problem("invalid_request", "signature must be base64url.");
      }
      if (sig.length !== 64) return problem("invalid_request", "An Ed25519 signature is 64 bytes.");
      const key = (await this.d.store.keys(trooth_id)).find((k) => k.public_jwk.kid === pending.kid)?.public_jwk;
      if (!key) return problem("conflict", "The key named in the signing input is no longer on file.");
      const jws = assembleJws(pending.prepared, sig);
      const check = await checkAssembledJws(jws.detached, pending.header, key, now);
      if (!check.ok) return problem("signature_invalid", `The signature did not verify: ${check.reason}.`);
      return this.finalize(company, v, pending.header, jws.detached, key.kid);
    }

    // Approval, and the two-officer rule when the company asks for it.
    const role = roleFromWorkspace({ user_id: ws.user_id, name: ws.name, role: ws.role, since: iso(now) });
    if (!role.ok) return problem("forbidden", role.reason);
    const builtRoot = v.file.root_hash;
    // Hosted custody: Trooth holds the key and releases it only after this person's passkey assertion
    // for exactly this version and root hash (W3C WebAuthn Level 3, 7.2). An approval without one does not count.
    const hosted = company.custody === "hosted";
    let passkey: PasskeyApproval | undefined;
    if (hosted) {
      const checked = await checkSigningAssertion(this, ws, trooth_id, { version: v.file.header.version, root_hash: builtRoot }, body);
      if (!checked.ok) return checked.result;
      passkey = checked.approval;
    }
    await this.d.store.addAuthorization(trooth_id, { record: role.record, at: iso(now), root_hash: builtRoot, ...(passkey ? { passkey } : {}) });
    const config = await this.d.store.getConfig(trooth_id);
    const decision = mayBeSigned(builtRoot, await this.d.store.authorizations(trooth_id, builtRoot), { ...config.signing, require_passkey: hosted });
    if (!decision.allowed) {
      // Two officers means two distinct accounts. A worker-f workspace has one account until team seats exist, so until
      // then a company with two_officer set cannot sign; the dashboard shows this sentence.
      const seats = config.signing.officers === "two_officer" ? { two_officer_note: TWO_OFFICER_NOTE } : {};
      return ok(202, { object: "semanto.sign_waiting", trooth_id, version: v.file.header.version, root_hash: builtRoot, reason: decision.reason, approvals_missing: decision.missing, ...seats });
    }

    const header: SemantoHeader = { ...v.file.header, state: "signed", identity: { ...v.file.header.identity, ...(decision.authorized_by ? { authorized_by: decision.authorized_by } : {}) } };

    if (hosted) {
      // A key made here takes this signing's own time as its nbf: the clock moves on during the writes, and a later nbf
      // than the statement's iat would make the first signature of every hosted company fail as key_not_yet_valid.
      const key = (await this.d.keys.getCompanySigningKey(trooth_id)) ?? (await this.newHostedKey(trooth_id, now)).privateJwk;
      const prepared = versionSigningInput(header, key.kid, now);
      const sig = await rawSign(await importPrivate(key), utf8(prepared.signing_input));
      const jws = assembleJws(prepared, sig);
      const check = await checkAssembledJws(jws.detached, header, toPublic(key), now);
      if (!check.ok) return problem("signature_invalid", `The hosted key did not produce a valid signature: ${check.reason}.`);
      return this.finalize(company, v, header, jws.detached, key.kid);
    }

    // A key staged as next in a rotation is published but does not sign until the rotation is confirmed.
    const customerKeys = (await this.d.store.keys(trooth_id)).filter((k) => k.custody === "customer" && !k.next).map((k) => k.public_jwk);
    const current = currentKey(customerKeys, now);
    if (!current) return problem("conflict", "No public key is on file. Send your Ed25519 public key to keys/rotate as public_jwk first.");
    const prepared = versionSigningInput(header, current.kid, now);
    await this.d.store.putPending({ trooth_id, version: header.version, header, prepared, kid: current.kid, created_at: iso(now) });
    return ok(200, {
      object: "semanto.signing_input",
      trooth_id,
      version: header.version,
      kid: current.kid,
      typ: prepared.typ,
      signing_input: prepared.signing_input,
      protected: prepared.protected_b64,
      payload: prepared.payload_b64,
      next: "Sign the UTF-8 bytes of signing_input with your Ed25519 private key and send the 64-byte signature, base64url, as { \"version\": n, \"signature\": \"<base64url signature>\" } to this same address.",
    });
  }

  /** Witness, log, timestamp, and store the signed version. */
  private async finalize(company: CompanyRecord, v: VersionHead, header: SemantoHeader, detached: string, kid: string): Promise<WorkspaceResult> {
    const now = this.d.now();
    const witness = await this.d.keys.getWitnessKey();
    const root = await rootHash(header);
    const vid = versionId(root);
    const witnessed_at = iso(now);
    const wit = await signObject({ root_hash: root, witnessed_at }, witness, JWS_TYPES.witness, { iat: now });
    const versionLeaf = await this.d.log.append({ kind: "semanto_version", trooth_id: company.trooth_id, ref: vid, hash: root, at: witnessed_at });
    const witnessLeaf = await this.d.log.append({ kind: "witness", trooth_id: company.trooth_id, ref: vid, hash: await digest(wit.detached), at: witnessed_at });
    const head = witnessLeaf.tree_head;
    const timestamp = await this.timestamp(head);
    const file: SemantoFile = {
      ...v.file,
      header,
      root_hash: root,
      signature: { alg: "EdDSA", kid, jws: detached, key: header.identity.key_binding.jwks_url },
      witness: { by: "Trooth", at: witnessed_at, kid: witness.kid, jws: wit.detached },
      ledger: { log: this.d.config.ledger_url, index: versionLeaf.index, tree_size: head.tree_size, tree_head: await treeHeadId(head) },
    };
    await this.d.store.markSigned(company.trooth_id, file, witnessed_at);
    await this.d.store.clearPending(company.trooth_id, header.version);
    await this.d.store.clearAuthorizations(company.trooth_id, v.file.root_hash);
    await stampStep(this, company.trooth_id, "sign", witnessed_at);
    return ok(200, {
      object: "semanto.signed",
      trooth_id: company.trooth_id,
      version: header.version,
      version_id: vid,
      root_hash: root,
      signed_at: witnessed_at,
      kid,
      ledger: file.ledger,
      log: { version_leaf: versionLeaf.index, witness_leaf: witnessLeaf.index, tree_head: head },
      timestamp,
    });
  }

  /** RFC 3161 time on a tree head, stored beside the log when the TSA answered. */
  private async timestamp(head: { tree_size: number; root_hash: string; signed_at: string; jws: string }): Promise<{ gen_time: string; token_key: string; signature_checked: false } | { error: string } | null> {
    if (!this.d.tsa) return null;
    const r = await timestampTreeHead(head, this.d.tsa.url, this.d.tsa.fetch);
    if (!r.ok || !r.token) return { error: r.reason ?? "the time-stamp authority gave no token" };
    await this.d.store.putBlob(r.token_key, r.token.token, "application/timestamp-reply");
    await this.d.logStore.putTreeHead({ ...head, tsa_token_key: r.token_key, tsa_time: r.token.gen_time });
    return { gen_time: r.token.gen_time, token_key: r.token_key, signature_checked: false };
  }

  // ---------------------------------------------------------------- keys

  private async newHostedKey(trooth_id: string, at?: Date): Promise<{ privateJwk: PrivateJwk; publicJwk: PublicJwk }> {
    const now = at ?? this.d.now();
    const k = await createHostedKey(trooth_id, now);
    await this.d.store.putKey(trooth_id, { public_jwk: k.record.public_jwk, custody: "hosted", created_at: k.record.created_at }, k.privateJwk);
    await this.logKey(trooth_id, k.record.public_jwk);
    return { privateJwk: k.privateJwk, publicJwk: k.record.public_jwk };
  }

  /** Append a key leaf to the public log (every new company key, staged or not). */
  async logKey(trooth_id: string, jwk: PublicJwk): Promise<void> {
    await this.d.log.append({ kind: "key", trooth_id, ref: jwk.kid, hash: await digest(canonicalize(jwk)), at: iso(this.d.now()) });
  }

  private async rotateKeys(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can change signing keys.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const now = this.d.now();
    const keys = (await this.d.store.keys(trooth_id)).filter((k) => !k.next);
    const custody = body.custody === "customer" || body.public_jwk !== undefined ? "customer" : body.custody === "hosted" ? "hosted" : company.custody;
    const overlap_until = iso(new Date(now.getTime() + ROTATION_OVERLAP_MS));

    if (custody === "customer") {
      const accepted = await acceptCustomerPublicKey(body.public_jwk, now);
      if (!accepted.ok) return problem("invalid_request", accepted.reason);
      const retiring = keys.filter((k) => !k.public_jwk.exp && !k.public_jwk.revoked_at && k.public_jwk.kid !== accepted.jwk.kid);
      for (const k of retiring) await this.d.store.putKey(trooth_id, { ...k, public_jwk: { ...k.public_jwk, exp: overlap_until } }, null);
      await this.d.store.putKey(trooth_id, { public_jwk: accepted.jwk, custody: "customer", created_at: iso(now) }, null);
      await this.logKey(trooth_id, accepted.jwk);
      return ok(200, { object: "semanto.key", trooth_id, custody: "customer", kid: accepted.jwk.kid, retired: retiring.map((k) => k.public_jwk.kid), overlap_until: retiring.length ? overlap_until : null, dns_record: `v=trooth1; kid=${accepted.jwk.kid}` });
    }

    const hosted = keys.filter((k) => k.custody === "hosted").map((k) => k.public_jwk);
    const current = currentKey(hosted.filter((k) => !k.exp), now);
    if (!current) {
      const created = await this.newHostedKey(trooth_id);
      return ok(200, { object: "semanto.key", trooth_id, custody: "hosted", kid: created.publicJwk.kid, retired: [], overlap_until: null, dns_record: `v=trooth1; kid=${created.publicJwk.kid}` });
    }
    const rotation = await rotateHostedKey(trooth_id, current, now);
    const old = keys.find((k) => k.public_jwk.kid === current.kid)!;
    await this.d.store.putKey(trooth_id, { ...old, public_jwk: rotation.retired }, null);
    await this.d.store.putKey(trooth_id, { public_jwk: rotation.next.record.public_jwk, custody: "hosted", created_at: rotation.next.record.created_at }, rotation.next.privateJwk);
    await this.logKey(trooth_id, rotation.next.record.public_jwk);
    return ok(200, { object: "semanto.key", trooth_id, custody: "hosted", kid: rotation.next.record.kid, retired: [current.kid], overlap_until: rotation.overlap_until, dns_record: rotation.dns_record });
  }

  private async addConnector(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can add a connector key.");
    const accepted = await acceptCustomerPublicKey(body.public_jwk, this.d.now());
    if (!accepted.ok) return problem("invalid_request", accepted.reason);
    const source = str(body.source) ?? "connector";
    if (!(await this.d.store.putConnectorKey(trooth_id, accepted.jwk, source, iso(this.d.now())))) return problem("conflict", `This key is already on file (kid ${accepted.jwk.kid}). Each connector needs its own key.`);
    return ok(200, { object: "semanto.connector_key", trooth_id, kid: accepted.jwk.kid, source });
  }

  // ---------------------------------------------------------------- LEI

  private async lei(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can bind an LEI.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const lei = str(body.lei);
    if (!lei) return problem("invalid_request", "Send the 20-character LEI as lei.");
    const r = await lookupLei(lei, this.d.identity.http, this.d.now());
    if (!r.ok) return problem(r.reason === "bad_format" ? "invalid_request" : r.reason === "not_found" ? "conflict" : "upstream_unavailable", r.sentence);
    const facts = await leiFacts(r.record);
    const config = await this.d.store.getConfig(trooth_id);
    const keys = new Set(facts.map((f) => f.key));
    await this.d.store.putConfig(trooth_id, { ...config, public_record_facts: [...config.public_record_facts.filter((f) => !keys.has(f.key)), ...facts] });
    await this.d.store.putCompany({ ...company, lei: r.record.lei });
    return ok(200, {
      object: "semanto.lei",
      trooth_id,
      record: r.record,
      name: compareLegalName(company.legal_name ?? company.org, r.record.legal_name),
      facts,
      next: "These public_record facts join the next build. Build and sign to publish them.",
    });
  }

  // ---------------------------------------------------------------- Semanto Basic

  private async basicClaim(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    // An owner or admin may claim. While the company has no registered owner, a member may claim too, and becomes its owner.
    const owner = await this.d.store.ownerUserId(trooth_id);
    if (!mayAdminister(ws.role) && !(ws.role === "member" && owner === null)) return problem("forbidden", "Only an owner or admin can claim a domain.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet. Start setup first (POST /os/semanto/setup/start).");
    // The domain is the one fixed at the claim; a request never changes it.
    const asked = str(body.domain) ? cleanDomain(str(body.domain)!) : company.domain;
    if (asked !== company.domain) return problem("domain_fixed", `This company's domain is ${company.domain}, fixed when it was claimed. It cannot change to ${str(body.domain)}.`);
    await ensureSetup(this, company, { user_id: ws.user_id, email: ws.name.includes("@") ? ws.name : null, signed_in_at: null });
    await this.d.store.registerOwner(trooth_id, ws.user_id);
    // One proof, on trooth.co: the domain's state there is the answer; there is no record to publish for Semanto.
    const proof = await syncDomainProof(this, company, ws.domains);
    return ok(200, { object: "semanto.basic_claim", trooth_id, domain: company.domain, state: proof.proven ? "domain_proved" : "claim", proof: proof.doc, steps: SETUP_STEPS });
  }

  /** Read the domain's state on trooth.co; when it is confirmed there, record the proof and queue the read (or promote a finished held read). Never compiles inside the request. */
  private async basicProve(ws: WorkspaceAuth, trooth_id: string): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "Claim the domain first.");
    const outcome = await syncDomainProof(this, company, ws.domains);
    const state = await setupState(this, trooth_id, { live: false, user_id: ws.user_id, ...(ws.domains ? { domains: ws.domains } : {}) });
    const setup = (await this.d.store.getSetup(trooth_id))!;
    const basic: BasicCompany = { trooth_id, domain: company.domain, state: outcome.proven ? "domain_proved" : "claim", claim_token: setup.challenge, claimed_at: setup.steps.company ?? setup.started_at };
    return ok(200, basicResponse(basic, {
      object: "semanto.basic_proof",
      trooth_id,
      proved: outcome.proven,
      method: outcome.doc.source,
      proof: outcome.doc,
      read: state.read,
      setup: state.timings,
    }), basicHeaders());
  }

  /** Semanto Basic: witness a built version without a company signature, and log the witness statement. */
  async witnessOnly(trooth_id: string, v: VersionHead): Promise<{ witnessed_at: string; log_index: number; tree_size: number } | null> {
    if (v.file.header.state !== "read") return null;
    // Nothing is witnessed before the domain is proven.
    if (!isDomainProven(await this.d.store.getCompany(trooth_id))) return null;
    const now = this.d.now();
    const witnessed_at = iso(now);
    const witness = await this.d.keys.getWitnessKey();
    const root = v.file.root_hash;
    const vid = versionId(root);
    const wit = await signObject({ root_hash: root, witnessed_at }, witness, JWS_TYPES.witness, { iat: now });
    const leaf = await this.d.log.append({ kind: "witness", trooth_id, ref: vid, hash: await digest(wit.detached), at: witnessed_at });
    const file: SemantoFile = { ...v.file, signature: null, witness: { by: "Trooth", at: witnessed_at, kid: witness.kid, jws: wit.detached }, ledger: null };
    await this.d.store.markWitnessed(trooth_id, file, witnessed_at);
    return { witnessed_at, log_index: leaf.index, tree_size: leaf.tree_size };
  }

  // ---------------------------------------------------------------- first publication

  private async firstPublication(trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    if (!isDomainProven(company)) return problem("domain_not_proven", `Prove you control ${company.domain} first. Trooth witnesses pages only on a proven domain.`);
    const url = str(body.url);
    let host: string;
    try {
      host = new URL(url ?? "").hostname;
    } catch {
      return problem("invalid_request", "Send the page address as url.");
    }
    if (registrableDomain(host) !== registrableDomain(company.domain)) return problem("forbidden", `Trooth witnesses pages on ${company.domain} for this company, not on ${host}.`);
    const res = await this.fetcher().fetch(url!);
    if (!res.ok || res.status !== 200) return problem("upstream_unavailable", res.ok ? `The page answered ${res.status}.` : res.detail);
    const page = extract({ html: res.text, url: url!, witnessed_at: res.fetchedAt, source_hash: res.source_hash, headers: res.headers });
    // Title and author are what the requester states (or the page's own title); the record keeps them apart from what Trooth witnessed.
    const record = await createFirstPublication(
      { url: url!, markdown: page.body, title: str(body.title) ?? page.title, ...(str(body.author) ? { author: str(body.author)! } : {}), trooth_id, witnessed_at: this.d.now() },
      await this.d.keys.getWitnessKey(),
      { append: async (leaf) => this.d.log.append(leaf as LogLeaf) },
    );
    await this.d.store.putFirstPublication(record);
    return ok(200, {
      object: "semanto.first_publication_receipt",
      ...record,
      markdown: page.body,
      record_url: `${this.d.config.public_api_base}/first-publication/${record.record.id}`,
      check_url: `${this.d.config.public_api_base}/first-publication/check`,
      dispute: exportDisputeStatement(record, { log_url: this.d.config.ledger_url, record_url: `${this.d.config.public_api_base}/first-publication/${record.record.id}`, check_url: `${this.d.config.public_api_base}/first-publication/check` }),
    });
  }

  // ---------------------------------------------------------------- gap report

  async gapReport(trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const file = (await this.d.versions.getCurrent(trooth_id)) ?? (await this.d.store.latestVersion(trooth_id))?.file ?? null;
    if (!file) return problem("conflict", "Build a version first; the report compares answers with it.");
    // { "queue": true } (the Watch page's Ask now): the report runs on the queue, where asking every assistant
    // every question has the time it needs, instead of inside a request. At most one every ten minutes.
    if (body.queue === true && this.d.enqueue) {
      const now = this.d.now().getTime();
      const config = await this.d.store.getConfig(trooth_id);
      const last = await this.d.store.latestGapReport(trooth_id);
      // The newest of the last report and the last ask: a second click while a report is still queued is refused too.
      const since = Math.max(last ? Date.parse(last.ran_at) : 0, config.gap.asked_at ? Date.parse(config.gap.asked_at) : 0);
      const next = since ? since + GAP_ASK_NOW_GAP_MS : 0;
      if (next > now) return problem("conflict", `A report was asked for at ${iso(new Date(since))}. Ask again after ${iso(new Date(next))}.`);
      const today = await this.d.store.gapReportsSince(trooth_id, iso(new Date(now - 24 * 3600_000)));
      if (today.length >= GAP_REPORTS_PER_DAY) return problem("conflict", `This company has had ${today.length} reports in the last 24 hours, the most a day allows. Ask again tomorrow.`);
      const queued_at = iso(this.d.now());
      await this.d.store.putConfig(trooth_id, { ...config, gap: { ...config.gap, asked_at: queued_at } });
      await this.d.enqueue({ kind: "companies", job: "gap", trooth_ids: [trooth_id], started_at: queued_at });
      return ok(202, { object: "semanto.gap_report_queued", trooth_id, queued_at });
    }
    const config = await this.d.store.getConfig(trooth_id);
    const kind = (["b2b", "shopping", "local", "competitor"] as QuestionKind[]).find((k) => k === body.kind) ?? config.gap.kinds[0] ?? "b2b";
    const products = (Array.isArray(body.products) ? body.products.filter((p): p is string => typeof p === "string") : config.gap.products).slice(0, GAP_MAX_PRODUCTS);
    const competitor = isRecord(body.competitor) && str(body.competitor.name) && str(body.competitor.domain) ? { name: str(body.competitor.name)!, domain: str(body.competitor.domain)! } : config.gap.competitor;
    const params: QuestionParams = { company: company.org, domain: company.domain, products, ...(competitor ? { competitor } : {}), ...(str(body.service) ?? config.gap.service ? { service: str(body.service) ?? config.gap.service } : {}) };
    const report = await runGapReport({
      trooth_id,
      company: company.org,
      kind,
      ran_at: iso(this.d.now()),
      questions: [...questionsFor(kind, params), ...(config.gap.questions ?? []).map((text, i) => ({ id: `custom:${i + 1}`, template_id: "custom", kind, text, keys: [] }))].slice(0, GAP_MAX_QUESTIONS),
      adapters: this.d.gapAdapters(),
      context: { facts: file.facts, domains: file.header.domains, networkBase: this.d.config.network_base },
    });
    await this.d.store.saveGapReport(report);
    return ok(200, { object: "semanto.gap_report_result", report, markdown: renderGapReportMarkdown(report) });
  }

  // ---------------------------------------------------------------- monitor

  /** The signed record as the monitor reads it: the current signed file plus the commerce tier's records and offers. */
  async signedRecord(trooth_id: string): Promise<SignedRecord | null> {
    const company = await this.d.store.getCompany(trooth_id);
    const file = await this.d.versions.getCurrent(trooth_id);
    // The monitor compares against a signed record only; a Basic record is witnessed, not signed.
    if (!company || !file || file.header.state !== "signed") return null;
    const signed_at = (await this.d.versions.listVersions(trooth_id)).find((v) => v.version === file.header.version)?.signed_at ?? file.header.built_at;
    const records = await this.d.commerce.records(trooth_id);
    const offers = await this.d.commerce.offers(trooth_id);
    return {
      trooth_id,
      domain: company.domain,
      org: company.org,
      version: file.header.version,
      signed_at,
      facts: file.facts,
      pages: file.header.pages_manifest,
      products: records.map(toMonitorProduct),
      offers: offers.map(toMonitorOffer),
    };
  }

  async monitorRun(trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    const record = await this.signedRecord(trooth_id);
    if (!record) return problem("conflict", "The monitor compares surfaces with the signed record. Sign a version first.");
    const config = await this.d.store.getConfig(trooth_id);
    const surfaces = isRecord(body.surfaces) ? (body.surfaces as AvailableSurfaces) : config.surfaces;
    const to = config.alert_emails;
    const clock: ClockPort = { now: () => this.d.now() };
    const { run, summary } = await runMonitor(
      {
        record,
        surfaces,
        ...(to.length && this.d.monitor.from ? { email: { from: this.d.monitor.from, to, actionUrl: this.d.monitor.actionUrl ?? `${this.d.config.network_base}/${trooth_id}` } } : {}),
      },
      { fetch: this.d.monitor.fetch, clock, store: this.d.monitor.store, ...(this.d.monitor.email ? { email: this.d.monitor.email } : {}), ...(this.d.monitor.tokens ? { tokens: this.d.monitor.tokens } : {}) },
    );
    // Content Signals drift: the signed policy against the site's robots.txt and home page headers (src/basic/content-signals.ts).
    const file = await this.d.versions.getCurrent(trooth_id);
    const getOrNull = async (url: string) => {
      try {
        return await this.d.monitor.fetch.get(url);
      } catch {
        return null;
      }
    };
    const robots = await getOrNull(`https://${record.domain}/robots.txt`);
    const home = await getOrNull(`https://${record.domain}/`);
    const content_signals = file ? checkContentSignalsDrift(file.controls.content_signals, { robotsTxt: robots && robots.status === 200 ? robots.body : null, headers: home?.headers ?? {} }) : null;
    return ok(200, { object: "semanto.monitor_result", summary, mismatches: run.mismatches, indexability: run.indexability, content_signals });
  }

  // ---------------------------------------------------------------- withdraw and revoke (finding 6)

  /** POST /os/semanto/{id}/withdraw: the version answers semanto_withdrawn from then on; the revocation is logged and the list re-signed. */
  private async withdraw(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can withdraw a version.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const version = typeof body.version === "number" && Number.isInteger(body.version) ? body.version : null;
    const reason = str(body.reason);
    if (version === null) return problem("invalid_request", "Send the version number to withdraw as version.");
    if (!reason) return problem("invalid_request", "Send the reason in plain words as reason. It is published with the withdrawal.");
    if (reason.length > 500) return problem("invalid_request", "Keep the reason under 500 characters.");
    const file = await this.d.store.getFile(trooth_id, version);
    if (!file) return problem("conflict", `Version ${version} does not exist.`);
    if (file.header.state === "withdrawn") return problem("conflict", `Version ${version} is already withdrawn.`);
    const at = iso(this.d.now());
    const entry: RevocationEntry = { kind: "version", ref: versionId(file.root_hash), reason, revoked_at: at };
    const leaf = await this.d.log.append(await revocationLeaf(entry, trooth_id));
    await this.d.store.putRevocation(trooth_id, entry, leaf.index);
    await this.d.store.withdrawVersion(trooth_id, version, at);
    await this.resignRevocations(trooth_id);
    await this.resignRevocations(null);
    return ok(200, { object: "semanto.withdrawn", trooth_id, version, version_id: entry.ref, revoked_at: at, log_index: leaf.index, revocations_url: `${this.d.config.public_api_base}/${trooth_id}/revocations` });
  }

  /**
   * POST /os/semanto/{id}/erase { confirm: "<the company's domain>" }: owner only. Every version and every key is
   * revoked and logged first, so a copy kept anywhere checks as revoked; then an erasure leaf is logged and every row
   * and stored object about the company is deleted, the sealed private keys included. What stays: the log's hashes and
   * the revocation entries. Database backups age out within 30 days (Cloudflare D1 Time Travel).
   */
  private async erase(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (ws.role !== "owner") return problem("forbidden", "Only the owner can erase the company's Semanto.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record to erase.");
    const confirm = str(body.confirm)?.trim().toLowerCase();
    if (confirm !== company.domain.toLowerCase()) return problem("invalid_request", `Type ${company.domain} as confirm to erase. Nothing was changed.`);
    try {
      const at = iso(this.d.now());
      const reason = "The company erased its Semanto record.";
      let revoked = 0;
      for (const v of await this.d.versions.listVersions(trooth_id)) {
        if (v.withdrawn_at) continue;
        const entry: RevocationEntry = { kind: "version", ref: v.version_id, reason, revoked_at: at };
        const leaf = await this.d.log.append(await revocationLeaf(entry, trooth_id));
        await this.d.store.putRevocation(trooth_id, entry, leaf.index);
        revoked++;
      }
      for (const k of await this.d.store.keys(trooth_id)) {
        if (k.public_jwk.revoked_at) continue;
        const entry: RevocationEntry = { kind: "key", ref: k.public_jwk.kid, reason, revoked_at: at };
        const leaf = await this.d.log.append(await revocationLeaf(entry, trooth_id));
        await this.d.store.putRevocation(trooth_id, entry, leaf.index);
        revoked++;
      }
      const erasure = { trooth_id, domain_hash: await digest(utf8(company.domain.toLowerCase())), erased_at: at };
      const leaf = await this.d.log.append({ kind: "erasure", trooth_id, ref: trooth_id, hash: await digest(canonicalize(erasure)), at });
      const gone = await this.d.store.eraseCompany(trooth_id);
      await this.resignRevocations(trooth_id);
      await this.resignRevocations(null);
      console.log(JSON.stringify({ event: "company_erased", trooth_id, rows: gone.rows, objects: gone.objects, revoked, log_index: leaf.index }));
      return ok(200, {
        object: "semanto.erased",
        trooth_id,
        erased_at: at,
        revoked,
        log_index: leaf.index,
        live: "Removed from Trooth's live systems within 24 hours.",
        backups: "Removed from backups within 30 days.",
        kept: "The public log keeps the hashes and the revocations, so any copy kept elsewhere checks as revoked.",
      });
    } catch (e) {
      return this.failed("erase", e);
    }
  }

  /** POST /os/semanto/{id}/keys/{kid}/revoke: revoked_at set (backdated to compromised_at when given), logged, list re-signed. */
  async revokeKey(ws: WorkspaceAuth, trooth_id: string, kid: string, input: unknown): Promise<WorkspaceResult> {
    try {
      const body = isRecord(input) ? input : {};
      if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can revoke a signing key.");
      const reason = str(body.reason);
      if (!reason) return problem("invalid_request", "Send the reason in plain words as reason. It is published with the revocation.");
      if (reason.length > 500) return problem("invalid_request", "Keep the reason under 500 characters.");
      const now = this.d.now();
      let at = now;
      if (body.compromised_at !== undefined) {
        const t = typeof body.compromised_at === "string" ? Date.parse(body.compromised_at) : NaN;
        if (Number.isNaN(t)) return problem("invalid_request", "compromised_at must be an ISO 8601 time.");
        if (t > now.getTime()) return problem("invalid_request", "compromised_at cannot be in the future.");
        at = new Date(t);
      }
      const key = (await this.d.store.keys(trooth_id)).find((k) => k.public_jwk.kid === kid);
      if (!key) return problem("conflict", `No key ${kid} is on file for this company.`);
      if (key.public_jwk.revoked_at) return problem("conflict", `Key ${kid} was already revoked on ${key.public_jwk.revoked_at}.`);
      const revoked = revokeKeyJwk(key.public_jwk, at);
      await this.d.store.putKey(trooth_id, { ...key, public_jwk: revoked }, null);
      const entry: RevocationEntry = { kind: "key", ref: kid, reason, revoked_at: revoked.revoked_at! };
      const leaf = await this.d.log.append(await revocationLeaf(entry, trooth_id));
      await this.d.store.putRevocation(trooth_id, entry, leaf.index);
      await this.resignRevocations(trooth_id);
      await this.resignRevocations(null);
      return ok(200, { object: "semanto.key_revoked", trooth_id, kid, revoked_at: entry.revoked_at, log_index: leaf.index, revocations_url: `${this.d.config.public_api_base}/${trooth_id}/revocations` });
    } catch (e) {
      return this.failed("keys/revoke", e);
    }
  }

  /** GET /os/semanto/{id}/keys: each key's state in words, and how the current key is bound to the domain. */
  private async keysRead(trooth_id: string): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const now = this.d.now();
    const revocations = await this.d.store.revocations(trooth_id);
    const keys = (await this.d.store.keys(trooth_id)).map((k) => {
      const st = keyState(k.public_jwk, revocations, now);
      return { kid: k.public_jwk.kid, custody: k.custody, state: st.state, sentence: st.sentence, created_at: k.created_at, ...(k.public_jwk.nbf ? { nbf: k.public_jwk.nbf } : {}), ...(k.public_jwk.exp ? { exp: k.public_jwk.exp } : {}), ...(k.public_jwk.revoked_at ? { revoked_at: k.public_jwk.revoked_at } : {}) };
    });
    const current = currentKey((await this.d.store.keys(trooth_id)).filter((k) => !k.next).map((k) => k.public_jwk).filter((k) => !k.exp && !k.revoked_at), now);
    const binding = current ? await bindingStatus(company.domain, current.kid, this.d.identity.http, dohDns(this.d.identity.http), now) : null;
    return ok(200, { object: "semanto.keys", trooth_id, keys, binding });
  }

  /** POST /os/semanto/{id}/detect: host detection on the company's own domain (src/serve/detect.ts), kept for the install step. */
  async detect(trooth_id: string): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const result = await detectHost(company.domain, { fetch: (url, init) => this.siteProbe(url, init.headers), dnsTxt: async (name) => (this.d.setupDns?.resolvers[0] ? this.d.setupDns.resolvers[0].txt(name) : []), networkCopy: await this.networkCopy(company) }, this.d.now());
    const setup = await this.d.store.getSetup(trooth_id);
    if (setup) await this.d.store.putSetup({ ...setup, detection: { host: result.host, at: result.checked_at } });
    return ok(200, result);
  }

  /** One GET to the company's site through the SSRF-guarded probe (null when it could not be reached). */
  async siteProbe(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array } | null> {
    if (!this.d.siteProbe) return null;
    try {
      return await this.d.siteProbe(url, headers);
    } catch {
      return null;
    }
  }

  /** The two well-known documents exactly as the Trooth-hosted routes answer them. */
  async networkCopy(company: CompanyRecord): Promise<{ semanto: Uint8Array; keys: Uint8Array }> {
    const file = await this.d.versions.getCurrent(company.trooth_id);
    // /.well-known/trooth.semanto on the company's domain is the Semanto file itself (docs/spec/semanto-file.md): every
    // adapter answers it from GET /public/semanto/{trooth_id} (adapters/shared/semanto-adapter.mjs API_PATHS.manifest),
    // byte for byte as that route serves it. The short pointer document stands in only before anything is built.
    const semanto = file ? JSON.stringify(file) : JSON.stringify(wellKnownSemanto(company, file, this.d.config));
    return { semanto: utf8(semanto), keys: utf8(JSON.stringify(await this.d.keys.getCompanyJwks(company.trooth_id))) };
  }

  /** GET /os/semanto/{id}/writeback: what write-back would send, built from the signed record. Nothing is sent. */
  private async writebackPreview(trooth_id: string): Promise<WorkspaceResult> {
    const record = await this.signedRecord(trooth_id);
    if (!record) return problem("conflict", "Write-back is built from the signed record. Sign a version first.");
    const config = await this.d.store.getConfig(trooth_id);
    const file = (await this.d.versions.getCurrent(trooth_id))!;
    const generated = generateJsonLd(file, { troothProfileUrl: `${this.d.config.network_base}/${trooth_id}` });
    // The homepage as it is now, read on demand when the preview is opened (2026-10-23: the preview compared against an
    // empty page, so every company was told to add the whole block). A page that does not answer is compared as empty.
    const home = `https://${record.domain}/`;
    let current: unknown[] = [];
    try {
      const page = await this.fetcher().fetch(home);
      if (page.ok && page.status === 200) current = jsonLdBlocks(page.text).blocks;
    } catch {
      current = [];
    }
    const ctx: WritebackContext = {
      at: iso(this.d.now()),
      ...(config.writeback?.merchant_center ? { merchantCenter: config.writeback.merchant_center } : {}),
      ...(config.writeback?.business_profile_location ? { businessProfileLocation: config.writeback.business_profile_location } : {}),
      pages: [{ url: home, current, generated: generated.graph }],
    };
    const { payloads, skipped } = allPayloads(record, ctx);
    return ok(200, { object: "semanto.writeback_preview", trooth_id, payloads, skipped });
  }

  /** POST /os/semanto/{id}/competitor-report: the free side-by-side with up to three others (src/gap/competitor.ts). */
  private async competitorReport(trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const kind = body.kind === "shopping" ? "shopping" : body.kind === "local" || body.kind === undefined ? "local" : null;
    if (!kind) return problem("invalid_request", "kind is local or shopping.");
    const list = Array.isArray(body.competitors) ? body.competitors.filter(isRecord) : [];
    const competitors = list.map((c) => ({ name: str(c.name) ?? "", domain: str(c.domain) ? (cleanDomain(str(c.domain)!) ?? "") : "" })).filter((c) => c.name && c.domain);
    if (competitors.length < 1 || competitors.length > MAX_COMPETITORS || competitors.length !== list.length) return problem("invalid_request", `Send 1 to ${MAX_COMPETITORS} competitors as [{ "name", "domain" }].`);
    const me = { name: company.org, domain: company.domain };
    const runs = await runCompetitorQuestions(kind, me, competitors, this.d.gapAdapters());
    const view = buildCompetitorView(kind, me, competitors, runs, iso(this.d.now()));
    return ok(200, { object: "semanto.competitor_report", view, markdown: renderCompetitorMarkdown(view) });
  }

  /** GET /os/semanto/{id}/receipts: a day's read receipts as a digest signed by Trooth's witness key, with the dashboard rows. */
  private async receiptsDigest(trooth_id: string, day?: string): Promise<WorkspaceResult> {
    if (!this.d.receiptStore) return problem("conflict", "Read receipts are not kept in this deployment.");
    const d = day ?? utcDay(new Date(this.d.now().getTime() - 24 * 60 * 60 * 1000));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return problem("invalid_request", "day is YYYY-MM-DD.");
    const { from, to } = dayBounds(d);
    const rows = await this.d.receiptStore.list(trooth_id, from, to);
    const signed = await signDailyDigest(trooth_id, d, rows, await this.d.keys.getWitnessKey(), this.d.now());
    return ok(200, { object: "semanto.receipts_digest", trooth_id, day: d, digest: signed.digest, jws: signed.jws, rows: dashboardRows(rows) });
  }

  /** GET /os/semanto/{id}/receipts.csv?from=&to=: the receipts as RFC 4180 CSV (at most 31 days). */
  private async receiptsCsvRead(trooth_id: string, from?: string, to?: string): Promise<WorkspaceResult> {
    if (!this.d.receiptStore) return problem("conflict", "Read receipts are not kept in this deployment.");
    const end = to ? Date.parse(to) : this.d.now().getTime();
    const start = from ? Date.parse(from) : end - 7 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return problem("invalid_request", "from and to are ISO 8601 times, from before to.");
    if (end - start > 31 * 24 * 60 * 60 * 1000) return problem("invalid_request", "Ask for at most 31 days at a time.");
    const rows = await this.d.receiptStore.list(trooth_id, new Date(start).toISOString(), new Date(end).toISOString());
    return { status: 200, raw: { contentType: "text/csv", text: receiptsCsv(rows) } };
  }

  // ---------------------------------------------------------------- the commerce catalog

  async catalog(trooth_id: string, req: SignedRequest): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const keys = await this.d.store.connectorKeys(trooth_id);
    const nowSec = Math.floor(this.d.now().getTime() / 1000);
    const sig = await verifyMessage(
      { kind: "request", method: req.method, url: req.url, headers: req.headers },
      { resolveKey: (kid) => keys.find((k) => k.kid === kid) ?? null, required: [...CONNECTOR_COMPONENTS], tag: CONNECTOR_TAG, now: nowSec, maxAgeSeconds: CONNECTOR_MAX_AGE_SECONDS },
    );
    const seen = async (kid: string | null, result: "ok" | "signature_failed") => {
      if (kid && this.d.connectorSeen && keys.some((k) => k.kid === kid)) await this.d.connectorSeen(kid, iso(this.d.now()), result).catch(() => undefined);
    };
    if (!sig.ok) {
      await seen(namedConnectorKid(req.headers), "signature_failed");
      return problem("unauthorized", `The connector signature did not check out (${sig.reason}). Paste the connector's public key into the dashboard under Delivery, Connectors, and sign with tag trooth-connector.`);
    }
    if (req.body.length > CATALOG_MAX_BYTES) return problem("payload_too_large", "The catalog is larger than 5 MB. Send it in parts.");
    if (!(await verifyContentDigest(req.headers.get("content-digest"), req.body))) {
      await seen(sig.keyid, "signature_failed");
      return problem("unauthorized", "Content-Digest does not match the body.");
    }
    // A nonce on every catalog request, claimed once (atomically in the NonceDO), so a captured request cannot be replayed.
    if (!sig.params.nonce) return problem("unauthorized", "The connector signature carries no nonce. Update the connector; every request needs a fresh nonce.");
    if (this.d.nonces) {
      const until = (sig.params.expires ?? sig.params.created + CONNECTOR_MAX_AGE_SECONDS) * 1000;
      if (!(await this.d.nonces.claim(`${sig.keyid}:${sig.params.nonce}`, until, nowSec * 1000))) return problem("unauthorized", "This catalog request was already received (its nonce was used). Send a new request.");
    }
    await seen(sig.keyid, "ok");
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(req.body));
    } catch {
      return problem("invalid_request", "The catalog is not JSON.");
    }
    if (!isRecord(doc) || !Array.isArray(doc.products)) return problem("invalid_request", "The catalog needs a products array.");
    if (doc.trooth_id !== undefined && doc.trooth_id !== trooth_id) return problem("forbidden", `This catalog names ${String(doc.trooth_id)}, not ${trooth_id}.`);
    const currency = str(doc.currency)?.toUpperCase() ?? "USD";
    const at = typeof doc.generated_at === "string" && !Number.isNaN(Date.parse(doc.generated_at)) ? new Date(doc.generated_at).toISOString() : iso(this.d.now());
    const { records, offers, skipped, removed } = catalogToInputs(doc.products, { company, currency, at, source: str(doc.source) ?? "connector" });
    const key = company.custody === "hosted" ? await this.d.keys.getCompanySigningKey(trooth_id) : null;
    // A discontinued product is taken out of the offers at once: nothing is signed for it, and no key is needed to stop offering it.
    for (const sku of removed) await this.d.commerce.removeOffers(trooth_id, sku);
    if (!key) {
      return ok(202, { object: "semanto.catalog_receipt", trooth_id, signed: false, records: records.length, offers: offers.length, removed, skipped, reason: "This company holds its own signing key, so Trooth cannot sign the records. Sign them from your own tools; nothing was published." });
    }
    const policy = await this.d.commerce.offerPolicy(trooth_id);
    const signedRecords: SignedProductRecord[] = [];
    const signedOffers: SignedOffer[] = [];
    for (const input of records) {
      try {
        const s = await signProductRecord(input, key, { iat: this.d.now() });
        const existing = await this.d.commerce.record(trooth_id, s.record.id);
        await this.d.commerce.putRecord(trooth_id, s);
        if (!existing) await this.d.log.append({ kind: "product_record", trooth_id, ref: s.record.id, hash: await digest(canonicalize(s.record)), at: iso(this.d.now()) });
        signedRecords.push(s);
      } catch (e) {
        const id = this.requestId();
        if (this.d.logError) this.d.logError(id, "catalog record", e);
        skipped.push({ sku: input.sku, reason: `the record did not validate (request id ${id})` });
      }
    }
    for (const input of offers) {
      try {
        const s = await signOffer(input, key, policy, { iat: this.d.now() });
        await this.d.commerce.putOffer(trooth_id, s);
        signedOffers.push(s);
      } catch (e) {
        const id = this.requestId();
        if (this.d.logError) this.d.logError(id, "catalog offer", e);
        skipped.push({ sku: input.sku, reason: `the offer did not validate (request id ${id})` });
      }
    }
    return ok(202, {
      object: "semanto.catalog_receipt",
      trooth_id,
      signed: true,
      kid: key.kid,
      connector_kid: sig.keyid,
      records: signedRecords.map((r) => ({ id: r.record.id, sku: r.record.sku })),
      offers: signedOffers.map((o) => ({ id: o.offer.id, sku: o.offer.sku, as_of: o.offer.as_of, not_after: o.offer.not_after })),
      removed,
      skipped,
    });
  }

  // ---------------------------------------------------------------- scheduled work: the crons fan out, one queue message per 25 companies

  /** Enqueue one message per 25 companies, or run them inline without a queue. Answers what ran inline. */
  private async fanOut<T>(job: CompaniesMessage["job"], ids: string[], inline: (ids: string[]) => Promise<T[]>, per = COMPANIES_PER_MESSAGE, started_at?: string): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += per) {
      const chunk = ids.slice(i, i + per);
      if (this.d.enqueue) await this.d.enqueue({ kind: "companies", job, trooth_ids: chunk, ...(started_at ? { started_at } : {}) });
      else out.push(...(await inline(chunk)));
    }
    return out;
  }

  /**
   * Hourly: queue change detection for every signed company. There is no
   * pending-proof sweep: a domain is proven on trooth.co, and Semanto reads
   * that confirmation with the person's own credential when they next open
   * setup (src/setup/workspace-domains.ts).
   */
  async hourlyChangeDetection(): Promise<{ trooth_id: string; changed: string[] }[]> {
    const signed = (await this.d.store.listCompanies("signed")).map((c) => c.trooth_id);
    return this.fanOut("changes", signed, (ids) => this.checkCompanyChanges(ids));
  }

  /** For these companies, check each signed page cheaply (sitemap lastmod, conditional GET, raw hash) and queue a rebuild of what changed. */
  /** The shortest time between two builds that change detection starts (23 hours, so the daily one lands on the same hour). */
  static readonly CHANGE_REBUILD_INTERVAL_MS = 23 * 3600_000;
  /** When only live pages changed: a build at most once a week, so they do not go stale. */
  static readonly LIVE_ONLY_REBUILD_INTERVAL_MS = 7 * 24 * 3600_000 - 3600_000;

  async checkCompanyChanges(trooth_ids: string[]): Promise<{ trooth_id: string; changed: string[] }[]> {
    const out: { trooth_id: string; changed: string[] }[] = [];
    const detector = new ChangeDetector(this.fetcher());
    for (const trooth_id of trooth_ids) {
      const company = await this.d.store.getCompany(trooth_id);
      const file = company ? await this.d.versions.getCurrent(trooth_id) : null;
      if (!company || !file) continue;
      // A read already running for this company finishes first: a second one would read the same pages again and
      // compete with it, and with a signing, for the same database (2026-10-24).
      const running = await this.staging.latestBuild(trooth_id);
      if (running && !["done", "failed"].includes(running.status)) {
        out.push({ trooth_id, changed: [] });
        continue;
      }
      const state = await this.d.store.changeState(trooth_id);
      // The newest build, signed or not: rows written after it are the changes it does not hold yet.
      const since = (await this.d.store.latestFile(trooth_id))?.file.header.built_at ?? file.header.built_at;
      const changed: string[] = [];
      const pending: string[] = [];
      const seen = new Set<string>();
      for (const page of file.header.pages_manifest) {
        if (seen.has(page.url)) continue;
        seen.add(page.url);
        const prev = state[page.url];
        const capture = { etag: prev?.etag ?? null, lastModified: prev?.last_modified ?? null, source_hash: prev?.raw_hash ?? page.source_hash, lastmod: prev?.lastmod ?? null };
        const r = await detector.check(page.url, capture, null);
        if (r.fetch && r.fetch.ok && r.fetch.status === 200) {
          // The words changed: the new text hash and the time it was seen. They did not: only the validators move, and
          // the row keeps the hash and time of the version it describes, so the review never reports a page as changed
          // because its bytes carried a new nonce.
          // A change remembers the one before it when that one was also seen by a check (after the newest build); a
          // row a build wrote holds the build's time, which is not a change, so it carries no earlier change.
          const row: ChangeRow = r.changed
            ? { etag: r.fetch.etag, last_modified: r.fetch.lastModified, raw_hash: await contentHash(r.fetch.text), lastmod: prev?.lastmod ?? null, checked_at: r.fetch.fetchedAt, prev_change_at: prev && prev.checked_at > since ? prev.checked_at : null }
            : { etag: r.fetch.etag, last_modified: r.fetch.lastModified, raw_hash: prev?.raw_hash ?? (await contentHash(r.fetch.text)), lastmod: prev?.lastmod ?? null, checked_at: prev?.checked_at ?? file.header.built_at, prev_change_at: null };
          await this.d.store.putChangeState(trooth_id, page.url, row);
          if (row.checked_at > since) pending.push(page.url);
        } else if (prev && prev.checked_at > since) pending.push(page.url);
        if (r.changed) changed.push(page.url);
      }
      // Every change is recorded within the hour (readers get the signed copy marked behind), but a new version is
      // built at most once a day: a status page or a live count changes every hour, and a version to sign each hour
      // helps no one. The rebuild carries every page changed since the newest build (2026-10-24). A live page (words
      // changed twice within 48 hours) does not start one on its own: it rides along with the next change to an
      // ordinary page, or with the weekly build that keeps it from going stale (2026-10-25).
      const lastBuild = running ? Date.parse(running.requested_at) : 0;
      const sinceBuild = this.d.now().getTime() - lastBuild;
      const after = await this.d.store.changeState(trooth_id);
      const ordinary = pending.filter((u) => !isLivePage(after[u]));
      const due = sinceBuild >= Pipeline.CHANGE_REBUILD_INTERVAL_MS && (ordinary.length > 0 || sinceBuild >= Pipeline.LIVE_ONLY_REBUILD_INTERVAL_MS);
      if (pending.length && due) {
        const job: CompileJob = { trooth_id, domain: company.domain, reason: "change_detected", changed_urls: pending, requested_at: iso(this.d.now()) };
        if (this.d.enqueue) await this.d.enqueue(job);
        else await this.compile(job);
        await this.promptToSign(company, pending);
      }
      out.push({ trooth_id, changed });
    }
    return out;
  }

  /** when_page_changed "prompt_to_sign": the owner is emailed that pages changed and a new version is ready to sign. */
  private async promptToSign(company: CompanyRecord, changed: string[]): Promise<void> {
    const settings = (await this.d.settings.get(company.trooth_id)) ?? DEFAULT_SETTINGS;
    if (settings.when_page_changed !== "prompt_to_sign") return;
    const to = (await this.d.store.getConfig(company.trooth_id)).alert_emails;
    if (!to.length || !this.d.monitor.email || !this.d.monitor.from) return;
    const n = changed.length;
    const text = `${n} page${n === 1 ? "" : "s"} on ${company.domain} changed after your last signature. Readers get the last signed copy marked behind until you sign the new version.\n\nSign it here: ${this.d.config.network_base}/${company.trooth_id}\n`;
    await this.d.monitor.email.send({ from: this.d.monitor.from, to, subject: `${n} page${n === 1 ? "" : "s"} on ${company.domain} changed: sign the new version`, text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
  }

  /** Nightly: sign a tree head, anchor it with an RFC 3161 timestamp, and re-sign every revocation list (each company's and everyone's). */
  async nightlyCheckpoint(): Promise<{ tree_head: { tree_size: number; root_hash: string } | null; timestamp: unknown; revocations: number; receipts_pruned: number }> {
    const size = await this.d.log.ledger.size();
    let head = null;
    let timestamp: unknown = null;
    if (size > 0) {
      const signed = await this.d.log.signTreeHead(size);
      head = { tree_size: signed.tree_size, root_hash: signed.root_hash };
      timestamp = await this.timestamp(signed);
    }
    const entries = await this.d.store.revocations(null);
    await this.resignRevocations(null);
    // Each company's 24-hour list is re-signed on the queue, 100 companies a message (ARCH-6): one cron call no longer
    // signs every list, so the nightly job stays inside a Worker's limits at any number of companies.
    const ids = [...new Set((await this.d.store.listCompanies("all")).map((c) => c.trooth_id))];
    await this.fanOut("revocations", ids, (chunk) => this.resignRevocationsFor(chunk), REVOCATIONS_PER_MESSAGE);
    return { tree_head: head, timestamp, revocations: entries.length, receipts_pruned: await this.pruneReceipts() };
  }

  /** Delete read receipts older than RECEIPT_RETENTION_DAYS. A failure is logged and left for the next night. */
  async pruneReceipts(): Promise<number> {
    if (!this.d.receiptStore?.prune) return 0;
    const before = iso(new Date(this.d.now().getTime() - RECEIPT_RETENTION_DAYS * 86_400_000));
    try {
      return await this.d.receiptStore.prune(before, RECEIPT_PRUNE_LIMIT);
    } catch (e) {
      console.error(JSON.stringify({ alert: "receipt_prune_failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
      return 0;
    }
  }

  /** Re-sign the revocation lists of these companies (a queued "revocations" message, or inline without a queue). */
  async resignRevocationsFor(trooth_ids: string[]): Promise<string[]> {
    for (const trooth_id of trooth_ids) await this.resignRevocations(trooth_id);
    return trooth_ids;
  }

  /** Sign and store the revocation list for one company (or everyone with null), 24 hours valid. */
  async resignRevocations(trooth_id: string | null): Promise<{ jws: string; issued_at: string }> {
    const now = this.d.now();
    const entries = await this.d.store.revocations(trooth_id);
    const { jws } = await signRevocationList(entries, trooth_id, await this.d.keys.getWitnessKey(), now);
    await this.d.store.putRevocationList(trooth_id, jws, iso(now));
    await this.d.store.putBlob(trooth_id ? `semanto/${trooth_id}/revocations/latest.jws` : "semanto/revocations/latest.jws", utf8(jws), "application/jose");
    return { jws, issued_at: iso(now) };
  }

  /** Weekly (WEEKLY_RUN.cron): queue the gap reports, one message per 25 signed companies. */
  async weeklyGapReports(): Promise<{ trooth_id: string; kinds: QuestionKind[]; errors: string[] }[]> {
    if (!this.d.gapReports) return [];
    const ids = (await this.d.store.listCompanies("signed")).map((c) => c.trooth_id);
    // One company a message: a report asks every question of every assistant, so one company fills a consumer's time.
    const started_at = iso(this.d.now());
    return this.fanOut("gap", ids, (chunk) => this.gapReportsFor(chunk, started_at), 1, started_at);
  }

  /** The gap report for these companies, for the kinds each asked for. */
  async gapReportsFor(trooth_ids: string[], started_at?: string): Promise<{ trooth_id: string; kinds: QuestionKind[]; errors: string[] }[]> {
    const out: { trooth_id: string; kinds: QuestionKind[]; errors: string[] }[] = [];
    for (const trooth_id of trooth_ids) {
      const config = await this.d.store.getConfig(trooth_id);
      const kinds = (config.gap.kinds.length ? config.gap.kinds : WEEKLY_RUN.kinds.slice(0, 1)).filter((k) => (k === "shopping" ? config.gap.products.length > 0 : k === "competitor" ? Boolean(config.gap.competitor) : true));
      const errors: string[] = [];
      // A retried message (or a second delivery) skips each kind already reported in this run, so nothing is asked twice.
      const done = new Set(started_at ? (await this.d.store.gapReportsSince(trooth_id, started_at)).map((r) => r.kind) : []);
      for (const kind of kinds) {
        if (done.has(kind)) continue;
        const r = await this.gapReport(trooth_id, { kind });
        if (r.problem) errors.push(`${kind}: ${r.problem.detail}`);
      }
      out.push({ trooth_id, kinds, errors });
    }
    return out;
  }

  /** The JobPort the serving layer's scheduled and queue handlers call. */
  jobs(): JobPort {
    return {
      hourlyChangeDetection: async () => {
        await this.hourlyChangeDetection();
      },
      nightlyCheckpoint: async () => {
        await this.nightlyCheckpoint();
      },
      weeklyGapReports: async () => {
        await this.weeklyGapReports();
      },
      compile: async (message: unknown, attempts?: number) => {
        await this.consume(message, attempts ?? 1);
      },
      failed: async (message: unknown, e: unknown) => {
        await this.consumeFailed(message, e);
      },
    };
  }
}

// ---------------------------------------------------------------- commerce helpers

/** The keyid a request's trooth-connector signature names, read from Signature-Input without checking it, or null. */
export function namedConnectorKid(headers: Headers): string | null {
  const si = headers.get("signature-input");
  if (!si) return null;
  try {
    const inputs = parseSignatureInput(si);
    for (const v of Object.values(inputs)) if (v.params.tag === CONNECTOR_TAG && typeof v.params.keyid === "string") return v.params.keyid;
  } catch {
    return null;
  }
  return null;
}

function toMonitorProduct(s: SignedProductRecord): MonitorProduct {
  const r = s.record;
  return {
    product_id: r.product_id,
    ...(r.variant_id ? { variant_id: r.variant_id } : {}),
    ...(r.gtin ? { gtin: r.gtin } : {}),
    sku: r.sku,
    name: r.name,
    url: r.url,
    brand: r.brand,
    description: r.description,
    ...(r.regulatory.consumer_notice ? { consumer_notice: { ...(r.regulatory.consumer_notice_type ? { type: r.regulatory.consumer_notice_type } : {}), message: r.regulatory.consumer_notice } } : {}),
    record_id: r.id,
    witnessed_at: r.evidence.witnessed_at,
    ...(imageOf(r.media) ? { image_url: imageOf(r.media)! } : {}),
  };
}

/** The first image among a record's media, by its file extension. */
function imageOf(media: { url: string }[]): string | null {
  return media.find((m) => /\.(png|jpe?g|gif|webp|avif|tiff?|heic)(?:[?#]|$)/i.test(m.url))?.url ?? null;
}

function toMonitorOffer(s: SignedOffer): MonitorOffer {
  const o = s.offer;
  return { offer_id: o.id, sku: o.sku, ...(o.variant_id ? { variant_id: o.variant_id } : {}), price: { amount: formatMinor(o.price), currency: o.price.currency }, availability: o.availability, url: o.url, as_of: o.as_of, not_after: o.not_after };
}

const STOCK: Record<string, Availability> = { instock: "in_stock", in_stock: "in_stock", outofstock: "out_of_stock", out_of_stock: "out_of_stock", onbackorder: "backorder", backorder: "backorder", preorder: "preorder", discontinued: "discontinued" };
const AXES: Record<string, keyof VariantAxes> = { color: "color", colour: "color", size: "size", formulation: "formulation", edition: "edition" };

/** Map the connector catalog document (adapters/wordpress-plugin/README.md) to product record and offer inputs. */
export function catalogToInputs(products: unknown[], ctx: { company: CompanyRecord; currency: string; at: string; source: string }): { records: ProductRecordInput[]; offers: OfferInput[]; skipped: { sku: string; reason: string }[]; removed: string[] } {
  const records: ProductRecordInput[] = [];
  const offers: OfferInput[] = [];
  const skipped: { sku: string; reason: string }[] = [];
  /** Skus sent as discontinued: a connector has no delete call, so this is how a deleted or unpublished product leaves the offers. */
  const removed: string[] = [];
  const seller = { domain: ctx.company.domain, trooth_id: ctx.company.trooth_id };
  const one = (p: Record<string, unknown>, parent: Record<string, unknown> | null) => {
    const id = str(String(p.id ?? "")) ?? null;
    const sku = str(p.sku) ?? (id ? `${ctx.source}-${id}` : null);
    if (String(p.stock_status ?? "").toLowerCase() === "discontinued" && sku) {
      removed.push(sku);
      return;
    }
    const url = str(p.url) ?? (parent ? str(parent.url) : undefined);
    const name = str(p.name) ?? (parent ? str(parent.name) : undefined);
    if (!sku || !url || !name) {
      skipped.push({ sku: sku ?? id ?? "unknown", reason: "a product needs a sku or id, a name and an https url" });
      return;
    }
    const attrs = isRecord(p.attributes) ? Object.entries(p.attributes).filter((e): e is [string, string] => typeof e[1] === "string") : [];
    const axes: VariantAxes = {};
    for (const [k, v] of attrs) {
      const axis = AXES[k.replace(/^pa_/, "").toLowerCase()];
      if (axis) axes[axis] = v;
    }
    const gtinRaw = str(p.gtin);
    const gtin = gtinRaw && isValidGtin(gtinRaw) ? gtinRaw : undefined;
    const productId = parent ? String(parent.id ?? sku) : String(p.id ?? sku);
    records.push({
      product_id: productId,
      ...(parent ? { variant_id: String(p.id ?? sku), parent_product_id: String(parent.id ?? productId) } : {}),
      ...(gtin ? { gtin } : {}),
      sku,
      brand: ctx.company.org,
      name,
      description: str(p.description) ?? (parent ? (str(parent.description) ?? "") : ""),
      attributes: attrs.map(([k, v]) => ({ name: k.replace(/^pa_/, ""), value: v })),
      regulatory: {},
      media: [],
      url,
      variant_axes: axes,
      provenance: "declared",
      evidence: { url, witnessed_at: ctx.at },
      not_before: ctx.at,
    });
    const priceText = str(p.sale_price) ?? str(p.price);
    const amount = priceText ? parseMinor(priceText, ctx.currency) : null;
    const availability = STOCK[String(p.stock_status ?? "").toLowerCase()];
    if (amount === null || !availability) {
      skipped.push({ sku, reason: "no offer: the price or the stock status is missing" });
      return;
    }
    offers.push({
      sku,
      ...(parent ? { variant_id: String(p.id ?? sku) } : {}),
      price: { amount, currency: ctx.currency },
      availability,
      ...(typeof p.stock === "number" && Number.isInteger(p.stock) && p.stock >= 0 ? { inventory_quantity: p.stock } : {}),
      as_of: ctx.at,
      seller,
      url,
    });
  };
  for (const raw of products) {
    if (!isRecord(raw)) continue;
    const variants = Array.isArray(raw.variants) ? raw.variants.filter(isRecord) : [];
    if (variants.length) for (const v of variants) one(v, raw);
    else one(raw, null);
  }
  return { records, offers, skipped, removed };
}

/** A commerce store whose company() is answered from the company rows, so the feeds and the UCP manifest name the company the records belong to. */
export function withCompanies(inner: CommerceStore, companies: { getCompany(id: string): Promise<CompanyRecord | null> }, publicApiBase: string): CommerceStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "company") {
        return async (trooth_id: string): Promise<FeedCompany | null> => {
          const own = await target.company(trooth_id);
          if (own) return own;
          const c = await companies.getCompany(trooth_id);
          return c ? { trooth_id, domain: c.domain, public_base: `${publicApiBase}/${trooth_id}`, jwks_url: jwksUrl(c.domain) } : null;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------- readers and receipts

/**
 * The receipt middleware's readers hook over src/readers/webbotauth.ts and
 * src/readers/forwarded.ts. A request forwarded by an adapter is proven only
 * when the adapter's connector signature (against that company's connector
 * keys) checks out; then the agent's signature is checked against the
 * forwarded authority and the forwarded address is used. A failure proves
 * nothing and names nobody.
 */
export function webBotAuthReaders(deps: WebBotAuthDeps, forwarding?: (trooth_id: string) => Promise<ForwardingContext | null>): { verify(req: Request, trooth_id?: string): Promise<ReaderProof> } {
  return {
    async verify(req, trooth_id) {
      const ctx = forwarding && trooth_id ? await forwarding(trooth_id) : null;
      return proveReader({ method: req.method, url: req.url, headers: req.headers }, deps, ctx);
    },
  };
}

/** The forwarding context for a company: its connector keys and its domain, from the pipeline store. */
export function forwardingFromStore(store: Pick<PipelineStore, "getCompany" | "connectorKeys">): (trooth_id: string) => Promise<ForwardingContext | null> {
  return async (trooth_id) => {
    const company = await store.getCompany(trooth_id);
    if (!company) return null;
    return { domain: company.domain, connectorKeys: await store.connectorKeys(trooth_id) };
  };
}

/**
 * Read receipts through src/readers/receipts.ts: the remote address is hashed
 * with a daily salt from the secret and never kept, and an agent is named only
 * when its key was proven.
 */
export class ReaderReceipts implements ReceiptPort {
  constructor(
    private readonly store: ReceiptStore,
    private readonly secret: string,
  ) {}
  async record(input: ReceiptInput): Promise<void> {
    const auth: WebBotAuthResult | null = input.proof === "web_bot_auth" && input.agent_key_url && input.keyid ? { proven: true, agent_key_url: input.agent_key_url, keyid: input.keyid, directory_signed: false } : null;
    await recordRead(
      { trooth_id: input.trooth_id, version: input.version, page_id: input.page_id, representation: input.representation, auth, read_at: new Date(input.read_at), address: input.address ?? "0.0.0.0" },
      this.secret,
      this.store,
    );
  }
}

// ---------------------------------------------------------------- workspace authorization through worker-f

/** The slice of a Cloudflare service binding this needs. */
export interface ServiceFetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/**
 * The address worker-f answers a session check at; it reads the bearer token
 * against app_sessions. Reached through the TROOTH_OS binding, which ignores
 * the host; the public host is kept so a DPoP proof trooth.co's server signed
 * for this exact address (RFC 9449, htu) passes worker-f's gate.
 */
export const TROOTH_OS_SESSION_URL = "https://api.trooth.co/auth/session";

/** The header trooth.co's server sends with the DPoP proof for TROOTH_OS_SESSION_URL. */
export const SESSION_PROOF_HEADER = "trooth-os-session-proof";

const ROLES: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
/** A DPoP proof is a compact JWS: three base64url parts. Anything else is not forwarded. */
const PROOF_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const proofFrom = (req: Request, header: string): string | null => {
  const v = req.headers.get(header)?.trim() ?? "";
  return v.length <= 4096 && PROOF_RE.test(v) ? v : null;
};

/**
 * Read a worker-f session through the TROOTH_OS service binding (GET
 * /auth/session in worker-f app-api.ts, read 22 Oct 2026). That route answers
 * { authenticated, companyId, userId, email, role, companyName } where role is
 * the account type, "vendor" or "buyer", and, once worker-f has team seats,
 * workspaceRole (owner, admin, member, viewer); companySlug (the
 * app_company_profile slug) and signedInAt when it sends them. Null when there
 * is no binding, no token, a refused session, or a buyer account (it has no
 * company to act for). This is the claim variant of authorization: a valid
 * session with no Semanto company yet (POST /os/semanto/claim, POST
 * /os/semanto/setup/start, GET /os/semanto/setup).
 *
 * worker-f accepts a session token only with a DPoP proof signed by
 * trooth.co's server key when SESSION_DPOP_REQUIRED is on (worker-f
 * src/dpop.ts). The bearer cannot carry a proof for another address, so
 * trooth.co's server signs one proof for each worker-f address this Worker
 * reads and sends them as Trooth-Os-Session-Proof and Trooth-Os-Domains-Proof;
 * each is used once, with the DPoP scheme. Without them the plain bearer is
 * sent, which worker-f accepts only where proofs are not required.
 *
 * The session also carries the WorkspaceDomains port bound to this caller
 * (src/setup/workspace-domains.ts): the workspace's domains on trooth.co.
 */
export function troothOsSession(service: ServiceFetcher | undefined): (req: Request) => Promise<WorkspaceSession | null> {
  return async (req) => {
    if (!service) return null;
    const auth = req.headers.get("authorization");
    if (!auth || !/^Bearer\s+\S+$/i.test(auth)) return null;
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const sessionProof = proofFrom(req, SESSION_PROOF_HEADER);
    let res: Response;
    try {
      res = await service.fetch(TROOTH_OS_SESSION_URL, { method: "GET", headers: sessionProof ? { authorization: `DPoP ${token}`, dpop: sessionProof, accept: "application/json" } : { authorization: auth, accept: "application/json" } });
    } catch {
      throw new SessionUnavailable(null);
    }
    if (res.status >= 500) throw new SessionUnavailable(res.status);
    if (res.status !== 200) return null;
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      return null;
    }
    if (!isRecord(j) || j.authenticated !== true) return null;
    const companyId = str(j.companyId);
    if (!companyId) return null;
    const accountType = str(j.role) ?? "vendor";
    if (accountType !== "vendor") return null;
    const stated = str(j.workspaceRole) as WorkspaceRole | undefined;
    const signedIn = str(j.signedInAt);
    const email = str(j.email) ?? null;
    return {
      os_company_id: companyId,
      user_id: str(j.userId) ?? "unknown",
      name: email ?? "Workspace member",
      role: stated !== undefined && ROLES.includes(stated) ? stated : null,
      company_slug: str(j.companySlug) ?? null,
      signed_in_at: signedIn && !Number.isNaN(Date.parse(signedIn)) ? new Date(signedIn).toISOString() : null,
      email,
      company_name: str(j.companyName) ?? null,
      domains: troothOsWorkspaceDomains(service, { token, proof: proofFrom(req, DOMAINS_PROOF_HEADER) }),
    };
  };
}

/**
 * Accept a workspace bearer token for a company's /os routes: the session
 * (troothOsSession) mapped to the company through
 * semanto_companies.os_company_id, which the claim writes, never guessed from
 * a name.
 *
 *   workspaceRole present   it is the role, as worker-f states it
 *   absent                  owner only when userId is the company's registered
 *                           owner (semanto_companies.os_owner_user_id, set by
 *                           the claim); every other vendor session is a member
 *
 * Deny (null) when there is no session or the session's company is not mapped.
 */
export function troothOsAuthorize(
  service: ServiceFetcher | undefined,
  troothIdForCompany: (os_company_id: string) => Promise<string | null> = async () => null,
  ownerUserIdFor: (trooth_id: string) => Promise<string | null> = async () => null,
): (req: Request, trooth_id: string) => Promise<WorkspaceAuth | null> {
  const session = troothOsSession(service);
  return async (req) => {
    const s = await session(req);
    if (!s) return null;
    const trooth_id = await troothIdForCompany(s.os_company_id);
    if (!trooth_id) return null;
    let role: WorkspaceRole;
    if (s.role) role = s.role;
    else {
      const owner = await ownerUserIdFor(trooth_id);
      role = owner !== null && s.user_id !== "unknown" && owner === s.user_id ? "owner" : "member";
    }
    return { trooth_id, role, user_id: s.user_id, name: s.name, ...(s.domains ? { domains: s.domains } : {}) };
  };
}
