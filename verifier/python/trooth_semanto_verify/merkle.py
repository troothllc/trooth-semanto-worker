# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# RFC 6962 (Certificate Transparency) Merkle hashing: leaf hash SHA-256(0x00 ||
# data), node hash SHA-256(0x01 || left || right), with the inclusion proof
# check of section 2.1.3 and the consistency proof check of section 2.1.4.2.

from __future__ import annotations

import hashlib
import re
from typing import Sequence

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def digest(data: bytes) -> str:
    """The printed form every Semanto digest uses: sha256: plus 64 lowercase hex."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def is_digest(value: object) -> bool:
    return isinstance(value, str) and DIGEST_RE.match(value) is not None


def digest_bytes(d: str) -> bytes:
    if not is_digest(d):
        raise ValueError(f'expected "sha256:<64 hex>", got {d!r}')
    return bytes.fromhex(d[7:])


def leaf_hash(data: bytes) -> bytes:
    return sha256(b"\x00" + data)


def node_hash(left: bytes, right: bytes) -> bytes:
    return sha256(b"\x01" + left + right)


def _largest_power_of_two_below(n: int) -> int:
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def root_from_leaf_hashes(leaves: Sequence[bytes]) -> bytes:
    if len(leaves) == 0:
        return sha256(b"")
    if len(leaves) == 1:
        return leaves[0]
    k = _largest_power_of_two_below(len(leaves))
    return node_hash(root_from_leaf_hashes(leaves[:k]), root_from_leaf_hashes(leaves[k:]))


def verify_inclusion(leaf: bytes, index: int, size: int, proof: Sequence[bytes], expected_root: bytes) -> bool:
    """RFC 6962 2.1.3: recompute the root from a leaf hash and its audit path."""
    if index < 0 or index >= size:
        return False
    fn, sn, r = index, size - 1, leaf
    for p in proof:
        if sn == 0:
            return False
        if fn % 2 == 1 or fn == sn:
            r = node_hash(p, r)
            while not (fn % 2 == 1 or fn == 0):
                fn >>= 1
                sn >>= 1
        else:
            r = node_hash(r, p)
        fn >>= 1
        sn >>= 1
    return sn == 0 and r == expected_root


def verify_consistency(old_size: int, new_size: int, old_root: bytes, new_root: bytes, proof: Sequence[bytes]) -> bool:
    """RFC 6962 2.1.4.2: the old tree is a prefix of the new tree."""
    if old_size > new_size:
        return False
    if old_size == new_size:
        return len(proof) == 0 and old_root == new_root
    if old_size == 0:
        return len(proof) == 0
    is_pow2 = (old_size & (old_size - 1)) == 0
    p = ([old_root] + list(proof)) if is_pow2 else list(proof)
    if not p:
        return False
    fn, sn = old_size - 1, new_size - 1
    while fn % 2 == 1:
        fn >>= 1
        sn >>= 1
    fr = sr = p[0]
    for c in p[1:]:
        if sn == 0:
            return False
        if fn % 2 == 1 or fn == sn:
            fr = node_hash(c, fr)
            sr = node_hash(c, sr)
            while not (fn % 2 == 1 or fn == 0):
                fn >>= 1
                sn >>= 1
        else:
            sr = node_hash(sr, c)
        fn >>= 1
        sn >>= 1
    return sn == 0 and fr == old_root and sr == new_root
