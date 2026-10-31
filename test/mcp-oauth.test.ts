// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Sign-in for the Semanto MCP server (src/mcp/oauth.ts, src/mcp/server.ts): the 401 challenge that starts it, each
// token check refusing on its own, and a signed-in AI tool acting as the person trooth.co linked, through a grant.

import { describe, it, expect } from "vitest";
import { handleMcp } from "@/mcp/server";
import { MemorySubjectLinks, OAuthVerifier, SEMANTO_MCP_METADATA_URL, SEMANTO_MCP_RESOURCE, protectedResourceMetadata, semantoRole } from "@/mcp/oauth";
import type { WorkspaceAuth } from "@/serve/ports";

const ISSUER = "https://example.authkit.app";
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));

async function issuer() {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const fetchDoc = async (url: string) => {
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/oauth2/jwks` }));
    if (url === `${ISSUER}/oauth2/jwks`) return new Response(JSON.stringify({ keys: [{ ...pub, kid: "k1", alg: "RS256", use: "sig" }] }));
    return new Response("{}", { status: 404 });
  };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const h = enc({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
    const p = enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  };
  return { fetchDoc, sign };
}

const now = Math.floor(Date.UTC(2026, 9, 30, 12) / 1000);
const good = { iss: ISSUER, sub: "user_01", aud: SEMANTO_MCP_RESOURCE, client_id: "client_claude", exp: now + 600, iat: now };

describe("the token checks", () => {
  it("accept a token for this server and refuse each wrong one on its own", async () => {
    const { fetchDoc, sign } = await issuer();
    const v = new OAuthVerifier({ issuer: ISSUER, fetch: fetchDoc, now: () => now * 1000 });
    expect((await v.verify(await sign(good))).ok).toBe(true);
    const refused = async (claims: Record<string, unknown>, header?: Record<string, unknown>) => {
      const r = await v.verify(await sign(claims, header));
      return r.ok ? "accepted" : r.description;
    };
    expect(await refused({ ...good, aud: "https://api.trooth.co/public/mcp" })).toMatch(/another server/);
    expect(await refused({ ...good, iss: "https://evil.example" })).toMatch(/not issued by Trooth/);
    expect(await refused({ ...good, exp: now - 3600 })).toMatch(/expired/);
    expect(await refused({ ...good, client_id: undefined })).toMatch(/no client/);
    expect(await refused(good, { jwk: {} })).toMatch(/issuer's metadata/);
    expect(await refused(good, { alg: "HS256" })).toMatch(/algorithm/);
    const t = await sign(good);
    expect((await v.verify(t.slice(0, -4) + "AAAA")).ok).toBe(false);
  });
});

describe("the MCP server with sign-in", () => {
  async function server(link: boolean, role = "owner") {
    const { fetchDoc, sign } = await issuer();
    const links = new MemorySubjectLinks();
    if (link) links.rows.set(`${ISSUER} user_01`, { os_company_id: "co-acme", user_id: "u-ada", email: "ada@acme.com", role });
    const grants = new Map<string, WorkspaceAuth>();
    const calls: Request[] = [];
    const deps = {
      now: () => new Date(now * 1000),
      call: async (r: Request) => {
        calls.push(r);
        return new Response(JSON.stringify({ object: "semanto.setup", ok: true }), { headers: { "content-type": "application/json" } });
      },
      oauth: { verifier: new OAuthVerifier({ issuer: ISSUER, fetch: fetchDoc, now: () => now * 1000 }), links, troothIdFor: async (id: string) => (id === "co-acme" ? "acme" : null), grant: (a: WorkspaceAuth) => (grants.set("g1", a), "g1") },
    };
    const mcp = (body: unknown, auth?: string) => handleMcp(new Request("https://api.trooth.co/os/semanto/mcp", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }), deps);
    return { sign, mcp, grants, calls };
  }

  it("answers 401 with the challenge that names the metadata when no credential is sent", async () => {
    const { mcp } = await server(true);
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${SEMANTO_MCP_METADATA_URL}"`);
    expect(protectedResourceMetadata(ISSUER)).toMatchObject({ resource: SEMANTO_MCP_RESOURCE, authorization_servers: [ISSUER] });
  });

  it("acts as the linked person through a grant, never by passing the token on", async () => {
    const { sign, mcp, grants, calls } = await server(true);
    const token = `Bearer ${await sign(good)}`;
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, token)).status).toBe(200);
    const who = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "semanto_whoami", arguments: {} } }, token)).json()) as Record<string, any>;
    expect(who.result.structuredContent).toMatchObject({ trooth_id: "acme", scope: "write", signed_in: true });
    await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "semanto_status", arguments: {} } }, token);
    const forwarded = calls.at(-1)!;
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("semanto-mcp-grant")).toBe("g1");
    expect(grants.get("g1")).toMatchObject({ trooth_id: "acme", role: "owner", user_id: "agent:oauth:u-ada" });
  });

  it("answers 401 with invalid_token for a bad token, and says how to link an unlinked sign-in", async () => {
    const { sign, mcp } = await server(false);
    const bad = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, `Bearer ${await sign({ ...good, aud: "https://other.example" })}`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    const r = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "semanto_status", arguments: {} } }, `Bearer ${await sign(good)}`)).json()) as Record<string, any>;
    expect(r.result.structuredContent.status).toBe("not_linked");
  });

  it("gives a viewer read only, and maps trooth.co roles", async () => {
    const { sign, mcp } = await server(true, "viewer");
    const r = (await (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "semanto_setup_resume", arguments: {} } }, `Bearer ${await sign(good)}`)).json()) as Record<string, any>;
    expect(r.result.structuredContent.status).toBe("forbidden");
    expect([semantoRole("owner"), semantoRole("admin"), semantoRole("editor"), semantoRole("viewer"), semantoRole(null)]).toEqual(["owner", "admin", "member", "viewer", "viewer"]);
  });
});

describe("sign-in through the Worker's own routes", () => {
  it("reads the setup as the linked person, serves the metadata, and refuses a forged grant", async () => {
    const { osWorld, OS } = await import("./helpers/os-world");
    const { fetchDoc, sign } = await issuer();
    const links = new MemorySubjectLinks();
    links.rows.set(`${ISSUER} user_01`, { os_company_id: "co-acme", user_id: "u-ada", email: "ada@acme.com", role: "owner" });
    const w = await osWorld({ mcpOAuth: { verifier: new OAuthVerifier({ issuer: ISSUER, fetch: fetchDoc, now: () => now * 1000 }), links, troothIdFor: async (id) => (id === "co-acme" ? "acme" : null) }, mcpOAuthIssuer: ISSUER });
    const call = async (name: string, auth?: string) => {
      const r = await w.app.request(`${OS}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    expect((await call("semanto_status")).status).toBe(401);
    const status = await call("semanto_status", `Bearer ${await sign(good)}`);
    expect(status.body.result.isError).toBe(false);
    expect(status.body.result.structuredContent.object).toBe("semanto.setup");
    const meta = await w.app.request("/.well-known/oauth-protected-resource/os/semanto/mcp");
    expect(await meta.json()).toMatchObject({ resource: SEMANTO_MCP_RESOURCE, authorization_servers: [ISSUER] });
    const forged = await w.app.request(`${OS}/acme/setup`, { headers: { "semanto-mcp-grant": "0".repeat(48) } });
    expect(forged.status).toBe(401);
  });
});
