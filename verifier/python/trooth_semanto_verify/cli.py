# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# semanto-verify for Python: the same commands as verifier/js/cli.mjs. Prints
# one line per check in plain words and exits 0 only when every check passed.
#
#   semanto-verify file <semanto.json> [--pages <dir>] [--keys <keys.json>] [--now <iso>] [--revocations <file>]
#   semanto-verify page <url> [--trooth <base>] [--now <iso>]
#   semanto-verify response <url> [--keys <keys.json>]
#   semanto-verify log --from <n> --to <m> [--log <url>] [--keys <keys.json>]

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

from .jws import parse_dns_key_records
from .verify import (
    parse_link,
    state_of,
    verify_consistency,
    verify_page_proof,
    verify_response,
    verify_revocation_list,
    verify_semanto,
    verify_tree_head,
)

TROOTH_API = "https://api.trooth.co"
DEFAULT_LOG = f"{TROOTH_API}/public/semanto/log"


def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _fetch(url: str, accept: str = "application/json") -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "semanto-verify/0.1 (python)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def _fetch_json(url: str) -> Any:
    status, _, body = _fetch(url)
    if status != 200:
        raise RuntimeError(f"{url} answered {status}")
    return json.loads(body)


def _print(result: dict, title: str) -> bool:
    print(title)
    for c in result.get("checks") or []:
        print(f"  {'ok  ' if c['ok'] else 'FAIL'} {c['name']}: {c['detail']}")
    if "checks" not in result:
        print(f"  {'ok  ' if result['ok'] else 'FAIL'} {result.get('reason') or ''}")
    print("Every check passed." if result["ok"] else f"Failed: {result.get('reason')}.")
    print()
    return bool(result["ok"])


def _load_keys(domain: str, args: argparse.Namespace) -> Any:
    if args.keys:
        return _read_json(args.keys)
    sets = []
    for url in (f"https://{domain}/.well-known/trooth-keys.json", f"{args.trooth or TROOTH_API}/.well-known/trooth-keys.json"):
        try:
            sets.append(_fetch_json(url))
            print(f"  ok   fetched the JWK Set at {url}")
        except Exception as e:  # noqa: BLE001 - we report and continue
            print(f"  note {url} could not be read ({e})")
    return sets


def _dns_note(domain: str, kid: Optional[str]) -> None:
    if not kid:
        return
    try:
        import subprocess

        out = subprocess.run(["dig", "+short", "TXT", f"_trooth-keys.{domain}"], capture_output=True, text=True, timeout=10).stdout
        kids = parse_dns_key_records([l.strip().strip('"') for l in out.splitlines()])
    except Exception:  # noqa: BLE001
        print(f"DNS binding\n  note _trooth-keys.{domain} was not checked (no dig on this machine).\n")
        return
    if kid in kids:
        print(f"DNS binding\n  ok   _trooth-keys.{domain} TXT names key {kid}.\n")
    elif kids:
        print(f"DNS binding\n  note _trooth-keys.{domain} TXT names {', '.join(kids)}, not the signing key {kid}.\n")
    else:
        print(f"DNS binding\n  note _trooth-keys.{domain} has no v=trooth1 record.\n")


def cmd_file(args: argparse.Namespace) -> int:
    doc = _read_json(args.path)
    file = doc.get("file", doc)
    base = os.path.dirname(os.path.abspath(args.path))
    if args.keys:
        keys = _read_json(args.keys)
    elif os.path.exists(os.path.join(base, "keys.json")):
        keys = _read_json(os.path.join(base, "keys.json"))
    elif args.offline:
        keys = {}
    else:
        keys = _load_keys(file["header"]["identity"]["domain"], args)
    pages_dir = args.pages or (os.path.join(base, "pages") if os.path.isdir(os.path.join(base, "pages")) else None)
    pages: dict = {}
    if pages_dir:
        for p in file["header"]["pages_manifest"]:
            f = os.path.join(pages_dir, f"{p['id']}.md")
            if os.path.exists(f):
                with open(f, "rb") as fh:
                    pages[p["url"]] = fh.read()
        print(f"Pages: {len(pages)} of {len(file['header']['pages_manifest'])} found in {pages_dir}.")
    revocations = None
    if args.revocations:
        r = _read_json(args.revocations)
        v = verify_revocation_list(r.get("jws", r), keys, now=args.now)
        print(f"Revocation list: {'signed by Trooth' if v['ok'] else 'not accepted (' + v['reason'] + ')'}.")
        if v["ok"]:
            revocations = v["payload"]
    result = verify_semanto(file, pages, keys, now=args.now or doc.get("now"), revocations=revocations)
    return 0 if _print(result, f"Semanto file {args.path} (version {result.get('version_id') or 'unknown'})") else 1


def cmd_response(args: argparse.Namespace, also_proof: bool = False) -> int:
    status, headers, body = _fetch(args.url, accept="text/markdown")
    print(f"GET {args.url} with Accept: text/markdown answered {status} {headers.get('content-type', '')}")
    domain = urlsplit(args.url).hostname or ""
    keys = _load_keys(domain, args)
    resp = verify_response(status, headers, body, keys, now=args.now)
    ok = _print(resp, "Signed response")
    _dns_note(domain, resp.get("keyid"))
    if also_proof:
        links = parse_link(headers.get("link"))
        proof_link = next((l for l in links if any(r in ("proof", "https://trooth.co/rel/proof") for r in (l["params"].get("rel") or "").split())), None)
        if not proof_link:
            print('Proof\n  FAIL the response has no Link rel="https://trooth.co/rel/proof".\n')
            ok = False
        else:
            proof_url = urljoin(args.url, proof_link["url"])
            try:
                doc = _fetch_json(proof_url)
                proof = doc.get("proof", doc)
                header = doc.get("header")
                if header is None and isinstance(proof.get("version"), int):
                    import re as _re

                    version_url = _re.sub(r"/pages/[^/]+/proof$", f"/versions/{proof['version']}", proof_url)
                    try:
                        header = _fetch_json(version_url).get("header")
                        print(f"  ok   fetched the version header at {version_url}")
                    except Exception as e:  # noqa: BLE001
                        print(f"  note {version_url} could not be read ({e}); the company signature is not checked.")
                pr = verify_page_proof(proof, body, keys, now=args.now, header=header)
                ok = _print(pr, f"Proof at {proof_url}") and ok
                if header:
                    print(f"State now: {state_of({'header': header, 'root_hash': proof.get('root_hash'), 'signature': proof.get('signature')}, args.now)}.\n")
            except Exception as e:  # noqa: BLE001
                print(f"Proof\n  FAIL {proof_url} could not be read or parsed ({e}).\n")
                ok = False
    return 0 if ok else 1


def cmd_log(args: argparse.Namespace) -> int:
    log = args.log or DEFAULT_LOG
    keys = _read_json(args.keys) if args.keys else _fetch_json(f"{args.trooth or TROOTH_API}/.well-known/trooth-keys.json")
    old = _fetch_json(f"{log}/tree-head?size={args.from_size}")
    new = _fetch_json(f"{log}/tree-head?size={args.to_size}")
    cons = _fetch_json(f"{log}/consistency?from={args.from_size}&to={args.to_size}")
    ok = True
    for name, head in ((f"Tree head at size {args.from_size}", old), (f"Tree head at size {args.to_size}", new)):
        v = verify_tree_head(head, keys, now=args.now)
        print(f"{name}: {'signed by Trooth key ' + v['kid'] + ', root ' + v['root_hash'] if v['ok'] else 'FAIL ' + v['reason']}")
        ok = ok and v["ok"]
    root_of = lambda head: (head.get("payload") or {}).get("root_hash") or head.get("root_hash")  # noqa: E731
    c = verify_consistency({"from": args.from_size, "to": args.to_size, "old_root": root_of(old), "new_root": root_of(new), "path": cons.get("path", cons)})
    print(f"Consistency {args.from_size} to {args.to_size}: " + ("the older tree is a prefix of the newer one; nothing was removed or rewritten" if c else "FAIL the proof does not connect the two roots"))
    return 0 if ok and c else 1


def main(argv: Optional[list] = None) -> int:
    p = argparse.ArgumentParser(prog="semanto-verify", description="Check a Semanto file, a page, a signed response or the public log. Exit 0 means every check passed.")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("file", help="check a Semanto file offline")
    f.add_argument("path")
    f.add_argument("--pages")
    f.add_argument("--keys")
    f.add_argument("--now")
    f.add_argument("--revocations")
    f.add_argument("--offline", action="store_true")
    f.add_argument("--trooth")
    for name in ("page", "response"):
        s = sub.add_parser(name, help="fetch a url with Accept: text/markdown and check the signed answer" + (" and its proof" if name == "page" else ""))
        s.add_argument("url")
        s.add_argument("--keys")
        s.add_argument("--now")
        s.add_argument("--trooth")
    l = sub.add_parser("log", help="check two tree heads and the consistency proof between them")
    l.add_argument("--from", dest="from_size", type=int, required=True)
    l.add_argument("--to", dest="to_size", type=int, required=True)
    l.add_argument("--log")
    l.add_argument("--keys")
    l.add_argument("--now")
    l.add_argument("--trooth")
    args = p.parse_args(argv)
    try:
        if args.cmd == "file":
            return cmd_file(args)
        if args.cmd == "page":
            return cmd_response(args, also_proof=True)
        if args.cmd == "response":
            return cmd_response(args)
        if args.cmd == "log":
            return cmd_log(args)
    except Exception as e:  # noqa: BLE001
        print(f"semanto-verify: {e}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
