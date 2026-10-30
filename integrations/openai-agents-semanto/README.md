# openai-agents-semanto

```python
from agents import Agent
from openai_agents_semanto import semanto_read_tool

agent = Agent(name="Buyer research", tools=[semanto_read_tool()])
```

The tool `semanto_read` takes a URL on a company's domain and answers JSON: `ok` (the signature checked against the company's published key), `reason` when it did not, the `version`, `dns` (the domain's DNS names the key), and the page `text`, cut at `max_chars` (20,000 by default).
