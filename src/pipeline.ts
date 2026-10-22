// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The pipeline: the modules wired into one flow, behind the ports.
//
//   compile    src/compiler discover, fetch and build (incremental when a
//              previous version exists); bodies and metadata stored; state read
//   sign       hosted custody signs with the company key (src/identity/keys.ts);
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

import type { CompileJob } from "./env";
import { utf8, fromBase64Url, toBase64Url } from "./core/encoding";
import { canonicalize } from "./core/canonical";
import { digest } from "./core/hash";
import { estimateTokens } from "./core/tokens";
import { JWS_TYPES, signObject } from "./core/jws";
import { importPrivate, sign as rawSign, toPublic, type PrivateJwk, type PublicJwk } from "./core/keys";
import { verifyContentDigest, verifyMessage } from "./core/httpsig";
import { factsRoot, rootHash, tierHash, versionId, type Fact, type Identity, type SemantoFile, type SemantoHeader } from "./core/semanto";
import { Fetcher, ChangeDetector, type FetcherOptions } from "./compiler/fetch";
import { discover } from "./compiler/discover";
import { buildVersion, type FetchedPage } from "./compiler/build";
import { generateJsonLd } from "./compiler/jsonld";
import { extract } from "./compiler/extract";
import { registrableDomain } from "./compiler/url";
import type { HttpPort as SiteHttpPort, Resolver } from "./compiler/ports";
import { assembleJws, acceptCustomerPublicKey, checkAssembledJws, createHostedKey, currentKey, jwksUrl, rotateHostedKey, versionSigningInput, ROTATION_OVERLAP_MS } from "./identity/keys";
import { mayBeSigned, roleFromWorkspace } from "./identity/roles";
import { compareLegalName, leiFacts, lookupLei } from "./identity/lei";
import type { HttpPort as IdentityHttpPort } from "./identity/ports";
import { treeHeadId, type LogStore } from "./ledger/log";
import type { LogLeaf } from "./ledger/ports";
import { timestampTreeHead } from "./ledger/timestamp";
import type { FetchPort as LedgerFetchPort } from "./ledger/ports";
import { signRevocationList } from "./ledger/revocation";
import { type WebBotAuthDeps, type WebBotAuthResult } from "./readers/webbotauth";
import { proveReader, type ForwardingContext, type ReaderProof } from "./readers/forwarded";
import { recordRead } from "./readers/receipts";
import type { NonceStore, ReceiptStore } from "./readers/ports";
import { runMonitor, type AvailableSurfaces } from "./monitor/run";
import type { ClockPort, EmailPort, FetchPort as MonitorFetchPort, StorePort as MonitorStorePort, TokenPort } from "./monitor/ports";
import type { Offer as MonitorOffer, Product as MonitorProduct, SignedRecord } from "./monitor/types";
import { questionsFor, type QuestionKind, type QuestionParams } from "./gap/prompts";
import type { ProviderAdapter } from "./gap/providers";
import { renderGapReportMarkdown, runGapReport, WEEKLY_RUN } from "./gap/report";
import { basicHeaders, basicResponse, buildBasic, claim, dnsClaimName, dnsClaimRecord, measureSetup, proveDomain, SETUP_CHECKLIST, wellKnownClaimUrl } from "./basic/tier";
import type { DomainProofPort } from "./basic/ports";
import { createFirstPublication, exportDisputeStatement } from "./basic/first-publication";
import { formatMinor, parseMinor, signOffer, type Availability, type OfferInput } from "./commerce/offers";
import { isValidGtin, signProductRecord, type ProductRecordInput, type VariantAxes } from "./commerce/product-record";
import type { CommerceStore } from "./commerce/ports";
import type { FeedCompany } from "./commerce/feeds";
import type { SignedOffer } from "./commerce/offers";
import type { SignedProductRecord } from "./commerce/product-record";
import { DEFAULT_SETTINGS } from "./settings/delivery";
import type { CompanyRecord, JobPort, KeyPort, ReceiptInput, ReceiptPort, ServeConfig, SettingsPort, SignedRequest, VersionStore, WorkspaceAction, WorkspaceAuth, WorkspaceHandlers, WorkspaceResult, WorkspaceRole } from "./serve/ports";
import type { LedgerLogPort } from "./serve/ledger-port";
import type { ProblemCode } from "./serve/errors";
import type { PipelineStore, StoredVersion } from "./pipeline-store";
export type { WebBotAuthResult };

export const CONNECTOR_TAG = "trooth-connector";
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
  domainProof: DomainProofPort;
  /** RFC 3161 time-stamp authority, when TSA_URL is set. */
  tsa?: { url: string; fetch: LedgerFetchPort };
  /** The gap report's providers (src/gap/providers.ts allAdapters with the Env keys in the Worker). */
  gapAdapters(): ProviderAdapter[];
  /** The compile queue. Without it, compile jobs run inline. */
  enqueue?: (job: CompileJob) => Promise<void>;
  /** Random bytes, injectable for tests. */
  random?: (n: number) => Uint8Array;
  /** Atomic nonce claims for the connector catalog route (the NonceDO Durable Object in the Worker). */
  nonces?: NonceStore;
  /** Where a failed step's exception goes, with its request id. Never to the client. */
  logError?: (request_id: string, action: string, error: unknown) => void;
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
  constructor(private readonly d: PipelineDeps) {}

  private random(n: number): Uint8Array {
    if (this.d.random) return this.d.random(n);
    return crypto.getRandomValues(new Uint8Array(n));
  }

  private fetcher(): Fetcher {
    return new Fetcher({ http: this.d.site.http, clock: { now: () => this.d.now() }, ...(this.d.site.resolve ? { resolve: this.d.site.resolve } : {}) }, this.d.site.fetcher ?? {});
  }

  // ---------------------------------------------------------------- compile (the queue consumer)

  async compile(job: CompileJob): Promise<CompileSummary> {
    const company = await this.d.store.getCompany(job.trooth_id);
    if (!company) throw new Error(`compile: no company ${job.trooth_id}`);
    const now = this.d.now();
    const fetcher = this.fetcher();
    const latest = await this.d.store.latestVersion(company.trooth_id);
    const discovery = await discover(company.domain, fetcher);
    const lastmod = new Map(discovery.urls.map((u) => [u.url, u.lastmod ?? null] as const));
    const fetched: FetchedPage[] = Object.values(discovery.fetched).map((f) => ({
      url: f.url,
      status: f.status,
      html: f.text,
      source_hash: f.source_hash,
      witnessed_at: f.fetchedAt,
      headers: f.headers,
      truncated: f.truncated,
      lastmod: lastmod.get(f.url) ?? null,
    }));
    const settings = (await this.d.settings.get(company.trooth_id)) ?? DEFAULT_SETTINGS;
    const config = await this.d.store.getConfig(company.trooth_id);
    const profile = `${this.d.config.network_base}/${company.trooth_id}`;
    const version = (latest?.file.header.version ?? 0) + 1;
    const identity: Identity = {
      domain: company.domain,
      trooth_id: company.trooth_id,
      ...(company.legal_name ? { legal_name: company.legal_name } : {}),
      ...(company.lei ? { lei: company.lei } : {}),
      key_binding: { jwks_url: jwksUrl(company.domain), dns_record: false },
    };
    const out = await buildVersion({
      org: company.org,
      identity,
      profile,
      version,
      supersedes: company.current_version,
      built_at: iso(now),
      discovery,
      fetched,
      controls: { content_signals: settings.content_signals },
      ...(latest ? { previous: { file: latest.file, bodies: latest.bodies } } : {}),
      ...(job.changed_urls ? { changed_urls: job.changed_urls } : {}),
    });
    let file = out.file;
    if (config.public_record_facts.length) {
      const have = new Set(file.facts.map((f) => f.id));
      file = await rehashFile(file, { facts: [...file.facts, ...config.public_record_facts.filter((f) => !have.has(f.id))] });
    }
    const jsonld = generateJsonLd(file, { troothProfileUrl: profile });
    const original_tokens: Record<string, number> = {};
    for (const p of file.header.pages_manifest) original_tokens[p.id] = p.original_tokens ?? 0;
    await this.d.store.saveBuilt(company.trooth_id, { file, bodies: out.bodies, original_tokens, signed_at: null }, { llms: out.llms, jsonld: utf8(JSON.stringify(jsonld.graph)) });
    for (const f of Object.values(discovery.fetched)) {
      await this.d.store.putChangeState(company.trooth_id, f.url, { etag: f.etag, last_modified: f.lastModified, raw_hash: f.source_hash, lastmod: lastmod.get(f.url) ?? null, checked_at: f.fetchedAt });
    }
    return {
      trooth_id: company.trooth_id,
      version,
      version_id: versionId(file.root_hash),
      root_hash: file.root_hash,
      state: "read",
      pages: file.header.pages_manifest.length,
      facts: file.facts.length,
      coverage: { found: out.receipt.found, read: out.receipt.read, left_out: out.receipt.left_out, changed: out.receipt.changed, removed: out.receipt.removed },
    };
  }

  // ---------------------------------------------------------------- workspace actions

  /** A short id a person can quote to support; the exception it names is logged, never sent. */
  private requestId(): string {
    return [...this.random(8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private failed(action: string, e: unknown): WorkspaceResult {
    const id = this.requestId();
    if (this.d.logError) this.d.logError(id, action, e);
    else console.error(`semanto ${action} failed, request ${id}:`, e);
    const message = e instanceof Error ? e.message : "";
    // A missing secret is this deployment's state, not an outside source failing.
    const code: ProblemCode = /HOSTED_KEY_SEAL_SECRET/.test(message) ? "conflict" : "upstream_unavailable";
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
        case "gap-report":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
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
          return await this.basicProve(trooth_id);
        case "first-publication":
          if (!mayOperate(ws.role)) return problem("forbidden", VIEWER_ONLY);
          return await this.firstPublication(trooth_id, body);
        case "connectors":
          return await this.addConnector(ws, trooth_id, body);
      }
    } catch (e) {
      return this.failed(action, e);
    }
  }

  private async build(trooth_id: string): Promise<WorkspaceResult> {
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet. Claim the domain first.");
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
    await this.d.store.addAuthorization(trooth_id, { record: role.record, at: iso(now), root_hash: builtRoot });
    const config = await this.d.store.getConfig(trooth_id);
    const decision = mayBeSigned(builtRoot, await this.d.store.authorizations(trooth_id, builtRoot), config.signing);
    if (!decision.allowed) {
      // Two officers means two distinct accounts. A worker-f workspace has one account until team seats exist, so until
      // then a company with two_officer set cannot sign; the dashboard shows this sentence.
      const seats = config.signing.officers === "two_officer" ? { two_officer_note: TWO_OFFICER_NOTE } : {};
      return ok(202, { object: "semanto.sign_waiting", trooth_id, version: v.file.header.version, root_hash: builtRoot, reason: decision.reason, approvals_missing: decision.missing, ...seats });
    }

    const header: SemantoHeader = { ...v.file.header, state: "signed", identity: { ...v.file.header.identity, ...(decision.authorized_by ? { authorized_by: decision.authorized_by } : {}) } };

    if (company.custody === "hosted") {
      const key = (await this.d.keys.getCompanySigningKey(trooth_id)) ?? (await this.newHostedKey(trooth_id)).privateJwk;
      const prepared = versionSigningInput(header, key.kid, now);
      const sig = await rawSign(await importPrivate(key), utf8(prepared.signing_input));
      const jws = assembleJws(prepared, sig);
      const check = await checkAssembledJws(jws.detached, header, toPublic(key), now);
      if (!check.ok) return problem("signature_invalid", `The hosted key did not produce a valid signature: ${check.reason}.`);
      return this.finalize(company, v, header, jws.detached, key.kid);
    }

    const customerKeys = (await this.d.store.keys(trooth_id)).filter((k) => k.custody === "customer").map((k) => k.public_jwk);
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
  private async finalize(company: CompanyRecord, v: StoredVersion, header: SemantoHeader, detached: string, kid: string): Promise<WorkspaceResult> {
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

  private async newHostedKey(trooth_id: string): Promise<{ privateJwk: PrivateJwk; publicJwk: PublicJwk }> {
    const now = this.d.now();
    const k = await createHostedKey(trooth_id, now);
    await this.d.store.putKey(trooth_id, { public_jwk: k.record.public_jwk, custody: "hosted", created_at: k.record.created_at }, k.privateJwk);
    await this.logKey(trooth_id, k.record.public_jwk);
    return { privateJwk: k.privateJwk, publicJwk: k.record.public_jwk };
  }

  private async logKey(trooth_id: string, jwk: PublicJwk): Promise<void> {
    await this.d.log.append({ kind: "key", trooth_id, ref: jwk.kid, hash: await digest(canonicalize(jwk)), at: iso(this.d.now()) });
  }

  private async rotateKeys(ws: WorkspaceAuth, trooth_id: string, body: Record<string, unknown>): Promise<WorkspaceResult> {
    if (!mayAdminister(ws.role)) return problem("forbidden", "Only an owner or admin can change signing keys.");
    const company = await this.d.store.getCompany(trooth_id);
    if (!company) return problem("conflict", "This company has no record yet.");
    const now = this.d.now();
    const keys = await this.d.store.keys(trooth_id);
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
    await this.d.store.putConnectorKey(trooth_id, accepted.jwk, source, iso(this.d.now()));
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
    const domain = str(body.domain)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return problem("invalid_request", "Send the domain as domain, for example acme.com.");
    const now = this.d.now();
    const token = `trooth-claim-${toBase64Url(this.random(18))}`;
    const c = claim(trooth_id, domain, token, now);
    if (!(await this.d.store.getCompany(trooth_id))) {
      await this.d.store.putCompany({ trooth_id, domain, org: str(body.org) ?? domain, tier: "basic", current_version: null, custody: "customer" });
    }
    await this.d.store.putBasic(c);
    await this.d.store.registerOwner(trooth_id, ws.user_id);
    return ok(200, {
      object: "semanto.basic_claim",
      trooth_id,
      domain,
      state: c.state,
      dns: { name: dnsClaimName(domain), type: "TXT", value: dnsClaimRecord(token) },
      well_known: { url: wellKnownClaimUrl(domain), body: token },
      checklist: SETUP_CHECKLIST,
    });
  }

  private async basicProve(trooth_id: string): Promise<WorkspaceResult> {
    const c = await this.d.store.getBasic(trooth_id);
    if (!c) return problem("conflict", "Claim the domain first.");
    const now = this.d.now();
    const proved = await proveDomain(c, this.d.domainProof, now);
    if (!proved.ok) return ok(200, { object: "semanto.basic_proof", trooth_id, state: c.state, proved: false, reason: proved.reason, checked: proved.checked });
    await this.d.store.putBasic(proved.company);
    const built = await buildBasic(proved.company, {
      build: async (domain, id) => {
        const s = await this.compile({ trooth_id: id, domain, reason: "first_build", requested_at: iso(now) });
        return { version: s.version, root_hash: s.root_hash, page_count: s.pages, fact_count: s.facts, built_at: iso(this.d.now()) };
      },
    }, this.d.now());
    let company = built.ok ? built.company : proved.company;
    // Witness-only finalize: Trooth's witness statement and a "witness" log leaf, no company signature. The record stays
    // state read; the public routes serve it marked witnessed-not-signed.
    let witnessed: { witnessed_at: string; log_index: number; tree_size: number } | null = null;
    if (built.ok && company.record) {
      const stored = await this.d.store.getVersion(trooth_id, company.record.version);
      if (stored) witnessed = await this.witnessOnly(trooth_id, stored);
      if (witnessed) company = { ...company, record: { ...company.record, witnessed: true } };
    }
    await this.d.store.putBasic(company);
    const setup = measureSetup(company.claimed_at, {
      enter_domain: company.claimed_at,
      ...(company.domain_proved_at ? { publish_token: company.domain_proved_at, prove_domain: company.domain_proved_at } : {}),
      ...(company.basic_built_at ? { build_record: company.basic_built_at } : {}),
    });
    return ok(200, basicResponse(company, { object: "semanto.basic_proof", trooth_id, proved: true, method: proved.method, state: company.state, record_state: "read", witnessed: witnessed !== null, witness: witnessed, record: company.record ?? null, setup }), basicHeaders());
  }

  /** Semanto Basic: witness a built version without a company signature, and log the witness statement. */
  private async witnessOnly(trooth_id: string, v: StoredVersion): Promise<{ witnessed_at: string; log_index: number; tree_size: number } | null> {
    if (v.file.header.state !== "read") return null;
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
    const config = await this.d.store.getConfig(trooth_id);
    const kind = (["b2b", "shopping", "local", "competitor"] as QuestionKind[]).find((k) => k === body.kind) ?? config.gap.kinds[0] ?? "b2b";
    const products = Array.isArray(body.products) ? body.products.filter((p): p is string => typeof p === "string") : config.gap.products;
    const competitor = isRecord(body.competitor) && str(body.competitor.name) && str(body.competitor.domain) ? { name: str(body.competitor.name)!, domain: str(body.competitor.domain)! } : config.gap.competitor;
    const params: QuestionParams = { company: company.org, domain: company.domain, products, ...(competitor ? { competitor } : {}), ...(str(body.service) ?? config.gap.service ? { service: str(body.service) ?? config.gap.service } : {}) };
    const report = await runGapReport({
      trooth_id,
      company: company.org,
      kind,
      ran_at: iso(this.d.now()),
      questions: questionsFor(kind, params),
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
    return ok(200, { object: "semanto.monitor_result", summary, mismatches: run.mismatches, indexability: run.indexability });
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
    if (!sig.ok) return problem("unauthorized", `The connector signature did not check out (${sig.reason}). Paste the connector's public key into the dashboard under Delivery, Connectors, and sign with tag trooth-connector.`);
    if (req.body.length > CATALOG_MAX_BYTES) return problem("payload_too_large", "The catalog is larger than 5 MB. Send it in parts.");
    if (!(await verifyContentDigest(req.headers.get("content-digest"), req.body))) return problem("unauthorized", "Content-Digest does not match the body.");
    // A nonce on every catalog request, claimed once (atomically in the NonceDO), so a captured request cannot be replayed.
    if (!sig.params.nonce) return problem("unauthorized", "The connector signature carries no nonce. Update the connector; every request needs a fresh nonce.");
    if (this.d.nonces) {
      const until = (sig.params.expires ?? sig.params.created + CONNECTOR_MAX_AGE_SECONDS) * 1000;
      if (!(await this.d.nonces.claim(`${sig.keyid}:${sig.params.nonce}`, until, nowSec * 1000))) return problem("unauthorized", "This catalog request was already received (its nonce was used). Send a new request.");
    }
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
    const { records, offers, skipped } = catalogToInputs(doc.products, { company, currency, at, source: str(doc.source) ?? "connector" });
    const key = company.custody === "hosted" ? await this.d.keys.getCompanySigningKey(trooth_id) : null;
    if (!key) {
      return ok(202, { object: "semanto.catalog_receipt", trooth_id, signed: false, records: records.length, offers: offers.length, skipped, reason: "This company holds its own signing key, so Trooth cannot sign the records. Sign them from your own tools; nothing was published." });
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
      skipped,
    });
  }

  // ---------------------------------------------------------------- scheduled work

  /** Hourly: for every signed company, check each signed page cheaply (sitemap lastmod, conditional GET, raw hash) and queue a rebuild of what changed. */
  async hourlyChangeDetection(): Promise<{ trooth_id: string; changed: string[] }[]> {
    const out: { trooth_id: string; changed: string[] }[] = [];
    const detector = new ChangeDetector(this.fetcher());
    for (const company of await this.d.store.listCompanies("signed")) {
      const file = await this.d.versions.getCurrent(company.trooth_id);
      if (!file) continue;
      const state = await this.d.store.changeState(company.trooth_id);
      const changed: string[] = [];
      const seen = new Set<string>();
      for (const page of file.header.pages_manifest) {
        if (seen.has(page.url)) continue;
        seen.add(page.url);
        const prev = state[page.url];
        const capture = { etag: prev?.etag ?? null, lastModified: prev?.last_modified ?? null, source_hash: prev?.raw_hash ?? page.source_hash, lastmod: prev?.lastmod ?? null };
        const r = await detector.check(page.url, capture, null);
        if (r.fetch && r.fetch.ok && r.fetch.status === 200) {
          await this.d.store.putChangeState(company.trooth_id, page.url, { etag: r.fetch.etag, last_modified: r.fetch.lastModified, raw_hash: r.fetch.source_hash, lastmod: prev?.lastmod ?? null, checked_at: r.fetch.fetchedAt });
        }
        if (r.changed) changed.push(page.url);
      }
      if (changed.length) {
        const job: CompileJob = { trooth_id: company.trooth_id, domain: company.domain, reason: "change_detected", changed_urls: changed, requested_at: iso(this.d.now()) };
        if (this.d.enqueue) await this.d.enqueue(job);
        else await this.compile(job);
      }
      out.push({ trooth_id: company.trooth_id, changed });
    }
    return out;
  }

  /** Nightly: sign a tree head for the current size, anchor it with an RFC 3161 timestamp, and re-sign the revocation list. */
  async nightlyCheckpoint(): Promise<{ tree_head: { tree_size: number; root_hash: string } | null; timestamp: unknown; revocations: number }> {
    const size = await this.d.log.ledger.size();
    let head = null;
    let timestamp: unknown = null;
    if (size > 0) {
      const signed = await this.d.log.signTreeHead(size);
      head = { tree_size: signed.tree_size, root_hash: signed.root_hash };
      timestamp = await this.timestamp(signed);
    }
    const now = this.d.now();
    const entries = await this.d.store.revocations(null);
    const { jws } = await signRevocationList(entries, null, await this.d.keys.getWitnessKey(), now);
    await this.d.store.putRevocationList(null, jws, iso(now));
    await this.d.store.putBlob("semanto/revocations/latest.jws", utf8(jws), "application/jose");
    return { tree_head: head, timestamp, revocations: entries.length };
  }

  /** Weekly (WEEKLY_RUN.cron): the gap report for every signed company, for the kinds it asked for. */
  async weeklyGapReports(): Promise<{ trooth_id: string; kinds: QuestionKind[]; errors: string[] }[]> {
    const out: { trooth_id: string; kinds: QuestionKind[]; errors: string[] }[] = [];
    for (const company of await this.d.store.listCompanies("signed")) {
      const config = await this.d.store.getConfig(company.trooth_id);
      const kinds = (config.gap.kinds.length ? config.gap.kinds : WEEKLY_RUN.kinds.slice(0, 1)).filter((k) => (k === "shopping" ? config.gap.products.length > 0 : k === "competitor" ? Boolean(config.gap.competitor) : true));
      const errors: string[] = [];
      for (const kind of kinds) {
        const r = await this.gapReport(company.trooth_id, { kind });
        if (r.problem) errors.push(`${kind}: ${r.problem.detail}`);
      }
      out.push({ trooth_id: company.trooth_id, kinds, errors });
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
      compile: async (job: unknown) => {
        if (!isRecord(job) || typeof job.trooth_id !== "string") throw new Error("compile: the message is not a CompileJob");
        await this.compile(job as unknown as CompileJob);
      },
    };
  }
}

// ---------------------------------------------------------------- commerce helpers

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
  };
}

function toMonitorOffer(s: SignedOffer): MonitorOffer {
  const o = s.offer;
  return { offer_id: o.id, sku: o.sku, ...(o.variant_id ? { variant_id: o.variant_id } : {}), price: { amount: formatMinor(o.price), currency: o.price.currency }, availability: o.availability, url: o.url, as_of: o.as_of, not_after: o.not_after };
}

const STOCK: Record<string, Availability> = { instock: "in_stock", in_stock: "in_stock", outofstock: "out_of_stock", out_of_stock: "out_of_stock", onbackorder: "backorder", backorder: "backorder", preorder: "preorder", discontinued: "discontinued" };
const AXES: Record<string, keyof VariantAxes> = { color: "color", colour: "color", size: "size", formulation: "formulation", edition: "edition" };

/** Map the connector catalog document (adapters/wordpress-plugin/README.md) to product record and offer inputs. */
export function catalogToInputs(products: unknown[], ctx: { company: CompanyRecord; currency: string; at: string; source: string }): { records: ProductRecordInput[]; offers: OfferInput[]; skipped: { sku: string; reason: string }[] } {
  const records: ProductRecordInput[] = [];
  const offers: OfferInput[] = [];
  const skipped: { sku: string; reason: string }[] = [];
  const seller = { domain: ctx.company.domain, trooth_id: ctx.company.trooth_id };
  const one = (p: Record<string, unknown>, parent: Record<string, unknown> | null) => {
    const id = str(String(p.id ?? "")) ?? null;
    const sku = str(p.sku) ?? (id ? `${ctx.source}-${id}` : null);
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
  return { records, offers, skipped };
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

/** The address worker-f answers a session check at; it reads the bearer token against app_sessions. */
export const TROOTH_OS_SESSION_URL = "https://trooth-os-worker-f/auth/session";

const ROLES: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];

/**
 * Accept a workspace bearer token by asking worker-f's session check through
 * the TROOTH_OS service binding (GET /auth/session in worker-f app-api.ts,
 * read 22 Oct 2026). That route answers { authenticated, companyId, userId,
 * email, role } where role is the account type, "vendor" or "buyer", and,
 * once worker-f has team seats, workspaceRole (owner, admin, member, viewer).
 *
 *   workspaceRole present   it is the role, as worker-f states it
 *   absent, vendor account  owner only when userId is the company's registered
 *                           owner (semanto_companies.os_owner_user_id, set when
 *                           the company is created or claimed); every other
 *                           vendor session is a member
 *   buyer account           refused: it has no company to act for
 *
 * The worker-f companyId is mapped to the Semanto trooth_id through
 * semanto_companies.os_company_id (migration 0003), never guessed from a
 * name. Deny (null) when there is no binding, no token, a refused session, an
 * unmapped company, or a buyer account.
 */
export function troothOsAuthorize(
  service: ServiceFetcher | undefined,
  troothIdForCompany: (os_company_id: string) => Promise<string | null> = async () => null,
  ownerUserIdFor: (trooth_id: string) => Promise<string | null> = async () => null,
): (req: Request, trooth_id: string) => Promise<WorkspaceAuth | null> {
  return async (req) => {
    if (!service) return null;
    const auth = req.headers.get("authorization");
    if (!auth || !/^Bearer\s+\S+$/i.test(auth)) return null;
    let res: Response;
    try {
      res = await service.fetch(TROOTH_OS_SESSION_URL, { method: "GET", headers: { authorization: auth, accept: "application/json" } });
    } catch {
      return null;
    }
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
    const trooth_id = await troothIdForCompany(companyId);
    if (!trooth_id) return null;
    const user_id = str(j.userId) ?? "unknown";
    const stated = str(j.workspaceRole) as WorkspaceRole | undefined;
    let role: WorkspaceRole;
    if (stated !== undefined && ROLES.includes(stated)) role = stated;
    else {
      const owner = await ownerUserIdFor(trooth_id);
      role = owner !== null && user_id !== "unknown" && owner === user_id ? "owner" : "member";
    }
    const name = str(j.email) ?? "Workspace member";
    return { trooth_id, role, user_id, name };
  };
}
