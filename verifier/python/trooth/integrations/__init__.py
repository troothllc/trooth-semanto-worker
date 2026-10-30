# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""Framework integrations, each behind its own extra so the base install pulls in no framework."""


def metadata_of(url: str, r: dict) -> dict:
    """The Semanto fields every integration puts beside the text."""
    return {
        "source": url,
        "semanto_ok": bool(r["ok"]),
        "semanto_reason": r.get("reason"),
        "semanto_version": r.get("version"),
        "semanto_signed_by": r.get("signed_by"),
        "semanto_keyid": r.get("keyid"),
        "semanto_dns": r.get("dns"),
    }
