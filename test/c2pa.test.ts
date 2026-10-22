// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Tests for src/c2pa/bridge.ts: a Semanto manifest mapped to C2PA assertions.

import { describe, it, expect } from "vitest";
import { isSemantoId, semantoId } from "@/core/ids";
import type { SemantoFile, DocumentEntry } from "@/core/semanto";
import { buildC2paManifest, buildC2paManifests, textAnnexStatus, TEXT_ANNEX_STATUS, TROOTH_ASSERTION_LABEL, HASH_PLACEHOLDER, isC2paMedia, mediaTypeOf, c2patoolCommand } from "@/c2pa/bridge";
import { BANNED_WORDS, ELLIPSIS, THREE_DOTS } from "./helpers/house-rules";

const H = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;

const pdf: DocumentEntry = { url: "https://acme.com/docs/terms.pdf", title: "Acme Terms", kind: "pdf", hash: H("a"), bytes: 1024, witnessed_at: "2026-10-01T09:00:00Z" };
const image: DocumentEntry = { url: "https://acme.com/images/widget.jpg", title: "Acme Widget photo", kind: "other", hash: H("b"), bytes: 2048, witnessed_at: "2026-10-01T09:00:00Z" };
const text: DocumentEntry = { url: "https://acme.com/docs/notes.txt", title: "Notes", kind: "other", hash: H("c"), bytes: 10, witnessed_at: "2026-10-01T09:00:00Z" };

const file = {
  header: { org: "Acme Inc", trooth_id: "acme-inc", identity: { domain: "acme.com" } },
  documents: [pdf, image, text],
  root_hash: H("d"),
} as unknown as SemantoFile;

describe("C2PA bridge", () => {
  it("builds a c2pa-rs manifest definition with the four assertions for a PDF", () => {
    const m = buildC2paManifest(pdf, { publicApiBase: "https://api.trooth.co/public/semanto", publisher: { name: "Acme Inc", url: "https://acme.com/" }, trooth_id: "acme-inc", version_id: semantoId("smv", H("d")) });
    expect(m.claim_generator).toBe("Trooth Semanto/0.1.0");
    expect(m.claim_generator_info).toEqual([{ name: "Trooth Semanto", version: "0.1.0" }]);
    expect(m.title).toBe("Acme Terms");
    expect(m.format).toBe("application/pdf");
    expect(m.assertions.map((a) => a.label)).toEqual(["c2pa.actions", "stds.schema-org.CreativeWork", "c2pa.hash.data", TROOTH_ASSERTION_LABEL]);
    const actions = m.assertions[0]!.data as { actions: { action: string; when: string }[] };
    expect(actions.actions[0]).toMatchObject({ action: "c2pa.published", when: "2026-10-01T09:00:00Z" });
    const cw = m.assertions[1]!.data as { publisher: { "@type": string; name: string }; contributor: { name: string; roleName: string }[] };
    expect(cw.publisher).toEqual({ "@type": "Organization", name: "Acme Inc", url: "https://acme.com/" });
    expect(cw.contributor[0]).toMatchObject({ name: "Trooth", roleName: "witness" });
    expect((m.assertions[2]!.data as { hash: string }).hash).toBe(HASH_PLACEHOLDER);
  });
  it("carries the custom co.trooth.semanto assertion with the version id, page id, page hash and proof url", () => {
    const out = buildC2paManifests(file, "https://api.trooth.co/public/semanto/");
    expect(out.manifests.map((m) => m.url)).toEqual([pdf.url, image.url]);
    const custom = out.manifests[1]!.manifest.assertions.find((a) => a.label === "co.trooth.semanto")!.data as Record<string, string>;
    expect(custom.trooth_id).toBe("acme-inc");
    expect(isSemantoId(custom.version_id, "smv")).toBe(true);
    expect(isSemantoId(custom.page_id, "smp")).toBe(true);
    expect(custom.page_hash).toBe(H("b"));
    expect(custom.proof_url).toBe(`https://api.trooth.co/public/semanto/acme-inc/pages/${custom.page_id}/proof`);
    expect(out.manifests[1]!.manifest.format).toBe("image/jpeg");
  });
  it("leaves text out and says why, and states the signing step is outside the Worker", () => {
    const out = buildC2paManifests(file, "https://api.trooth.co/public/semanto");
    expect(out.skipped).toEqual([{ url: text.url, reason: "not a C2PA media type; text is covered by the Semanto page hash" }]);
    expect(out.signing_note).toContain("c2patool");
    expect(isC2paMedia(text)).toBe(false);
    expect(mediaTypeOf({ url: "https://acme.com/a.PNG", kind: "other" })).toBe("image/png");
    expect(() => buildC2paManifest(text, { publicApiBase: "x", publisher: { name: "a", url: "b" }, trooth_id: "acme-inc", version_id: "v" })).toThrow(/not a C2PA media type/);
    expect(c2patoolCommand("widget.jpg", "widget.c2pa.json", "widget.signed.jpg")).toBe('c2patool "widget.jpg" --manifest "widget.c2pa.json" --output "widget.signed.jpg"');
  });
  it("returns the exact text annex status string for the dashboard", () => {
    expect(textAnnexStatus()).toBe(TEXT_ANNEX_STATUS);
    expect(textAnnexStatus()).toBe("C2PA 2.4 Annex A.8 (text) is under review and is not used for text. Pages are covered by the signed Semanto record and its page hashes.");
    expect(buildC2paManifests(file, "https://api.trooth.co/public/semanto").text_status).toBe(TEXT_ANNEX_STATUS);
  });
  it("uses no banned words and no ellipses in the manifest JSON", () => {
    const json = JSON.stringify(buildC2paManifests(file, "https://api.trooth.co/public/semanto"));
    expect(json).not.toMatch(BANNED_WORDS);
    expect(json).not.toContain(THREE_DOTS);
  });
});
