# semanto-mcp

An MCP server with two read-only tools:

- `semanto_read { url }`: reads a page from a company's domain as its signed Semanto copy and says whether the signature checked against the company's published key and whether the domain's DNS names that key.
- `semanto_facts { trooth_id }`: reads the company's facts as JSON-LD from the Trooth API, checked the same way.

```json
{ "mcpServers": { "semanto": { "command": "npx", "args": ["-y", "semanto-mcp"] } } }
```

The same two tools are planned for the Trooth Network MCP server (`io.github.troothllc/trooth-network`) in its next version.
