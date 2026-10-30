<!-- SPDX-License-Identifier: LicenseRef-Trooth-Proprietary -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# The Semanto MCP server

`https://api.trooth.co/os/semanto/mcp`, Model Context Protocol over Streamable HTTP: one JSON-RPC message per POST, one JSON answer, no session and no server-sent stream (GET answers 405). Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26; the asked version when supported, else 2025-11-25. 2026-07-28 replaces initialize with server/discover and changes every result's shape, so it is offered once that is built. An `Origin` header from a web page other than trooth.co or localhost is refused with 403, as the transport asks of every server; no Origin (a desktop or server client) and app schemes are allowed. An `MCP-Protocol-Version` header the server does not support is a 400.

## Auth

The company's agent key, `Authorization: Bearer` followed by the `tsk_` secret, on the MCP request. A person makes it in Semanto settings on trooth.co (`POST /os/semanto/{id}/agent-keys` with `{ name, scope: "read" | "write", expires_in_days? }`; the secret is in that answer only), lists them (`GET /os/semanto/{id}/agent-keys`) and revokes them (`POST /os/semanto/{id}/agent-keys/{kid}/revoke`). Only the SHA-256 is stored (`semanto_agent_keys`, migration 0013). A read key acts as a viewer, a write key as an admin. An agent key can never make, list or revoke agent keys. Whatever its scope, an agent key is refused (403) on what only a person may do: signing and its passkeys, the signing keys (rotate, start or confirm a rotation, revoke), the signing policy, publishing a seller list or a recall, connecting Google, approving or denying an app, and erasing (src/serve/routes.ts `PEOPLE_ONLY_ROUTES`); the matching tools are person tools that answer the page. A key that is sent but no longer works answers HTTP 401 with `WWW-Authenticate: Bearer realm="semanto", error="invalid_token"`. Without a key the public tools still answer. Every workspace write, through MCP or the dashboard, is counted in the `os_write` rate limit and leaves an audit row naming who made it; an agent key shows as itself.

Arguments a tool does not name are refused as a tool error, and a `path` or id with a `.` or `..` segment is refused.

## Scoping

The server address narrows a session, as Supabase's `read_only` and `features` and GitHub's toolsets do, and the server enforces it: `?read_only=true` offers only the read-only tools, and `?groups=setup,keys` offers those groups plus Start here (group names are the categories in lowercase with hyphens: `setup`, `build-and-publish`, `put-it-on-the-site`, `delivery-settings`, `keys`, `readers`, `connectors`, `google`, `listings`, `commerce`, `reports`, `company`, `read-and-check`). A tool left out answers `not_offered`.

## Tools

`src/mcp/catalog.ts` is the list: every tool has a title and all four hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) set explicitly, `_meta["co.trooth/category"]` and `_meta["co.trooth/access"]` (public, read, write, person). Each tool is one request to a route of this Worker, so roles, rate limits, the audit trail (`agent:<kid>` as who) and the signed answers are those of the dashboard. A person tool (signing, confirming a key rotation, connecting Google, two-officer signing, erasing, agent keys) changes nothing: it answers `{ status: "human_action_required", url }`, the page where the person finishes it.

`semanto_install_guide` answers the install for the company's host with every value filled in. For Cloudflare it carries the Worker as one ES module (`src/mcp/cloudflare-worker.generated.ts`, built from `deploy/cloudflare` by `scripts/build-deploy.mjs`, esbuild pinned), its SHA-256, and the two Cloudflare API calls an agent makes with Cloudflare's own tools: upload the script with its bindings, then add the route. No GitHub is involved.

## Prompts

`set_up_semanto` and `check_semanto`.

## Logo and listing

The icons follow GitHub's MCP server exactly (github/github-mcp-server, `script/fetch-icons` and `pkg/octicons`). `serverInfo.icons` is the brand mark, as GitHub's is the Invertocat: the Trooth disc with the figure cut out, one color, drawn 22 pixels wide in a 24 by 24 PNG with a clear background, once in Trooth's ink for a light theme and once in white for a dark theme, sent as data URIs with no `sizes` field. Every tool carries its group's icon the same way, as GitHub's tools carry their toolset's Octicon; the group icons come from Lucide, the set trooth.co uses. `scripts/build-icons.mjs` makes them into `src/mcp/icons.generated.ts`. AI tools that show server icons (VS Code today) show them beside the server and each tool. `server.json` at the root of this repository is the entry for the MCP Registry (schema 2025-12-11) under `co.trooth/semanto` with the agent key header and, like GitHub's, no icons; publishing it asks for proof of trooth.co, which the domain's owner gives.
