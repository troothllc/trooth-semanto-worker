// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/gap: buyer questions, provider adapters, comparison and the competitor view.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { factId, type Fact } from "@/core/semanto";
import { isSemantoId } from "@/core/ids";
import { questionsFor, allQuestions, coveredKeys, KEY_CATALOG, keyInfo, QUESTION_SETS, type QuestionParams, type Question } from "@/gap/prompts";
import {
  parseOpenAiResponse, parseAnthropicResponse, parseGeminiResponse, parsePerplexityResponse,
  buildOpenAiRequest, buildAnthropicRequest, buildGeminiRequest, buildPerplexityRequest,
  httpAdapter, serpAdapter, allAdapters, liveAdapters, withDeadline, PAUSED_PROVIDERS, providerMessage, retryDelayMs, durationMs, USER_PROMPT_PREFIX, isAnswer, isNotConfigured, isProviderError, MODELS, PROVIDERS, type ProviderAnswer,
} from "@/gap/providers";
import type { FetchPort, SerpPort, SerpAnswer, SerpEngine } from "@/gap/ports";
import { compareAnswer, citationNote, normalizeHours, extractMoney, type CompareContext } from "@/gap/compare";
import { buildGapReport, renderGapReportMarkdown, diffReports, renderDiffMarkdown, weeklyRunPlan, nextWeeklyRun, WEEKLY_RUN, runGapReport, type GapReport } from "@/gap/report";
import { buildCompetitorView, renderCompetitorHtml, renderCompetitorMarkdown, runCompetitorQuestions, type CompetitorRun } from "@/gap/competitor";
import { BANNED_WORDS, ELLIPSIS, THREE_DOTS } from "./helpers/house-rules";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/gap/${name}`, import.meta.url), "utf8")) as T;

interface FactsFixture { company: string; trooth_id: string; domains: string[]; facts: Omit<Fact, "id">[] }
const factsFixture = fixture<FactsFixture>("acme-facts.fixture.json");
const answers = fixture<Record<string, ProviderAnswer>>("answers.fixture.json");

async function loadFacts(): Promise<Fact[]> {
  return Promise.all(factsFixture.facts.map(async (f) => ({ id: await factId(f), ...f })));
}

const PARAMS: QuestionParams = { company: "Acme Inc", domain: "acme.com", products: ["Acme Widget"], competitor: { name: "Bolt Co", domain: "bolt.example" }, service: "a tune-up" };

async function ctx(): Promise<CompareContext> {
  return { facts: await loadFacts(), domains: ["acme.com"], networkBase: "https://trooth.co/network/company" };
}

const q = (id: string, kind: Question["kind"] = "shopping"): Question => allQuestions(PARAMS).find((x) => x.id === id) ?? (() => { throw new Error(`no question ${id} in ${kind}`); })();

// ------------------------------------------------------------------ A1 question sets

describe("gap question sets", () => {
  it("has at least 60 questions across the four sets for one company with one product", () => {
    const all = allQuestions(PARAMS);
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(questionsFor("b2b", PARAMS).length).toBeGreaterThanOrEqual(15);
    expect(questionsFor("shopping", PARAMS).length).toBeGreaterThanOrEqual(12);
    expect(questionsFor("local", PARAMS).length).toBeGreaterThanOrEqual(12);
    expect(questionsFor("competitor", PARAMS).length).toBeGreaterThanOrEqual(12);
  });
  it("maps every question to keys that are all in the key catalog", () => {
    for (const k of coveredKeys()) expect(KEY_CATALOG[k], k).toBeDefined();
    expect(keyInfo("products.acme-widget.price").type).toBe("money");
    expect(keyInfo("local.hours").type).toBe("hours");
  });
  it("covers the B2B, shopping and local topics the brief lists", () => {
    const keys = new Set(coveredKeys());
    for (const k of ["security.mfa", "security.encryption_at_rest", "security.soc2", "security.iso27001", "security.data_residency", "privacy.subprocessors", "terms.uptime_commitment", "support.hours", "commercial.pricing_model", "terms.minimum_term", "privacy.data_deletion_days"]) expect(keys.has(k), k).toBe(true);
    for (const k of ["products.{slug}.price", "products.{slug}.availability", "products.{slug}.sizes", "products.{slug}.materials", "products.{slug}.warranty", "commercial.returns_window_days", "commercial.authorized_sellers", "products.{slug}.safety_warnings"]) expect(keys.has(k), k).toBe(true);
    for (const k of ["local.hours", "local.address", "local.phone", "local.services", "local.parking", "local.accessibility", "local.appointment_policy"]) expect(keys.has(k), k).toBe(true);
  });
  it("parameterizes by company, product and competitor, and repeats product questions per product", () => {
    const shop = questionsFor("shopping", { ...PARAMS, products: ["Acme Widget", "Acme Gadget"] });
    expect(shop.filter((x) => x.template_id === "shop.price")).toHaveLength(2);
    expect(shop.find((x) => x.id === "shop.price:acme-gadget")?.keys).toEqual(["products.acme-gadget.price"]);
    const cmp = questionsFor("competitor", PARAMS);
    for (const x of cmp) expect(x.text).toMatch(/Which of Acme Inc and Bolt Co/);
    expect(questionsFor("local", PARAMS).find((x) => x.id === "local.service_price")?.text).toContain("a tune-up");
  });
  it("never uses the banned words in question copy", () => {
    for (const set of Object.values(QUESTION_SETS)) for (const t of set) expect(t.text(PARAMS, "Acme Widget")).not.toMatch(BANNED_WORDS);
  });
});

// ------------------------------------------------------------------ A2 providers

describe("gap provider adapters", () => {
  it("builds the documented request shapes with the model constants", () => {
    const o = buildOpenAiRequest("q", "k1");
    expect(o.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(o.init.body)).toMatchObject({ model: MODELS.openai, web_search_options: { search_context_size: "low" } });
    expect(o.init.headers.authorization).toBe("Bearer k1");
    const a = buildAnthropicRequest("q", "k2");
    expect(a.init.headers["x-api-key"]).toBe("k2");
    expect(JSON.parse(a.init.body).tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search" });
    const g = buildGeminiRequest("q", "k3");
    expect(g.url).toContain(`/models/${MODELS.gemini}:generateContent`);
    expect(JSON.parse(g.init.body).tools[0]).toEqual({ google_search: {} });
    // Sonar Chat Completions ended 2026-09-27: the Agent API at /v1/agent, "fast" effort, the question as input.
    const p = buildPerplexityRequest("q", "k4");
    expect(p.url).toBe("https://api.perplexity.ai/v1/agent");
    expect(JSON.parse(p.init.body)).toEqual({ effort: "fast", input: `${USER_PROMPT_PREFIX}q` });
  });
  it("parses the OpenAI fixture: text and url_citation annotations", () => {
    const r = parseOpenAiResponse(fixture("openai.fixture.json"));
    expect(r.answer_text).toContain("$59");
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-retailer.test/acme-widget", "https://acme.com/widget"]);
    expect(r.model).toBe("gpt-4o-search-preview-fixture");
  });
  it("parses the Anthropic fixture: joined text blocks and web_search_result_location citations", () => {
    const r = parseAnthropicResponse(fixture("anthropic.fixture.json"));
    expect(r.answer_text).toBe("According to Acme's product page, the Acme Widget costs $49.");
    expect(r.citations).toEqual([{ url: "https://acme.com/widget", title: "Acme Widget" }]);
  });
  it("parses the Gemini fixture: parts and groundingChunks", () => {
    const r = parseGeminiResponse(fixture("gemini.fixture.json"));
    expect(r.answer_text).toBe("Acme Inc holds a SOC 2 Type II report, renewed every year.");
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-reviews.test/acme", "https://example-directory.test/acme-inc"]);
  });
  it("parses the Perplexity Agent API answer: output_text parts and search_results items", () => {
    const r = parsePerplexityResponse(fixture("perplexity-agent.fixture.json"));
    expect(r.answer_text).toContain("multi-factor");
    expect(r.citations.map((c) => c.url)).toEqual(["https://example-reviews.test/acme-security", "https://example-forum.test/thread/12"]);
    expect(r.model).toBe("perplexity/agent-fast-fixture");
  });
  it("parses the Perplexity fixture: content, search_results and citations, deduplicated", () => {
    const r = parsePerplexityResponse(fixture("perplexity.fixture.json"));
    expect(r.answer_text).toContain("multi-factor");
    expect(r.citations).toHaveLength(2);
    expect(r.citations[0]).toEqual({ url: "https://example-reviews.test/acme-security", title: "Acme security review" });
  });
  it("reports a provider without a key as not configured, never silently skipped", async () => {
    const neverCalled: FetchPort = async () => { throw new Error("must not be called"); };
    for (const p of ["openai", "anthropic", "gemini", "perplexity"] as const) {
      const r = await httpAdapter(p, {}, neverCalled).ask("q");
      expect(isNotConfigured(r)).toBe(true);
      if (isNotConfigured(r)) expect(r.reason).toMatch(/_API_KEY is not set/);
    }
    const serp = serpAdapter("google_ai_mode", undefined);
    const r = await serp.ask("q");
    expect(isNotConfigured(r)).toBe(true);
    expect(allAdapters({}, neverCalled).map((a) => a.provider)).toEqual(PROVIDERS);
  });
  it("asks through the fetch port and returns the common shape; non-2xx is an error, not an answer", async () => {
    const fetchPort: FetchPort = async (url) => ({ status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(fixture(url.includes("openai") ? "openai.fixture.json" : "perplexity.fixture.json")) });
    const r = await httpAdapter("openai", { OPENAI_API_KEY: "k" }, fetchPort).ask("How much does the Acme Widget cost?", { now: () => new Date("2026-10-20T09:00:00Z") });
    expect(isAnswer(r)).toBe(true);
    if (isAnswer(r)) {
      expect(r.provider).toBe("openai");
      expect(r.asked_at).toBe("2026-10-20T09:00:00.000Z");
      expect(r.citations.length).toBe(2);
    }
    const failing: FetchPort = async () => ({ status: 500, headers: { get: () => null }, text: async () => "server error" });
    const e = await httpAdapter("perplexity", { PERPLEXITY_API_KEY: "k" }, failing).ask("q");
    expect(isProviderError(e)).toBe(true);
  });
  it("reads Google AI Mode, AI Overviews and Copilot through the SERP port; a null answer is an empty answer", async () => {
    const data = fixture<Record<SerpEngine, SerpAnswer | null>>("serp.fixture.json");
    const port: SerpPort = { name: "fixture-serp", engines: ["google_ai_mode", "google_ai_overviews", "copilot"], fetchAnswer: async (engine) => data[engine] };
    const mode = await serpAdapter("google_ai_mode", port).ask("q");
    expect(isAnswer(mode) && mode.answer_text).toContain("99.9%");
    const ov = await serpAdapter("google_ai_overviews", port).ask("q");
    expect(isAnswer(ov) && ov.answer_text).toBe("");
    const cp = await serpAdapter("copilot", port).ask("q");
    expect(isAnswer(cp) && cp.citations[0]?.url).toBe("https://example-directory.test/acme");
    const narrow: SerpPort = { ...port, engines: ["copilot"] };
    expect(isNotConfigured(await serpAdapter("google_ai_mode", narrow).ask("q"))).toBe(true);
  });
});

// ------------------------------------------------------------------ A3 comparison

describe("gap adapters: deadlines and paused assistants", () => {
  it("an assistant that never answers counts as not answered once the deadline passes", async () => {
    const hang: FetchPort = () => new Promise(() => undefined);
    const a = httpAdapter("openai", { OPENAI_API_KEY: "k" }, hang, 20);
    const r = await a.ask("Who is Acme?");
    expect(r).toMatchObject({ provider: "openai", configured: true });
    expect((r as { error?: string }).error).toContain("no answer within");
    const slowBody: FetchPort = async () => ({ status: 200, headers: { get: () => null }, text: () => new Promise<string>(() => undefined) });
    expect(((await httpAdapter("anthropic", { ANTHROPIC_API_KEY: "k" }, slowBody, 20).ask("q")) as { error?: string }).error).toContain("no answer within");
    const serp: SerpPort = { name: "fixture", engines: ["copilot"], fetchAnswer: () => new Promise<SerpAnswer | null>(() => undefined) };
    expect(((await serpAdapter("copilot", serp, 20).ask("q")) as { error?: string }).error).toContain("no answer within");
  });
  it("production reports leave out the paused assistants until they are taken out of the set", () => {
    const keys = { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k", PERPLEXITY_API_KEY: "k" };
    const fetchPort: FetchPort = async () => ({ status: 500, headers: { get: () => null }, text: async () => "" });
    expect(liveAdapters(keys, fetchPort).map((a) => a.provider)).toEqual(["openai", "anthropic", "perplexity"]);
    expect([...PAUSED_PROVIDERS].sort()).toEqual(["copilot", "gemini", "google_ai_mode", "google_ai_overviews"]);
    expect(liveAdapters(keys, fetchPort, undefined, new Set()).map((a) => a.provider)).toEqual(["openai", "anthropic", "gemini", "perplexity", "google_ai_mode", "google_ai_overviews", "copilot"]);
  });
  it("a rate-limited assistant is asked again after Retry-After, and a failure keeps the provider's own reason without any key", async () => {
    let calls = 0;
    const busyOnce: FetchPort = async () => {
      calls++;
      if (calls === 1) return { status: 429, headers: { get: (n: string) => (n === "retry-after" ? "0" : null) }, text: async () => JSON.stringify({ error: { message: "Rate limit reached" } }) };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture("openai.fixture.json")) };
    };
    const ok = await httpAdapter("openai", { OPENAI_API_KEY: "k" }, busyOnce).ask("Who is Acme?");
    expect(calls).toBe(2);
    expect(isAnswer(ok)).toBe(true);
    const denied: FetchPort = async () => ({ status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com." } }) });
    const r = (await httpAdapter("openai", { OPENAI_API_KEY: "k" }, denied).ask("q")) as { error: string; status: number };
    expect(r.status).toBe(401);
    expect(r.error).toContain("provider answered 401: Incorrect API key provided: [key]");
    expect(r.error).not.toContain("sk-proj");
    expect(providerMessage(JSON.stringify({ error: "credit balance too low" }))).toBe("credit balance too low");
    expect(providerMessage("<html>")).toBeNull();
    expect(retryDelayMs("3", 0)).toBe(3000);
    expect(retryDelayMs(null, 1)).toBe(4000);
    expect(retryDelayMs("120", 0)).toBe(10_000);
    // The report keeps the first reason per assistant.
    const report = await runGapReport({ trooth_id: "acme-inc", company: "Acme Inc", kind: "b2b", ran_at: "2026-10-29T21:00:00Z", questions: allQuestions(PARAMS).filter((x) => x.kind === "b2b").slice(0, 2), adapters: [httpAdapter("openai", { OPENAI_API_KEY: "k" }, denied)], context: await ctx() });
    expect(report.providers[0]).toMatchObject({ provider: "openai", errors: 2, last_error: expect.stringContaining("401") });
  });
  it("OpenAI is asked one question at a time, a key is read without surrounding spaces, and reset times parse", async () => {
    let open = 0;
    let most = 0;
    const seen: string[] = [];
    const slow: FetchPort = async (_url, init) => {
      open++;
      most = Math.max(most, open);
      seen.push(init.headers.authorization ?? "");
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture("openai.fixture.json")) };
    };
    const a = httpAdapter("openai", { OPENAI_API_KEY: "  k-openai \n" }, slow);
    await Promise.all([a.ask("q1"), a.ask("q2"), a.ask("q3")]);
    expect(most).toBe(1);
    expect(seen).toEqual(["Bearer k-openai", "Bearer k-openai", "Bearer k-openai"]);
    expect(durationMs("28ms")).toBe(28);
    expect(durationMs("1.5s")).toBe(1500);
    expect(durationMs("6m0s")).toBe(360_000);
    expect(durationMs("soon")).toBeNull();
    expect(retryDelayMs(null, 0, "28ms")).toBe(250);
    expect(retryDelayMs(null, 0, "1.5s")).toBe(1500);
  });
  it("withDeadline passes a prompt answer through untouched", async () => {
    expect(await withDeadline(Promise.resolve(7), 1000)).toBe(7);
  });
});

describe("gap comparison", () => {
  it("classifies a wrong price as differs with the signed correction", async () => {
    const [f] = compareAnswer(q("shop.price:acme-widget"), answers.wrong_price!, await ctx());
    expect(f!.classification).toBe("differs");
    expect(f!.said).toContain("$59");
    expect(f!.signed_statement).toBe("The Acme Widget costs $49.");
    expect(isSemantoId(f!.fact_id, "smf")).toBe(true);
    expect(f!.evidence_url).toBe("https://acme.com/widget");
    expect(f!.citation).toBe("own_domain");
  });
  it("classifies a right price cited from the company's own site as matches", async () => {
    const [f] = compareAnswer(q("shop.price:acme-widget"), answers.right_price_own_site!, await ctx());
    expect(f!.classification).toBe("matches");
    expect(f!.citation).toBe("own_domain");
  });
  it("classifies a fabricated SOC 2 claim as unsupported_claim when the record says not_published", async () => {
    const [f] = compareAnswer(q("b2b.soc2"), answers.fabricated_soc2!, await ctx());
    expect(f!.classification).toBe("unsupported_claim");
    expect(f!.signed_value).toBe("not_published");
  });
  it("classifies a right claim with only third-party citations as cites_third_party", async () => {
    const fs = compareAnswer(q("b2b.mfa"), answers.third_party_mfa!, await ctx());
    expect(fs.map((f) => f.classification)).toEqual(["cites_third_party", "cites_third_party"]);
    expect(fs[0]!.citation).toBe("neither");
  });
  it("notes a Trooth Network citation and counts it as matches", async () => {
    const [f] = compareAnswer(q("b2b.uptime"), answers.network_cited_uptime!, await ctx());
    expect(f!.classification).toBe("matches");
    expect(f!.citation).toBe("trooth_network");
  });
  it("classifies silence as not_answered", async () => {
    const [f] = compareAnswer(q("local.hours"), answers.silent!, await ctx());
    expect(f!.classification).toBe("not_answered");
    expect(f!.citation).toBe("none");
  });
  it("reads hours, phone numbers, addresses and booleans", async () => {
    const c = await ctx();
    expect(compareAnswer(q("local.hours"), answers.wrong_hours!, c)[0]!.classification).toBe("differs");
    expect(normalizeHours("9am-5pm")).toBe("09:00-17:00");
    expect(normalizeHours("8:30 a.m. to 6 p.m.")).toBe("08:30-18:00");
    expect(compareAnswer(q("local.phone"), answers.right_phone_and_address!, c)[0]!.classification).toBe("matches");
    expect(compareAnswer(q("local.address"), answers.right_phone_and_address!, c)[0]!.classification).toBe("matches");
    expect(compareAnswer(q("local.walk_ins"), answers.walk_ins_wrong!, c)[0]!.classification).toBe("differs");
  });
  it("prefers the sentence about the named product when reading money", () => {
    const claim = extractMoney("The Acme Gadget costs $19. The Acme Widget costs $49.", ["cost", "costs"], "Acme Widget");
    expect(claim?.value).toBe(49);
  });
  it("recognizes own-domain citations with and without www and subdomains", () => {
    expect(citationNote([{ url: "https://www.acme.com/x" }], ["acme.com"], "https://trooth.co/network/company")).toBe("own_domain");
    expect(citationNote([{ url: "https://shop.acme.com/x" }], ["acme.com"], "https://trooth.co/network/company")).toBe("own_domain");
    expect(citationNote([{ url: "https://notacme.com/x" }], ["acme.com"], "https://trooth.co/network/company")).toBe("neither");
    expect(citationNote([], ["acme.com"], "https://trooth.co/network/company")).toBe("none");
  });
});

// ------------------------------------------------------------------ A4 report

async function sampleReport(ranAt: string, priceAnswer: ProviderAnswer): Promise<GapReport> {
  return buildGapReport({
    trooth_id: "acme-inc",
    company: "Acme Inc",
    kind: "shopping",
    ran_at: ranAt,
    asked: [
      { question: q("shop.price:acme-widget"), results: [priceAnswer, { provider: "gemini", configured: false, reason: "GEMINI_API_KEY is not set" }] },
      { question: q("b2b.mfa"), results: [answers.third_party_mfa!, { provider: "gemini", configured: false, reason: "GEMINI_API_KEY is not set" }] },
      { question: q("local.hours"), results: [answers.silent!] },
    ],
    adapters: [
      { provider: "openai", missing: null },
      { provider: "perplexity", missing: null },
      { provider: "google_ai_mode", missing: null },
      { provider: "gemini", missing: "GEMINI_API_KEY is not set" },
      { provider: "copilot", missing: "no SERP data provider is connected for Microsoft Copilot" },
    ],
    context: await ctx(),
  });
}

describe("gap report", () => {
  it("builds the report object with totals, corrections and citation shares, and a content-addressed id", async () => {
    const r = await sampleReport("2026-10-20T09:00:00Z", answers.wrong_price!);
    expect(r.object).toBe("semanto.gap_report");
    expect(isSemantoId(r.id, "smg")).toBe(true);
    expect(r.totals.openai!.differs).toBe(1);
    expect(r.totals.perplexity!.cites_third_party).toBe(2);
    expect(r.totals.google_ai_mode!.not_answered).toBe(1);
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0]).toMatchObject({ provider: "openai", signed_statement: "The Acme Widget costs $49.", evidence_url: "https://acme.com/widget" });
    expect(r.own_domain_citation_share.openai).toEqual({ cited_own_domain: 1, answers: 1, share: 1 });
    expect(r.own_domain_citation_share.perplexity).toEqual({ cited_own_domain: 0, answers: 1, share: 0 });
    expect(r.providers.find((p) => p.provider === "gemini")).toMatchObject({ configured: false, reason: "GEMINI_API_KEY is not set" });
    expect(r.providers.find((p) => p.provider === "copilot")?.configured).toBe(false);
    const again = await sampleReport("2026-10-20T09:00:00Z", answers.wrong_price!);
    expect(again.id).toBe(r.id);
  });
  it("renders markdown a person can read, with unconfigured providers named and no banned words", async () => {
    const r = await sampleReport("2026-10-20T09:00:00Z", answers.wrong_price!);
    const md = renderGapReportMarkdown(r);
    expect(md).toContain("# What AI assistants say about Acme Inc");
    expect(md).toContain("Gemini (Google): not configured");
    expect(md).toContain("Microsoft Copilot: not configured");
    expect(md).toContain("The signed record says: The Acme Widget costs $49.");
    expect(md).toContain("1 of 1 answers");
    expect(md).not.toMatch(BANNED_WORDS);
    expect(md).not.toContain(THREE_DOTS);
  });
  it("diffs two reports by classification: a corrected price counts as resolved", async () => {
    const before = await sampleReport("2026-10-13T09:00:00Z", answers.wrong_price!);
    const after = await sampleReport("2026-10-20T09:00:00Z", { ...answers.right_price_own_site!, provider: "openai" });
    const d = diffReports(before, after);
    expect(d.delta.openai!.differs).toBe(-1);
    expect(d.delta.openai!.matches).toBe(1);
    expect(d.resolved).toHaveLength(1);
    expect(d.regressed).toHaveLength(0);
    expect(d.changed[0]).toMatchObject({ provider: "openai", key: "products.acme-widget.price", before: "differs", after: "matches" });
    const md = renderDiffMarkdown(d);
    expect(md).toContain("1 mismatch now match the signed record");
    const back = diffReports(after, before);
    expect(back.regressed).toHaveLength(1);
  });
  it("plans the weekly Monday run", () => {
    expect(WEEKLY_RUN.cron).toBe("0 6 * * MON");
    expect(nextWeeklyRun(new Date("2026-10-21T12:00:00Z")).toISOString()).toBe("2026-10-26T06:00:00.000Z");
    expect(nextWeeklyRun(new Date("2026-10-26T06:00:00Z")).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(nextWeeklyRun(new Date("2026-10-26T05:00:00Z")).toISOString()).toBe("2026-10-26T06:00:00.000Z");
    const plan = weeklyRunPlan("acme-inc", new Date("2026-10-21T12:00:00Z"));
    expect(plan).toMatchObject({ trooth_id: "acme-inc", cron: "0 6 * * MON", next_run_at: "2026-10-26T06:00:00.000Z", alert_on: ["differs", "unsupported_claim"] });
  });
  it("runs end to end through adapters with in-memory ports", async () => {
    const fetchPort: FetchPort = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture("openai.fixture.json")) });
    const adapters = allAdapters({ OPENAI_API_KEY: "k" }, fetchPort);
    const r = await runGapReport({ trooth_id: "acme-inc", company: "Acme Inc", kind: "shopping", ran_at: "2026-10-20T09:00:00Z", questions: [q("shop.price:acme-widget")], adapters, context: await ctx() });
    expect(r.providers.filter((p) => p.configured).map((p) => p.provider)).toEqual(["openai"]);
    expect(r.providers.filter((p) => !p.configured)).toHaveLength(6);
    expect(r.totals.openai!.differs).toBe(1);
  });
});

// ------------------------------------------------------------------ A5 competitor view

describe("competitor view", () => {
  const companies = [
    { name: "Acme Inc", domain: "acme.com" },
    { name: "Bolt Co", domain: "bolt.example" },
    { name: "Cog Ltd", domain: "cog.example" },
    { name: "Dyno LLC", domain: "dyno.example" },
  ];
  function runsFor(): CompetitorRun[] {
    const runs: CompetitorRun[] = [];
    for (const c of companies) {
      for (const question of questionsFor("local", { company: c.name, domain: c.domain, products: [] })) {
        const named = c.name !== "Dyno LLC";
        runs.push({
          company: c.name,
          question,
          results: [
            { provider: "openai", model: "fixture", answer_text: named ? `${c.name} is open 9am to 5pm on weekdays.` : "No clear answer was found.", citations: c.name === "Acme Inc" ? [{ url: `https://${c.domain}/contact` }] : [{ url: "https://example-directory.test/x" }], asked_at: "2026-10-20T09:00:00Z", raw: null },
            { provider: "gemini", configured: false, reason: "GEMINI_API_KEY is not set" },
          ],
        });
      }
    }
    return runs;
  }
  it("builds a side-by-side for a company and three competitors", () => {
    const v = buildCompetitorView("local", companies[0]!, companies.slice(1), runsFor(), "2026-10-20T09:00:00Z");
    expect(v.rows.length).toBe(questionsFor("local", { company: "x", domain: "x.example", products: [] }).length);
    const row = v.rows.find((r) => r.template_id === "local.hours")!;
    expect(row.question).toBe("What are this business's opening hours?");
    expect(row.cells.map((c) => c.company)).toEqual(["Acme Inc", "Bolt Co", "Cog Ltd", "Dyno LLC"]);
    expect(row.cells[0]).toMatchObject({ mentioned_in: 1, answers: 1, own_site_cited_in: 1 });
    expect(row.cells[1]).toMatchObject({ mentioned_in: 1, own_site_cited_in: 0 });
    expect(row.cells[3]).toMatchObject({ mentioned_in: 0, what_they_said: null });
    expect(v.summary.mentioned_in).toBe(v.rows.length);
    expect(v.providers_not_configured[0]).toMatchObject({ provider: "gemini" });
  });
  it("refuses more than three competitors", () => {
    expect(() => buildCompetitorView("local", companies[0]!, [...companies.slice(1), { name: "E", domain: "e.example" }], [], "2026-10-20T09:00:00Z")).toThrow(/at most 3/);
  });
  it("renders mobile-first HTML with exactly one blue action link, and plain markdown", () => {
    const v = buildCompetitorView("local", companies[0]!, companies.slice(1), runsFor(), "2026-10-20T09:00:00Z");
    const html = renderCompetitorHtml(v, "https://trooth.co/semanto/start?domain=acme.com");
    expect(html).toContain('name="viewport"');
    expect(html.match(/#1A73E8/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("Named in 1 of 1 answers");
    expect(html).not.toMatch(BANNED_WORDS);
    const md = renderCompetitorMarkdown(v);
    expect(md).toContain("Your business was named in");
    expect(md).not.toContain(THREE_DOTS);
  });
  it("asks the set about each company through the adapters", async () => {
    const seen: string[] = [];
    const adapter = { provider: "openai" as const, missing: () => null, ask: async (t: string) => { seen.push(t); return { provider: "openai" as const, model: "m", answer_text: "", citations: [], asked_at: "2026-10-20T09:00:00Z", raw: null }; } };
    const runs = await runCompetitorQuestions("local", companies[0]!, companies.slice(1, 3), [adapter]);
    const perCompany = questionsFor("local", { company: "x", domain: "x", products: [] }).length;
    expect(runs).toHaveLength(perCompany * 3);
    expect(seen.some((t) => t.includes("Cog Ltd"))).toBe(true);
  });
});
