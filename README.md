# Semanto by Trooth

[![PyPI version](https://img.shields.io/pypi/v/trooth.svg?label=pypi)](https://pypi.org/project/trooth/)

Semanto turns a company's website into one signed copy that AI agents can read and check. Each page carries a signature from the company's own key, and every published version is entered in a public log, so anyone can confirm what a company said and when it said it.

This repository holds the Semanto Worker, the open readers for Python, JavaScript and Go, and the shared test vectors.

## Documentation

The documentation is at [trooth.co/docs/semanto](https://trooth.co/docs/semanto), with [install guides](https://trooth.co/docs/semanto#install) for Cloudflare, Vercel, Netlify, Fastly, Akamai, Gcore, nginx, Apache, WordPress, Shopify, Webflow and Squarespace.

## Installation

```sh
pip install trooth
```

## Usage

```python
from trooth import SemantoClient

r = SemantoClient().read("https://acme.com/pricing")
print(r["ok"], r["reason"])
```

`read` fetches the page as Markdown, checks its signature against the domain's published keys and its DNS record, and returns every check in plain words.

## Readers

| Reader | Path | Needs |
| --- | --- | --- |
| Python | [`verifier/python`](verifier/python) | `pip install trooth` |
| JavaScript | [`verifier/js`](verifier/js) | Node 20 or newer, no dependencies |
| Go | [`verifier/go`](verifier/go) | Go 1.22 or newer, standard library only |

All three share the same functions, reason codes and the vectors in [`verifier/test-vectors/v1`](verifier/test-vectors/v1). Framework extras: `trooth[langchain]`, `trooth[llama-index]` and `trooth[openai-agents]`.

## Releases

Python releases are built and published by GitHub Actions through PyPI Trusted Publishing, with no stored token. Each file carries a PEP 740 attestation that ties it to the workflow run that built it, and every action in the workflow is pinned by commit.

## Security

Report a vulnerability to security@trooth.co. Please do not open a public issue for it.

## License

The readers in [`verifier`](verifier) are licensed under the [Apache License 2.0](verifier/LICENSE). The Worker and everything else in this repository is proprietary to Trooth, LLC.
