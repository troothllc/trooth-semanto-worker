# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""LlamaIndex reader (pip install "trooth[llama-index]")."""
from __future__ import annotations

from typing import Any, List, Optional

from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document
from trooth_semanto_verify.client import SemantoClient

from . import metadata_of


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
            out.append(Document(text=r["text"], metadata=metadata_of(url, r)))
        return out


__all__ = ["SemantoReader"]
