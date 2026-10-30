# llama-index-readers-semanto

```python
from llama_index.readers.semanto import SemantoReader
docs = SemantoReader(only_signed=True).load_data(["https://acme.com/pricing"])
docs[0].metadata["semanto_ok"]
```

Each Document's metadata carries `source`, `semanto_ok`, `semanto_reason`, `semanto_version`, `semanto_signed_by`, `semanto_keyid` and `semanto_dns`.
