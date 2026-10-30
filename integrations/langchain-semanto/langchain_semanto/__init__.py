# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
"""LangChain document loader for Semanto signed copies."""
from __future__ import annotations

from typing import Iterator, List, Optional, Sequence

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document
from trooth_semanto_verify.client import SemantoClient


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


class SemantoLoader(BaseLoader):
    """Load pages as markdown from a company's domain, each checked against its signature."""

    def __init__(self, urls: Sequence[str], client: Optional[SemantoClient] = None, only_signed: bool = False):
        self.urls = list(urls)
        self.client = client or SemantoClient()
        self.only_signed = only_signed
        self.skipped: List[dict] = []

    def lazy_load(self) -> Iterator[Document]:
        for url in self.urls:
            r = self.client.read(url)
            if self.only_signed and not r["ok"]:
                self.skipped.append({"url": url, "reason": r.get("reason")})
                continue
            yield Document(page_content=r["text"], metadata=metadata_of(url, r))


__all__ = ["SemantoLoader", "metadata_of"]
