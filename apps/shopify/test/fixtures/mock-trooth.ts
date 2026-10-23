// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Test fixture: the Semanto Worker routes the app calls, in memory, checking
// signatures with the Worker's own code. Signed requests (the catalog and the
// uninstall route) go through src/core/httpsig.ts verifyMessage and
// verifyContentDigest exactly as the catalog handler in src/pipeline.ts calls
// them (required components, tag trooth-connector, 300-second age, one claim
// per nonce), so a request this fixture accepts is one the Worker accepts.
// The connect session routes follow docs/program/CONTRACT-2026-10-23.md 1d.
// Fixture values only; nothing here is a real company.

import { verifyContentDigest, verifyMessage } from "../../../../src/core/httpsig";
import type { PublicJwk } from "../../../../src/core/keys";
import { thumbprint } from "../../../../adapters/shared/sign-request.mjs";

export const CONNECTOR_COMPONENTS = ["@method", "@target-uri", "content-digest", "content-type"];

interface Session {
  id: string;
  poll_token: string;
  shop: string;
  public_jwk: PublicJwk;
  expires_at: number;
  state: "pending" | "approved" | "denied";
  trooth_id?: string;
}

export interface ConnectorKey {
  kid: string;
  jwk: PublicJwk;
  source: string;
  trooth_id: string;
  revoked_at: string | null;
  last_result: string | null;
}

export class MockTrooth {
  readonly base = "https://api.trooth.test";
  readonly dashboard = "https://trooth.co/dashboard/semanto";
  readonly sessions = new Map<string, Session>();
  readonly keys = new Map<string, ConnectorKey>();
  readonly nonces = new Set<string>();
  readonly catalogs: { trooth_id: string; kid: string; doc: { products: unknown[]; [k: string]: unknown } }[] = [];
  readonly revocations: { kid: string; reason: string; registered: boolean }[] = [];
  readonly calls: { method: string; path: string; status: number }[] = [];
  /** Answer the next N signed calls with this status (429, 503) before handling them. */
  failNext: { count: number; status: number; retryAfter?: string } = { count: 0, status: 503 };
  /** Signed records or a custody-customer company that cannot be signed. */
  signs = true;
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  approve(sessionId: string, troothId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("no such session");
    s.state = "approved";
    s.trooth_id = troothId;
    this.keys.set(s.public_jwk.kid, { kid: s.public_jwk.kid, jwk: s.public_jwk, source: `shopify:${s.shop}`, trooth_id: troothId, revoked_at: null, last_result: null });
  }

  /** A key pasted in the dashboard by hand (not an app install), which an app may not revoke. */
  registerManual(jwk: PublicJwk, troothId: string): void {
    this.keys.set(jwk.kid, { kid: jwk.kid, jwk, source: "cloudflare-worker", trooth_id: troothId, revoked_at: null, last_result: null });
  }

  deny(sessionId: string): void {
    this.sessions.get(sessionId)!.state = "denied";
  }

  latestSession(): Session {
    return [...this.sessions.values()].at(-1)!;
  }

  activeKeysFor(shop: string): ConnectorKey[] {
    return [...this.keys.values()].filter((k) => k.source === `shopify:${shop}` && !k.revoked_at);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" } });
  }

  private problem(status: number, code: string, detail: string): Response {
    return this.json(status, { type: `https://trooth.co/problems/${code}`, title: code, status, code, detail });
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.route(input, init);
    this.calls.push({ method: init.method ?? "GET", path: new URL(input).pathname, status: res.status });
    return res;
  }

  private async route(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : init.body ? String(init.body) : "";
    const nowMs = this.now().getTime();

    if (method === "POST" && url.pathname === "/public/semanto/connect/sessions") {
      const j = JSON.parse(body) as { app?: string; account?: string; public_jwk?: PublicJwk & { d?: string }; return_url?: string };
      if (j.app !== "shopify" || typeof j.account !== "string" || !j.public_jwk) return this.problem(400, "invalid_request", "app, account and public_jwk are required");
      if (j.public_jwk.d) return this.problem(400, "invalid_request", "private parts present");
      if ((await thumbprint({ x: j.public_jwk.x })) !== j.public_jwk.kid) return this.problem(400, "invalid_request", "kid is not the thumbprint");
      const id = `cs_fixture_${++this.seq}`;
      const s: Session = { id, poll_token: `pt_fixture_${this.seq}`, shop: j.account, public_jwk: j.public_jwk, expires_at: nowMs + 15 * 60 * 1000, state: "pending" };
      this.sessions.set(id, s);
      return this.json(201, { session_id: id, poll_token: s.poll_token, approve_url: `${this.dashboard}/connect/${id}`, expires_at: new Date(s.expires_at).toISOString() });
    }

    const pollMatch = /^\/public\/semanto\/connect\/sessions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && pollMatch) {
      const s = this.sessions.get(decodeURIComponent(pollMatch[1]!));
      if (!s || headers.get("authorization") !== `Bearer ${s.poll_token}`) return this.problem(401, "unauthorized", "Send the poll_token this session answered as Authorization: Bearer.");
      if (s.state === "approved") return this.json(200, { state: "approved", trooth_id: s.trooth_id, kid: s.public_jwk.kid });
      if (s.state === "denied") return this.json(200, { state: "denied" });
      return this.json(200, { state: nowMs >= s.expires_at ? "expired" : "pending" });
    }

    if (method === "POST" && (url.pathname === "/public/semanto/connect/uninstall" || /^\/os\/semanto\/[^/]+\/commerce\/catalog$/.test(url.pathname))) {
      if (this.failNext.count > 0) {
        this.failNext.count--;
        return new Response("busy", { status: this.failNext.status, headers: this.failNext.retryAfter ? { "retry-after": this.failNext.retryAfter } : {} });
      }
      const nowSec = Math.floor(nowMs / 1000);
      const sig = await verifyMessage(
        { kind: "request", method, url: url.href, headers },
        { resolveKey: (kid) => this.keys.get(kid)?.jwk ?? null, required: CONNECTOR_COMPONENTS, tag: "trooth-connector", now: nowSec, maxAgeSeconds: 300 },
      );
      if (url.pathname === "/public/semanto/connect/uninstall") {
        const j = JSON.parse(body) as { kid?: string; reason?: string; account?: string };
        // As src/os/connectors.ts uninstallConnector answers: 404 never registered, 403 not an app install's key, 401 bad signature.
        const named = /keyid="([^"]+)"/.exec(headers.get("signature-input") ?? "")?.[1];
        const row = named ? this.keys.get(named) : undefined;
        if (!row) {
          this.revocations.push({ kid: j.kid ?? "", reason: j.reason ?? "", registered: false });
          return this.problem(404, "not_registered", `No connector key ${named ?? ""} was ever registered with Trooth. There is nothing to revoke.`);
        }
        if (!row.source.includes(":")) return this.problem(403, "forbidden", "This key was not registered by an app install, so an app cannot revoke it. Revoke it in the dashboard.");
        if (!sig.ok) return this.problem(401, "unauthorized", `The connector signature did not check out (${sig.reason}).`);
        if (!(await verifyContentDigest(headers.get("content-digest"), body))) return this.problem(401, "unauthorized", "Content-Digest does not match the body.");
        if (!this.claim(`${sig.keyid}:${sig.params.nonce}`)) return this.problem(401, "unauthorized", "nonce used");
        if (j.account && row.source !== `shopify:${j.account}`) return this.problem(403, "forbidden", `This key belongs to ${row.source}, not ${j.account}.`);
        const reason = j.reason ?? "uninstalled";
        if (!["uninstalled", "disconnected", "shop_redact"].includes(reason)) return this.problem(400, "invalid_request", "reason is one of uninstalled, disconnected, shop_redact.");
        row.revoked_at ??= this.now().toISOString();
        this.revocations.push({ kid: sig.keyid, reason, registered: true });
        return this.json(200, { object: "semanto.connector_revoked", kid: sig.keyid, reason });
      }
      const troothId = decodeURIComponent(url.pathname.split("/")[3]!);
      if (!sig.ok) return this.problem(401, "unauthorized", `The connector signature did not check out (${sig.reason}).`);
      if (!(await verifyContentDigest(headers.get("content-digest"), body))) return this.problem(401, "unauthorized", "Content-Digest does not match the body.");
      if (!sig.params.nonce) return this.problem(401, "unauthorized", "no nonce");
      if (!this.claim(`${sig.keyid}:${sig.params.nonce}`)) return this.problem(401, "unauthorized", "This catalog request was already received (its nonce was used).");
      const k = this.keys.get(sig.keyid)!;
      if (k.revoked_at) return this.problem(401, "unauthorized", "The connector key was revoked.");
      if (k.trooth_id !== troothId) return this.problem(403, "forbidden", "key belongs to another company");
      if (body.length > 5 * 1024 * 1024) return this.problem(413, "payload_too_large", "The catalog is larger than 5 MB.");
      const doc = JSON.parse(body) as { products: unknown[]; trooth_id?: string };
      if (!Array.isArray(doc.products)) return this.problem(400, "invalid_request", "The catalog needs a products array.");
      if (doc.trooth_id !== undefined && doc.trooth_id !== troothId) return this.problem(403, "forbidden", "names another company");
      k.last_result = "ok";
      this.catalogs.push({ trooth_id: troothId, kid: sig.keyid, doc });
      const all = (doc.products as { sku?: string; stock_status?: string; variants?: { sku?: string; stock_status?: string }[] }[]).flatMap((p) => (p.variants?.length ? p.variants : [p]));
      const removed = all.filter((p) => p.stock_status === "discontinued").map((p) => p.sku);
      const flat = all.filter((p) => p.stock_status !== "discontinued");
      if (!this.signs) return this.json(202, { object: "semanto.catalog_receipt", trooth_id: troothId, signed: false, records: flat.length, offers: flat.length, removed, skipped: [], reason: "This company holds its own signing key, so Trooth cannot sign the records." });
      return this.json(202, { object: "semanto.catalog_receipt", trooth_id: troothId, signed: true, connector_kid: sig.keyid, records: flat.map((p) => ({ sku: p.sku })), offers: flat.map((p) => ({ sku: p.sku })), removed, skipped: [] });
    }
    return this.problem(404, "not_found", `${method} ${url.pathname}`);
  }

  private claim(key: string): boolean {
    if (this.nonces.has(key)) return false;
    this.nonces.add(key);
    return true;
  }
}
