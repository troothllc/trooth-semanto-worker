# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# HTTP Message Signatures, RFC 9421, with Content-Digest, RFC 9530. Verifies a
# Semanto response (tag trooth-semanto) and a Web Bot Auth request (tag
# web-bot-auth, draft-ietf-webbotauth-httpsig-protocol). Ed25519 only.

from __future__ import annotations

import base64
import hashlib
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional
from urllib.parse import urlsplit

from .jws import ed25519_verify, key_valid_at

SEMANTO_RESPONSE_COMPONENTS = ["@status", "content-type", "content-digest", "trooth-semanto-version", "trooth-page-hash"]
SEMANTO_RESPONSE_TAG = "trooth-semanto"
WEB_BOT_AUTH_TAG = "web-bot-auth"
WEB_BOT_AUTH_REQUIRED = ["@authority", "signature-agent"]

_INPUT_RE = re.compile(r'([A-Za-z0-9_*.-]+)=\(((?:\s*"(?:[^"\\]|\\.)*")*)\s*\)((?:;[A-Za-z*][A-Za-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))?)*)')
_COMP_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')
_PARAM_RE = re.compile(r';([A-Za-z*][A-Za-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|[^;,\s]+))?')
_SIG_RE = re.compile(r"([A-Za-z0-9_*.-]+)=:([A-Za-z0-9+/=]+):")


def header_get(headers: Dict[str, Any], name: str) -> Optional[str]:
    n = name.lower()
    for k, v in headers.items():
        if k.lower() == n:
            if v is None:
                return None
            if isinstance(v, (list, tuple)):
                return ", ".join(str(x).strip() for x in v)
            return str(v)
    return None


def _canon_field(v: str) -> str:
    return re.sub(r"[\r\n]+[ \t]+", " ", v).strip()


def _sf_string(s: str) -> str:
    if re.search(r"[^\x20-\x7e]", s):
        raise ValueError("non-ASCII in structured field string")
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _derived(name: str, m: dict) -> str:
    u = urlsplit(m["url"]) if m.get("url") else None
    if name == "@method":
        if m.get("kind") != "request" or not m.get("method"):
            raise ValueError("@method needs a request")
        return m["method"].upper()
    if name == "@target-uri":
        if not u:
            raise ValueError("@target-uri needs a url")
        return m["url"]
    if name == "@authority":
        if not u:
            raise ValueError("@authority needs a url")
        return u.netloc.lower()
    if name == "@scheme":
        if not u:
            raise ValueError("@scheme needs a url")
        return u.scheme.lower()
    if name == "@path":
        if not u:
            raise ValueError("@path needs a url")
        return u.path or "/"
    if name == "@query":
        if not u:
            raise ValueError("@query needs a url")
        return "?" + u.query if u.query else "?"
    if name == "@status":
        if m.get("kind") != "response" or m.get("status") is None:
            raise ValueError("@status needs a response")
        return str(m["status"])
    raise ValueError(f"unsupported derived component {name}")


def parse_signature_input(value: str) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for m in _INPUT_RE.finditer(value):
        label, comps_raw, params_raw = m.group(1), m.group(2), m.group(3)
        components = [re.sub(r"\\(.)", r"\1", c) for c in _COMP_RE.findall(comps_raw)]
        params: Dict[str, Any] = {}
        for pm in _PARAM_RE.finditer(params_raw):
            k, v = pm.group(1), pm.group(2)
            if v is None:
                v = ""
            elif v.startswith('"'):
                v = re.sub(r"\\(.)", r"\1", v[1:-1])
            if k in ("created", "expires"):
                try:
                    params[k] = int(v)
                except ValueError:
                    params[k] = None
            elif k in ("keyid", "alg", "nonce", "tag"):
                params[k] = v
        if not isinstance(params.get("created"), int) or not isinstance(params.get("keyid"), str):
            continue
        out[label] = {"components": components, "params": params, "raw": f"({comps_raw.strip()}){params_raw}"}
    return out


def parse_signature(value: str) -> Dict[str, bytes]:
    return {m.group(1): base64.b64decode(m.group(2)) for m in _SIG_RE.finditer(value)}


def signature_base(m: dict, components: List[str], raw_params: str) -> str:
    lines = []
    seen = set()
    for c in components:
        key = c.lower()
        if key in seen:
            raise ValueError(f"duplicate component {c}")
        seen.add(key)
        if c.startswith("@"):
            value = _derived(c, m)
        else:
            v = header_get(m["headers"], c)
            if v is None:
                raise ValueError(f"missing header {c}")
            value = _canon_field(v)
        lines.append(f"{_sf_string(key)}: {value}")
    lines.append(f'"@signature-params": {raw_params}')
    return "\n".join(lines)


def verify_content_digest(header: Optional[str], body: bytes) -> bool:
    if not header:
        return False
    m = re.search(r"sha-256=:([A-Za-z0-9+/=]+):", header)
    if not m:
        return False
    return m.group(1) == base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")


def verify_message(
    m: dict,
    resolve_key: Callable[[str], Optional[dict]],
    required: Optional[Iterable[str]] = None,
    tag: Optional[str] = None,
    now: Optional[int] = None,
    max_age_seconds: Optional[int] = None,
    skew_seconds: int = 60,
) -> dict:
    """m = {"kind": "request"|"response", "method", "url", "status", "headers"}."""
    si = header_get(m["headers"], "signature-input")
    sg = header_get(m["headers"], "signature")
    if not si or not sg:
        return {"ok": False, "reason": "no_signature"}
    inputs = parse_signature_input(si)
    sigs = parse_signature(sg)
    labels = [l for l in inputs if l in sigs]
    if not labels:
        return {"ok": False, "reason": "malformed"}
    now = int(time.time()) if now is None else now
    last = {"ok": False, "reason": "malformed"}
    req = [r.lower() for r in (required or [])]
    for label in labels:
        components, params, raw = inputs[label]["components"], inputs[label]["params"], inputs[label]["raw"]
        if params.get("alg") and params["alg"] != "ed25519":
            last = {"ok": False, "reason": "unsupported_alg"}
            continue
        if tag and params.get("tag") != tag:
            last = {"ok": False, "reason": "wrong_tag"}
            continue
        lower = [c.lower() for c in components]
        if any(r not in lower for r in req):
            last = {"ok": False, "reason": "missing_component"}
            continue
        if params.get("expires") is not None and now >= params["expires"]:
            last = {"ok": False, "reason": "expired"}
            continue
        if params["created"] > now + skew_seconds:
            last = {"ok": False, "reason": "not_yet_valid"}
            continue
        if max_age_seconds is not None and now - params["created"] > max_age_seconds:
            last = {"ok": False, "reason": "too_old"}
            continue
        jwk = resolve_key(params["keyid"])
        if jwk is None:
            last = {"ok": False, "reason": "unknown_key"}
            continue
        kv = key_valid_at(jwk, datetime.fromtimestamp(now, tz=timezone.utc))
        if kv:
            last = {"ok": False, "reason": kv}
            continue
        try:
            base = signature_base(m, components, raw)
        except ValueError:
            last = {"ok": False, "reason": "missing_component"}
            continue
        if not ed25519_verify(jwk, sigs[label], base.encode("utf-8")):
            last = {"ok": False, "reason": "bad_signature"}
            continue
        return {"ok": True, "label": label, "keyid": params["keyid"], "params": params, "components": components}
    return last
