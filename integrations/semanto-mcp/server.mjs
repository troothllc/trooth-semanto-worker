#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Trooth, LLC
//
// semanto-mcp: a stdio MCP server with semanto_read and semanto_facts.
//
//   { "mcpServers": { "semanto": { "command": "npx", "args": ["-y", "semanto-mcp"] } } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SemantoClient } from "@trooth/semanto-verify/client";
import { TOOLS, semantoFacts, semantoRead } from "./tools.mjs";

const client = new SemantoClient();
const server = new McpServer({ name: "semanto", version: "0.1.0" });
const readOnly = { readOnlyHint: true, openWorldHint: true };

server.registerTool("semanto_read", { ...TOOLS.semanto_read, inputSchema: { url: z.string().url() }, annotations: readOnly }, (args) => semantoRead(client, args));
server.registerTool("semanto_facts", { ...TOOLS.semanto_facts, inputSchema: { trooth_id: z.string() }, annotations: readOnly }, (args) => semantoFacts(client, args));

await server.connect(new StdioServerTransport());
