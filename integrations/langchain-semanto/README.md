# langchain-semanto

```python
from langchain_semanto import SemantoLoader
docs = SemantoLoader(["https://acme.com/pricing"], only_signed=True).load()
docs[0].metadata["semanto_ok"]  # True: the signature checked against the company's published key
```

With `only_signed=True`, a page whose copy did not check out is left out (`skipped` lists it with the reason). Every Document's metadata carries `source`, `semanto_ok`, `semanto_reason`, `semanto_version`, `semanto_signed_by`, `semanto_keyid` and `semanto_dns`.
