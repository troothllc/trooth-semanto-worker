# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
import json

import pytest


class FakeClient:
    def read(self, url, accept="text/markdown"):
        ok = url.endswith("/pricing")
        return {"ok": ok, "reason": None if ok else "content_digest_mismatch", "text": "x" * 30 if ok else "# Other", "version": "smv_x", "signed_by": None, "keyid": "k1" if ok else None, "dns": True if ok else None}


URLS = ["https://acme.com/pricing", "https://acme.com/bad"]


def test_top_level_exports_the_client():
    import trooth

    assert trooth.SemantoClient.__name__ == "SemantoClient"


def test_langchain_loader():
    pytest.importorskip("langchain_core")
    from trooth.integrations.langchain import SemantoLoader

    docs = SemantoLoader(URLS, client=FakeClient()).load()
    assert [d.metadata["semanto_ok"] for d in docs] == [True, False]
    loader = SemantoLoader(URLS, client=FakeClient(), only_signed=True)
    assert len(loader.load()) == 1
    assert loader.skipped == [{"url": "https://acme.com/bad", "reason": "content_digest_mismatch"}]


def test_llama_index_reader():
    pytest.importorskip("llama_index.core")
    from trooth.integrations.llama_index import SemantoReader

    r = SemantoReader(client=FakeClient(), only_signed=True)
    docs = r.load_data(URLS)
    assert len(docs) == 1 and docs[0].metadata["semanto_keyid"] == "k1"


def test_openai_agents_tool():
    pytest.importorskip("agents")
    from trooth.integrations.openai_agents import read_as_json, semanto_read_tool

    out = json.loads(read_as_json(FakeClient(), URLS[0], max_chars=10))
    assert out["ok"] is True and out["signed_by"] == "company" and out["cut"] is True and len(out["text"]) == 10
    assert semanto_read_tool(FakeClient()).name == "semanto_read"
