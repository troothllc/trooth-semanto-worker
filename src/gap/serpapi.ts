// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// SerpApi behind the SERP port (src/gap/ports.ts): the licensed data provider for the three answer surfaces with no
// public API. Trooth does not scrape Google or Bing; SerpApi returns them as structured JSON (serpapi.com):
//   Google AI Mode       GET https://serpapi.com/search?engine=google_ai_mode&q&gl&hl   text_blocks[].snippet, references[]
//   Google AI Overviews  GET https://serpapi.com/search?engine=google&q&gl&hl          ai_overview (text_blocks, references),
//                        or ai_overview.page_token, then engine=google_ai_overview&page_token within one minute
//   Microsoft Copilot    GET https://serpapi.com/search?engine=bing_copilot&q           text_blocks[].snippet, references[]
// A surface that showed no AI answer for the query is null (reported as not answered). The key is a query parameter,
// as SerpApi requires; this module never puts a request address in an error message, so the key never reaches a report.

import type { FetchPort, SerpAnswer, SerpCitation, SerpEngine, SerpPort } from "./ports";

export const SERPAPI_BASE = "https://serpapi.com/search";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The text of SerpApi's text_blocks: paragraphs, headings and list items (nested lists and blocks included), in order. */
export function textOfBlocks(blocks: unknown): string {
  const out: string[] = [];
  const walk = (list: unknown, depth: number) => {
    if (!Array.isArray(list) || depth > 4) return;
    for (const b of list) {
      if (!isObj(b)) continue;
      const t = str(b.snippet) ?? str(b.title);
      if (t) out.push(t);
      walk(b.list, depth + 1);
      walk(b.text_blocks, depth + 1);
    }
  };
  walk(blocks, 0);
  return out.join("\n");
}

export function citationsOf(refs: unknown): SerpCitation[] {
  if (!Array.isArray(refs)) return [];
  const out: SerpCitation[] = [];
  for (const r of refs) {
    if (!isObj(r)) continue;
    const url = str(r.link);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = str(r.title);
    out.push(title ? { url, title } : { url });
  }
  return out;
}

function answerOf(container: unknown, raw: unknown, model: string): SerpAnswer | null {
  if (!isObj(container)) return null;
  const answer_text = textOfBlocks(container.text_blocks);
  if (!answer_text) return null;
  return { answer_text, citations: citationsOf(container.references), model, raw };
}

export function serpApiPort(apiKey: string, fetchPort: FetchPort): SerpPort {
  const get = async (params: Record<string, string>): Promise<Json> => {
    const q = new URLSearchParams({ ...params, api_key: apiKey, output: "json" });
    const res = await fetchPort(`${SERPAPI_BASE}?${q.toString()}`, { method: "GET", headers: { accept: "application/json" } });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`SerpApi answered ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("SerpApi answer was not JSON");
    }
    if (!isObj(json)) throw new Error("SerpApi answer was not an object");
    if (str(json.error) && !/hasn't returned any results|no results/i.test(String(json.error))) throw new Error(`SerpApi: ${String(json.error).slice(0, 200)}`);
    return json;
  };
  const locale = (opts: { country?: string; language?: string }) => ({ ...(opts.country ? { gl: opts.country.toLowerCase() } : {}), ...(opts.language ? { hl: opts.language.toLowerCase() } : {}) });
  return {
    name: "serpapi",
    engines: ["google_ai_mode", "google_ai_overviews", "copilot"],
    async fetchAnswer(engine: SerpEngine, query: string, opts: { country?: string; language?: string }): Promise<SerpAnswer | null> {
      if (engine === "google_ai_mode") {
        const j = await get({ engine: "google_ai_mode", q: query, ...locale(opts) });
        return answerOf(j, j, "serpapi:google_ai_mode");
      }
      if (engine === "copilot") {
        const j = await get({ engine: "bing_copilot", q: query });
        return answerOf(j, j, "serpapi:bing_copilot");
      }
      const j = await get({ engine: "google", q: query, ...locale(opts) });
      const overview = isObj(j.ai_overview) ? j.ai_overview : null;
      if (!overview) return null;
      const direct = answerOf(overview, j, "serpapi:google_ai_overview");
      if (direct) return direct;
      const token = str(overview.page_token);
      if (!token) return null;
      const more = await get({ engine: "google_ai_overview", page_token: token });
      return answerOf(isObj(more.ai_overview) ? more.ai_overview : null, more, "serpapi:google_ai_overview");
    },
  };
}
