# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
import json

from openai_agents_semanto import read_as_json, semanto_read_tool


class FakeClient:
    def read(self, url, accept="text/markdown"):
        return {"ok": True, "reason": None, "text": "x" * 30, "version": "smv_x", "signed_by": None, "keyid": "k1", "dns": True}


def test_tool_answers_json_with_the_check_and_cut_text():
    out = json.loads(read_as_json(FakeClient(), "https://acme.com/pricing", max_chars=10))
    assert out == {"url": "https://acme.com/pricing", "ok": True, "reason": None, "version": "smv_x", "signed_by": "company", "dns": True, "text": "x" * 10, "cut": True}
    tool = semanto_read_tool(FakeClient())
    assert tool.name == "semanto_read"
    assert "url" in json.dumps(tool.params_json_schema)
