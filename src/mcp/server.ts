// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// THE SEMANTO MCP SERVER: https://api.trooth.co/os/semanto/mcp, Streamable HTTP (MCP specification,
// basic/transports): a client POSTs one JSON-RPC message and gets one JSON answer. Stateless: no session id,
// no server-sent stream, so GET is 405, as the transport allows for a server that sends no stream.
//
// Auth is a person's Trooth sign-in (OAuth, src/mcp/oauth.ts) or the company's agent key, sent as Authorization: Bearer followed by the tsk_ key on the MCP request (src/os/agent-keys.ts),
// as Vercel's and Cloudflare's servers take an API token. Without one, the public tools still answer. Every tool
// runs the same route the dashboard uses, through this Worker's own app, so roles, rate limits, the audit trail
// and the signed answers are the same for an agent as for a person.

import { GROUP_ICONS, SERVER_ICONS } from "./icons.generated";
import { SEMANTO_TOOLS, toolByName, type SemantoTool } from "./catalog";
import { CLOUDFLARE_COMPATIBILITY_DATE, CLOUDFLARE_WORKER_JS, CLOUDFLARE_WORKER_SHA256 } from "./cloudflare-worker.generated";
import { authorizeAgentKey, bearerAgentKey, type AgentKeyStore } from "../os/agent-keys";
import type { WorkspaceAuth } from "../serve/ports";
import { looksLikeJwt, semantoRole, wwwAuthenticate, type OAuthVerifier, type SubjectLinks } from "./oauth";

export const MCP_URL = "https://api.trooth.co/os/semanto/mcp";
const ORIGIN = "https://api.trooth.co";
// The revisions this server implements in full. 2026-07-28 drops initialize for server/discover and changes every
// result's shape, so it is offered once those are built, not before; a client asking for it is answered 2025-11-25.
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = {
  name: "semanto",
  title: "Semanto by Trooth",
  version: "1.0.0",
  description: "Set up, sign, publish and check Semanto, a company's signed website file for AI agents.",
  websiteUrl: "https://trooth.co/docs/semanto#mcp",
  // The Trooth mark, light and dark, as GitHub's server sends the Invertocat (src/mcp/icons.generated.ts).
  icons: SERVER_ICONS,
};
const MAX_TEXT = 200_000;

export interface McpDeps {
  /** This Worker's own app: every tool is one request to it. */
  call(req: Request): Promise<Response>;
  agentKeys?: AgentKeyStore;
  now(): Date;
  /**
   * Sign-in (src/mcp/oauth.ts). When set, a request with no credential answers 401 with the challenge that starts the
   * client's sign-in, and an AuthKit access token for this server acts as the person it names, through a grant the
   * Worker's own routes accept for one minute (src/serve/routes.ts mcpGrant).
   */
  oauth?: {
    verifier: OAuthVerifier;
    links: SubjectLinks;
    troothIdFor(os_company_id: string): Promise<string | null>;
    grant(auth: WorkspaceAuth): string;
  };
}

type Json = Record<string, unknown>;
const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

const INSTRUCTIONS = [
  "Semanto by Trooth turns a company's website into one signed copy AI agents can read and check.",
  "Start with semanto_whoami, then semanto_status: its next_action is the next call to make.",
  "Setup runs in order: prove the domain, read the site, review the facts, sign, put it on the site, check it.",
  "The person does three things only: confirms the domain on trooth.co, signs with their passkey (semanto_sign gives the link), and approves any tool their client asks about.",
  "To put it on the site, call semanto_install_guide: it gives the exact files and, for Cloudflare, the two Cloudflare API calls to make with the host's own tools. Then call semanto_install_check.",
  "Tools marked read-only never change anything. Tools that change something wait for the person's approval in most clients.",
].join(" ");

/** A group name as the server address names it: "Put it on the site" is put-it-on-the-site. */
export const groupSlug = (category: string): string => category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function toolDescriptor(t: SemantoTool) {
  const props: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(t.params)) props[k] = { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}), ...(p.items ? { items: p.items } : {}) };
  const access = t.access === "public" ? "No key needed." : t.access === "read" ? "Needs an agent key (read or write)." : t.access === "write" ? "Needs an agent key with write scope." : "Hands the step to the person with a link.";
  return {
    name: t.name,
    title: t.title,
    description: `${t.description} ${access}`,
    inputSchema: { type: "object", properties: props, ...(t.required?.length ? { required: t.required } : {}), additionalProperties: false },
    annotations: { title: t.title, ...t.hints },
    icons: GROUP_ICONS[t.category],
    _meta: { "co.trooth/category": t.category, "co.trooth/access": t.access },
  };
}

/** Fill {name} placeholders from args and take them out; the path argument keeps its slashes. */
function fillPath(template: string, args: Json, troothId: string | null): { path: string; rest: Json } | { error: string } {
  const rest: Json = { ...args };
  let missing: string | null = null;
  const path = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    let v = name === "trooth_id" ? (rest.trooth_id ?? troothId) : rest[name];
    delete rest[name];
    if (v === undefined || v === null || v === "") {
      missing = name;
      return "";
    }
    v = String(v);
    // No dot segments: "../" in a path or an id would climb out of the route the tool names.
    if (/(^|\/)\.\.?(\/|$)|%2e/i.test(v as string)) {
      missing = `${name}!`;
      return "";
    }
    if (name === "path") return (v as string).startsWith("/") ? encodeURI(v as string) : `/${encodeURI(v as string)}`;
    return encodeURIComponent(v as string);
  });
  delete rest.trooth_id;
  if (missing) return { error: (missing as string).endsWith("!") ? `${(missing as string).slice(0, -1)} may not contain . or .. segments.` : missing === "trooth_id" ? "trooth_id is needed: pass it, or send an agent key so the company is known." : `${missing} is needed.` };
  return { path, rest };
}

async function asToolResult(res: Response): Promise<Json> {
  const type = res.headers.get("content-type") ?? "";
  let text = await res.text();
  let structured: unknown;
  if (/json/.test(type)) {
    try {
      structured = JSON.parse(text);
      text = JSON.stringify(structured, null, 2);
    } catch {
      /* keep the text */
    }
  }
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n[cut at ${MAX_TEXT} characters; ask for a narrower page]`;
  const isError = res.status >= 400;
  const meta = { status: res.status, request_id: res.headers.get("trooth-request-id") };
  return {
    content: [{ type: "text", text }],
    ...(structured && typeof structured === "object" && !Array.isArray(structured) ? { structuredContent: structured } : {}),
    isError,
    _meta: { "co.trooth/http": meta },
  };
}

const textResult = (value: unknown, isError = false): Json => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}), isError });

const GUIDE = {
  object: "semanto.agent_guide",
  what: "Semanto by Trooth publishes a company's website as one signed copy: every page hashed, signed with the company's key, witnessed by Trooth and entered in a public log, so an AI agent reading it can check what the company said and when.",
  order: [
    { step: "1. Find where setup is", tool: "semanto_status", who: "agent" },
    { step: "2. Prove the domain", tool: "semanto_setup_look_again", who: "the person confirms the domain on trooth.co once; the agent then reads it again" },
    { step: "3. Read the site", tool: "semanto_setup_read_again or semanto_build", who: "agent" },
    { step: "4. Choose Basic or the full signed copy", tool: "semanto_setup_choose", who: "agent, as the person asked" },
    { step: "5. Review and confirm the facts", tool: "semanto_review_get then semanto_setup_confirm", who: "agent shows the person the facts; confirms what they approve" },
    { step: "6. Sign", tool: "semanto_sign", who: "the person, with their passkey, at the link the tool gives" },
    { step: "7. Put it on the site", tool: "semanto_install_guide", who: "agent, with the host's own tools (Cloudflare, Vercel, Netlify connectors) or the person" },
    { step: "8. Check it", tool: "semanto_install_check", who: "agent" },
  ],
  docs: "https://trooth.co/docs/semanto",
};

const HEAD = (pub: string) => `<link rel="https://trooth.co/rel/semanto" href="${pub}">\n<link rel="alternate" type="application/ld+json" href="${pub}/facts.jsonld">`;

/** The install for one host, every value filled in. */
export function installGuide(host: string, troothId: string, domain: string | null): Json {
  const pub = `${ORIGIN}/public/semanto/${encodeURIComponent(troothId)}`;
  const docs = (id: string) => `https://trooth.co/docs/semanto/install/${id}`;
  const site = domain ?? "<the company's domain>";
  const head = { kind: "paste_head_code", code: HEAD(pub) };
  switch (host) {
    case "cloudflare":
      return {
        host: "Cloudflare",
        docs: docs("cloudflare-worker"),
        options: [
          {
            option: "Agent with Cloudflare's tools (no GitHub)",
            needs: "the Cloudflare account and zone that serve the domain; the domain's DNS records proxied (orange cloud)",
            calls: [
              {
                what: "Upload the Worker",
                method: "PUT",
                path: "/accounts/{account_id}/workers/scripts/trooth-semanto",
                body: "multipart/form-data: part metadata (application/json) and part worker.js (application/javascript+module)",
                metadata: { main_module: "worker.js", compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE, bindings: [{ type: "plain_text", name: "TROOTH_ID", text: troothId }], observability: { enabled: true, head_sampling_rate: 1 } },
                worker_js: CLOUDFLARE_WORKER_JS,
                worker_js_sha256: CLOUDFLARE_WORKER_SHA256,
              },
              { what: "Route the domain to it", method: "POST", path: "/zones/{zone_id}/workers/routes", body: { pattern: `${site}/*`, script: "trooth-semanto" } },
              { what: "Check it", tool: "semanto_install_check" },
            ],
          },
          { option: "Deploy button (a person, with GitHub)", url: "https://deploy.workers.cloudflare.com/?url=https://github.com/troothllc/trooth-semanto-worker/tree/main/deploy/cloudflare", values: { TROOTH_ID: troothId } },
          { option: "Command line", commands: ["npm create cloudflare@latest -- trooth-semanto --template=troothllc/trooth-semanto-worker/deploy/cloudflare", `npx wrangler deploy --var TROOTH_ID:${troothId}`] },
        ],
        safe: "Every request the Worker does not serve goes to the site unchanged; if Trooth is slow or down, the site keeps answering.",
      };
    case "netlify":
      return { host: "Netlify", docs: docs("netlify-edge"), options: [{ option: "Two lines in _redirects (no code)", file: "_redirects", lines: [`/.well-known/trooth.semanto     ${pub}            200!`, `/.well-known/trooth-keys.json   ${pub}/keys.json  200!`] }, { option: "The edge function (full adapter)", package: `${"https://trooth.co"}/downloads/semanto/trooth-semanto-netlify-edge.zip`, env: { TROOTH_ID: troothId } }] };
    case "vercel":
      return { host: "Vercel", docs: docs("vercel-middleware"), options: [{ option: "Middleware in the project", package: "https://trooth.co/downloads/semanto/trooth-semanto-vercel-middleware.zip", env: { TROOTH_ID: troothId }, note: "Copied into the existing project (into src when the app folder is there) and deployed with it; on Next.js 16 the file is proxy.ts. An agent with Vercel's tools sets the environment variable and redeploys, and redeploys again after each new signed version so the two well-known files update." }] };
    case "wordpress":
      return { host: "WordPress", docs: docs("wordpress-plugin"), options: [{ option: "Plugin", package: "https://trooth.co/downloads/semanto/trooth-semanto-wordpress-plugin.zip", steps: ["Plugins, Add New Plugin, Upload Plugin, choose the zip, Install Now, Activate", "Settings, Trooth Semanto: paste the Trooth ID, Save"], values: { trooth_id: troothId } }] };
    case "nginx":
      return { host: "nginx", docs: docs("nginx-config"), options: [{ option: "Configuration", package: "https://trooth.co/downloads/semanto/trooth-semanto-nginx-config.zip", replace: { "example-inc": troothId }, note: "Three files go in /etc/nginx; semanto-server.conf has its own location /, so the site's existing location / settings move into it." }] };
    case "apache":
      return { host: "Apache", docs: docs("apache-config"), options: [{ option: "Configuration", package: "https://trooth.co/downloads/semanto/trooth-semanto-apache-config.zip", replace: { "example-inc": troothId } }] };
    case "fastly":
      return { host: "Fastly", docs: docs("fastly-compute"), options: [{ option: "Compute service", package: "https://trooth.co/downloads/semanto/trooth-semanto-fastly-compute.zip", env: { TROOTH_ID: troothId }, note: "The origin backend is the origin server's hostname, never the public domain, which points at Fastly." }] };
    case "akamai":
      return { host: "Akamai", docs: docs("akamai-edgeworkers"), options: [{ option: "EdgeWorker", package: "https://trooth.co/downloads/semanto/trooth-semanto-akamai-edgeworkers.zip", property_variable: { PMUSER_TROOTH_ID: troothId }, note: "Create the EdgeWorker ID first in Akamai Control Center; upload, activate and the property's EdgeWorkers behavior all use it." }] };
    case "gcore":
      return { host: "Gcore", docs: docs("head-tag"), options: [{ option: "Head code on every page", note: "Gcore runs JavaScript only as a standalone app, not in front of a site, so on Gcore Semanto is the head code.", ...head }] };
    case "shopify":
      return { host: "Shopify", docs: docs("shopify-app"), options: [{ option: "Theme head code", where: "Online Store, Themes, Edit code, theme.liquid, just above the closing head tag", ...head }] };
    case "webflow":
      return { host: "Webflow", docs: docs("webflow-head-code"), options: [{ option: "Head code", where: "Site settings, Custom code, Head code; then Publish", ...head }] };
    case "squarespace":
      return { host: "Squarespace", docs: docs("squarespace-code-injection"), options: [{ option: "Code injection", where: "Pages, Website Tools, Code Injection, Header", ...head }] };
    case "wix":
      return { host: "Wix", docs: docs("wix-custom-code"), options: [{ option: "Custom code", where: "Settings, Custom Code, Add Custom Code; All pages, Head", ...head }] };
    default:
      return { host: "Any other host", docs: docs("head-tag"), options: [{ option: "Head code on every page", ...head }] };
  }
}

/**
 * The Origin check the Streamable HTTP transport asks of every server (MCP 2025-11-25, basic/transports, security
 * warning: validate Origin, answer 403 when it is not allowed). No Origin is a desktop or server client; trooth.co is
 * the dashboard; localhost is a developer's own tool, such as the MCP Inspector; an app scheme (vscode-file:, app:) is
 * a desktop client. Any other web origin is refused, so a page a person visits cannot drive their agent key.
 */
export function originAllowed(origin: string | null): boolean {
  if (!origin || origin === "null") return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") return true;
  return u.protocol === "https:" && (u.hostname === "trooth.co" || u.hostname.endsWith(".trooth.co"));
}

export async function handleMcp(req: Request, deps: McpDeps): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Mcp-Protocol-Version, WWW-Authenticate" };
  if (!originAllowed(req.headers.get("origin"))) return new Response(JSON.stringify(rpcError(null, -32000, "This Origin may not call the Semanto MCP server.")), { status: 403, headers });
  const headerVersion = req.headers.get("mcp-protocol-version");
  if (headerVersion && !SUPPORTED.includes(headerVersion)) return new Response(JSON.stringify(rpcError(null, -32600, `MCP-Protocol-Version ${headerVersion} is not supported. Supported: ${SUPPORTED.join(", ")}.`)), { status: 400, headers });
  if (headerVersion) headers["Mcp-Protocol-Version"] = headerVersion;
  // No credential at all: the challenge that starts sign-in, as Stripe's, Supabase's and GitHub's servers answer.
  const authz = req.headers.get("authorization") ?? "";
  if (deps.oauth && !/^Bearer\s+\S+$/i.test(authz) && req.method === "POST") {
    return new Response(JSON.stringify(rpcError(null, -32001, "Sign in to Trooth to use the Semanto MCP server, or send an agent key as Authorization: Bearer.")), { status: 401, headers: { ...headers, "WWW-Authenticate": wwwAuthenticate() } });
  }
  if (req.method === "GET" || req.method === "DELETE") return new Response(JSON.stringify(rpcError(null, -32000, "This server answers POST only: one JSON-RPC message, one JSON answer.")), { status: 405, headers: { ...headers, Allow: "POST" } });
  let msg: Json;
  try {
    msg = (await req.json()) as Json;
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "The body is not JSON.")), { status: 400, headers });
  }
  if (Array.isArray(msg) || !msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return new Response(JSON.stringify(rpcError((msg as Json | null)?.id, -32600, "One JSON-RPC 2.0 message per request.")), { status: 400, headers });
  const id = msg.id;
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Json;
  // A notification gets 202 with no body.
  if (id === undefined) return new Response(null, { status: 202, headers });

  // Scope the session from the server address, as Supabase (read_only, features) and GitHub (toolsets, read-only)
  // let a person do: ?read_only=true offers only the tools that change nothing; ?groups=setup,keys offers those
  // groups (Start here is always offered). The server enforces it: a tool left out is refused, not just hidden.
  const q = new URL(req.url).searchParams;
  const readOnly = q.get("read_only") === "true";
  const groups = (q.get("groups") ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  const offered = (t: SemantoTool) => (!readOnly || t.hints.readOnlyHint) && (groups.length === 0 || t.category === "Start here" || groups.includes(groupSlug(t.category)));
  const secret = bearerAgentKey(req);
  let agent: WorkspaceAuth | null = secret && deps.agentKeys ? await authorizeAgentKey(deps.agentKeys, secret, deps.now()) : null;
  // A signed-in person's AI tool: the token is checked first, then the workspace trooth.co linked to that person.
  let viaSignIn: { grant: string } | null = null;
  let signInProblem: { status: string; detail: string; url: string } | null = null;
  const token = /^Bearer\s+(\S+)$/i.exec(authz)?.[1] ?? "";
  if (!secret && deps.oauth && looksLikeJwt(token)) {
    const v = await deps.oauth.verifier.verify(token);
    if (!v.ok) return new Response(JSON.stringify(rpcError(msg.id ?? null, -32001, v.description)), { status: v.status, headers: { ...headers, ...(v.status === 401 ? { "WWW-Authenticate": wwwAuthenticate("invalid_token", v.description) } : { "Retry-After": "30" }) } });
    const link = await deps.oauth.links.find(v.principal.issuer, v.principal.subject);
    const troothId = link ? await deps.oauth.troothIdFor(link.os_company_id) : null;
    if (!link) signInProblem = { status: "not_linked", detail: "This sign-in is not linked to a Trooth workspace yet. Sign in to trooth.co once with the same account, then try again.", url: "https://trooth.co/login" };
    else if (!semantoRole(link.role)) signInProblem = { status: "not_linked", detail: "This sign-in is no longer a member of a Trooth workspace. Ask the workspace owner to add you again on trooth.co.", url: "https://trooth.co/dashboard/team" };
    else if (!troothId) signInProblem = { status: "semanto_not_set_up", detail: "Your Trooth workspace has no Semanto record yet. Start Semanto on trooth.co, then try again.", url: "https://trooth.co/dashboard/semanto" };
    else {
      // The AI tool acts as the person but is still an agent: "agent:" keeps it from what only a person may do.
      agent = { trooth_id: troothId, role: semantoRole(link.role)!, user_id: `agent:oauth:${link.user_id}`, name: `${link.email ?? "A Trooth member"} with an AI tool` };
      viaSignIn = { grant: deps.oauth.grant(agent) };
    }
  }
  /** The credential an internal call carries: the agent key as sent, or the one-minute grant for a signed-in AI tool. */
  const credential = (): Record<string, string> => (viaSignIn ? { "semanto-mcp-grant": viaSignIn.grant } : authz ? { authorization: authz } : {});
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });

  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return reply(rpc(id, { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }));
    }
    case "ping":
      return reply(rpc(id, {}));
    case "tools/list":
      return reply(rpc(id, { tools: SEMANTO_TOOLS.filter(offered).map(toolDescriptor) }));
    case "prompts/list":
      return reply(rpc(id, { prompts: [{ name: "set_up_semanto", title: "Set up Semanto for my company", description: "Run Semanto setup end to end, asking the person only for what needs them." }, { name: "check_semanto", title: "Check my Semanto", description: "Check the site, the signature, the keys and who read it, and say what needs attention." }] }));
    case "prompts/get": {
      const name = String(params.name ?? "");
      const text = name === "set_up_semanto" ? "Set up Semanto for my company. Call semanto_guide and semanto_status, then follow next_action step by step. Ask me only to confirm the domain on trooth.co, to approve the facts, and to sign with my passkey at the link semanto_sign gives. Put it on the site with semanto_install_guide, using the host's own tools if you have them, then run semanto_install_check and tell me each result." : name === "check_semanto" ? "Check my Semanto: run semanto_status, semanto_install_check, semanto_keys_get and semanto_receipts_list for the last 7 days, and tell me in plain words what is working and what needs attention." : null;
      if (!text) return reply(rpcError(id, -32602, `No prompt named ${name}.`));
      return reply(rpc(id, { messages: [{ role: "user", content: { type: "text", text } }] }));
    }
    case "resources/list":
      return reply(rpc(id, { resources: [] }));
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
      const tool = toolByName(name);
      if (!tool) return reply(rpcError(id, -32602, `No tool named ${name}.`));
      if (!offered(tool)) return reply(rpc(id, textResult({ status: "not_offered", detail: readOnly && !tool.hints.readOnlyHint ? "This server address is read only (read_only=true). The tool changes something, so it is not offered here." : "This tool's group is not in the server address's groups." }, true)));
      // A key that is sent but no longer works is an HTTP 401 with WWW-Authenticate (RFC 9110, MCP authorization), so the
      // client knows to ask the person for a new key rather than retry.
      if (secret && !agent && tool.access !== "public") return new Response(JSON.stringify(rpc(id, textResult({ status: "unauthorized", detail: "The agent key is unknown, revoked or expired. A person makes a new one in Semanto settings on trooth.co.", url: "https://trooth.co/dashboard/semanto/company" }, true))), { status: 401, headers: { ...headers, "WWW-Authenticate": 'Bearer realm="semanto", error="invalid_token"' } });
      // Arguments the tool does not name are refused, not passed on (MCP tools: input errors are tool errors).
      const unknown = Object.keys(args).filter((k) => k !== "trooth_id" && !(k in tool.params));
      if (unknown.length > 0) return reply(rpc(id, textResult({ status: "invalid_request", detail: `${tool.name} takes no ${unknown.join(", ")}. It takes ${Object.keys(tool.params).join(", ") || "no arguments"}.` }, true)));
      if ((tool.access === "read" || tool.access === "write") && !agent && signInProblem) return reply(rpc(id, textResult(signInProblem, true)));
      if ((tool.access === "read" || tool.access === "write") && !agent) return reply(rpc(id, textResult({ status: "agent_key_required", detail: "This tool acts in a company's workspace. Send the company's agent key as Authorization: Bearer followed by the tsk_ key on the MCP request. A person makes one in Semanto settings on trooth.co.", url: "https://trooth.co/dashboard/semanto/company" }, true)));
      if (tool.access === "write" && agent && agent.role === "viewer") return reply(rpc(id, textResult({ status: "forbidden", detail: viaSignIn ? "You can view this workspace on trooth.co but not change it. Ask an owner or admin for the editor role." : "This agent key has read scope. This tool changes something; it needs a key with write scope." }, true)));
      const troothId = String(args.trooth_id ?? agent?.trooth_id ?? "") || null;
      if (tool.name === "semanto_whoami") return reply(rpc(id, textResult({ object: "semanto.whoami", trooth_id: agent!.trooth_id, scope: agent!.role === "viewer" ? "read" : "write", acts_as: agent!.name, signed_in: viaSignIn !== null, mcp_url: MCP_URL })));
      if (tool.name === "semanto_guide") return reply(rpc(id, textResult(GUIDE)));
      if (tool.access === "person") return reply(rpc(id, textResult({ status: "human_action_required", detail: tool.description, url: tool.page, trooth_id: troothId })));
      if (tool.name === "semanto_install_guide") {
        if (!troothId) return reply(rpc(id, textResult({ status: "invalid_request", detail: "trooth_id is needed." }, true)));
        const s = await deps.call(new Request(`${ORIGIN}/os/semanto/${encodeURIComponent(troothId)}/setup`, { headers: { ...credential(), accept: "application/json" } }));
        const setup = s.ok ? ((await s.json()) as Json) : null;
        const install = (setup?.install ?? {}) as Json;
        const host = String(args.host ?? install.host ?? "head_tag");
        return reply(rpc(id, textResult({ object: "semanto.install_guide", trooth_id: troothId, domain: setup?.domain ?? null, ...installGuide(host, troothId, typeof setup?.domain === "string" ? setup.domain : null) })));
      }
      const filled = fillPath(tool.path!, args, troothId);
      if ("error" in filled) return reply(rpc(id, textResult({ status: "invalid_request", detail: filled.error }, true)));
      const url = new URL(ORIGIN + filled.path);
      // The caller's address goes along, so the public rate limit counts this caller, not every MCP call together.
      const ip = req.headers.get("cf-connecting-ip");
      const init: RequestInit = { method: tool.method, headers: { accept: tool.name === "semanto_page" ? "text/markdown" : "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}), ...(tool.access !== "public" ? credential() : {}) } };
      if (tool.method === "GET") {
        for (const [k, v] of Object.entries(filled.rest)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      } else {
        const body = tool.freeBody ? (filled.rest.body ?? {}) : filled.rest;
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
      try {
        return reply(rpc(id, await asToolResult(await deps.call(new Request(url, init)))));
      } catch {
        return reply(rpc(id, textResult({ status: "upstream_unavailable", detail: "The call did not complete. Try again." }, true)));
      }
    }
    default:
      return reply(rpcError(id, -32601, `Method ${msg.method} is not offered.`));
  }
}
