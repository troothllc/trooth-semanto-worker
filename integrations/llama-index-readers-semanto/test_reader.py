# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
from llama_index.readers.semanto import SemantoReader


class FakeClient:
    def read(self, url, accept="text/markdown"):
        ok = url.endswith("/pricing")
        return {"ok": ok, "reason": None if ok else "no_signature", "text": "# Pricing", "version": "smv_x", "signed_by": None, "keyid": "k1" if ok else None, "dns": None}


def test_reads_documents_with_semanto_metadata():
    r = SemantoReader(client=FakeClient(), only_signed=True)
    docs = r.load_data(["https://acme.com/pricing", "https://acme.com/other"])
    assert len(docs) == 1
    assert docs[0].text == "# Pricing"
    assert docs[0].metadata["semanto_ok"] is True
    assert r.skipped == [{"url": "https://acme.com/other", "reason": "no_signature"}]
