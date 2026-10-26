// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// SerpApi behind the SERP port: the request each surface sends, the answer and citations read back, the two-step AI
// Overview, a surface that showed no AI answer, and an error that never carries the key.

import { describe, it, expect } from "vitest";
import { serpApiPort, textOfBlocks } from "@/gap/serpapi";
import { allAdapters } from "@/gap/providers";
import type { FetchPort } from "@/gap/ports";

const KEY = "serpapi-fixture-key";

function fake(routes: (u: URL) => { status?: number; body: unknown }) {
  const seen: URL[] = [];
  const port: FetchPort = async (url) => {
    const u = new URL(url);
    seen.push(u);
    const r = routes(u);
    return { status: r.status ?? 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(r.body) };
  };
  return { port, seen };
}

const blocks = [
  { type: "paragraph", snippet: "Acme Inc makes kettles and toasters." },
  { type: "list", list: [{ snippet: "Ships to the US and Canada." }, { snippet: "Free returns for 30 days." }] },
];
const refs = [{ index: 0, title: "Acme shipping", link: "https://acme.com/shipping" }, { index: 1, title: "no link" }, { index: 2, link: "javascript:alert(1)" }];

describe("SerpApi behind the SERP port", () => {
  it("Google AI Mode and Copilot: one request each, the text blocks in order and the linked references", async () => {
    const f = fake(() => ({ body: { text_blocks: blocks, references: refs } }));
    const port = serpApiPort(KEY, f.port);
    const mode = await port.fetchAnswer("google_ai_mode", "Does Acme ship to Canada?", { country: "US", language: "en" });
    expect(mode).toMatchObject({ answer_text: "Acme Inc makes kettles and toasters.\nShips to the US and Canada.\nFree returns for 30 days.", citations: [{ url: "https://acme.com/shipping", title: "Acme shipping" }], model: "serpapi:google_ai_mode" });
    expect(Object.fromEntries(f.seen[0]!.searchParams)).toMatchObject({ engine: "google_ai_mode", q: "Does Acme ship to Canada?", gl: "us", hl: "en", api_key: KEY });
    const copilot = await port.fetchAnswer("copilot", "Does Acme ship to Canada?", {});
    expect(copilot?.model).toBe("serpapi:bing_copilot");
    expect(f.seen[1]!.searchParams.get("engine")).toBe("bing_copilot");
    expect(f.seen.every((u) => u.origin + u.pathname === "https://serpapi.com/search")).toBe(true);
  });

  it("Google AI Overviews: read in place, or follow the page_token to google_ai_overview; no overview is no answer", async () => {
    const inline = fake(() => ({ body: { ai_overview: { text_blocks: blocks, references: refs } } }));
    expect((await serpApiPort(KEY, inline.port).fetchAnswer("google_ai_overviews", "q", {}))?.answer_text).toContain("Ships to the US and Canada.");
    expect(inline.seen.map((u) => u.searchParams.get("engine"))).toEqual(["google"]);
    const twoStep = fake((u) => (u.searchParams.get("engine") === "google" ? { body: { ai_overview: { page_token: "tok-1" } } } : { body: { ai_overview: { text_blocks: blocks, references: refs } } }));
    const a = await serpApiPort(KEY, twoStep.port).fetchAnswer("google_ai_overviews", "q", {});
    expect(a?.citations).toEqual([{ url: "https://acme.com/shipping", title: "Acme shipping" }]);
    expect(Object.fromEntries(twoStep.seen[1]!.searchParams)).toMatchObject({ engine: "google_ai_overview", page_token: "tok-1" });
    const none = fake(() => ({ body: { organic_results: [] } }));
    expect(await serpApiPort(KEY, none.port).fetchAnswer("google_ai_overviews", "q", {})).toBeNull();
  });

  it("a failure says what happened without the key, and the gap report counts all three surfaces as set up", async () => {
    const bad = fake(() => ({ status: 401, body: { error: "Invalid API key." } }));
    await expect(serpApiPort(KEY, bad.port).fetchAnswer("copilot", "q", {})).rejects.toThrow("SerpApi answered 401");
    await expect(serpApiPort(KEY, bad.port).fetchAnswer("copilot", "q", {})).rejects.not.toThrow(KEY);
    const adapters = allAdapters({}, bad.port, serpApiPort(KEY, bad.port));
    const serpSurfaces = adapters.filter((a) => ["google_ai_mode", "google_ai_overviews", "copilot"].includes(a.provider));
    expect(serpSurfaces.map((a) => a.missing())).toEqual([null, null, null]);
    expect(textOfBlocks([{ type: "heading", title: "Shipping" }, { text_blocks: [{ snippet: "Nested." }] }])).toBe("Shipping\nNested.");
  });
});
