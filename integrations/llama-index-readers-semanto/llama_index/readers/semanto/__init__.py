# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""LlamaIndex reader for Semanto signed copies."""
from __future__ import annotations

from typing import Any, List, Optional

from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document
from trooth_semanto_verify.client import SemantoClient


class SemantoReader(BaseReader):
    """Read pages as markdown from a company's domain, each checked against its signature."""

    def __init__(self, client: Optional[Any] = None, only_signed: bool = False):
        self.client = client or SemantoClient()
        self.only_signed = only_signed
        self.skipped: List[dict] = []

    def load_data(self, urls: List[str]) -> List[Document]:  # type: ignore[override]
        out: List[Document] = []
        for url in urls:
            r = self.client.read(url)
            if self.only_signed and not r["ok"]:
                self.skipped.append({"url": url, "reason": r.get("reason")})
                continue
            out.append(
                Document(
                    text=r["text"],
                    metadata={
                        "source": url,
                        "semanto_ok": bool(r["ok"]),
                        "semanto_reason": r.get("reason"),
                        "semanto_version": r.get("version"),
                        "semanto_signed_by": r.get("signed_by"),
                        "semanto_keyid": r.get("keyid"),
                        "semanto_dns": r.get("dns"),
                    },
                )
            )
        return out


__all__ = ["SemantoReader"]
