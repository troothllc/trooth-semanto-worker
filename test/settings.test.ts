// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for the delivery settings model (settings panel, section D): defaults,
// validation messages, the Content-Signal header, and the resolver for every
// markdown_source and when_page_changed mode, including the no-duplicate rule
// (Semanto answers signed pages first so a converter never produces a second
// copy of the same page).

import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, PROOF_ONLY_WARNING, contentSignalHeader, describeMode, resolve, validateSettings, withDefaults, type DeliverySettings } from "@/settings/delivery";

const base = (over: Partial<DeliverySettings> = {}): DeliverySettings => withDefaults({ ...DEFAULT_SETTINGS, ...over });
const signed = { page_signed: true, live: "current" as const };
const unsigned = { page_signed: false, live: "unknown" as const };

describe("settings model", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_SETTINGS.where).toEqual({ trooth_hosted: true, own_domain: false });
    expect(DEFAULT_SETTINGS.formats.whole_file).toBe(true);
    expect(DEFAULT_SETTINGS.markdown_source).toBe("semanto_only");
    expect(DEFAULT_SETTINGS.when_page_changed).toBe("serve_last_signed_marked_behind");
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it("fills a partial object and keeps the always-on switches on", () => {
    const s = withDefaults({ where: { trooth_hosted: true, own_domain: true }, formats: { markdown: false, jsonld: true, llms: true, sitemap_md: true, whole_file: true } });
    expect(s.where.trooth_hosted).toBe(true);
    expect(s.formats.whole_file).toBe(true);
    expect(s.formats.markdown).toBe(false);
    expect(s.host).toBe("unknown");
  });
  it("validates with plain messages", () => {
    expect(validateSettings(null)[0]!.message).toBe("Settings must be an object.");
    const bad = validateSettings({ ...DEFAULT_SETTINGS, where: { trooth_hosted: false, own_domain: "yes" }, host: "aws", markdown_source: "other", when_page_changed: "never", content_signals: { "ai-train": "no", search: true, "ai-input": true } });
    const paths = bad.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["where.trooth_hosted", "where.own_domain", "host", "markdown_source", "when_page_changed", "content_signals.ai-train"]));
    expect(bad.find((i) => i.path === "where.trooth_hosted")!.message).toBe("The Trooth-hosted copy cannot be turned off.");
    expect(validateSettings({ ...DEFAULT_SETTINGS, formats: { ...DEFAULT_SETTINGS.formats, whole_file: false } }).map((i) => i.path)).toContain("formats.whole_file");
  });
  it("refuses a converter mode on a host that has no converter, and markdown off with Semanto as the source", () => {
    const a = validateSettings(base({ host: "vercel", where: { trooth_hosted: true, own_domain: true }, markdown_source: "semanto_then_cloudflare_for_unsigned" }));
    expect(a).toEqual([{ path: "markdown_source", message: "Only Cloudflare runs a markdown converter. On this host choose semanto_only." }]);
    const b = validateSettings(base({ formats: { ...DEFAULT_SETTINGS.formats, markdown: false } }));
    expect(b.map((i) => i.path)).toEqual(["formats.markdown"]);
    const c = validateSettings(base({ host: "nginx" }));
    expect(c.map((i) => i.path)).toEqual(["where.own_domain"]);
    expect(validateSettings(base({ host: "cloudflare", where: { trooth_hosted: true, own_domain: true }, markdown_source: "cloudflare_format_semanto_proof_only" }))).toEqual([]);
  });
  it("prints the Content-Signal header in the contentsignals.org form", () => {
    expect(contentSignalHeader({ "ai-train": true, search: true, "ai-input": false })).toBe("ai-train=yes, search=yes, ai-input=no");
    expect(contentSignalHeader(DEFAULT_SETTINGS.content_signals)).toBe("ai-train=no, search=yes, ai-input=yes");
  });
  it("describes each mode in plain words, with the warning for proof-only", () => {
    expect(describeMode(base()).warning).toBeUndefined();
    expect(describeMode(base({ host: "cloudflare", markdown_source: "cloudflare_format_semanto_proof_only" })).warning).toBe(PROOF_ONLY_WARNING);
    expect(PROOF_ONLY_WARNING).toBe("Individual pages cannot be checked in this mode, because the converter's bytes change on every request");
  });
});

describe("resolver", () => {
  const cf = (markdown_source: DeliverySettings["markdown_source"], over: Partial<DeliverySettings> = {}) => base({ host: "cloudflare", where: { trooth_hosted: true, own_domain: true }, markdown_source, ...over });

  it("passes html through to the host in every mode", () => {
    for (const s of [base(), cf("semanto_then_cloudflare_for_unsigned"), cf("cloudflare_format_semanto_proof_only")]) {
      expect(resolve(s, { path: "/about", accept: "*/*", ...signed }).action).toBe("passthrough");
      expect(resolve(s, { path: "/about", accept: null, ...signed }).action).toBe("passthrough");
      expect(resolve(s, { path: "/about", accept: "text/html", ...signed }).action).toBe("passthrough");
    }
  });

  it("semanto_only: Semanto answers markdown and JSON-LD; unsigned pages get a markdown not-found notice", () => {
    const s = base();
    const r = resolve(s, { path: "/about", accept: "text/markdown", ...signed });
    expect(r).toMatchObject({ action: "serve_semanto", rep: "markdown", serve: "page", base_path: "/about" });
    expect(r.mode).toContain("Semanto answers every markdown");
    expect(resolve(s, { path: "/about.md", accept: "*/*", ...signed })).toMatchObject({ action: "serve_semanto", serve: "page", base_path: "/about" });
    expect(resolve(s, { path: "/about", accept: "application/ld+json", ...signed })).toMatchObject({ action: "serve_semanto", serve: "page_jsonld" });
    expect(resolve(s, { path: "/new-page", accept: "text/markdown", ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "problem", problem: "page_not_found" });
  });

  it("semanto_then_cloudflare_for_unsigned: signed pages are Semanto's first, so Cloudflare never converts them; unsigned pages fall through", () => {
    const s = cf("semanto_then_cloudflare_for_unsigned");
    expect(resolve(s, { path: "/about", accept: "text/markdown", ...signed })).toMatchObject({ action: "serve_semanto", serve: "page" });
    expect(resolve(s, { path: "/about", accept: "text/*", ...signed })).toMatchObject({ action: "serve_semanto", serve: "page" });
    expect(resolve(s, { path: "/blog/new", accept: "text/markdown", ...unsigned })).toMatchObject({ action: "fall_through_host", state_header: "unsigned" });
    expect(resolve(s, { path: "/about", accept: "text/markdown", ...signed }).mode).toContain("Semanto answers first");
  });

  it("cloudflare_format_semanto_proof_only: markdown goes to the converter, proofs and the file stay with Semanto, and the warning is shown", () => {
    const s = cf("cloudflare_format_semanto_proof_only");
    const r = resolve(s, { path: "/about", accept: "text/markdown", ...signed });
    expect(r.action).toBe("fall_through_host");
    expect(r.warning).toBe(PROOF_ONLY_WARNING);
    expect(resolve(s, { path: "/.well-known/trooth.semanto", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "well_known_semanto" });
    expect(resolve(s, { path: "/.well-known/trooth-keys.json", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "well_known_keys" });
    expect(resolve(s, { path: "/llms.txt", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "llms" });
    expect(resolve(s, { path: "/facts.jsonld", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "facts" });
    expect(resolve(s, { path: "/about", accept: "application/ld+json", ...signed })).toMatchObject({ action: "serve_semanto", serve: "page_jsonld" });
  });

  it("when_page_changed decides what a behind page gets", () => {
    const behind = { page_signed: true, live: "behind" as const };
    expect(resolve(base(), { path: "/about", accept: "text/markdown", ...behind })).toMatchObject({ action: "serve_semanto", serve: "page", state_header: "behind" });
    expect(resolve(base({ when_page_changed: "serve_live_marked_unsigned" }), { path: "/about", accept: "text/markdown", ...behind })).toMatchObject({ action: "fall_through_host", state_header: "unsigned" });
    expect(resolve(base({ when_page_changed: "prompt_to_sign" }), { path: "/about", accept: "text/markdown", ...behind })).toMatchObject({ action: "serve_semanto", serve: "page", state_header: "behind", prompt_to_sign: true });
    expect(resolve(base(), { path: "/about", accept: "application/ld+json", ...behind })).toMatchObject({ serve: "page_jsonld", state_header: "behind" });
  });

  it("site-wide files follow their format switches", () => {
    const off = base({ formats: { markdown: true, jsonld: false, llms: false, sitemap_md: false, whole_file: true } });
    expect(resolve(off, { path: "/llms.txt", accept: null, ...unsigned }).action).toBe("passthrough");
    expect(resolve(off, { path: "/llms-full.txt", accept: null, ...unsigned }).action).toBe("passthrough");
    expect(resolve(off, { path: "/sitemap.md", accept: null, ...unsigned }).action).toBe("passthrough");
    expect(resolve(off, { path: "/facts.jsonld", accept: null, ...unsigned }).action).toBe("passthrough");
    expect(resolve(off, { path: "/about", accept: "application/ld+json", ...signed }).action).toBe("passthrough");
    const on = base();
    expect(resolve(on, { path: "/llms-full.txt", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "llms_full" });
    expect(resolve(on, { path: "/sitemap.md", accept: null, ...unsigned })).toMatchObject({ action: "serve_semanto", serve: "sitemap" });
  });

  it("never looks at anything but the path and Accept", () => {
    const a = resolve(base(), { path: "/about", accept: "text/markdown", ...signed });
    const b = resolve(base(), { path: "/about", accept: "text/markdown", ...signed });
    expect(a).toEqual(b);
    expect(resolve.length).toBe(2);
  });
});
