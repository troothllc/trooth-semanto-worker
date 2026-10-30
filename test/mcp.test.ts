// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The Semanto MCP server (src/mcp/server.ts) and agent keys (src/os/agent-keys.ts), through the Hono app with
// the in-memory world: a person makes a key, an agent runs Semanto with it, and what only a person may do is
// handed back with a link.

import { describe, it, expect } from "vitest";
import { SEMANTO_TOOLS } from "@/mcp/catalog";
import { CLOUDFLARE_WORKER_SHA256 } from "@/mcp/cloudflare-worker.generated";
import { GROUP_ICONS, SERVER_ICONS } from "@/mcp/icons.generated";
import { readFileSync } from "node:fs";
import { OS, buildAndSign, json, osWorld, post, get, type OsWorld } from "./helpers/os-world";
import { BANNED_WORDS, ELLIPSIS } from "./helpers/house-rules";

const MCP = `${OS}/mcp`;

async function call(w: OsWorld, method: string, params: Record<string, unknown> = {}, key?: string) {
  const r = await w.app.request(MCP, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const tool = async (w: OsWorld, name: string, args: Record<string, unknown> = {}, key?: string) => (await call(w, "tools/call", { name, arguments: args }, key)).body.result as Record<string, any>;

async function makeKey(w: OsWorld, scope: "read" | "write" = "write"): Promise<string> {
  const r = await post(w, "/acme/agent-keys", { name: "Claude", scope });
  expect(r.status).toBe(201);
  const b = await json(r);
  expect(b.secret).toMatch(/^tsk_[A-Za-z0-9_-]{43}$/);
  return b.secret as string;
}

describe("the tool catalog", () => {
  it("names every tool once, titles it, and sets all four hints explicitly", () => {
    const names = SEMANTO_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(60);
    for (const t of SEMANTO_TOOLS) {
      expect(t.name).toMatch(/^semanto_[a-z0-9_]+$/);
      expect(t.title.length).toBeGreaterThan(3);
      for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) expect(typeof t.hints[h]).toBe("boolean");
      if (t.hints.readOnlyHint) expect(t.hints.destructiveHint).toBe(false);
      if (t.access === "person") expect(t.page).toMatch(/^https:\/\/trooth\.co\/dashboard\/semanto\//);
      else if (!["semanto_whoami", "semanto_guide", "semanto_install_guide"].includes(t.name)) expect(t.path).toMatch(/^\/(os|public)\/semanto\//);
      for (const r of t.required ?? []) expect(Object.keys(t.params)).toContain(r);
    }
  });

  it("keeps every revoke, withdraw and cancel marked destructive, and nothing that only reads marked as a change", () => {
    for (const t of SEMANTO_TOOLS) {
      if (/revoke|withdraw|cancel|disconnect/.test(t.name) && t.access !== "person") expect(t.hints.destructiveHint).toBe(true);
      if (t.method === "GET") expect(t.hints.readOnlyHint).toBe(true);
    }
  });

  it("uses no banned words and no ellipsis in what an agent reads", () => {
    const text = JSON.stringify(SEMANTO_TOOLS);
    expect(BANNED_WORDS.test(text)).toBe(false);
    expect(ELLIPSIS.test(text)).toBe(false);
  });
});

describe("the MCP Registry entry", () => {
  it("names the live server and its agent key header", () => {
    const entry = JSON.parse(readFileSync("server.json", "utf8"));
    expect(entry.name).toBe("co.trooth/semanto");
    expect(entry.description.length).toBeLessThanOrEqual(100);
    expect(entry.remotes).toEqual([expect.objectContaining({ type: "streamable-http", url: "https://api.trooth.co/os/semanto/mcp" })]);
    expect(entry.remotes[0].headers[0]).toMatchObject({ name: "Authorization", isSecret: true });
  });
});

describe("the MCP transport", () => {
  it("initializes with the asked protocol version when it is supported, and instructions", async () => {
    const w = await osWorld();
    const r = await call(w, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe("2025-11-25");
    expect(r.body.result.serverInfo.name).toBe("semanto");
    expect(r.body.result.instructions).toMatch(/semanto_status/);
    expect(r.body.result.serverInfo.icons).toEqual(SERVER_ICONS);
    expect(SERVER_ICONS.map((i) => i.theme)).toEqual(["light", "dark"]);
    expect((await call(w, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-11-25");
    expect((await call(w, "initialize", { protocolVersion: "2026-07-28" })).body.result.protocolVersion).toBe("2025-11-25");
  });

  it("draws every icon as GitHub's server does: a 24 pixel PNG data URI with a clear background, light and dark, no sizes", async () => {
    const w = await osWorld();
    const list = (await call(w, "tools/list")).body.result.tools as Array<Record<string, any>>;
    expect(new Set(SEMANTO_TOOLS.map((t) => t.category))).toEqual(new Set(Object.keys(GROUP_ICONS)));
    for (const t of list) expect(t.icons).toEqual(GROUP_ICONS[t._meta["co.trooth/category"]]);
    for (const icon of [...SERVER_ICONS, ...Object.values(GROUP_ICONS).flat()]) {
      expect(icon).not.toHaveProperty("sizes");
      expect(icon.mimeType).toBe("image/png");
      const png = Buffer.from(icon.src.replace(/^data:image\/png;base64,/, ""), "base64");
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([24, 24]);
      expect(png[25]).toBe(6); // RGBA: the background is clear
    }
  });

  it("lists every tool with its annotations and answers 202 to a notification and 405 to GET", async () => {
    const w = await osWorld();
    const list = (await call(w, "tools/list")).body.result.tools as Array<Record<string, any>>;
    expect(list).toHaveLength(SEMANTO_TOOLS.length);
    expect(list.find((t) => t.name === "semanto_status")!.annotations.readOnlyHint).toBe(true);
    const n = await w.app.request(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(n.status).toBe(202);
    expect((await w.app.request(MCP)).status).toBe(405);
  });

  it("offers the two prompts", async () => {
    const w = await osWorld();
    const p = (await call(w, "prompts/get", { name: "set_up_semanto" })).body.result;
    expect(p.messages[0].content.text).toMatch(/semanto_install_guide/);
  });
});

describe("scoping from the server address", () => {
  const listAt = async (w: OsWorld, query: string) => {
    const r = await w.app.request(`${MCP}?${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return ((await r.json()) as Record<string, any>).result.tools as Array<Record<string, any>>;
  };
  it("offers only read-only tools with read_only=true, and refuses the rest when called", async () => {
    const w = await osWorld();
    const tools = await listAt(w, "read_only=true");
    expect(tools.length).toBe(SEMANTO_TOOLS.filter((t) => t.hints.readOnlyHint).length);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    const key = await makeKey(w);
    const r = await w.app.request(`${MCP}?read_only=true`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "semanto_setup_resume", arguments: {} } }) });
    expect(((await r.json()) as Record<string, any>).result.structuredContent.status).toBe("not_offered");
  });
  it("offers the named groups and Start here with groups=", async () => {
    const w = await osWorld();
    const tools = await listAt(w, "groups=keys,put-it-on-the-site");
    const cats = new Set(tools.map((t) => t._meta["co.trooth/category"]));
    expect([...cats].sort()).toEqual(["Keys", "Put it on the site", "Start here"]);
  });
});

describe("the transport's guards", () => {
  const raw = (w: OsWorld, headers: Record<string, string>, body: unknown) => w.app.request(MCP, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  it("refuses a web page's Origin and allows none, trooth.co, localhost and app schemes", async () => {
    const w = await osWorld();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await raw(w, { origin: "https://evil.example" }, ping)).status).toBe(403);
    for (const origin of ["https://trooth.co", "http://localhost:6274", "vscode-file://vscode-app"]) expect((await raw(w, { origin }, ping)).status).toBe(200);
    expect((await raw(w, {}, ping)).status).toBe(200);
  });
  it("answers 400 to an MCP-Protocol-Version it does not support", async () => {
    const w = await osWorld();
    expect((await raw(w, { "mcp-protocol-version": "1999-01-01" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(400);
    expect((await raw(w, { "mcp-protocol-version": "2025-11-25" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });
  it("answers 401 with WWW-Authenticate to a key that no longer works", async () => {
    const w = await osWorld();
    const r = await raw(w, { authorization: "Bearer tsk_" + "b".repeat(43) }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "semanto_status", arguments: { trooth_id: "acme" } } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer realm="semanto", error="invalid_token"/);
  });
  it("refuses arguments a tool does not name, and dot segments in a path", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    expect((await tool(w, "semanto_status", { surprise: 1 }, key)).structuredContent.status).toBe("invalid_request");
    expect((await tool(w, "semanto_page", { trooth_id: "acme", path: "/../../os/semanto/acme/setup" })).structuredContent.status).toBe("invalid_request");
  });
});

describe("agent keys", () => {
  it("are made by a person, show the secret once, and are listed without it", async () => {
    const w = await osWorld();
    await makeKey(w);
    const list = await json(await get(w, "/acme/agent-keys"));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ name: "Claude", scope: "write", status: "active" });
    expect(JSON.stringify(list)).not.toMatch(/tsk_/);
    expect(w.agentKeys.rows[0]!.secret_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("act in their own company only, and can never make or revoke agent keys", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    expect((await get(w, "/acme/settings", `Bearer ${key}`)).status).toBe(200);
    expect((await post(w, "/acme/agent-keys", { name: "x", scope: "write" }, `Bearer ${key}`)).status).toBe(403);
    expect((await get(w, "/other/settings", `Bearer ${key}`)).status).toBe(403);
    expect((await get(w, "/acme/settings", "Bearer tsk_" + "a".repeat(43))).status).toBe(401);
  });

  it("can never sign, add a passkey, rotate or revoke signing keys, set the signing policy or connect an app", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    for (const path of ["/acme/passkeys/options", "/acme/passkeys", "/acme/sign/options", "/acme/sign", "/acme/keys/rotate", "/acme/keys/rotation/start", "/acme/keys/rotation/confirm", "/acme/keys/k1/revoke", "/acme/company/signing-policy", "/acme/google/connect", "/acme/sellers/lists", "/acme/recalls", "/acme/connect/s1/approve", "/acme/erase"]) {
      const r = await post(w, path, { custody: "customer" }, `Bearer ${key}`);
      expect(r.status, path).toBe(403);
      expect((await json(r)).detail, path).toMatch(/Only a person can do this/);
    }
  });

  it("leave an audit row naming the key for every pipeline write, and are rate limited", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    await post(w, "/acme/setup/save-for-later", {}, `Bearer ${key}`);
    expect(JSON.stringify(w.osStore.audit.at(-1))).toMatch(/setup\.save-for-later/);
    expect(JSON.stringify(w.osStore.audit.at(-1))).toMatch(/agent:ak_/);
  });

  it("stop working the moment they are revoked", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    const kid = (await json(await get(w, "/acme/agent-keys"))).data[0].kid;
    expect((await post(w, `/acme/agent-keys/${kid}/revoke`, {})).status).toBe(200);
    expect((await get(w, "/acme/settings", `Bearer ${key}`)).status).toBe(401);
  });
});

describe("running Semanto through the MCP", () => {
  it("knows the company from the key and reads the setup status", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    const who = await tool(w, "semanto_whoami", {}, key);
    expect(who.structuredContent).toMatchObject({ trooth_id: "acme", scope: "write" });
    const status = await tool(w, "semanto_status", {}, key);
    expect(status.isError).toBe(false);
    expect(status.structuredContent.object).toBe("semanto.setup");
  });

  it("refuses a workspace tool without a key, and a change with a read key", async () => {
    const w = await osWorld();
    expect((await tool(w, "semanto_status", { trooth_id: "acme" })).structuredContent.status).toBe("agent_key_required");
    const read = await makeKey(w, "read");
    expect((await tool(w, "semanto_settings_get", {}, read)).isError).toBe(false);
    expect((await tool(w, "semanto_setup_resume", {}, read)).structuredContent.status).toBe("forbidden");
  });

  it("changes settings with a write key, and the audit trail names the key", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    const r = await tool(w, "semanto_settings_save", { body: { content_signals: { "ai-train": false, search: true, "ai-input": true } } }, key);
    expect(r.isError).toBe(false);
    expect(w.osStore.audit.at(-1)).toMatchObject({ action: "settings.save" });
    expect(JSON.stringify(w.osStore.audit.at(-1))).toMatch(/agent:ak_/);
  });

  it("hands signing, erasing and agent keys to the person with a link", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    for (const name of ["semanto_sign", "semanto_erase", "semanto_agent_keys", "semanto_keys_rotation_confirm"]) {
      const r = await tool(w, name, {}, key);
      expect(r.structuredContent.status).toBe("human_action_required");
      expect(r.structuredContent.url).toMatch(/^https:\/\/trooth\.co\/dashboard\/semanto\//);
    }
  });

  it("gives the Cloudflare install as the Worker and the two API calls, with the Trooth ID in place", async () => {
    const w = await osWorld();
    const key = await makeKey(w);
    const g = (await tool(w, "semanto_install_guide", { host: "cloudflare" }, key)).structuredContent;
    expect(g.host).toBe("Cloudflare");
    const upload = g.options[0].calls[0];
    expect(upload.metadata.bindings).toContainEqual({ type: "plain_text", name: "TROOTH_ID", text: "acme" });
    expect(upload.worker_js).toMatch(/export \{|export default/);
    expect(upload.worker_js_sha256).toBe(CLOUDFLARE_WORKER_SHA256);
    expect(g.options[0].calls[1].body).toEqual({ pattern: "acme.com/*", script: "trooth-semanto" });
  });

  it("reads any company's public record with no key", async () => {
    const w = await osWorld();
    await buildAndSign(w);
    const r = await tool(w, "semanto_read", { trooth_id: "acme" });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.header.trooth_id).toBe("acme");
    expect((await tool(w, "semanto_log_checkpoint")).isError).toBe(false);
  });
});
