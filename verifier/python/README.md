# trooth-semanto-verify (Python)

Check a Semanto by Trooth file, a page proof, a signed response or the public log, offline. Standard library plus `cryptography` (for Ed25519). Python 3.11 or newer.

```
pip install cryptography
pip install .            # from this folder; gives the semanto-verify command
```

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
