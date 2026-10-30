<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (c) 2026 Trooth, LLC -->

# trooth (Python)

Read a company's Semanto signed copy and check it: the file, a page proof, a signed response or the public log, offline. Standard library plus `cryptography` (for Ed25519). Python 3.11 or newer.

```
pip install trooth                    # the checks, SemantoClient and the semanto-verify command
pip install "trooth[langchain]"       # plus trooth.integrations.langchain.SemantoLoader
pip install "trooth[llama-index]"     # plus trooth.integrations.llama_index.SemantoReader
pip install "trooth[openai-agents]"   # plus trooth.integrations.openai_agents.semanto_read_tool
```

Every release is built and published by GitHub Actions through PyPI Trusted Publishing, with no stored token, and carries PEP 740 attestations that tie each file to the workflow run that built it.

Without installing: `PYTHONPATH=verifier/python python3 -m trooth_semanto_verify file verifier/test-vectors/v1/semanto.json --pages verifier/test-vectors/v1/pages`

## Commands

```
semanto-verify file <semanto.json> [--pages <dir>] [--keys <keys.json>] [--now <iso>] [--revocations <file>]
semanto-verify page <url> [--trooth <base>] [--now <iso>]
semanto-verify response <url> [--keys <keys.json>]
semanto-verify log --from <n> --to <m> [--log <url>] [--keys <keys.json>]
```

`file` needs no network when `--keys` is given or a `keys.json` sits beside the file. Pages are read from `<dir>/<page id>.md`. Exit code 0 means every check passed; 1 means at least one failed.

## Library

```python
import json, trooth_semanto_verify as V

file = json.load(open("semanto.json"))
keys = [json.load(open("acme-keys.json")), json.load(open("trooth-keys.json"))]
result = V.verify_semanto(file, {"https://acme.com/security": open("security.md", "rb").read()}, keys)
for check in result["checks"]:
    print("ok  " if check["ok"] else "FAIL", check["name"], check["detail"])
```

The functions and the reason codes are the same as the JavaScript and Go kits: `verify_semanto`, `verify_page_proof`, `verify_response`, `verify_web_bot_auth_request`, `verify_tree_head`, `verify_inclusion_in_log`, `verify_consistency`, `verify_checkpoint`, `verify_offer`, `verify_revocation_list`, `state_of`, plus `canonicalize` (RFC 8785), the RFC 6962 primitives and `verify_jws`.

Canonical JSON here supports integers exactly. A non-integer float raises `CanonicalizeError` with a message saying to use minor units or a string, because Semanto never signs one.

## Tests

`python3 -m pytest` runs every shared vector in `verifier/test-vectors/v1` (positive and negative), the RFC 6962 known roots, the RFC 8785 cases, the state rules and the command line.

## SemantoClient

```python
from trooth_semanto_verify.client import SemantoClient
r = SemantoClient().read("https://acme.com/pricing")
print(r["ok"], r["dns"], r["reason"])
```

It fetches with the standard library (pass `fetch=` to use your own), checks the response signature and the domain's `_trooth-keys` TXT record over DNS over HTTPS, and keeps key sets and DNS answers five minutes.
