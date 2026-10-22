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
// without blocking the response (Workers waitUntil when present).

import { Hono, type Context } from "hono";
import { utf8 } from "../core/encoding";
import { isTroothId, isSemantoId } from "../core/ids";
import { negotiate } from "../core/negotiate";
import { estimateTokens } from "../core/tokens";
import { versionId, type SemantoFile } from "../core/semanto";
import { buildResponse, toResponse, type LinkTargets, type ResponseSpec, type ServedRepresentation } from "./headers";
import { behindNotice, problem, renderProblem, type Problem, type ProblemCode } from "./errors";
import { negotiateRoute } from "./negotiate-route";
import { buildPageProof, verifyUrl } from "./proof";
import { factsJsonLd, manifestMarkdown, pageJsonLd, wellKnownSemanto } from "./represent";
import type { CompanyRecord, Ports, ReceiptInput, StoredPage } from "./ports";
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
  readers?: { verify(req: Request): Promise<{ agent_key_url: string | null; proven: boolean }> };
  /** Workspace authorization for /os routes, when the identity module is wired. Without it, every /os call is refused. */
  authorize?: (req: Request, trooth_id: string) => Promise<boolean>;
  /** Per-reader rate limit, when wired. */
  rateLimit?: (req: Request) => Promise<{ allowed: boolean; retry_after: number }>;
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
      if (deps.readers) {
        const r = await deps.readers.verify(c.req.raw);
        agent_key_url = r.agent_key_url ?? agent_key_url;
        proven = r.proven;
      }
      await ports.receipts.record({ ...input, agent_key_url, proof: proven ? "web_bot_auth" : "none", read_at: ports.now().toISOString() });
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
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, If-None-Match, Signature, Signature-Input, Signature-Agent, Trooth-Contract",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    await next();
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
    return send(c, { status: 200, rep: "json", body, version_id: versionId(file.root_hash), page_hash: file.root_hash, content_signals: settings.content_signals, links: links(company, file), signer });
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
    return send(c, { status: 200, rep: "json", body: json(file), version_id: versionId(file.root_hash), page_hash: file.root_hash, content_signals: settings.content_signals, links: links(company, file), signer: await signerFor(company) });
  });

  // ------------------------------------------------------------ pages

  type Loaded = { company: CompanyRecord; file: SemantoFile; settings: DeliverySettings; signer: Signer };

  async function servePage(c: Context<Vars>, r: Loaded, page: StoredPage, rep: "markdown" | "jsonld"): Promise<Response> {
    const { company, file, settings, signer } = r;
    const vid = versionId(file.root_hash);
    const behind = page.live === "behind";
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
    return send(c, {
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
    if (decision.rep === "html") {
      // Not ours: the company's host serves the HTML. Point the browser there.
      return new Response(null, { status: 303, headers: { Location: page.entry.url, Vary: "Accept", "Access-Control-Allow-Origin": "*" } });
    }
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
    return send(c, { status: 200, rep: "json", body: json(proof), version_id: proof.version_id, page_hash: proof.page_hash, content_signals: r.settings.content_signals, links: links(r.company, r.file, page), signer: r.signer });
  }

  // ------------------------------------------------------------ facts, llms, sitemap

  async function serveFacts(c: Context<Vars>, r: Loaded): Promise<Response> {
    const stored = await ports.versions.getJsonLd(r.company.trooth_id);
    const body = stored ?? json(factsJsonLd(r.file, ports.config));
    recordReceipt(c, { trooth_id: r.company.trooth_id, version: r.file.header.version, page_id: null, representation: "jsonld" });
    return send(c, { status: 200, rep: "jsonld", body, version_id: versionId(r.file.root_hash), content_signals: r.settings.content_signals, links: links(r.company, r.file), signer: r.signer });
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
    const text = new TextDecoder().decode(body);
    recordReceipt(c, { trooth_id: r.company.trooth_id, version: r.file.header.version, page_id: null, representation: "markdown" });
    return send(c, { status: 200, rep: "markdown", body, version_id: versionId(r.file.root_hash), markdown_tokens: estimateTokens(text), content_signals: r.settings.content_signals, links: links(r.company, r.file), signer: r.signer });
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
  app.get(`${apiPrefix}/:trooth_id/.well-known/trooth-keys.json`, serveKeys);

  app.get(`${apiPrefix}/:trooth_id/.well-known/trooth.semanto`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const file = await ports.versions.getCurrent(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(wellKnownSemanto(company, file, ports.config)), version_id: file ? versionId(file.root_hash) : null, links: links(company, file), signer: await signerFor(company) });
  });

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

  app.get(`${osPrefix}/:trooth_id/settings`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    if (!deps.authorize || !(await deps.authorize(c.req.raw, trooth_id))) return new Response(null, { status: 401 });
    const company = await ports.versions.getCompany(trooth_id);
    if (!company) return sendProblem(c, null, null, "semanto_not_found");
    const settings = await settingsFor(trooth_id);
    const file = await ports.versions.getCurrent(trooth_id);
    return send(c, { status: 200, rep: "json", body: json(settings), version_id: file ? versionId(file.root_hash) : null, signer: await signerFor(company) });
  });

  app.post(`${osPrefix}/:trooth_id/settings`, async (c) => {
    const trooth_id = c.req.param("trooth_id");
    if (!isTroothId(trooth_id)) return sendProblem(c, null, null, "invalid_trooth_id");
    if (!deps.authorize || !(await deps.authorize(c.req.raw, trooth_id))) return new Response(null, { status: 401 });
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

  app.notFound((c) => sendProblem(c, null, null, "semanto_not_found", { detail: "No route here. The public routes are listed at https://trooth.co/docs/semanto." }));

  return app;
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
