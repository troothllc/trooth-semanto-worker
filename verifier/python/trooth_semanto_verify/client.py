# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""SemantoClient: read a company's signed copy and check it in one call.

It fetches the page as markdown, the company's key set on its domain and
Trooth's, checks the response signature with verify_response, and checks the
signing key against the domain's _trooth-keys TXT record over DNS over HTTPS.
Key sets and DNS answers are kept in memory for cache_seconds (300 by default).
The standard library does the HTTP; pass `fetch` to use your own.

    from trooth_semanto_verify.client import SemantoClient
    r = SemantoClient().read("https://acme.com/pricing")
    if r["ok"]:
        use(r["text"])
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from .jws import parse_dns_key_records
from .verify import verify_response

TROOTH_API = "https://api.trooth.co"
DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"

# fetch(url, headers) -> (status, headers with lowercase names, body bytes)
Fetch = Callable[[str, Dict[str, str]], Tuple[int, Dict[str, str], bytes]]


def urllib_fetch(url: str, headers: Dict[str, str], timeout: float = 10.0) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(url, headers={**headers, "User-Agent": "trooth-semanto-verify-python"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (https URLs chosen by the caller)
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


class SemantoClient:
    def __init__(self, fetch: Optional[Fetch] = None, api_base: str = TROOTH_API, doh: Optional[str] = DOH_ENDPOINT, cache_seconds: int = 300, now: Optional[Callable[[], float]] = None):
        self.fetch: Fetch = fetch or urllib_fetch
        self.api_base = api_base.rstrip("/")
        self.doh = doh
        self.cache_seconds = cache_seconds
        self.now = now or time.time
        self._cache: Dict[str, Tuple[float, Any]] = {}

    def _cached(self, key: str, load: Callable[[], Any]) -> Any:
        hit = self._cache.get(key)
        if hit and self.now() - hit[0] < self.cache_seconds:
            return hit[1]
        value = load()
        self._cache[key] = (self.now(), value)
        return value

    def _json(self, url: str) -> Any:
        status, _, body = self.fetch(url, {"Accept": "application/json"})
        if status != 200:
            raise ValueError(f"{url} answered {status}")
        return json.loads(body)

    def keys_for(self, domain: str) -> Dict[str, Any]:
        def load() -> Dict[str, Any]:
            keys: Dict[str, Any] = {"company": {"keys": []}, "trooth": {"keys": []}}
            notes: List[str] = []
            for role, url in (("company", f"https://{domain}/.well-known/trooth-keys.json"), ("trooth", f"{self.api_base}/public/semanto/.well-known/trooth-keys.json")):
                try:
                    keys[role] = self._json(url)
                except Exception as e:  # noqa: BLE001 (any failure is a note, never a crash)
                    notes.append(f"{url} could not be read ({e})")
            return {"keys": keys, "notes": notes}

        return self._cached(f"keys:{domain}", load)

    def dns_kids(self, domain: str) -> Optional[List[str]]:
        if not self.doh:
            return None

        def load() -> Optional[List[str]]:
            try:
                q = urllib.parse.urlencode({"name": f"_trooth-keys.{domain}", "type": "TXT"})
                status, _, body = self.fetch(f"{self.doh}?{q}", {"Accept": "application/dns-json"})
                if status != 200:
                    return None
                answers = json.loads(body).get("Answer") or []
                txt = [str(a.get("data", "")).strip('"').replace('" "', "") for a in answers if a.get("type") == 16]
                return parse_dns_key_records(txt)
            except Exception:  # noqa: BLE001
                return None

        return self._cached(f"dns:{domain}", load)

    def read(self, url: str, accept: str = "text/markdown") -> Dict[str, Any]:
        """Read one URL and check it. ok is True only when the signature checks against a published key."""
        domain = urllib.parse.urlsplit(url).hostname or ""
        status, headers, body = self.fetch(url, {"Accept": accept})
        loaded = self.keys_for(domain)
        res = verify_response(status, headers, body, loaded["keys"], now=int(self.now()))
        dns: Optional[bool] = None
        if res.get("keyid") and (headers.get("trooth-signed-by") or "").lower() != "witness":
            kids = self.dns_kids(domain)
            dns = None if kids is None else res["keyid"] in kids
        return {
            "ok": res["ok"],
            "reason": None if res["ok"] else res.get("reason"),
            "status": status,
            "text": body.decode("utf-8", "replace"),
            "version": headers.get("trooth-semanto-version"),
            "signed_by": headers.get("trooth-signed-by"),
            "keyid": res.get("keyid"),
            "dns": dns,
            "checks": res.get("checks", []),
            "notes": loaded["notes"],
        }

    def facts(self, trooth_id: str) -> Dict[str, Any]:
        r = self.read(f"{self.api_base}/public/semanto/{urllib.parse.quote(trooth_id)}/facts.jsonld", accept="application/ld+json")
        try:
            r["data"] = json.loads(r["text"])
        except ValueError:
            r["data"] = None
        return r
