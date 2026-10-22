# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# JSON Canonicalization Scheme, RFC 8785, written by hand so the package needs
# no dependency for it. Semanto signs integers only; a non-integer float raises
# with a clear message instead of guessing at ECMAScript number formatting.

from __future__ import annotations

from typing import Any

_ESCAPES = {
    0x22: '\\"',
    0x5C: "\\\\",
    0x08: "\\b",
    0x0C: "\\f",
    0x0A: "\\n",
    0x0D: "\\r",
    0x09: "\\t",
}

_MAX_SAFE = 2**53


class CanonicalizeError(ValueError):
    """Raised when a value cannot be canonicalized the way Semanto signs it."""


def _string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        esc = _ESCAPES.get(c)
        if esc is not None:
            out.append(esc)
        elif c < 0x20:
            out.append(f"\\u{c:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(s: str) -> bytes:
    # RFC 8785 sorts member names by UTF-16 code units; comparing UTF-16-BE
    # byte strings gives exactly that order.
    return s.encode("utf-16-be")


def canonicalize(value: Any) -> str:
    """Return the RFC 8785 canonical JSON text of `value`."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) >= _MAX_SAFE:
            raise CanonicalizeError(
                f"canonicalize: integer {value} is outside the range Semanto signs (less than 2**53 in magnitude)"
            )
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise CanonicalizeError("canonicalize: non-finite number")
        if value.is_integer() and abs(value) < _MAX_SAFE:
            return str(int(value))
        raise CanonicalizeError(
            f"canonicalize: {value!r} is not an integer. Semanto signs integers only; "
            "represent amounts in minor units (cents) and other decimals as strings."
        )
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = []
        for k in sorted(value.keys(), key=lambda k: _utf16_key(str(k))):
            if not isinstance(k, str):
                raise CanonicalizeError("canonicalize: object keys must be strings")
            items.append(_string(k) + ":" + canonicalize(value[k]))
        return "{" + ",".join(items) + "}"
    raise CanonicalizeError(f"canonicalize: cannot serialize {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return canonicalize(value).encode("utf-8")
