// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Provider adapters for the gap report. One interface, ask(question, options),
// returns the same shape from every assistant so the comparison never cares
// who answered. Each adapter is a pure request builder plus a pure response
// parser over the fetch port; the key comes from Env and a provider without a
// key is reported as "not configured", never silently skipped.
//
// Request shapes follow each vendor's public API reference as of October 2026 (models updated 2026-10-25):
//   OpenAI      Chat Completions with web_search_options (platform.openai.com,
//               "Web search" guide) and url_citation annotations
//   Anthropic   Messages API with the web_search_20250305 server tool and
//               web_search_result_location citations (docs.anthropic.com,
//               "Web search tool")
//   Google      generateContent with the google_search tool (Grounding with
//               Google Search, ai.google.dev) and groundingChunks
//   Perplexity  Chat Completions, model sonar, with search_results
//   Google AI Mode, AI Overviews and Microsoft Copilot
//               through the SERP port only. No scraping of Google or Bing in
//               this code, by design: those surfaces have no public API, and
//               the founder connects a licensed SERP data provider.
//
// Model names live in MODELS so they can be updated in one place.

import type { FetchPort, ProviderKeys, SerpEngine, SerpPort } from "./ports";

export type ProviderName = "openai" | "anthropic" | "gemini" | "perplexity" | SerpEngine;

export const PROVIDERS: ProviderName[] = ["openai", "anthropic", "gemini", "perplexity", "google_ai_mode", "google_ai_overviews", "copilot"];

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  openai: "ChatGPT (OpenAI)",
  anthropic: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
  perplexity: "Perplexity",
  google_ai_mode: "Google AI Mode",
  google_ai_overviews: "Google AI Overviews",
  copilot: "Microsoft Copilot",
};

/** The model each adapter asks for. Change here and nowhere else. */
export const MODELS = {
  // 2026-10-25: gpt-4o-search-preview was shut down on 2026-07-23; gpt-5-search-api is OpenAI's web search model for
  // Chat Completions. gemini-3.8-flash is the newest stable Flash with Grounding with Google Search (GA 2026-09-02).
  openai: "gpt-5-search-api",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-3.8-flash",
  // 2026-10-29: Sonar Chat Completions support ended on 2026-09-27 (the API answers 403); the Agent API's "fast" effort
  // is Perplexity's mapping for Sonar (docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
  perplexity: "fast",
} as const;

export const ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  perplexity: "https://api.perplexity.ai/v1/agent",
} as const;

export const ANTHROPIC_VERSION = "2023-06-01";

export interface Citation {
  url: string;
  title?: string;
}

export interface ProviderAnswer {
  provider: ProviderName;
  model: string;
  answer_text: string;
  citations: Citation[];
  /** ISO 8601. */
  asked_at: string;
  raw: unknown;
}

export interface NotConfigured {
  provider: ProviderName;
  configured: false;
  reason: string;
}

export interface ProviderError {
  provider: ProviderName;
  configured: true;
  error: string;
  status?: number;
  asked_at: string;
}

export type AskResult = ProviderAnswer | NotConfigured | ProviderError;

export const isAnswer = (r: AskResult): r is ProviderAnswer => "answer_text" in r;
export const isNotConfigured = (r: AskResult): r is NotConfigured => "configured" in r && r.configured === false;
export const isProviderError = (r: AskResult): r is ProviderError => "error" in r;

export interface AskOptions {
  /** Two-letter country for the SERP port. */
  country?: string;
  language?: string;
  now?: () => Date;
}

export interface BuiltRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

export interface Parsed {
  answer_text: string;
  citations: Citation[];
  model: string;
}

export interface ProviderAdapter {
  provider: ProviderName;
  /** Why the provider is not configured, or null when it is. */
  missing(): string | null;
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
}

// A sentence a buyer would type; the same framing to every provider so answers compare.
export const USER_PROMPT_PREFIX = "Answer as you would for a buyer, with sources. ";

const iso = (opts?: AskOptions) => (opts?.now ? opts.now() : new Date()).toISOString();

function dedupe(cs: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of cs) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c.title ? { url: c.url, title: c.title } : { url: c.url });
  }
  return out;
}

// ------------------------------------------------------------------ OpenAI

export function buildOpenAiRequest(question: string, key: string): BuiltRequest {
  return {
    url: ENDPOINTS.openai,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODELS.openai,
        // "low" keeps each answer's search context small: a new account's tokens-per-minute limit (45,000 on
        // 2026-10-29) was spent by two questions at the default size.
        web_search_options: { search_context_size: "low" },
        messages: [{ role: "user", content: USER_PROMPT_PREFIX + question }],
      }),
    },
  };
}

export function parseOpenAiResponse(json: unknown): Parsed {
  const j = json as { model?: string; choices?: { message?: { content?: string; annotations?: { type?: string; url_citation?: { url?: string; title?: string } }[] } }[] };
  const msg = j.choices?.[0]?.message;
  const citations: Citation[] = [];
  for (const a of msg?.annotations ?? []) {
    if (a.type === "url_citation" && a.url_citation?.url) citations.push({ url: a.url_citation.url, ...(a.url_citation.title ? { title: a.url_citation.title } : {}) });
  }
  return { answer_text: msg?.content ?? "", citations: dedupe(citations), model: j.model ?? MODELS.openai };
}

// ------------------------------------------------------------------ Anthropic

export function buildAnthropicRequest(question: string, key: string): BuiltRequest {
  return {
    url: ENDPOINTS.anthropic,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: MODELS.anthropic,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: USER_PROMPT_PREFIX + question }],
      }),
    },
  };
}

export function parseAnthropicResponse(json: unknown): Parsed {
  const j = json as {
    model?: string;
    content?: { type?: string; text?: string; citations?: { type?: string; url?: string; title?: string }[]; content?: { type?: string; url?: string; title?: string }[] }[];
  };
  let text = "";
  const cited: Citation[] = [];
  const searched: Citation[] = [];
  for (const block of j.content ?? []) {
    if (block.type === "text") {
      text += block.text ?? "";
      for (const c of block.citations ?? []) if (c.type === "web_search_result_location" && c.url) cited.push({ url: c.url, ...(c.title ? { title: c.title } : {}) });
    } else if (block.type === "web_search_tool_result") {
      for (const r of block.content ?? []) if (r.type === "web_search_result" && r.url) searched.push({ url: r.url, ...(r.title ? { title: r.title } : {}) });
    }
  }
  // Citations the model attached to its text are what it relied on; the search
  // results are the fallback when it attached none.
  return { answer_text: text, citations: dedupe(cited.length ? cited : searched), model: j.model ?? MODELS.anthropic };
}

// ------------------------------------------------------------------ Gemini

export function buildGeminiRequest(question: string, key: string): BuiltRequest {
  return {
    url: ENDPOINTS.gemini(MODELS.gemini),
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: USER_PROMPT_PREFIX + question }] }],
        tools: [{ google_search: {} }],
      }),
    },
  };
}

export function parseGeminiResponse(json: unknown): Parsed {
  const j = json as {
    modelVersion?: string;
    candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] } }[];
  };
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const citations: Citation[] = [];
  for (const ch of cand?.groundingMetadata?.groundingChunks ?? []) if (ch.web?.uri) citations.push({ url: ch.web.uri, ...(ch.web.title ? { title: ch.web.title } : {}) });
  return { answer_text: text, citations: dedupe(citations), model: j.modelVersion ?? MODELS.gemini };
}

// ------------------------------------------------------------------ Perplexity

export function buildPerplexityRequest(question: string, key: string): BuiltRequest {
  return {
    url: ENDPOINTS.perplexity,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ effort: MODELS.perplexity, input: USER_PROMPT_PREFIX + question }),
    },
  };
}

/** The Agent API answer (output[]: search_results items and message items with output_text parts), and the older Sonar shape. */
export function parsePerplexityResponse(json: unknown): Parsed {
  type Part = { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] };
  type Item = { type?: string; results?: { url?: string; title?: string }[]; content?: Part[] };
  const j = json as { model?: string; output_text?: string; output?: Item[]; choices?: { message?: { content?: string } }[]; search_results?: { url?: string; title?: string }[]; citations?: string[] };
  const citations: Citation[] = [];
  let text = "";
  for (const item of j.output ?? []) {
    if (item.type === "search_results") for (const r of item.results ?? []) if (r.url) citations.push({ url: r.url, ...(r.title ? { title: r.title } : {}) });
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) text += part.text;
        for (const a of part.annotations ?? []) if (a.url) citations.push({ url: a.url, ...(a.title ? { title: a.title } : {}) });
      }
    }
  }
  for (const r of j.search_results ?? []) if (r.url) citations.push({ url: r.url, ...(r.title ? { title: r.title } : {}) });
  for (const u of j.citations ?? []) citations.push({ url: u });
  const answer = text || (typeof j.output_text === "string" ? j.output_text : "") || j.choices?.[0]?.message?.content || "";
  return { answer_text: answer, citations: dedupe(citations), model: j.model ?? `perplexity-agent:${MODELS.perplexity}` };
}

// ------------------------------------------------------------------ adapters

type HttpProvider = "openai" | "anthropic" | "gemini" | "perplexity";

const HTTP: Record<HttpProvider, { keyName: keyof ProviderKeys; build: (q: string, key: string) => BuiltRequest; parse: (json: unknown) => Parsed }> = {
  openai: { keyName: "OPENAI_API_KEY", build: buildOpenAiRequest, parse: parseOpenAiResponse },
  anthropic: { keyName: "ANTHROPIC_API_KEY", build: buildAnthropicRequest, parse: parseAnthropicResponse },
  gemini: { keyName: "GEMINI_API_KEY", build: buildGeminiRequest, parse: parseGeminiResponse },
  perplexity: { keyName: "PERPLEXITY_API_KEY", build: buildPerplexityRequest, parse: parsePerplexityResponse },
};

/** How long one question waits for one assistant, answer body included, before it counts as not answered. */
export const GAP_ASK_TIMEOUT_MS = 45_000;

/** Settles with the promise, or rejects once `ms` passes, so one slow assistant never holds the whole report. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} seconds`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Assistants kept out of customer reports until counsel has reviewed them (founder, 2026-10-29): Gemini answers
 * grounded in Google Search (the Gemini API terms limit storing and analyzing grounded results) and the three
 * surfaces read through SerpApi (Google v. SerpApi and Reddit v. SerpApi are open). The adapters stay built and
 * tested; taking a name out of this set brings that assistant back.
 */
export const PAUSED_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(["gemini", "google_ai_mode", "google_ai_overviews", "copilot"]);

/** The adapters production reports use: every adapter except the paused ones. */
export function liveAdapters(keys: ProviderKeys, fetchPort: FetchPort, serp?: SerpPort, paused: ReadonlySet<ProviderName> = PAUSED_PROVIDERS): ProviderAdapter[] {
  return allAdapters(keys, fetchPort, serp).filter((a) => !paused.has(a.provider));
}

const RETRY_STATUSES = new Set([429, 503, 529]);
/** Asked one question at a time (OpenAI's search model: 45,000 tokens a minute on a new account, 2026-10-29). */
const ONE_AT_A_TIME: ReadonlySet<HttpProvider> = new Set<HttpProvider>(["openai"]);
const RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A reset time as OpenAI writes it ("28ms", "1.5s", "6m0s"), in milliseconds. */
export function durationMs(v: string | null): number | null {
  if (!v) return null;
  const m = /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(v.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
}

/** Retry-After in seconds, else the tokens or requests reset time, else 2 s doubling; never under 250 ms or over 10 s. */
export function retryDelayMs(retryAfter: string | null, attempt: number, reset: string | null = null): number {
  const s = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : durationMs(reset);
  return Math.max(250, Math.min(s ?? 2000 * 2 ** attempt, 10_000));
}

/** The provider's own error message ({ error: { message } } or { error: "a message" }), one line, at most 200 characters. */
export function providerMessage(bodyText: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const e = (j as { error?: unknown; detail?: unknown } | null)?.error ?? (j as { detail?: unknown } | null)?.detail;
  const m = typeof e === "string" ? e : typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : null;
  // Never keep anything shaped like a key, even a masked one ("sk-proj-****abcd").
  return m ? m.replace(/\b(?:sk|pplx|xai|AIza)[-_A-Za-z0-9*]{4,}/g, "[key]").replace(/[A-Za-z0-9_*-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 200) : null;
}

export function httpAdapter(provider: HttpProvider, keys: ProviderKeys, fetchPort: FetchPort, timeoutMs = GAP_ASK_TIMEOUT_MS): ProviderAdapter {
  const spec = HTTP[provider];
  // A key pasted with a space or a line break around it is read without them.
  const key = keys[spec.keyName]?.trim();
  const missing = () => (key ? null : `${spec.keyName} is not set`);
  // Providers with a tight tokens-per-minute limit are asked one question at a time; the deadline starts when the turn comes.
  let turn: Promise<unknown> = Promise.resolve();
  const oneAtATime = ONE_AT_A_TIME.has(provider);
  return {
    provider,
    missing,
    ask(question, opts) {
      if (!oneAtATime) return askNow(question, opts);
      const mine = turn.then(() => askNow(question, opts));
      turn = mine.catch(() => undefined);
      return mine;
    },
  };
  async function askNow(question: string, opts?: AskOptions): Promise<AskResult> {
    {
      const why = missing();
      if (why) return { provider, configured: false, reason: why };
      const asked_at = iso(opts);
      const req = spec.build(question, key!);
      let res;
      let bodyText: string;
      try {
        ({ res, bodyText } = await withDeadline(
          (async () => {
            // A busy or rate-limited provider (429, 503, 529) is asked again after its Retry-After, at most twice.
            for (let attempt = 0; ; attempt++) {
              const r = await fetchPort(req.url, req.init);
              const text = await r.text();
              if (!RETRY_STATUSES.has(r.status) || attempt >= RETRIES) return { res: r, bodyText: text };
              await sleep(retryDelayMs(r.headers.get("retry-after"), attempt, r.headers.get("x-ratelimit-reset-tokens") ?? r.headers.get("x-ratelimit-reset-requests")));
            }
          })(),
          timeoutMs,
        ));
      } catch (e) {
        return { provider, configured: true, error: `request failed: ${(e as Error).message}`, asked_at };
      }
      if (res.status < 200 || res.status >= 300) {
        const why = providerMessage(bodyText);
        return { provider, configured: true, error: `provider answered ${res.status}${why ? `: ${why}` : ""}`, status: res.status, asked_at };
      }
      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        return { provider, configured: true, error: "provider answer was not JSON", status: res.status, asked_at };
      }
      const parsed = spec.parse(json);
      return { provider, model: parsed.model, answer_text: parsed.answer_text, citations: parsed.citations, asked_at, raw: json };
    }
  }
}

export function serpAdapter(engine: SerpEngine, serp: SerpPort | undefined, timeoutMs = GAP_ASK_TIMEOUT_MS): ProviderAdapter {
  const missing = () => {
    if (!serp) return `no SERP data provider is connected for ${PROVIDER_LABELS[engine]}`;
    if (!serp.engines.includes(engine)) return `the SERP data provider ${serp.name} does not return ${PROVIDER_LABELS[engine]}`;
    return null;
  };
  return {
    provider: engine,
    missing,
    async ask(question, opts) {
      const why = missing();
      if (why) return { provider: engine, configured: false, reason: why };
      const asked_at = iso(opts);
      let a;
      try {
        a = await withDeadline(serp!.fetchAnswer(engine, question, { ...(opts?.country ? { country: opts.country } : {}), ...(opts?.language ? { language: opts.language } : {}) }), timeoutMs);
      } catch (e) {
        return { provider: engine, configured: true, error: `SERP provider failed: ${(e as Error).message}`, asked_at };
      }
      if (!a) return { provider: engine, model: `${serp!.name}:${engine}`, answer_text: "", citations: [], asked_at, raw: null };
      return { provider: engine, model: a.model ?? `${serp!.name}:${engine}`, answer_text: a.answer_text, citations: dedupe(a.citations), asked_at, raw: a.raw };
    },
  };
}

/** Every adapter, configured or not, so the report can say which is which. */
export function allAdapters(keys: ProviderKeys, fetchPort: FetchPort, serp?: SerpPort): ProviderAdapter[] {
  return [
    httpAdapter("openai", keys, fetchPort),
    httpAdapter("anthropic", keys, fetchPort),
    httpAdapter("gemini", keys, fetchPort),
    httpAdapter("perplexity", keys, fetchPort),
    serpAdapter("google_ai_mode", serp),
    serpAdapter("google_ai_overviews", serp),
    serpAdapter("copilot", serp),
  ];
}
