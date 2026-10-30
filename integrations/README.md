<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# Semanto integrations

One package per registry, so there is one thing to install, update and trust.

| Registry | Package | What it holds |
| --- | --- | --- |
| PyPI | `trooth` (`verifier/python`) | `SemantoClient`, the checks, and the LangChain loader, LlamaIndex reader and OpenAI Agents tool as extras: `trooth[langchain]`, `trooth[llama-index]`, `trooth[openai-agents]` |
| npm | `semanto-mcp` (this folder) | an MCP server with `semanto_read` and `semanto_facts` |

`semanto-mcp` runs its own tests with `node --test --test-reporter=tap`; the Python package's are in `verifier/python/test_integrations.py`.
