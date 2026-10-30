# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""A function tool for the OpenAI Agents SDK that reads a Semanto signed copy."""
from __future__ import annotations

import json
from typing import Any, Optional

from agents import FunctionTool, function_tool
from trooth_semanto_verify.client import SemantoClient


def read_as_json(client: Any, url: str, max_chars: int = 20_000) -> str:
    """The tool's answer: whether the copy checked out, and the text, as one JSON string."""
    r = client.read(url)
    text = r["text"]
    cut = len(text) > max_chars
    return json.dumps({
        "url": url,
        "ok": bool(r["ok"]),
        "reason": r.get("reason"),
        "version": r.get("version"),
        "signed_by": r.get("signed_by") or ("company" if r.get("keyid") else None),
        "dns": r.get("dns"),
        "text": text[:max_chars],
        "cut": cut,
    })


def semanto_read_tool(client: Optional[Any] = None, max_chars: int = 20_000) -> FunctionTool:
    c = client or SemantoClient()

    @function_tool(name_override="semanto_read")
    def semanto_read(url: str) -> str:
        """Read a page from a company's website as its signed Semanto copy, and say whether the signature checked out.

        Args:
            url: The page's address on the company's own domain, for example https://acme.com/pricing.
        """
        return read_as_json(c, url, max_chars)

    return semanto_read


__all__ = ["semanto_read_tool", "read_as_json"]
