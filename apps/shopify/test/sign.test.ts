// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's request signing is the one the Worker checks, byte for byte:
// requests the app signs pass src/core/httpsig.ts verifyMessage and
// verifyContentDigest with the catalog handler's exact options, and for the
// same key, time and nonce the app's Signature-Input and Signature fields are
// identical to what the Worker's own signMessage produces (Ed25519 is
// deterministic, so equal bytes prove an equal signature base). Any change to
// the covered components, their order, the parameters or the digest fails here.

import { describe, expect, it } from "vitest";
import { contentDigest as workerDigest, signMessage, verifyContentDigest, verifyMessage } from "../../../src/core/httpsig";
import type { PrivateJwk } from "../../../src/core/keys";
import { generateConnectorKey, signJson, publicOf, CONNECTOR_COMPONENTS, CONNECTOR_TAG } from "../app/lib/sign";

const URL_ = "https://api.trooth.co/os/semanto/fixture-co/commerce/catalog";
const DOC = { source: "shopify", trooth_id: "fixture-co", products: [{ id: "1", name: "Fixture Product 1", url: "https://fixture.example/products/one", sku: "FIX-1" }] };

describe("connector signing matches the Worker's checker", () => {
  it("covers exactly the components and tag the catalog handler requires", () => {
    expect([...CONNECTOR_COMPONENTS]).toEqual(["@method", "@target-uri", "content-digest", "content-type"]);
    expect(CONNECTOR_TAG).toBe("trooth-connector");
  });

  it("a signed catalog passes verifyMessage and verifyContentDigest with the handler's options", async () => {
    const { privateJwk } = await generateConnectorKey();
    const now = new Date("2026-10-23T12:00:00Z");
    const { body, headers } = await signJson(URL_, DOC, privateJwk, now);
    const h = new Headers(headers);
    const v = await verifyMessage(
      { kind: "request", method: "POST", url: URL_, headers: h },
      { resolveKey: (kid) => (kid === privateJwk.kid ? publicOf(privateJwk) : null), required: ["@method", "@target-uri", "content-digest", "content-type"], tag: "trooth-connector", now: Math.floor(now.getTime() / 1000), maxAgeSeconds: 300 },
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.keyid).toBe(privateJwk.kid);
      expect(v.params.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(v.params.expires! - v.params.created).toBe(300);
    }
    expect(await verifyContentDigest(h.get("content-digest"), body)).toBe(true);
    expect(h.get("content-digest")).toBe(await workerDigest(body));
  });

  it("produces the same Signature-Input and Signature bytes as the Worker's signMessage for the same inputs", async () => {
    const { privateJwk } = await generateConnectorKey();
    const now = new Date("2026-10-23T12:00:00Z");
    const created = Math.floor(now.getTime() / 1000);
    const { signPost } = await import("../app/lib/sign");
    const body = JSON.stringify(DOC);
    const app = await signPost({ url: URL_, body, privateJwk, created, nonce: "fixture-nonce-0001" });
    const worker = await signMessage(
      { kind: "request", method: "POST", url: URL_, headers: { "content-type": "application/json", "content-digest": await workerDigest(body) } },
      privateJwk as unknown as PrivateJwk,
      { components: ["@method", "@target-uri", "content-digest", "content-type"], created, ttlSeconds: 300, tag: "trooth-connector", nonce: "fixture-nonce-0001" },
    );
    expect(app["Signature-Input"]).toBe(worker["Signature-Input"]);
    expect(app.Signature).toBe(worker.Signature);
  });

  it("is refused by the Worker's checker when the body, the address, the tag or the age is wrong", async () => {
    const { privateJwk } = await generateConnectorKey();
    const now = new Date("2026-10-23T12:00:00Z");
    const nowSec = Math.floor(now.getTime() / 1000);
    const { body, headers } = await signJson(URL_, DOC, privateJwk, now);
    const opts = { resolveKey: () => publicOf(privateJwk), required: ["@method", "@target-uri", "content-digest", "content-type"], tag: "trooth-connector", now: nowSec, maxAgeSeconds: 300 };
    expect(await verifyContentDigest(headers["Content-Digest"]!, body + " ")).toBe(false);
    const other = await verifyMessage({ kind: "request", method: "POST", url: URL_.replace("fixture-co", "other-co"), headers: new Headers(headers) }, opts);
    expect(other).toEqual({ ok: false, reason: "bad_signature" });
    const wrongTag = await verifyMessage({ kind: "request", method: "POST", url: URL_, headers: new Headers(headers) }, { ...opts, tag: "web-bot-auth" });
    expect(wrongTag).toEqual({ ok: false, reason: "wrong_tag" });
    const late = await verifyMessage({ kind: "request", method: "POST", url: URL_, headers: new Headers(headers) }, { ...opts, now: nowSec + 301 });
    expect(late.ok).toBe(false);
  });

  it("signs every attempt afresh: two signatures of the same document never share a nonce", async () => {
    const { privateJwk } = await generateConnectorKey();
    const a = await signJson(URL_, DOC, privateJwk);
    const b = await signJson(URL_, DOC, privateJwk);
    const nonce = (s: string) => /nonce="([^"]+)"/.exec(s)![1];
    expect(nonce(a.headers["Signature-Input"]!)).not.toBe(nonce(b.headers["Signature-Input"]!));
  });

  it("never sends the private part of the key as the public key", async () => {
    const { privateJwk } = await generateConnectorKey();
    expect(privateJwk.d).toBeTruthy();
    expect("d" in publicOf(privateJwk)).toBe(false);
  });
});
