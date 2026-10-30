# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
from langchain_semanto import SemantoLoader


class FakeClient:
    def read(self, url, accept="text/markdown"):
        ok = url.endswith("/pricing")
        return {"ok": ok, "reason": None if ok else "content_digest_mismatch", "text": "# Pricing", "version": "smv_x", "signed_by": None, "keyid": "k1" if ok else None, "dns": True if ok else None}


def test_loads_documents_with_semanto_metadata_and_skips_unsigned_when_asked():
    docs = SemantoLoader(["https://acme.com/pricing", "https://acme.com/bad"], client=FakeClient()).load()
    assert [d.metadata["semanto_ok"] for d in docs] == [True, False]
    assert docs[0].page_content == "# Pricing"
    assert docs[0].metadata["semanto_keyid"] == "k1"
    loader = SemantoLoader(["https://acme.com/pricing", "https://acme.com/bad"], client=FakeClient(), only_signed=True)
    assert len(loader.load()) == 1
    assert loader.skipped == [{"url": "https://acme.com/bad", "reason": "content_digest_mismatch"}]
