# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# The top-level Semanto checks: a whole file offline, a per-page proof, a
# signed response, tree heads, log inclusion and consistency, checkpoints,
# offers, revocation lists, and the state of a version at an instant. Every
# function returns plain dicts: {"ok", "reason", "checks": [{"name", "ok",
# "detail"}]} so a CLI prints exactly what was checked, in plain words. Nothing
# here produces a number or a verdict about a company.

from __future__ import annotations

import base64
import hashlib
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Union

from .canonical import canonical_bytes, canonicalize
from .httpsig import (
    SEMANTO_RESPONSE_COMPONENTS,
    SEMANTO_RESPONSE_TAG,
    WEB_BOT_AUTH_REQUIRED,
    WEB_BOT_AUTH_TAG,
    header_get,
    verify_content_digest,
    verify_message,
)
from .jws import JWS_TYPES, b64url_decode, ed25519_verify, key_resolver, parse_time, verify_jws
from .merkle import digest, digest_bytes, is_digest, leaf_hash, root_from_leaf_hashes, verify_consistency as _verify_consistency, verify_inclusion

SCHEMA_URL = "https://trooth.co/schemas/semanto/v1.json"
_B32 = "abcdefghijklmnopqrstuvwxyz234567"
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")

Now = Union[datetime, str, int, float, None]


def _at(now: Now) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if isinstance(now, datetime):
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    if isinstance(now, (int, float)):
        return datetime.fromtimestamp(now, tz=timezone.utc)
    return parse_time(now)


def _epoch(now: Now) -> int:
    return int(_at(now).timestamp())


# ------------------------------------------------------------------ ids and hashing


def semanto_id(prefix: str, d: str) -> str:
    if not is_digest(d):
        raise ValueError("semanto_id needs a digest")
    bits = "".join(f"{int(ch, 16):04b}" for ch in d[7:])
    out = "".join(_B32[int(bits[i : i + 5], 2)] for i in range(0, len(bits) - 4, 5))[:26]
    return f"{prefix}_{out}"


def pages_root(manifest: List[dict]) -> str:
    leaves = [leaf_hash(digest_bytes(p["hash"])) for p in manifest]
    return "sha256:" + root_from_leaf_hashes(leaves).hex()


def facts_root(facts: List[dict]) -> str:
    ordered = sorted(facts, key=lambda f: f["id"])
    leaves = [leaf_hash(canonical_bytes(f)) for f in ordered]
    return "sha256:" + root_from_leaf_hashes(leaves).hex()


def tier_hash(value: Any) -> str:
    return digest(canonical_bytes(value))


def root_hash(header: dict) -> str:
    return digest(canonical_bytes(header))


def version_id(root: str) -> str:
    return semanto_id("smv", root)


def fact_id(fact: dict) -> str:
    rest = {k: v for k, v in fact.items() if k != "id"}
    return semanto_id("smf", digest(canonical_bytes(rest)))


# ------------------------------------------------------------------ states


def state_of(version: dict, now: Now = None, revocations: Optional[dict] = None, latest: Optional[int] = None) -> str:
    """The state at `now` in the ledger's words: current, superseded, behind, expired, withdrawn or unsigned."""
    header = version.get("header", version)
    at = _at(now)
    root = version.get("root_hash") or header.get("root_hash")
    smv = version_id(root) if root and is_digest(root) else None
    entries: list = []
    if revocations:
        entries = revocations.get("revocations") or revocations.get("entries") or (revocations.get("payload") or {}).get("revocations") or []
    for e in entries:
        if e.get("kind") != "version":
            continue
        if (smv and e.get("ref") == smv) or (root and e.get("ref") == root):
            if not e.get("revoked_at") or at >= parse_time(e["revoked_at"]):
                return "withdrawn"
    state = header.get("state")
    if state == "withdrawn":
        return "withdrawn"
    if state in ("read", "confirmed"):
        return "unsigned"
    if state == "signed" and "header" in version and not version.get("signature"):
        return "unsigned"
    if header.get("not_after") and at >= parse_time(header["not_after"]):
        return "expired"
    if header.get("not_before") and at < parse_time(header["not_before"]):
        return "behind"
    if isinstance(latest, int) and isinstance(header.get("version"), int) and latest > header["version"]:
        return "superseded"
    return "current" if state == "signed" else "unsigned"


# ------------------------------------------------------------------ check list


class _Checks:
    def __init__(self) -> None:
        self.list: List[dict] = []
        self.reason: Optional[str] = None

    def add(self, name: str, ok: bool, detail: str, reason: Optional[str] = None) -> bool:
        self.list.append({"name": name, "ok": ok, "detail": detail})
        if not ok and self.reason is None:
            self.reason = reason or name
        return ok

    def result(self, **extra: Any) -> dict:
        ok = all(c["ok"] for c in self.list)
        out = {"ok": ok, "reason": None if ok else self.reason, "checks": self.list}
        out.update(extra)
        return out


def _validate(file: dict, out: List[dict]) -> bool:
    def push(path: str, message: str) -> None:
        out.append({"path": path, "message": message})

    h = file.get("header")
    if not isinstance(h, dict):
        push("header", "missing")
        return False
    if h.get("schema") != SCHEMA_URL:
        push("header.schema", "unknown schema")
    if h.get("contract") != 1:
        push("header.contract", "expected 1")
    if not isinstance(h.get("org"), str) or not h["org"]:
        push("header.org", "required")
    if not isinstance(h.get("domains"), list) or not h["domains"]:
        push("header.domains", "at least one domain")
    if not isinstance(h.get("version"), int) or h["version"] < 1:
        push("header.version", "positive integer")
    if not isinstance(h.get("built_at"), str) or not _ISO.match(h["built_at"]):
        push("header.built_at", "ISO 8601 UTC")
    if h.get("state") not in ("read", "confirmed", "signed", "withdrawn"):
        push("header.state", "unknown state")
    if not is_digest(h.get("pages_root")):
        push("header.pages_root", "digest")
    if not is_digest(h.get("facts_root")):
        push("header.facts_root", "digest")
    if not isinstance(h.get("tiers"), list):
        push("header.tiers", "array")
    if not isinstance(h.get("pages_manifest"), list):
        push("header.pages_manifest", "array")
    else:
        for i, p in enumerate(h["pages_manifest"]):
            if not is_digest(p.get("hash")):
                push(f"header.pages_manifest[{i}].hash", "digest")
            if not isinstance(p.get("url"), str) or not p["url"].startswith("https://"):
                push(f"header.pages_manifest[{i}].url", "https url")
    if not isinstance(file.get("facts"), list):
        push("facts", "array")
    else:
        for i, f in enumerate(file["facts"]):
            if f.get("provenance") not in ("witnessed", "public_record", "attested", "declared"):
                push(f"facts[{i}].provenance", "unknown provenance")
            if not isinstance(f.get("evidence"), dict) or not isinstance(f["evidence"].get("url"), str):
                push(f"facts[{i}].evidence.url", "required")
    if not isinstance(file.get("controls"), dict) or not isinstance(file["controls"].get("when_unknown"), str):
        push("controls.when_unknown", "required")
    if not is_digest(file.get("root_hash")):
        push("root_hash", "digest")
    return not out


PageBytes = Union[Dict[str, Union[bytes, str]], Callable[[dict], Optional[bytes]], None]


def _as_bytes(b: Union[bytes, bytearray, str]) -> bytes:
    return b.encode("utf-8") if isinstance(b, str) else bytes(b)


def verify_semanto(file: dict, page_bytes_by_url: PageBytes = None, keys: Any = None, now: Now = None, revocations: Optional[dict] = None, latest: Optional[int] = None) -> dict:
    """Verify a whole Semanto file offline. See docs/spec/semanto-file.md."""
    c = _Checks()
    at = _at(now)
    resolve = key_resolver(keys)
    issues: List[dict] = []
    if not isinstance(file, dict) or not isinstance(file.get("header"), dict):
        c.add("structure", False, "The file has no header.", "malformed")
        return c.result(issues=issues)
    ok = _validate(file, issues)
    c.add("structure", ok, "The file has every required field." if ok else "; ".join(f"{i['path']}: {i['message']}" for i in issues), "malformed")
    if not ok:
        return c.result(issues=issues)
    h = file["header"]

    root = root_hash(h)
    c.add("root_hash", root == file["root_hash"], f"root_hash is the digest of the canonical header: {root}" if root == file["root_hash"] else f"root_hash {file['root_hash']} is not the digest of the header, which is {root}", "root_hash_mismatch")
    pr = pages_root(h["pages_manifest"])
    c.add("pages_root", pr == h["pages_root"], f"pages_root matches the {len(h['pages_manifest'])} page hashes in the manifest." if pr == h["pages_root"] else f"pages_root does not match the manifest (computed {pr}).", "pages_root_mismatch")
    fr = facts_root(file["facts"])
    c.add("facts_root", fr == h["facts_root"], f"facts_root matches the {len(file['facts'])} facts." if fr == h["facts_root"] else f"facts_root does not match the facts (computed {fr}).", "facts_root_mismatch")

    tiers = {"facts": file.get("facts"), "controls": file.get("controls"), "question_map": file.get("question_map"), "documents": file.get("documents"), "products": file.get("products"), "pages": h["pages_manifest"]}
    for t in h.get("tiers") or []:
        name = t.get("name")
        if name == "header":
            continue
        if name not in tiers or tiers[name] is None:
            c.add(f"tier.{name}", False, f"The header lists a {name} tier that is not in the file.", "tier_missing")
            continue
        th = tier_hash(tiers[name])
        c.add(f"tier.{name}", th == t.get("hash"), f"The {name} tier matches its hash." if th == t.get("hash") else f"The {name} tier does not match its hash in the header.", "tier_hash_mismatch")

    bad = [f["id"] for f in file["facts"] if fact_id(f) != f.get("id")]
    c.add("fact_ids", not bad, "Every fact id is the digest of its fact." if not bad else "These fact ids do not match their facts: " + ", ".join(bad), "fact_id_mismatch")

    checked, wrong = 0, []
    for p in h["pages_manifest"]:
        if callable(page_bytes_by_url):
            b = page_bytes_by_url(p)
        elif page_bytes_by_url:
            b = page_bytes_by_url.get(p["url"], page_bytes_by_url.get(p.get("id")))
        else:
            b = None
        if b is None:
            continue
        checked += 1
        if digest(_as_bytes(b)) != p["hash"]:
            wrong.append(p["url"])
    if checked:
        c.add("page_bytes", not wrong, f"{checked} of {len(h['pages_manifest'])} pages were given and every one matches its hash." if not wrong else "These pages do not match their hash: " + ", ".join(wrong), "page_hash_mismatch")
    else:
        c.list.append({"name": "page_bytes", "ok": True, "detail": "No page bytes were given, so page bytes were not checked."})

    sig = file.get("signature")
    if sig:
        v = verify_jws(sig.get("jws"), resolve, expect_typ=JWS_TYPES["semantoVersion"], payload=h, at=at)
        c.add("company_signature", v["ok"], f"The header is signed by key {v['header']['kid']} (typ semanto-version)." if v["ok"] else f"The company's signature did not check out: {v['reason']}.", None if v["ok"] else v["reason"])
    else:
        c.add("company_signature", h.get("state") != "signed", "The file says it is signed but carries no signature." if h.get("state") == "signed" else "The file is not signed yet; that matches its state.", "unsigned")

    w = file.get("witness")
    if w:
        payload = {"root_hash": file["root_hash"], "witnessed_at": w.get("at")}
        v = verify_jws(w.get("jws"), resolve, expect_typ=JWS_TYPES["witness"], payload=payload, at=at)
        c.add("witness", v["ok"], f"Trooth witnessed root_hash at {w.get('at')} with key {v['header']['kid']}." if v["ok"] else f"The witness statement did not check out: {v['reason']}.", None if v["ok"] else f"witness_{v['reason']}")
    else:
        c.list.append({"name": "witness", "ok": True, "detail": "No witness statement in the file."})

    state = state_of(file, at, revocations, latest)
    c.add("state", state == "current" or h.get("state") != "signed", f"State at {at.isoformat()}: {state}.", state)
    return c.result(issues=issues, state=state, version_id=version_id(file["root_hash"]) if is_digest(file.get("root_hash")) else None)


def verify_page_proof(proof: dict, page_bytes: Union[bytes, str], keys: Any = None, now: Now = None, header: Optional[dict] = None) -> dict:
    """Verify a semanto.proof document (what /pages/{id}/proof returns) against the page's bytes.

    Pass the version header (fetched beside the proof) to tie the proof to root_hash and check the company's signature.
    """
    c = _Checks()
    at = _at(now)
    resolve = key_resolver(keys)
    b = _as_bytes(page_bytes)
    h = header if header is not None else proof.get("header")
    inc = proof.get("inclusion")
    if proof.get("object") != "semanto.proof" or not is_digest(proof.get("page_hash")) or not is_digest(proof.get("pages_root")) or not is_digest(proof.get("root_hash")) or not isinstance(inc, dict):
        c.add("structure", False, "The proof is not a semanto.proof with full digests and an inclusion block.", "malformed")
        return c.result()

    d = digest(b)
    c.add("page_hash", d == proof["page_hash"], f"The page bytes hash to {d}, the hash in the manifest." if d == proof["page_hash"] else f"The page bytes hash to {d}; the proof says {proof['page_hash']}. The page is not the one that was signed.", "page_hash_mismatch")

    index, size = inc.get("index"), inc.get("size")
    try:
        in_pages = verify_inclusion(leaf_hash(digest_bytes(proof["page_hash"])), index, size, [digest_bytes(x) for x in inc.get("path") or []], digest_bytes(proof["pages_root"]))
    except (ValueError, TypeError):
        in_pages = False
    c.add("pages_root", in_pages, f"Page {index + 1} of {size} is in pages_root {proof['pages_root']}." if in_pages else "The inclusion proof does not lead to pages_root.", "pages_root_mismatch")

    if h is not None:
        manifest = h.get("pages_manifest") or []
        entry = manifest[index] if isinstance(index, int) and 0 <= index < len(manifest) else None
        root = root_hash(h)
        bound = h.get("pages_root") == proof["pages_root"] and root == proof["root_hash"] and entry is not None and entry.get("id") == proof.get("page_id") and entry.get("hash") == proof["page_hash"] and h.get("version") == proof.get("version")
        if bound:
            detail, reason = f"The version header hashes to root_hash {root} and lists this page at index {index}.", None
        elif root != proof["root_hash"]:
            detail, reason = f"The header hashes to {root}, not the proof's root_hash {proof['root_hash']}.", "root_hash_mismatch"
        else:
            detail, reason = "The header does not list this page at that index with this hash.", "manifest_mismatch"
        c.add("header", bound, detail, reason)
        sig = verify_jws(proof.get("signature"), resolve, expect_typ=JWS_TYPES["semantoVersion"], payload=h, at=at)
        c.add("company_signature", sig["ok"], f"The header is signed by key {sig['header']['kid']} (typ semanto-version)." if sig["ok"] else f"The company's signature did not check out: {sig['reason']}.", None if sig["ok"] else sig["reason"])
    else:
        c.list.append({"name": "header", "ok": True, "detail": "No version header was given, so the proof was not tied to the signed header and the company signature was not checked."})

    if proof.get("witness"):
        payload = {"root_hash": proof["root_hash"], "witnessed_at": proof.get("witnessed_at")}
        w = verify_jws(proof["witness"], resolve, expect_typ=JWS_TYPES["witness"], payload=payload, at=at)
        c.add("witness", w["ok"], f"Trooth witnessed this root_hash at {proof.get('witnessed_at')} with key {w['header']['kid']}." if w["ok"] else f"The witness statement did not check out: {w['reason']}.", None if w["ok"] else f"witness_{w['reason']}")

    l = proof.get("ledger")
    if l:
        try:
            leaf_h: Optional[bytes] = digest_bytes(l.get("leaf_hash"))
        except ValueError:
            leaf_h = None
        leaf = l.get("leaf")
        if leaf is not None:
            recomputed = leaf_hash(canonical_bytes(leaf)).hex()
            same_hash = recomputed == str(l.get("leaf_hash"))[7:]
            names = leaf.get("hash") == proof["root_hash"] and leaf.get("kind") == "semanto_version"
            c.add("log_leaf", same_hash and names, ("The log leaf is the canonical leaf record and names this root_hash." if names else "The log leaf names a different root_hash.") if same_hash else "The leaf record does not hash to leaf_hash.", "log_leaf_mismatch")
        else:
            c.list.append({"name": "log_leaf", "ok": True, "detail": "The proof carries only the leaf hash, so the leaf record was not recomputed."})
        try:
            in_log = leaf_h is not None and verify_inclusion(leaf_h, l["index"], l["tree_size"], [digest_bytes(x) for x in (l.get("inclusion_path") or l.get("path") or [])], digest_bytes(l["root_hash"]))
        except (ValueError, KeyError, TypeError):
            in_log = False
        c.add("log_inclusion", in_log, f"Leaf {l.get('index')} is in the log of size {l.get('tree_size')} with root {l.get('root_hash')}." if in_log else "The log inclusion proof does not lead to the tree head.", "log_inclusion_failed")
        th = verify_tree_head({"jws": l.get("tree_head_jws") or (l.get("tree_head") or {}).get("jws"), "payload": (l.get("tree_head") or {}).get("payload")}, keys, at)
        same = th["ok"] and th.get("tree_size") == l.get("tree_size") and th.get("root_hash") == l.get("root_hash")
        c.add("tree_head", same, (f"The tree head of size {th.get('tree_size')} is signed by Trooth (key {th.get('kid')})." if same else "The signed tree head names a different tree.") if th["ok"] else f"The tree head signature did not check out: {th['reason']}.", "tree_head_mismatch" if th["ok"] else f"tree_head_{th['reason']}")

    vid = proof.get("version_id") or (version_id(proof["root_hash"]) if is_digest(proof.get("root_hash")) else None)
    return c.result(version_id=vid)


def verify_response(status: int, headers: Dict[str, Any], body: Union[bytes, str], keys: Any = None, now: Now = None, tag: str = SEMANTO_RESPONSE_TAG, required: Optional[List[str]] = None, max_age_seconds: Optional[int] = None) -> dict:
    """Verify a signed HTTP response: RFC 9421 with tag trooth-semanto and RFC 9530 Content-Digest."""
    c = _Checks()
    b = _as_bytes(body)
    now_sec = int(time.time()) if now is None else _epoch(now)
    dg = verify_content_digest(header_get(headers, "content-digest"), b)
    c.add("content_digest", dg, "Content-Digest matches the body." if dg else "Content-Digest does not match the body, or is missing.", "content_digest_mismatch")
    v = verify_message({"kind": "response", "status": status, "headers": headers}, key_resolver(keys), required=required or SEMANTO_RESPONSE_COMPONENTS, tag=tag, now=now_sec, max_age_seconds=max_age_seconds)
    c.add("signature", v["ok"], f"The response is signed by key {v['keyid']} with tag {v['params'].get('tag')}, covering {', '.join(v['components'])}." if v["ok"] else f"The response signature did not check out: {v['reason']}.", None if v["ok"] else v["reason"])
    page_hash = header_get(headers, "trooth-page-hash")
    if page_hash:
        d = digest(b)
        c.add("page_hash", d == page_hash, f"Trooth-Page-Hash is the digest of the body: {d}" if d == page_hash else f"Trooth-Page-Hash {page_hash} is not the digest of the body ({d}).", "page_hash_mismatch")
    return c.result(keyid=v.get("keyid") if v["ok"] else None, params=v.get("params") if v["ok"] else None, version=header_get(headers, "trooth-semanto-version"), page_hash=page_hash)


def verify_web_bot_auth_request(method: str, url: str, headers: Dict[str, Any], keys: Any = None, now: Now = None, max_age_seconds: Optional[int] = None) -> dict:
    """Verify a Web Bot Auth signed request; returns the Signature-Agent it names when it checks out."""
    now_sec = int(time.time()) if now is None else _epoch(now)
    v = verify_message({"kind": "request", "method": method, "url": url, "headers": headers}, key_resolver(keys), required=WEB_BOT_AUTH_REQUIRED, tag=WEB_BOT_AUTH_TAG, now=now_sec, max_age_seconds=max_age_seconds)
    if not v["ok"]:
        return v
    agent = (header_get(headers, "signature-agent") or "").strip().strip('"')
    return {**v, "agent": agent}


def verify_tree_head(tree_head: Union[dict, str], keys: Any = None, now: Now = None) -> dict:
    """A compact JWS (typ signed-tree-head) over { tree_size, root_hash, signed_at }; a string, {"jws"} or {"payload", "jws"}."""
    jws = tree_head if isinstance(tree_head, str) else (tree_head.get("jws") or tree_head.get("tree_head_jws"))
    given = None if isinstance(tree_head, str) else tree_head.get("payload")
    v = verify_jws(jws, key_resolver(keys), expect_typ=JWS_TYPES["treeHead"], payload=given, at=_at(now))
    if not v["ok"]:
        return v
    p = v["payload"]
    if given is not None and canonicalize(given) != canonicalize(p):
        return {"ok": False, "reason": "payload_mismatch"}
    if not isinstance(p.get("tree_size"), int) or not is_digest(p.get("root_hash")):
        return {"ok": False, "reason": "malformed"}
    if isinstance(tree_head, dict) and tree_head.get("root_hash") is not None:
        if tree_head["root_hash"] != p["root_hash"] or (tree_head.get("tree_size") is not None and tree_head["tree_size"] != p["tree_size"]):
            return {"ok": False, "reason": "payload_mismatch"}
    return {"ok": True, "kid": v["header"]["kid"], "payload": p, "tree_size": p["tree_size"], "root_hash": p["root_hash"], "signed_at": p.get("signed_at")}


def verify_inclusion_in_log(proof: dict, root_hash_override: Optional[str] = None) -> bool:
    leaf_h = digest_bytes(proof["leaf_hash"]) if proof.get("leaf_hash") else leaf_hash(canonical_bytes(proof["leaf"]))
    root = digest_bytes(root_hash_override or proof["root_hash"])
    return verify_inclusion(leaf_h, proof["index"], proof["tree_size"], [digest_bytes(x) for x in (proof.get("path") or proof.get("inclusion_path") or [])], root)


def verify_consistency(proof: dict) -> bool:
    return _verify_consistency(proof["from"], proof["to"], digest_bytes(proof["old_root"]), digest_bytes(proof["new_root"]), [digest_bytes(x) for x in proof.get("path") or []])


def verify_checkpoint(text: str, keys: Any = None, expected_origin: Optional[str] = None) -> dict:
    """A signed note (golang.org/x/mod/sumdb/note): origin, size, base64 root, blank line, then lines "\u2014 name base64(keyhash4||sig)".

    keyhash4 is the first 4 bytes of SHA-256(name || "\n" || 0x01 || pubkey). The signer name is the log operator's (Trooth: "trooth.co").
    """
    split = text.find("\n\n")
    if split < 0:
        return {"ok": False, "reason": "malformed"}
    body, sig_block = text[: split + 1], text[split + 2 :]
    lines = body.split("\n")
    if len(lines) < 3:
        return {"ok": False, "reason": "malformed"}
    origin = lines[0]
    if expected_origin and origin != expected_origin:
        return {"ok": False, "reason": "wrong_origin"}
    try:
        size = int(lines[1])
        root = base64.b64decode(lines[2], validate=True)
    except (ValueError, TypeError):
        return {"ok": False, "reason": "malformed"}
    candidates: list = []
    from .jws import _collect

    _collect(keys, candidates)
    saw_line = False
    for line in sig_block.split("\n"):
        m = re.match(r"^\u2014 (\S+) (\S+)$", line)
        if not m:
            continue
        saw_line = True
        name = m.group(1)
        blob = base64.b64decode(m.group(2))
        key_hash, sig = blob[:4], blob[4:]
        for jwk in candidates:
            pub = b64url_decode(jwk["x"])
            expect = hashlib.sha256(name.encode("utf-8") + b"\n\x01" + pub).digest()[:4]
            if key_hash != expect:
                continue
            if ed25519_verify(jwk, sig, body.encode("utf-8")):
                return {"ok": True, "origin": origin, "name": name, "tree_size": size, "root_hash": "sha256:" + root.hex(), "kid": jwk.get("kid")}
            return {"ok": False, "reason": "bad_signature"}
    return {"ok": False, "reason": "unknown_key" if saw_line else "malformed"}


def verify_offer(jws: str, keys: Any = None, now: Now = None) -> dict:
    v = verify_jws(jws, key_resolver(keys), expect_typ=JWS_TYPES["offer"], at=_at(now))
    if not v["ok"]:
        return v
    return {**v, "offer_id": semanto_id("smo", digest(canonical_bytes(v["payload"])))}


def verify_revocation_list(jws: str, keys: Any = None, now: Now = None) -> dict:
    return verify_jws(jws, key_resolver(keys), expect_typ=JWS_TYPES["revocation"], at=_at(now))


def parse_link(value: Optional[str]) -> List[dict]:
    out: List[dict] = []
    if not value:
        return out
    for m in re.finditer(r'<([^>]*)>((?:\s*;\s*[A-Za-z0-9-]+=(?:"[^"]*"|[^;,]*))*)', value):
        params = {}
        for pm in re.finditer(r';\s*([A-Za-z0-9-]+)=("([^"]*)"|[^;,]*)', m.group(2)):
            params[pm.group(1).lower()] = pm.group(3) if pm.group(3) is not None else pm.group(2).strip()
        out.append({"url": m.group(1), "params": params})
    return out
