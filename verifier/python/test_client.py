# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
import json
from pathlib import Path

from trooth_semanto_verify.client import SemantoClient

V = Path(__file__).resolve().parent.parent / "test-vectors" / "v1"


def test_read_checks_signature_dns_and_caches():
    v = json.loads((V / "response.json").read_text())
    k = json.loads((V / "keys.json").read_text())
    calls = []

    def fetch(url, headers):
        calls.append(url)
        if url == "https://acme.com/security":
            return v["response"]["status"], {h.lower(): x for h, x in v["response"]["headers"].items()}, v["response"]["body"].encode()
        if url == "https://acme.com/.well-known/trooth-keys.json":
            return 200, {}, json.dumps(k["company"]["jwks"]).encode()
        if url == "https://api.trooth.co/public/semanto/.well-known/trooth-keys.json":
            return 200, {}, json.dumps(k["trooth"]["jwks"]).encode()
        if url.startswith("https://cloudflare-dns.com/dns-query?name=_trooth-keys.acme.com"):
            return 200, {}, json.dumps({"Answer": [{"type": 16, "data": '"' + k["company"]["dns_txt"][0] + '"'}]}).encode()
        return 404, {}, b"no"

    c = SemantoClient(fetch=fetch, now=lambda: v["now_epoch"])
    r = c.read("https://acme.com/security")
    assert r["ok"] is True
    assert r["keyid"] == v["expect"]["keyid"]
    assert r["dns"] is True
    c.read("https://acme.com/security")
    assert len([u for u in calls if "trooth-keys.json" in u]) == 2
    assert len([u for u in calls if "dns-query" in u]) == 1
