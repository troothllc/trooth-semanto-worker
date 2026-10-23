// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The local doubles the QA stack (qa/stack.mjs) puts at the network boundary.
// None of them is a real provider; each answers in the shape the Worker's
// code reads (src/os/google.ts, src/os/writeback.ts, src/monitor/ports.ts):
//
//   upstream   one loopback server the Worker reaches through DEV_UPSTREAM_BASE
//              (src/dev-upstream.ts): /oauth2.googleapis.com/token and /revoke,
//              the Merchant API, Business Profile account and location reads and
//              writes, and /api.resend.com/emails (every message is captured).
//              It also serves /consent, the stand-in for Google's consent page
//              the browser is sent to (the walk routes accounts.google.com here).
//   dns        DNS over HTTPS (JSON form) for the hosts the walk names.
//   site       the company sites the Worker reads (acmegoods-qa.com, globex-qa.com).
//   profile    trooth.co's network profile reads worker-f's MCP tool makes.
//
// Modes are switched through the control server in qa/stack.mjs so the walk can
// make Google refuse a refresh (invalid_grant), answer 429 or 500, and so on.

import http from "node:http";
import { randomBytes } from "node:crypto";

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c).toString("utf8"))); });
const b64url = (s) => Buffer.from(s).toString("base64url");

export function upstreamState() {
  return {
    /** Google token refresh: "ok" | "invalid_grant" | "500". */
    refresh: "ok",
    /** Merchant and Business Profile writes: a list of statuses answered in turn, then 200 for the rest. */
    writes: [],
    /** Consent: the scopes the person grants, or null for "every scope asked". */
    grant: null,
    codes: new Map(),
    refreshTokens: new Map(),
    revoked: [],
    calls: [],
    emails: [],
  };
}

/** The upstream double: Google and Resend behind DEV_UPSTREAM_BASE, and the consent page. */
export function startUpstream(port, state = upstreamState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = await readBody(req);
    const parts = url.pathname.split("/").filter(Boolean);
    const host = parts[0] ?? "";
    const path = "/" + parts.slice(1).join("/");
    const auth = String(req.headers.authorization || "");
    state.calls.push({ at: new Date().toISOString(), method: req.method, host, path, query: url.search, auth: auth ? auth.slice(0, 12) + "[redacted]" : null });

    // The consent page stand-in: what Google's page asks, Allow and Cancel.
    if (url.pathname === "/consent") {
      const q = url.searchParams;
      const scopes = (q.get("scope") || "").split(" ").filter(Boolean);
      const redirect = q.get("redirect_uri") || "";
      const st = q.get("state") || "";
      if (req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("decision") !== "allow") {
          res.writeHead(302, { location: `${redirect}?error=access_denied&state=${encodeURIComponent(st)}` });
          return res.end();
        }
        const granted = f.getAll("scope");
        const code = "qa-code-" + randomBytes(9).toString("base64url");
        state.codes.set(code, { scopes: granted, challenge: q.get("code_challenge"), client_id: q.get("client_id"), redirect_uri: redirect });
        res.writeHead(302, { location: `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}&scope=${encodeURIComponent(granted.join(" "))}` });
        return res.end();
      }
      const boxes = scopes.map((s) => `<label><input type="checkbox" name="scope" value="${s}" checked> ${s}</label><br>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html lang="en"><head><title>Sign in with Google (QA stand-in)</title></head><body><main><h1>QA stand-in for Google's consent page</h1><p>Semanto by Trooth wants to:</p><form method="post">${boxes}<button name="decision" value="allow">Allow</button> <button name="decision" value="cancel">Cancel</button></form></main></body></html>`);
    }

    if (host === "oauth2.googleapis.com" && path === "/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") === "authorization_code") {
        const c = state.codes.get(f.get("code") || "");
        if (!c) return json(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
        state.codes.delete(f.get("code"));
        const access = "ya29.qa-" + randomBytes(12).toString("base64url");
        const refresh = "1//qa-refresh-" + randomBytes(12).toString("base64url");
        state.refreshTokens.set(refresh, c.scopes);
        const idToken = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ email: "merchant@acmegoods-qa.com", sub: "1080", aud: f.get("client_id") }))}.qa-signature`;
        return json(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3599, scope: c.scopes.join(" "), token_type: "Bearer", id_token: idToken });
      }
      if (f.get("grant_type") === "refresh_token") {
        if (state.refresh === "invalid_grant" || !state.refreshTokens.has(f.get("refresh_token") || "")) return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        if (state.refresh === "500") return json(res, 500, { error: "internal_failure" });
        return json(res, 200, { access_token: "ya29.qa-" + randomBytes(12).toString("base64url"), expires_in: 3599, scope: (state.refreshTokens.get(f.get("refresh_token")) || []).join(" "), token_type: "Bearer" });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (host === "oauth2.googleapis.com" && path === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(body).get("token") || "";
      state.revoked.push(token.slice(0, 14));
      state.refreshTokens.delete(token);
      return json(res, 200, {});
    }
    const bearer = /^Bearer ya29\.qa-/.test(auth);
    if (host === "merchantapi.googleapis.com" && path === "/accounts/v1/accounts") {
      if (!bearer) return json(res, 401, { error: { code: 401, message: "Request is missing required authentication credential." } });
      return json(res, 200, { accounts: [{ name: "accounts/123456", accountId: "123456", accountName: "Acme Goods Store" }] });
    }
    if (host === "mybusinessaccountmanagement.googleapis.com" && path === "/v1/accounts") {
      if (!bearer) return json(res, 401, { error: { code: 401, message: "Unauthenticated." } });
      return json(res, 200, { accounts: [{ name: "accounts/987", accountName: "Acme Goods" }] });
    }
    if (host === "mybusinessbusinessinformation.googleapis.com" && /^\/v1\/accounts\/[^/]+\/locations$/.test(path)) {
      if (!bearer) return json(res, 401, { error: { code: 401, message: "Unauthenticated." } });
      return json(res, 200, { locations: [{ name: "locations/555", title: "Acme Goods, Main Street" }] });
    }
    const isWrite = (host === "merchantapi.googleapis.com" && /productInputs:insert$/.test(path) && req.method === "POST") || (host === "mybusinessbusinessinformation.googleapis.com" && /^\/v1\/locations\/[^/]+$/.test(path) && req.method === "PATCH");
    if (isWrite) {
      if (!bearer) return json(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
      const next = state.writes.length ? state.writes.shift() : 200;
      if (next === 429) return json(res, 429, { error: { code: 429, message: "Quota exceeded for quota metric 'Product inputs'.", status: "RESOURCE_EXHAUSTED" } });
      if (next >= 500) return json(res, next, { error: { code: next, message: "Internal error encountered.", status: "INTERNAL" } });
      if (next >= 400) return json(res, next, { error: { code: next, message: "[productAttributes.price] The price is not valid for the feed label.", status: "INVALID_ARGUMENT" } });
      return json(res, 200, { name: "accounts/123456/productInputs/en~US~qa", product: "accounts/123456/products/en~US~qa" });
    }
    if (host === "api.resend.com" && path === "/emails" && req.method === "POST") {
      let message = null;
      try { message = JSON.parse(body); } catch { /* raw kept below */ }
      const id = "qa-mail-" + (state.emails.length + 1);
      state.emails.push({ id, at: new Date().toISOString(), authorization_present: Boolean(auth), message, raw: message ? null : body });
      return json(res, 200, { id });
    }
    return json(res, 404, { error: "qa upstream double: no such address", host, path });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, port, state, origin: `http://127.0.0.1:${port}`, close: () => { server.close(); server.closeAllConnections?.(); } })));
}

/** DNS over HTTPS answers (JSON form) from a table: { "host": { A: ["203.0.113.10"], TXT: ["v=..."] } }. */
export function dnsAnswer(table, url) {
  const name = (url.searchParams.get("name") || "").toLowerCase().replace(/\.$/, "");
  const typeRaw = (url.searchParams.get("type") || "A").toUpperCase();
  const types = { A: 1, AAAA: 28, TXT: 16, CNAME: 5, NS: 2, MX: 15 };
  const type = types[typeRaw] ? typeRaw : Object.keys(types).find((k) => String(types[k]) === typeRaw) || "A";
  const rec = table[name];
  const data = rec?.[type] ?? [];
  if (!rec) return { Status: 3, Answer: [] };
  return { Status: 0, Answer: data.map((d) => ({ name: name + ".", type: types[type], TTL: 60, data: type === "TXT" ? `"${d}"` : d })) };
}

/** A company site: a home page, three pages, robots.txt and a sitemap, with a host header Semanto detects. */
export function companySite(domain, org) {
  const page = (title, body, links = []) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | ${org}</title><meta name="description" content="${org}: ${title}."></head><body><header><nav>${["/", "/about", "/pricing", "/contact", "/products/kettle"].map((p) => `<a href="${p}">${p}</a>`).join(" ")}</nav></header><main><h1>${title}</h1>${body}${links.join("")}</main><footer>${org}, 1 Main Street, Springfield. Phone +1 555 0100.</footer></body></html>`;
  const pages = {
    "/": page(`${org}`, `<p>${org} makes kettles and teapots for home kitchens. We ship to the United States and Canada.</p>`),
    "/about": page("About us", `<p>${org} was founded in 2019. Our team of twelve designs every product in Springfield.</p>`),
    "/pricing": page("Pricing", `<p>The Classic Kettle costs 49 US dollars. Shipping is free on orders over 75 US dollars.</p>`),
    "/contact": page("Contact", `<p>Email hello@${domain} or call +1 555 0100, Monday to Friday, 9 to 5.</p>`),
    "/products/kettle": page("Classic Kettle", `<p>The Classic Kettle holds 1.7 litres. SKU KET-001. GTIN 00012345678905. Price 49 US dollars. In stock.</p><img src="/images/kettle.png" alt="The Classic Kettle"><img src="/images/missing.png" alt="A photo that is not there"><p><a href="/docs/kettle-manual.pdf">Kettle manual (PDF)</a></p>`),
  };
  return {
    seen: [],
    handle(u, method) {
      this.seen.push(`${method} ${u.pathname}`);
      const h = { "server": "Vercel", "x-vercel-id": "qa1::abcd", "content-type": "text/html; charset=utf-8" };
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://" + domain + "/sitemap.xml\n", { headers: { ...h, "content-type": "text/plain" } });
      if (u.pathname === "/sitemap.xml") return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(pages).map((p) => `<url><loc>https://${domain}${p}</loc></url>`).join("")}</urlset>`, { headers: { ...h, "content-type": "application/xml" } });
      if (pages[u.pathname]) return new Response(method === "HEAD" ? null : pages[u.pathname], { headers: h });
      // One real PNG (1x1) and one small PDF, so the build has assets to make content credentials for.
      if (u.pathname === "/images/kettle.png") return new Response(method === "HEAD" ? null : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64"), { headers: { ...h, "content-type": "image/png" } });
      if (u.pathname === "/docs/kettle-manual.pdf") return new Response(method === "HEAD" ? null : "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", { headers: { ...h, "content-type": "application/pdf" } });
      return new Response("Not found", { status: 404, headers: { ...h, "content-type": "text/plain" } });
    },
  };
}

/** trooth.co's network profile reads for worker-f's MCP tool (src/mcp.ts), for the companies the walk publishes. */
export function startProfileStub(port, companies) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const q = (url.searchParams.get("q") || url.searchParams.get("company") || url.searchParams.get("domain") || url.searchParams.get("slug") || "").toLowerCase();
    const c = companies.find((x) => x.domain === q || x.slug === q);
    if (url.pathname === "/api/network/profile/history") {
      if (!c) return json(res, 404, { found: false });
      return json(res, 200, { found: true, companyId: c.slug, headVersion: 1, changes: [{ sequence: 1, eventId: "e1", kind: "published", recordedAt: "2026-10-01T10:00:00Z", digest: "sha-256=qa", previousDigest: null, correctsVersion: null, corrections: [], facts: { added: [], removed: [], changed: [], withheldChanges: 0 } }], next: null });
    }
    if (url.pathname === "/api/network/profile") {
      if (!c) return json(res, 404, { found: false });
      return json(res, 200, { found: true, contractVersion: 2, slug: c.slug, domain: c.domain, name: c.name, canonicalUrl: `https://trooth.co/network/company/${c.slug}`, witnessed: { standing: "witnessed", lastWitnessed: "2026-10-01T10:00:00Z" }, facts: [] });
    }
    return json(res, 404, { error: "qa profile stub: no such address", path: url.pathname });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${port}`, close: () => { server.close(); server.closeAllConnections?.(); } })));
}
