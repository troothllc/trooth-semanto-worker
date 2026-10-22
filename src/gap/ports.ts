// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The ports the gap report talks through. Everything that leaves the process
// goes through one of these, so tests run in Node with in-memory versions and
// no network. The fetch port is the WHATWG fetch shape (RFC 9110 semantics);
// the SERP port is the one place Google AI Mode, AI Overviews and Microsoft
// Copilot answers come from. Trooth does not scrape Google or Bing: the
// founder connects a SERP data provider that is licensed to return those
// surfaces, and that provider is behind this port.

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchPort = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

/** The surfaces a SERP data provider can return. */
export type SerpEngine = "google_ai_mode" | "google_ai_overviews" | "copilot";

export interface SerpCitation {
  url: string;
  title?: string;
}

export interface SerpAnswer {
  /** The text the surface showed for the query. Empty when the surface showed no AI answer. */
  answer_text: string;
  citations: SerpCitation[];
  /** The provider's own name for the model or surface version, when it reports one. */
  model?: string;
  /** The provider's raw response, kept for audit. */
  raw: unknown;
}

/**
 * A SERP data provider. `null` means the engine showed no AI answer for the
 * query (for example no AI Overview was triggered), which is a finding in
 * itself and is reported as "not_answered".
 */
export interface SerpPort {
  name: string;
  engines: SerpEngine[];
  fetchAnswer(engine: SerpEngine, query: string, opts: { country?: string; language?: string }): Promise<SerpAnswer | null>;
}

/** The keys the report reads. `Env` in src/env.ts satisfies this shape. */
export interface ProviderKeys {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
