// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The public routes of Semanto as a Hono app over the serving ports
// (docs/ARCHITECTURE.md, "Public routes"). Every response, including every
// problem, goes through headers.ts, so every response is signed (RFC 9421),
// digested (RFC 9530), cacheable with a strong ETag (RFC 9110) and readable
// cross-origin. Format is chosen by Accept or path suffix through
// negotiate-route.ts; User-Agent is never read. A read receipt input is
// computed after the response is built and handed to ReceiptPort.record
// without blocking the response (Workers waitUntil when present). The public
// log routes answer in the shapes docs/spec/log.md states, over the ledger.
// Workspace routes (/os) are denied by default: without an authorize hook, or
// without a session it accepts, they answer a 401 problem; the work itself is
// done by src/pipeline.ts behind RouteDeps.workspace.

import { Hono, type Context } from "hono";
import { utf8 } from "../core/encoding";
import { isTroothId, isSemantoId } from "../core/ids";
import { negotiate } from "../core/negotiate";
import { estimateTokens } from "../core/tokens";
import { versionId, type SemantoFile } from "../core/semanto";
import { buildResponse, toResponse, type LinkTargets, type ResponseSpec, type ServedRepresentation } from "./headers";
import { basicNotice, behindNotice, problem, renderProblem, type Problem, type ProblemCode } from "./errors";
import { WITNESSED_NOT_SIGNED } from "../basic/tier";
import { withTrustState, type TrustState } from "../compiler/llms";
import { checkAgainstRecord, type FirstPublicationDocument, type FirstPublicationRecord } from "../basic/first-publication";
import { negotiateRoute } from "./negotiate-route";
import { buildPageProof, verifyUrl } from "./proof";
import { factsJsonLd, manifestMarkdown, pageJsonLd, wellKnownSemanto } from "./represent";
import type { CompanyRecord, Ports, ReceiptInput, StoredPage, WorkspaceAction, WorkspaceAuth, WorkspaceHandlers, WorkspaceResult } from "./ports";
import type { CommerceStore } from "../commerce/ports";
import { feedResponse, offerResponse, offersResponse, problemMarkdown, productResponse, productsResponse, ucpManifestResponse, type PlainResponse as CommerceResponse } from "../commerce/routes";
import { resolve as resolveDelivery, validateSettings, withDefaults, DEFAULT_SETTINGS, type DeliverySettings } from "../settings/delivery";

type Vars = { Variables: { receipt?: ReceiptInput } };
export type ServeApp = Hono<Vars>;

interface Signer {
  key: ResponseSpec["signer"]["key"];
  by: "company" | "witness";
}

export interface RouteDeps {
  ports: Ports;
  /** Verify a Web Bot Auth request, when the readers module is wired. Without it, only the Signature-Agent header is recorded and proof is "none". */
  readers?: { verify(req: Request, trooth_id?: string): Promise<{ agent_key_url: string | null; proven: boolean; keyid?: string | null; address?: string | null; via_adapter?: boolean }> };
  /**
   * Workspace authorization for /os routes. Answers the caller's workspace
   * (trooth_id and role), or null to refuse. `true` is accepted from simple
   * hooks and reads as an admin of the company in the address. Without the
   * hook, every /os call is refused with a 401 problem.
   */
  authorize?: (req: Request, trooth_id: string) => Promise<boolean | WorkspaceAuth | null>;
  /** The pipeline behind the /os actions (src/pipeline.ts). */
  workspace?: WorkspaceHandlers;
  /** Product records, offers and feeds for the commerce public routes. */
  commerce?: CommerceStore;
  /** Per-reader rate limit, when wired. */
  rateLimit?: (req: Request) => Promise<{ allowed: boolean; retry_after: number }>;
  /** First-publication records (src/basic/first-publication.ts), for the public record and check routes. */
  firstPublications?: { get(record_id: string): Promise<FirstPublicationRecord | null> };
}

/** The request pieces the handlers read. Never the user agent. */
function requestHints(c: Context<Vars>) {
  return {
    accept: c.req.header("accept") ?? null,
    ifNoneMatch: c.req.header("if-none-match") ?? null,
    contract: c.req.header("trooth-contract") ?? null,
    signatureAgent: c.req.header("signature-agent") ?? null,
  };
}

export function createApp(deps: RouteDeps): ServeApp {
  const { ports } = deps;
  const app = new Hono<Vars>();
  const base = ports.config.public_api_base;
  const apiPrefix = new URL(base).pathname.replace(/\/$/, "");

  // ------------------------------------------------------------ helpers

  async function signerFor(company: CompanyRecord | null): Promise<Signer> {
    if (company && company.custody === "hosted") {
      const k = await ports.keys.getCompanySigningKey(company.trooth_id);
      if (k) return { key: k, by: "company" };
    }
    return { key: await ports.keys.getWitnessKey(), by: "witness" };
  }

  async function settingsFor(trooth_id: string): Promise<DeliverySettings> {
    return (await ports.settings.get(trooth_id)) ?? DEFAULT_SETTINGS;
  }

  function links(company: CompanyRecord, file: SemantoFile | null, page?: StoredPage): LinkTargets {
    const b = `${base}/${company.trooth_id}`;
    return {
      canonical: page ? page.entry.url : `https://${company.domain}/`,
      markdown: page ? `${b}/pages/${page.entry.id}.md` : `${b}/llms-full.txt`,
      jsonld: page ? `${b}/pages/${page.entry.id}.jsonld` : `${b}/facts.jsonld`,
      semanto: `https://${company.domain}/.well-known/trooth.semanto`,
      trust_profile: `${ports.config.network_base}/${company.trooth_id}`,
      proof: page ? `${b}/pages/${page.entry.id}/proof` : file ? `${b}/versions/${file.header.version}` : null,
      keys: `${b}/keys`,
    };
  }

  function recordReceipt(c: Context<Vars>, input: Omit<ReceiptInput, "agent_key_url" | "proof" | "read_at">): void {
    const hints = requestHints(c);
    const work = (async () => {
      let agent_key_url = hints.signatureAgent;
      let proven = false;
      let keyid: string | null = null;
      let address = c.req.header("cf-connecting-ip") ?? null;
      if (deps.readers) {
        const r = await deps.readers.verify(c.req.raw, input.trooth_id);
        agent_key_url = r.agent_key_url ?? agent_key_url;
        proven = r.proven;
        keyid = r.proven ? (r.keyid ?? null) : null;
        // Through an adapter whose connector signature checked out, the reader's address is the one it vouched for.
        if (r.via_adapter && r.address) address = r.address;
      }
      await ports.receipts.record({ ...input, agent_key_url, proof: proven ? "web_bot_auth" : "none", ...(keyid ? { keyid } : {}), read_at: ports.now().toISOString(), ...(address ? { address } : {}) });
    })().catch(() => undefined);
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // No execution context (tests, Node): the promise runs on its own.
    }
  }

  async function send(c: Context<Vars>, spec: Omit<ResponseSpec, "now">): Promise<Response> {
    const p = await buildResponse({ ...spec, now: ports.now() }, { ifNoneMatch: requestHints(c).ifNoneMatch });
    return toResponse(p);
  }

  /** A Semanto Basic record: Trooth witnessed it, the company did not sign it. */
  const isBasic = (file: SemantoFile | null): boolean => !!file && file.header.state !== "signed" && !!file.witness;

  /**
   * Every Basic body carries the notice (src/basic/tier.ts WITNESSED_NOT_SIGNED):
   * front matter on markdown and text, a "notice" member on JSON, and the
   * notice under its Trooth IRI on JSON-LD.
   */
  function basicBody(rep: ServedRepresentation, body: Uint8Array): Uint8Array {
    if (rep === "markdown" || rep === "text") {
      const n = utf8(basicNotice(WITNESSED_NOT_SIGNED));
      const out = new Uint8Array(n.length + body.length);
      out.set(n, 0);
      out.set(body, n.length);
      return out;
    }
    if (rep === "json" || rep === "jsonld") {
      try {
        const v = JSON.parse(new TextDecoder().decode(body)) as unknown;
        if (typeof v === "object" && v !== null && !Array.isArray(v)) return json(rep === "json" ? { ...v, tier: "basic", notice: WITNESSED_NOT_SIGNED } : { ...v, "https://trooth.co/rel/notice": WITNESSED_NOT_SIGNED });
      } catch {
        return body;
      }
    }
    return body;
  }

  /** Send a response for a loaded file, marking a Basic record in its header and its body. */
  async function sendFor(c: Context<Vars>, file: SemantoFile | null, spec: Omit<ResponseSpec, "now">): Promise<Response> {
    if (!isBasic(file) || spec.status >= 300) return send(c, spec);
    return send(c, { ...spec, body: basicBody(spec.rep, spec.body), state: "witnessed-not-signed" });
  }

  /** The trust state the llms.txt Trooth section describes. */
  const trustState = (file: SemantoFile): TrustState => (file.header.state === "signed" && file.signature && file.witness ? "signed_and_witnessed" : file.witness ? "witnessed" : "neither");

  async function sendProblem(c: Context<Vars>, company: CompanyRecord | null, file: SemantoFile | null, code: ProblemCode, opts: { detail?: string; retry_after?: number } = {}): Promise<Response> {
    const hints = requestHints(c);
    const p: Problem = problem(code, { ...opts, instance: new URL(c.req.url).pathname });
    const { rep, body } = renderProblem(p, hints.accept);
    const settings = company ? await settingsFor(company.trooth_id) : null;
    return send(c, {
      status: p.status,
      rep,
      body,
      version_id: file ? versionId(file.root_hash) : null,
      content_signals: settings?.content_signals ?? null,
      links: company ? links(company, file) : {},
      signer: await signerFor(company),
      retry_after_seconds: p.retry_after ?? null,
    });
  }

  /** Load the company and its current signed file, answering the right problem when either is missing. */
  async function load(c: Context<Vars>, trooth_id: string): Promise<{ company: CompanyRecord; file: SemantoFile; settings: DeliverySettings; signer: Signer } | Response> {
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    if (!file) return sendProblem(c, company, null, "semanto_not_signed");
    return { company, file, settings: await settingsFor(trooth_id), signer: await signerFor(company) };
  }

  const json = (v: unknown) => utf8(JSON.stringify(v));

  // ------------------------------------------------------------ middleware

  app.use("*", async (c, next) => {
    const hints = requestHints(c);
    if (hints.contract && hints.contract !== "1") return sendProblem(c, null, null, "unsupported_contract_version");
    if (deps.rateLimit) {
      const r = await deps.rateLimit(c.req.raw);
      if (!r.allowed) return sendProblem(c, null, null, "rate_limited", { retry_after: r.retry_after });
    }
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type, Content-Digest, If-None-Match, Signature, Signature-Input, Signature-Agent, Trooth-Contract",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    await next();
  });

  // ------------------------------------------------------------ the public log (docs/spec/log.md), before /:trooth_id

  const witnessSigner = async (): Promise<Signer> => ({ key: await ports.keys.getWitnessKey(), by: "witness" });
  const logPrefix = `${apiPrefix}/log`;
  const intParam = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const sendLog = async (c: Context<Vars>, value: unknown): Promise<Response> => send(c, { status: 200, rep: "json", body: json(value), version_id: null, links: {}, signer: await witnessSigner() });
  const logMissing = (c: Context<Vars>, detail: string) => sendProblem(c, null, null, "log_entry_not_found", { detail });
  const badLogQuery = (c: Context<Vars>, detail: string) => sendProblem(c, null, null, "invalid_request", { detail });

  async function serveTreeHead(c: Context<Vars>, forceText: boolean): Promise<Response> {
    const sizeQ = c.req.query("size");
    const size = sizeQ === undefined ? undefined : intParam(sizeQ);
    if (size === null) return badLogQuery(c, "size must be a whole number.");
    const head = size === undefined ? await ports.log.latestTreeHead() : await ports.log.getTreeHead(size);
    if (!head) return logMissing(c, size === undefined ? "The log has no signed tree head yet." : `No signed tree head of size ${size}.`);
    const wantsText = forceText || prefersPlainText(requestHints(c).accept);
    if (wantsText) {
      const text = await ports.log.checkpoint(head.tree_size);
      if (text === null) return logMissing(c, `No checkpoint of size ${head.tree_size}.`);
      return send(c, { status: 200, rep: "text", body: utf8(text), version_id: null, links: {}, signer: await witnessSigner() });
    }
    return sendLog(c, { tree_size: head.tree_size, root_hash: head.root_hash, signed_at: head.signed_at, jws: head.jws });
  }
  app.get(`${logPrefix}/tree-head`, (c) => serveTreeHead(c, false));
  app.get(`${logPrefix}/checkpoint`, (c) => serveTreeHead(c, true));

  app.get(`${logPrefix}/proof`, async (c) => {
    const index = intParam(c.req.query("index"));
    if (index === null) return badLogQuery(c, "index is required and must be a whole number.");
    const sizeQ = c.req.query("size");
    const size = sizeQ === undefined ? ((await ports.log.latestTreeHead())?.tree_size ?? null) : intParam(sizeQ);
    if (size === null) return sizeQ === undefined ? logMissing(c, "The log has no signed tree head yet.") : badLogQuery(c, "size must be a whole number.");
    const proof = await ports.log.inclusion(index, size);
    return proof ? sendLog(c, proof) : logMissing(c, `Leaf ${index} is not in a tree of ${size} leaves.`);
  });

  app.get(`${logPrefix}/consistency`, async (c) => {
    const from = intParam(c.req.query("from"));
    const toQ = c.req.query("to");
    const to = toQ === undefined ? ((await ports.log.latestTreeHead())?.tree_size ?? null) : intParam(toQ);
    if (from === null || to === null) return badLogQuery(c, "from and to must be whole numbers.");
    const proof = await ports.log.consistency(from, to);
    return proof ? sendLog(c, proof) : logMissing(c, `No consistency proof from ${from} to ${to}.`);
  });

  app.get(`${logPrefix}/leaves/:index`, async (c) => {
    const index = intParam(c.req.param("index"));
    if (index === null) return badLogQuery(c, "The leaf index must be a whole number.");
    const leaf = await ports.log.leaf(index);
    return leaf ? sendLog(c, leaf) : logMissing(c, `The log has no leaf ${index}.`);
  });

  // ------------------------------------------------------------ verify (before /:trooth_id)

  app.get(`${apiPrefix}/verify`, async (c) => {
    const url = c.req.query("url") ?? "";
    const hash = c.req.query("hash") ?? "";
    const store = ports.versions;
    const answer = await verifyUrl(store, base, url, hash, async (tid, v) => (await store.listVersions(tid)).find((x) => x.version === v)?.signed_at ?? null);
    const company = answer.version !== null ? await store.getCompanyByDomain(new URL(url).hostname.toLowerCase()) : null;
    const file = company ? await store.getCurrent(company.trooth_id) : null;
    return send(c, {
      status: 200,
      rep: "json",
      body: json(answer),
      version_id: file ? versionId(file.root_hash) : null,
      links: company ? links(company, file) : {},
      signer: await signerFor(company),
    });
  });

  // ------------------------------------------------------------ first publication (before /:trooth_id)

  /** The record, its JWS and its inclusion proof in the log against the latest tree head. */
  async function firstPublicationDocument(record_id: string): Promise<FirstPublicationDocument | null> {
    if (!deps.firstPublications || !isSemantoId(record_id, "smb")) return null;
    const r = await deps.firstPublications.get(record_id);
    if (!r) return null;
    let inclusion: FirstPublicationDocument["inclusion"] = null;
    if (r.log) {
      const head = await ports.log.latestTreeHead();
      if (head) inclusion = await ports.log.inclusion(r.log.index, head.tree_size);
    }
    return { object: "semanto.first_publication_record", record: r.record, jws: r.jws, leaf: r.leaf, leaf_hash: r.leaf_hash, inclusion, check_url: `${base}/first-publication/check` };
  }

  const witnessSend = async (c: Context<Vars>, value: unknown): Promise<Response> => send(c, { status: 200, rep: "json", body: json(value), version_id: null, links: {}, signer: { key: await ports.keys.getWitnessKey(), by: "witness" } });

  app.post(`${apiPrefix}/first-publication/check`, async (c) => {
    const input = await readJson(c);
    if (!input || typeof input !== "object") return sendProblem(c, null, null, "invalid_request", { detail: 'Send { "record_id": "<the smb_ record id>", "markdown": "<the text>" } as JSON.' });
    const { record_id, markdown } = input as { record_id?: unknown; markdown?: unknown };
    if (typeof record_id !== "string" || typeof markdown !== "string") return sendProblem(c, null, null, "invalid_request", { detail: 'Send { "record_id": "<the smb_ record id>", "markdown": "<the text>" } as JSON.' });
    const doc = await firstPublicationDocument(record_id);
    if (!doc) return sendProblem(c, null, null, "semanto_not_found", { detail: `No first-publication record ${record_id}.` });
    return witnessSend(c, await checkAgainstRecord(doc, markdown));
  });

  app.get(`${apiPrefix}/first-publication/:record_id`, async (c) => {
    const doc = await firstPublicationDocument(c.req.param("record_id"));
    if (!doc) return sendProblem(c, null, null, "semanto_not_found", { detail: "No first-publication record with this id." });
    return witnessSend(c, doc);
  });

  // ------------------------------------------------------------ the semanto object

  app.get(`${apiPrefix}/:trooth_id`, async (c) => {
    const r = await load(c, c.req.param("trooth_id"));
    if (r instanceof Response) return r;
    const { company, file, settings, signer } = r;
    const rep = negotiate(requestHints(c).accept, ["json", "markdown", "jsonld"], "json");
    if (rep === "markdown") return serveLlms(c, r, "llms-full");
    if (rep === "jsonld") return serveFacts(c, r);
    const body = json(file);
    recordReceipt(c, { trooth_id: company.trooth_id, version: file.header.version, page_id: null, representation: "json" });
    return sendFor(c, file, { status: 200, rep: "json", body, version_id: versionId(file.root_hash), content_signals: settings.content_signals, links: links(company, file), signer });
  });

  // ------------------------------------------------------------ versions

  app.get(`${apiPrefix}/:trooth_id/versions`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    const list = await ports.versions.listVersions(trooth_id);
    return send(c, {
      status: 200,
      rep: "json",
      body: json({ object: "semanto.versions", trooth_id, current: company.current_version, versions: list }),
      version_id: file ? versionId(file.root_hash) : null,
      links: links(company, file),
      signer: await signerFor(company),
    });
  });

  app.get(`${apiPrefix}/:trooth_id/versions/:n`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const n = Number(c.req.param("n"));
    const current = await ports.versions.getCurrent(trooth_id);
    if (!Number.isInteger(n) || n < 1) return sendProblem(c, company, current, "semanto_version_not_found");
    const file = await ports.versions.getVersion(trooth_id, n);
    if (!file) return sendProblem(c, company, current, "semanto_version_not_found");
    if (file.header.state === "withdrawn") return sendProblem(c, company, current, "semanto_withdrawn");
    if (file.header.state !== "signed") return sendProblem(c, company, current, "semanto_not_signed");
    const settings = await settingsFor(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(file), version_id: versionId(file.root_hash), content_signals: settings.content_signals, links: links(company, file), signer: await signerFor(company) });
  });

  // ------------------------------------------------------------ pages

  type Loaded = { company: CompanyRecord; file: SemantoFile; settings: DeliverySettings; signer: Signer };

  async function servePage(c: Context<Vars>, r: Loaded, page: StoredPage, rep: "markdown" | "jsonld"): Promise<Response> {
    const { company, file, settings, signer } = r;
    const vid = versionId(file.root_hash);
    const behind = page.live === "behind" && !isBasic(file);
    const markdownText = new TextDecoder().decode(page.bytes);
    let body: Uint8Array;
    let served: ServedRepresentation;
    if (rep === "jsonld") {
      body = json(pageJsonLd(file, page.entry, markdownText, ports.config));
      served = "jsonld";
    } else if (behind) {
      const signed_at = (await ports.versions.listVersions(company.trooth_id)).find((v) => v.version === page.version)?.signed_at ?? file.header.not_before;
      const notice = utf8(behindNotice(signed_at, vid));
      body = new Uint8Array(notice.length + page.bytes.length);
      body.set(notice, 0);
      body.set(page.bytes, notice.length);
      served = "markdown";
    } else {
      body = page.bytes;
      served = "markdown";
    }
    recordReceipt(c, { trooth_id: company.trooth_id, version: page.version, page_id: page.entry.id, representation: rep });
    return sendFor(c, file, {
      status: 200,
      rep: served,
      body,
      version_id: vid,
      page_hash: page.entry.hash,
      markdown_tokens: page.entry.tokens || estimateTokens(markdownText),
      original_tokens: page.original_tokens,
      content_signals: settings.content_signals,
      links: links(company, file, page),
      signer,
      state: behind ? "behind" : null,
    });
  }

  /** A 303 to the page on the company's host. Signed like every other response (Location is covered), with an empty body; it is navigation, never content. */
  async function sendRedirect(c: Context<Vars>, r: Loaded, page: StoredPage): Promise<Response> {
    return send(c, { status: 303, rep: "markdown", body: new Uint8Array(0), version_id: versionId(r.file.root_hash), location: page.entry.url, links: links(r.company, r.file, page), signer: r.signer });
  }

  app.get(`${apiPrefix}/:trooth_id/pages/:page{.+}`, async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.endsWith("/proof")) return servePageProof(c);
    const r = await load(c, c.req.param("trooth_id"));
    if (r instanceof Response) return r;
    const decision = negotiateRoute(pathname, requestHints(c).accept);
    const page_id = decision.basePath.split("/").filter(Boolean).pop() ?? "";
    if (!isSemantoId(page_id, "smp")) return sendProblem(c, r.company, r.file, "page_not_found");
    const page = await ports.versions.getPage(r.company.trooth_id, page_id);
    if (!page) return sendProblem(c, r.company, r.file, "page_not_found");
    // Not ours: the company's host serves the HTML. Point the browser there, with a signed 303.
    if (decision.rep === "html") return sendRedirect(c, r, page);
    return servePage(c, r, page, decision.rep);
  });

  async function servePageProof(c: Context<Vars>): Promise<Response> {
    const r = await load(c, c.req.param("trooth_id") ?? "");
    if (r instanceof Response) return r;
    const parts = new URL(c.req.url).pathname.split("/").filter(Boolean);
    const page_id = parts[parts.length - 2] ?? "";
    if (!isSemantoId(page_id, "smp")) return sendProblem(c, r.company, r.file, "page_not_found");
    const page = await ports.versions.getPage(r.company.trooth_id, page_id);
    if (!page) return sendProblem(c, r.company, r.file, "page_not_found");
    const log = r.file.ledger ? await ports.log.getInclusion(r.file.ledger.index) : null;
    const signed_at = (await ports.versions.listVersions(r.company.trooth_id)).find((v) => v.version === page.version)?.signed_at ?? null;
    const proof = await buildPageProof(r.file, page_id, log, signed_at);
    if (!proof) return sendProblem(c, r.company, r.file, "page_not_found");
    return sendFor(c, r.file, { status: 200, rep: "json", body: json(proof), version_id: proof.version_id, page_hash: proof.page_hash, content_signals: r.settings.content_signals, links: links(r.company, r.file, page), signer: r.signer });
  }

  // ------------------------------------------------------------ facts, llms, sitemap

  async function serveFacts(c: Context<Vars>, r: Loaded): Promise<Response> {
    const stored = await ports.versions.getJsonLd(r.company.trooth_id);
    const body = stored ?? json(factsJsonLd(r.file, ports.config));
    recordReceipt(c, { trooth_id: r.company.trooth_id, version: r.file.header.version, page_id: null, representation: "jsonld" });
    return sendFor(c, r.file, { status: 200, rep: "jsonld", body, version_id: versionId(r.file.root_hash), content_signals: r.settings.content_signals, links: links(r.company, r.file), signer: r.signer });
  }

  async function serveLlms(c: Context<Vars>, r: Loaded, kind: "llms" | "llms-full" | "sitemap"): Promise<Response> {
    let body = await ports.versions.getLlms(r.company.trooth_id, kind);
    if (!body) {
      const pages = new Map<string, string>();
      if (kind === "llms-full") {
        for (const p of r.file.header.pages_manifest) {
          const sp = await ports.versions.getPage(r.company.trooth_id, p.id);
          if (sp) pages.set(p.id, new TextDecoder().decode(sp.bytes));
        }
      }
      body = utf8(manifestMarkdown(r.file, kind === "sitemap" ? "sitemap" : "llms", pages));
    }
    // The Trooth section of llms.txt says what is true of this version: signed and witnessed, witnessed only, or neither.
    if (kind === "llms") body = utf8(withTrustState(new TextDecoder().decode(body), trustState(r.file)));
    const text = new TextDecoder().decode(body);
    recordReceipt(c, { trooth_id: r.company.trooth_id, version: r.file.header.version, page_id: null, representation: "markdown" });
    return sendFor(c, r.file, { status: 200, rep: "markdown", body, version_id: versionId(r.file.root_hash), markdown_tokens: estimateTokens(text), content_signals: r.settings.content_signals, links: links(r.company, r.file), signer: r.signer });
  }

  app.get(`${apiPrefix}/:trooth_id/facts.jsonld`, async (c) => {
    const r = await load(c, c.req.param("trooth_id"));
    return r instanceof Response ? r : serveFacts(c, r);
  });
  app.get(`${apiPrefix}/:trooth_id/llms.txt`, async (c) => {
    const r = await load(c, c.req.param("trooth_id"));
    return r instanceof Response ? r : serveLlms(c, r, "llms");
  });
  app.get(`${apiPrefix}/:trooth_id/llms-full.txt`, async (c) => {
    const r = await load(c, c.req.param("trooth_id"));
    return r instanceof Response ? r : serveLlms(c, r, "llms-full");
  });
  app.get(`${apiPrefix}/:trooth_id/sitemap.md`, async (c) => {
    const r = await load(c, c.req.param("trooth_id"));
    return r instanceof Response ? r : serveLlms(c, r, "sitemap");
  });

  // ------------------------------------------------------------ keys and the well-known documents (hosted copies)

  async function serveKeys(c: Context<Vars>): Promise<Response> {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    const jwks = await ports.keys.getCompanyJwks(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(jwks), version_id: file ? versionId(file.root_hash) : null, links: links(company, file), signer: await signerFor(company) });
  }
  app.get(`${apiPrefix}/:trooth_id/keys`, serveKeys);
  // The adapters fetch /keys.json and serve it as /.well-known/trooth-keys.json (adapters/shared/semanto-adapter.mjs API_PATHS.keys).
  app.get(`${apiPrefix}/:trooth_id/keys.json`, serveKeys);
  app.get(`${apiPrefix}/:trooth_id/.well-known/trooth-keys.json`, serveKeys);

  app.get(`${apiPrefix}/:trooth_id/.well-known/trooth.semanto`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(wellKnownSemanto(company, file, ports.config)), version_id: file ? versionId(file.root_hash) : null, links: links(company, file), signer: await signerFor(company) });
  });

  // ------------------------------------------------------------ a page by its path on the company's domain (adapters' API_PATHS.byPath)

  async function serveByPath(c: Context<Vars>): Promise<Response> {
    const r = await load(c, c.req.param("trooth_id") ?? "");
    if (r instanceof Response) return r;
    const pathname = new URL(c.req.url).pathname;
    const marker = `/${r.company.trooth_id}/by-path`;
    const raw = pathname.slice(pathname.indexOf(marker) + marker.length) || "/";
    // The site root's /facts.jsonld is the company's facts, as every adapter maps it; any other .jsonld is a page's JSON-LD.
    if (raw === "/facts.jsonld") return serveFacts(c, r);
    const decision = negotiateRoute(raw, requestHints(c).accept);
    const base = decision.basePath || "/";
    const candidates = [`https://${r.company.domain}${base}`];
    if (base.length > 1 && base.endsWith("/")) candidates.push(`https://${r.company.domain}${base.slice(0, -1)}`);
    else if (base !== "/") candidates.push(`https://${r.company.domain}${base}/`);
    let page: StoredPage | null = null;
    for (const url of candidates) {
      page = await ports.versions.getPageByUrl(r.company.trooth_id, url);
      if (page) break;
    }
    if (!page) return sendProblem(c, r.company, r.file, "page_not_found", { detail: `The current signed version has no page at ${base} on ${r.company.domain}.` });
    if (decision.rep === "html") return sendRedirect(c, r, page);
    return servePage(c, r, page, decision.rep);
  }
  app.get(`${apiPrefix}/:trooth_id/by-path`, serveByPath);
  app.get(`${apiPrefix}/:trooth_id/by-path/*`, serveByPath);

  // ------------------------------------------------------------ adapter helper: what to do for a path on the company's domain

  app.get(`${apiPrefix}/:trooth_id/resolve`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    const settings = await settingsFor(trooth_id);
    const path = c.req.query("path") ?? "/";
    const accept = c.req.query("accept") ?? null;
    const basePath = negotiateRoute(path, accept).basePath;
    const page = file ? await ports.versions.getPageByUrl(trooth_id, `https://${company.domain}${basePath}`) : null;
    const resolution = resolveDelivery(settings, { path, accept, page_signed: Boolean(page), live: page?.live ?? "unknown" });
    const body = json({ object: "semanto.resolution", trooth_id, path, ...resolution, page_id: page?.entry.id ?? null, page_url: page ? `${base}/${trooth_id}/pages/${page.entry.id}` : null });
    return send(c, { status: 200, rep: "json", body, version_id: file ? versionId(file.root_hash) : null, content_signals: settings.content_signals, links: links(company, file), signer: await signerFor(company) });
  });

  // ------------------------------------------------------------ workspace: settings (section D)

  const osPrefix = apiPrefix.replace(/\/public\//, "/os/");

  /** Deny by default: no hook, no session or a refused session is a 401 problem; a session for another company is a 403 problem. */
  async function workspaceFor(c: Context<Vars>, trooth_id: string): Promise<WorkspaceAuth | Response> {
    if (!deps.authorize) return sendProblem(c, null, null, "unauthorized");
    const answer = await deps.authorize(c.req.raw, trooth_id);
    if (!answer) return sendProblem(c, null, null, "unauthorized");
    if (answer === true) return { trooth_id, role: "admin", user_id: "workspace", name: "Workspace" };
    if (answer.trooth_id !== trooth_id) return sendProblem(c, null, null, "forbidden", { detail: `This session belongs to ${answer.trooth_id}, not ${trooth_id}.` });
    return answer;
  }

  app.get(`${osPrefix}/:trooth_id/settings`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const ws = await workspaceFor(c, trooth_id);
    if (ws instanceof Response) return ws;
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const settings = await settingsFor(trooth_id);
    const file = await ports.versions.getCurrent(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(settings), version_id: file ? versionId(file.root_hash) : null, signer: await signerFor(company) });
  });

  app.post(`${osPrefix}/:trooth_id/settings`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const ws = await workspaceFor(c, trooth_id);
    if (ws instanceof Response) return ws;
    if (ws.role !== "owner" && ws.role !== "admin") return sendProblem(c, null, null, "forbidden", { detail: "Only an owner or admin can change delivery settings." });
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      input = null;
    }
    const merged = withDefaults((input ?? {}) as Partial<DeliverySettings>);
    const issues = validateSettings(merged);
    const file = await ports.versions.getCurrent(trooth_id);
    if (issues.length) return send(c, { status: 422, rep: "json", body: json({ object: "semanto.settings_issues", issues }), version_id: file ? versionId(file.root_hash) : null, signer: await signerFor(company) });
    await ports.settings.put(trooth_id, merged);
    return send(c, { status: 200, rep: "json", body: json(merged), version_id: file ? versionId(file.root_hash) : null, signer: await signerFor(company) });
  });


  // ------------------------------------------------------------ workspace actions (src/pipeline.ts)

  async function sendWorkspace(c: Context<Vars>, trooth_id: string, result: WorkspaceResult): Promise<Response> {
    const company = await ports.versions.getCompany(trooth_id);
    const file = company ? await ports.versions.getCurrent(trooth_id) : null;
    if (result.problem) return sendProblem(c, company, file, result.problem.code, { detail: result.problem.detail });
    return send(c, { status: result.status, rep: "json", body: json(result.body ?? null), version_id: file ? versionId(file.root_hash) : null, links: company ? links(company, file) : {}, signer: await signerFor(company), extra: result.headers });
  }

  async function readJson(c: Context<Vars>): Promise<unknown> {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  const actionRoute = (action: WorkspaceAction) =>
    app.post(`${osPrefix}/:trooth_id/${action}`, async (c) => {
      const trooth_id = c.req.param("trooth_id");
      if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
      const ws = await workspaceFor(c, trooth_id);
      if (ws instanceof Response) return ws;
      if (!deps.workspace) return sendProblem(c, null, null, "conflict", { detail: "The pipeline is not wired in this deployment." });
      const input = await readJson(c);
      if (input === undefined) return sendProblem(c, null, null, "invalid_request", { detail: "The body is not JSON." });
      return sendWorkspace(c, trooth_id, await deps.workspace.handle(action, ws, trooth_id, input));
    });
  for (const action of ["build", "sign", "gap-report", "monitor/run", "keys/rotate", "lei", "basic/claim", "basic/prove", "first-publication", "connectors"] as WorkspaceAction[]) actionRoute(action);

  // The commerce connectors (WordPress plugin, Shopify, BigCommerce, Salesforce Commerce scripts) post here, signed with RFC 9421 (tag trooth-connector).
  app.post(`${osPrefix}/:trooth_id/commerce/catalog`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    if (!deps.workspace) return sendProblem(c, null, null, "conflict", { detail: "The pipeline is not wired in this deployment." });
    // At most 5 MB: a larger declared length is refused before reading, and the read stops at the cap.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > CATALOG_MAX_BYTES) return sendProblem(c, null, null, "payload_too_large", { detail: "The catalog is larger than 5 MB. Send it in parts." });
    const body = await readCapped(c.req.raw, CATALOG_MAX_BYTES);
    if (body === null) return sendProblem(c, null, null, "payload_too_large", { detail: "The catalog is larger than 5 MB. Send it in parts." });
    return sendWorkspace(c, trooth_id, await deps.workspace.catalog(trooth_id, { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body }));
  });

  // ------------------------------------------------------------ commerce public routes (src/commerce/routes.ts)

  async function sendCommerce(c: Context<Vars>, trooth_id: string, r: CommerceResponse): Promise<Response> {
    const company = await ports.versions.getCompany(trooth_id);
    const file = company ? await ports.versions.getCurrent(trooth_id) : null;
    const type = r.headers["Content-Type"] ?? "";
    const isProblem = type.startsWith("application/problem+json");
    const wantsMarkdown = isProblem && negotiate(requestHints(c).accept, ["markdown", "json"], "json") === "markdown";
    const out = wantsMarkdown ? problemMarkdown(r) : r;
    const rep = wantsMarkdown ? "markdown" : isProblem ? "problem_json" : type.startsWith("text/tab-separated-values") ? "tsv" : "json";
    const extra: Record<string, string> = {};
    if (!isProblem && r.headers["Cache-Control"]) extra["Cache-Control"] = r.headers["Cache-Control"];
    const settings = company ? await settingsFor(trooth_id) : null;
    return send(c, { status: out.status, rep, body: utf8(out.body), version_id: file ? versionId(file.root_hash) : null, content_signals: settings?.content_signals ?? null, links: company ? links(company, file) : {}, signer: await signerFor(company), extra });
  }

  const commerceRoute = (path: string, handler: (store: CommerceStore, trooth_id: string, c: Context<Vars>) => Promise<CommerceResponse>) =>
    app.get(`${apiPrefix}/:trooth_id${path}`, async (c) => {
      const trooth_id = c.req.param("trooth_id");
      if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
      if (!deps.commerce) return sendProblem(c, null, null, "semanto_not_found", { detail: "No commerce records are served here." });
      return sendCommerce(c, trooth_id, await handler(deps.commerce, trooth_id, c));
    });
  commerceRoute("/products", (store, id) => productsResponse(store, id, ports.now()));
  commerceRoute("/products/:record_id", (store, id, c) => productResponse(store, id, c.req.param("record_id") ?? ""));
  commerceRoute("/offers", (store, id) => offersResponse(store, id, ports.now()));
  commerceRoute("/offers/:sku", (store, id, c) => offerResponse(store, id, decodeURIComponent(c.req.param("sku") ?? ""), ports.now()));
  commerceRoute("/feeds/:kind", (store, id, c) => {
    const raw = c.req.param("kind") ?? "";
    const tsv = raw.endsWith(".tsv");
    return feedResponse(store, id, tsv ? raw.slice(0, -4) : raw, ports.now(), tsv ? "tsv" : "json");
  });
  commerceRoute("/.well-known/ucp", (store, id) => ucpManifestResponse(store, id));

  app.notFound((c) => sendProblem(c, null, null, "semanto_not_found", { detail: "No route here. The public routes are listed at https://trooth.co/docs/semanto." }));

  return app;
}

/** The largest catalog body the connector route reads (src/pipeline.ts uses the same number). */
export const CATALOG_MAX_BYTES = 5 * 1024 * 1024;

/** Read a request body up to `cap` bytes; null when it is longer. */
export async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) {
    out.set(ch, o);
    o += ch.byteLength;
  }
  return out;
}

/** True when Accept names text/plain at least as strongly as application/json (the checkpoint is plain text; the tree head is JSON). */
export function prefersPlainText(accept: string | null): boolean {
  if (!accept) return false;
  let text = -1;
  let jsonQ = -1;
  for (const part of accept.split(",")) {
    const [media, ...params] = part.trim().toLowerCase().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split("=").map((x) => x.trim());
      if (k === "q" && v !== undefined && Number.isFinite(Number(v))) q = Number(v);
    }
    if (media === "text/plain") text = Math.max(text, q);
    if (media === "application/json") jsonQ = Math.max(jsonQ, q);
  }
  return text > 0 && text >= jsonQ;
}

// ------------------------------------------------------------ scheduled and queue handlers

/** Map wrangler.toml crons to the jobs: hourly change detection, nightly checkpoint, weekly gap reports. */
export async function runScheduled(ports: Ports, cron: string): Promise<void> {
  if (cron === "15 * * * *") return ports.jobs.hourlyChangeDetection();
  if (cron === "30 1 * * *") return ports.jobs.nightlyCheckpoint();
  if (cron === "0 6 * * 1") return ports.jobs.weeklyGapReports();
}

export async function runQueue(ports: Ports, messages: { body: unknown; ack(): void; retry(): void }[]): Promise<void> {
  for (const m of messages) {
    try {
      await ports.jobs.compile(m.body);
      m.ack();
    } catch {
      m.retry();
    }
  }
}
