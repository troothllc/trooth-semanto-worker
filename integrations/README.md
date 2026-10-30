<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# Semanto integrations

Small packages that let an agent framework read a company's signed copy and know whether it checked out. Each one wraps `SemantoClient` from `verifier/` (JavaScript, Python) and adds nothing else.

| Package | Framework | What it adds |
| --- | --- | --- |
| `langchain-semanto` | LangChain | `SemantoLoader`, a document loader; each Document carries `semanto_ok`, the version, the signer, the key and the DNS result in its metadata |
| `llama-index-readers-semanto` | LlamaIndex | `SemantoReader`, the same as a reader |
| `openai-agents-semanto` | OpenAI Agents SDK | `semanto_read_tool()`, a function tool that reads a URL and says whether the copy checked out |
| `semanto-mcp` | Model Context Protocol | an MCP server with `semanto_read` and `semanto_facts` |

None is published yet. Each runs its own tests with `python3 -m pytest` (or `node --test` for `semanto-mcp`) with `verifier/python` (or `verifier/js`) beside it.
