# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Runs every shared vector in verifier/test-vectors/v1 through the Python
# verifier, positive and negative, plus the RFC 6962 known roots and the
# RFC 8785 cases the JavaScript tests use. Run: python3 -m pytest

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import pytest

import trooth_semanto_verify as V

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", "test-vectors", "v1")


def read(name: str):
    with open(os.path.join(DIR, name), "r", encoding="utf-8") as f:
        return json.load(f)


KEYS = read("keys.json")
MANIFEST = read("manifest.json")["files"]
SEMANTO = read("semanto.json")


def run(v: dict) -> dict:
    kind = v["kind"]
    # A vector may carry its own keys (a rotated or revoked key) and its own page bytes (a forged page).
    KEYS = v.get("keys") or globals()["KEYS"]
    if kind == "semanto-file":
        return V.verify_semanto(v["file"], v.get("pages_by_url") or read("pages.json")["by_url"], KEYS, now=v["now"])
    if kind == "tree-head":
        return V.verify_tree_head(v["tree_head"], KEYS, now=v["now"])
    if kind == "page-proof":
        return V.verify_page_proof(v["proof"], v["page_markdown"], KEYS, now=v["now"], header=v.get("header"))
    if kind == "response":
        r = v["response"]
        return V.verify_response(r["status"], r["headers"], r["body"], KEYS, now=v["now_epoch"])
    if kind == "web-bot-auth-request":
        r = v["request"]
        return V.verify_web_bot_auth_request(r["method"], r["url"], r["headers"], KEYS, now=v["now_epoch"])
    if kind == "offer":
        return V.verify_offer(v["jws"], KEYS, now=v["now"])
    if kind == "witness":
        return V.verify_jws(v["jws"], V.key_resolver(KEYS), expect_typ=V.JWS_TYPES["witness"], payload=v["payload"], at=datetime.fromisoformat(v["now"].replace("Z", "+00:00")))
    if kind == "revocations":
        l = V.verify_revocation_list(v["jws"], KEYS, now=v["now"])
        return {"ok": l["ok"], "reason": None if l["ok"] else l["reason"], "state": V.state_of(SEMANTO["file"], v["now"], l["payload"] if l["ok"] else None)}
    if kind == "log":
        incl = V.verify_inclusion_in_log(v["inclusion"])
        cons = V.verify_consistency(v["consistency"])
        th3 = V.verify_tree_head(v["tree_heads"]["3"], KEYS, now=v["now"])
        th5 = V.verify_tree_head(v["tree_heads"]["5"], KEYS, now=v["now"])
        cp = V.verify_checkpoint(v["checkpoint"], KEYS, v["origin"])
        ok = incl and cons and th3["ok"] and th5["ok"] and cp["ok"] and cp["root_hash"] == v["inclusion"]["root_hash"]
        return {"ok": ok, "reason": None if ok else "log_check_failed"}
    if kind == "pages":
        return {"ok": True}
    raise AssertionError(f"unknown vector kind {kind}")


@pytest.mark.parametrize("name", [f for f in MANIFEST if f != "keys.json"])
def test_vector(name: str) -> None:
    v = read(name)
    r = run(v)
    assert r["ok"] == v["expect"]["ok"], f"{name}: {r}"
    if v["expect"].get("reason"):
        assert r["reason"] == v["expect"]["reason"]
    if v["expect"].get("state"):
        assert r["state"] == v["expect"]["state"]
    if v["expect"].get("keyid"):
        assert r["keyid"] == v["expect"]["keyid"]
    if v["expect"].get("agent"):
        assert r["agent"] == v["expect"]["agent"]
    if v["expect"].get("version_id"):
        assert r["version_id"] == v["expect"]["version_id"]
    if v["expect"].get("note"):
        assert any(v["expect"]["note"] in n for n in r.get("notes") or []), r.get("notes")


def test_canonical_json_matches_rfc_8785_cases() -> None:
    assert V.canonicalize({"b": 1, "a": [True, None, "x"], "é": 2, "A": 3}) == '{"A":3,"a":[true,null,"x"],"b":1,"é":2}'
    assert V.canonicalize({"s": 'line\nbreak\t"q"\\'}) == '{"s":"line\\nbreak\\t\\"q\\"\\\\"}'
    assert V.canonicalize({"n": 49.0}) == '{"n":49}'
    # UTF-16 order: a supplementary character (surrogate pair, 0xD83D) sorts before U+FF01 in UTF-16 but after it by code point.
    assert V.canonicalize({"！": 1, "\U0001F600": 2}) == '{"\U0001F600":2,"！":1}'
    with pytest.raises(V.CanonicalizeError, match="integers only"):
        V.canonicalize({"price": 49.99})


def test_header_canonical_bytes_hash_to_root() -> None:
    f = SEMANTO["file"]
    assert V.root_hash(f["header"]) == f["root_hash"]
    assert V.pages_root(f["header"]["pages_manifest"]) == f["header"]["pages_root"]
    assert V.facts_root(f["facts"]) == f["header"]["facts_root"]
    assert V.version_id(f["root_hash"]) == SEMANTO["expect"]["version_id"]
    for k in KEYS["company"]["jwks"]["keys"] + KEYS["trooth"]["jwks"]["keys"]:
        assert V.thumbprint(k) == k["kid"]


def test_rfc_6962_known_roots() -> None:
    leaves = [b"", b"\x00", b"\x10", b"\x20\x21", b"\x30\x31", b"\x40\x41\x42\x43", b"\x50\x51\x52\x53\x54\x55\x56\x57", bytes(range(0x60, 0x70))]
    hashed = [V.leaf_hash(l) for l in leaves]
    assert V.root_from_leaf_hashes(hashed).hex() == "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"
    assert V.root_from_leaf_hashes(hashed[:3]).hex() == "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77"
    assert V.root_from_leaf_hashes([]).hex() == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_tampering_is_caught_in_each_layer() -> None:
    v = read("page-proof.json")
    swapped = json.loads(json.dumps(v["proof"]))
    swapped["inclusion"]["path"].reverse()
    r = V.verify_page_proof(swapped, v["page_markdown"], KEYS, now=v["now"], header=v["header"])
    assert r["ok"] is False and r["reason"] == "pages_root_mismatch"
    edited = json.loads(json.dumps(v["header"]))
    edited["org"] = "Acme Incorporated"
    r = V.verify_page_proof(v["proof"], v["page_markdown"], KEYS, now=v["now"], header=edited)
    assert r["ok"] is False and r["reason"] == "root_hash_mismatch"
    wrong_leaf = json.loads(json.dumps(v["proof"]))
    wrong_leaf["ledger"]["leaf"]["hash"] = V.digest(b"another root")
    r = V.verify_page_proof(wrong_leaf, v["page_markdown"], KEYS, now=v["now"], header=v["header"])
    assert r["reason"] == "log_leaf_mismatch"
    # Strict: without the version header the proof is not tied to a signed version.
    no_header = V.verify_page_proof(v["proof"], v["page_markdown"], KEYS, now=v["now"])
    assert no_header["ok"] is False and no_header["reason"] == "header_absent"
    resp = read("response.json")
    rr = resp["response"]
    r = V.verify_response(rr["status"], rr["headers"], rr["body"] + " ", KEYS, now=resp["now_epoch"])
    assert r["reason"] == "content_digest_mismatch"
    r = V.verify_response(rr["status"], rr["headers"], rr["body"], KEYS, now=resp["now_epoch"], tag="web-bot-auth")
    assert r["reason"] == "wrong_tag"
    wba = read("web-bot-auth-request.json")["request"]
    r = V.verify_web_bot_auth_request(wba["method"], "https://other.example/security", wba["headers"], KEYS, now=read("web-bot-auth-request.json")["now_epoch"])
    assert r["reason"] == "bad_signature"


def test_state_of() -> None:
    f = SEMANTO["file"]
    assert V.state_of(f, "2026-10-22T12:00:10Z") == "current"
    assert V.state_of(f, "2026-10-01T00:00:00Z") == "behind"
    assert V.state_of(f, "2027-03-01T00:00:00Z") == "expired"
    smv = V.version_id(f["root_hash"])
    assert V.state_of(f, "2026-10-22T12:00:10Z", {"revocations": [{"kind": "version", "ref": smv, "revoked_at": "2026-10-22T12:00:05Z"}]}) == "withdrawn"
    assert V.state_of(f, "2026-10-22T12:00:10Z", {"revocations": [{"kind": "version", "ref": smv, "revoked_at": "2026-10-23T00:00:00Z"}]}) == "current"
    assert V.state_of(f, "2026-10-22T12:00:10Z", None, latest=2) == "superseded"
    assert V.state_of({**f, "header": {**f["header"], "state": "confirmed"}, "signature": None}, datetime.now(timezone.utc)) == "unsigned"


def test_cli_offline() -> None:
    env = {**os.environ, "PYTHONPATH": HERE}
    good = subprocess.run([sys.executable, "-m", "trooth_semanto_verify", "file", os.path.join(DIR, "semanto.json"), "--pages", os.path.join(DIR, "pages")], capture_output=True, text=True, env=env, cwd=HERE)
    assert good.returncode == 0, good.stdout + good.stderr
    assert "Every check passed." in good.stdout
    assert "3 of 3 pages were given" in good.stdout
    bad = subprocess.run([sys.executable, "-m", "trooth_semanto_verify", "file", os.path.join(DIR, "negative", "fact-tampered.json"), "--keys", os.path.join(DIR, "keys.json")], capture_output=True, text=True, env=env, cwd=HERE)
    assert bad.returncode == 1
    assert "FAIL facts_root" in bad.stdout


def test_jws_types_include_every_core_type() -> None:
    # Review finding 19: the kit's registry matches src/core/jws.ts JWS_TYPES, marketplaceCatalog included.
    assert V.JWS_TYPES["marketplaceCatalog"] == "https://trooth.co/types/marketplace-catalog"
    assert len(V.JWS_TYPES) == 13


def test_web_bot_auth_refuses_a_second_label() -> None:
    v = read("negative/web-bot-auth-two-labels.json")
    r = v["request"]
    assert V.verify_web_bot_auth_request(r["method"], r["url"], r["headers"], KEYS, now=v["now_epoch"])["reason"] == "more_than_one_label"
