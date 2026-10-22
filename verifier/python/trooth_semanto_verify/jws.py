# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Ed25519 keys as JWKs (RFC 8037, RFC 7638 thumbprints as key ids) and JWS
# compact serialization (RFC 7515) over RFC 8785 canonical payloads, as the
# Semanto file, the witness statement, tree heads, offers and revocation lists
# use. Ed25519 itself comes from the `cryptography` package.

from __future__ import annotations

import base64
import json
import hashlib
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .canonical import canonical_bytes

JWS_TYPES = {
    "semantoVersion": "https://trooth.co/types/semanto-version",
    "witness": "https://trooth.co/types/witness-statement",
    "receipt": "https://trooth.co/types/coverage-receipt",
    "treeHead": "https://trooth.co/types/signed-tree-head",
    "offer": "https://trooth.co/types/signed-offer",
    "productRecord": "https://trooth.co/types/product-record",
    "sellerAttestation": "https://trooth.co/types/seller-attestation",
    "recall": "https://trooth.co/types/recall-notice",
    "firstPublication": "https://trooth.co/types/first-publication",
    "readReceipt": "https://trooth.co/types/read-receipt",
    "revocation": "https://trooth.co/types/revocation-list",
    "contentSignals": "https://trooth.co/types/content-signals",
}


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def parse_time(value: str) -> datetime:
    """ISO 8601 UTC, with or without fractional seconds, Z or +00:00."""
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def thumbprint(jwk: dict) -> str:
    """RFC 7638: SHA-256 of the canonical required members."""
    required = {"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"]}
    return b64url_encode(hashlib.sha256(canonical_bytes(required)).digest())


def ed25519_verify(jwk: dict, signature: bytes, data: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(b64url_decode(jwk["x"])).verify(signature, data)
        return True
    except (InvalidSignature, ValueError, KeyError):
        return False


def key_valid_at(jwk: dict, at: datetime) -> Optional[str]:
    """None when the key may be used at `at`, else a reason code."""
    if jwk.get("nbf") and at < parse_time(jwk["nbf"]):
        return "key_not_yet_valid"
    if jwk.get("exp") and at >= parse_time(jwk["exp"]):
        return "key_expired"
    if jwk.get("revoked_at") and at >= parse_time(jwk["revoked_at"]):
        return "key_revoked"
    return None


def _collect(keys: Any, out: list) -> None:
    if keys is None:
        return
    if isinstance(keys, list):
        for k in keys:
            _collect(k, out)
        return
    if isinstance(keys, dict):
        if isinstance(keys.get("keys"), list):
            out.extend(j for j in keys["keys"] if isinstance(j, dict))
            return
        if "jwks" in keys:
            _collect(keys["jwks"], out)
            return
        if keys.get("kty") == "OKP":
            out.append(keys)
            return
        for v in keys.values():
            _collect(v, out)


def key_resolver(keys: Any) -> Callable[[str], Optional[dict]]:
    """Accepts a JWKS, a list of JWKS, a map of names to JWKS, or the keys.json vector shape."""
    all_keys: list = []
    _collect(keys, all_keys)

    def resolve(kid: str) -> Optional[dict]:
        for j in all_keys:
            if j.get("kid") == kid and j.get("kty") == "OKP" and j.get("crv") == "Ed25519":
                return j
        return None

    return resolve


def parse_dns_key_records(txt: Iterable[str]) -> list:
    import re

    out = []
    for t in txt:
        m = re.match(r'^v=trooth1;\s*kid=([A-Za-z0-9_-]{43})$', str(t).strip().strip('"'))
        if m:
            out.append(m.group(1))
    return out


def verify_jws(jws: str, resolve_key: Callable[[str], Optional[dict]], expect_typ: Optional[str] = None, payload: Any = None, at: Optional[datetime] = None) -> dict:
    """Verify a compact (h.p.s) or detached (h..s) JWS. Returns {"ok": bool, ...}."""
    if not isinstance(jws, str):
        return {"ok": False, "reason": "malformed"}
    parts = jws.split(".")
    if len(parts) != 3:
        return {"ok": False, "reason": "malformed"}
    h, p_given, s = parts
    try:
        header = json.loads(b64url_decode(h))
    except Exception:
        return {"ok": False, "reason": "malformed"}
    if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
        return {"ok": False, "reason": "malformed"}
    if expect_typ and header.get("typ") != expect_typ:
        return {"ok": False, "reason": "wrong_type"}
    if p_given != "":
        p = p_given
    elif payload is not None:
        p = b64url_encode(canonical_bytes(payload))
    else:
        return {"ok": False, "reason": "malformed"}
    jwk = resolve_key(header["kid"])
    if jwk is None:
        return {"ok": False, "reason": "unknown_key"}
    at = at or datetime.now(timezone.utc)
    kv = key_valid_at(jwk, at)
    if kv:
        return {"ok": False, "reason": kv}
    try:
        sig = b64url_decode(s)
    except Exception:
        return {"ok": False, "reason": "malformed"}
    if not ed25519_verify(jwk, sig, f"{h}.{p}".encode("ascii")):
        return {"ok": False, "reason": "bad_signature"}
    if header.get("nbf") and at < parse_time(header["nbf"]):
        return {"ok": False, "reason": "not_yet_valid"}
    if header.get("exp") and at >= parse_time(header["exp"]):
        return {"ok": False, "reason": "expired"}
    try:
        body = json.loads(b64url_decode(p))
    except Exception:
        return {"ok": False, "reason": "malformed"}
    return {"ok": True, "header": header, "payload": body}
