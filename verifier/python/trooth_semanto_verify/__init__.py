# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Trooth, LLC
#
# trooth_semanto_verify: check a Semanto file, a page proof, a signed response
# or the public log, offline, with the standard library plus `cryptography`.
# The same functions, names and reason codes as the JavaScript and Go kits, so
# the shared vectors in verifier/test-vectors/v1 run unchanged.

from .canonical import CanonicalizeError, canonical_bytes, canonicalize
from .httpsig import (
    SEMANTO_RESPONSE_COMPONENTS,
    SEMANTO_RESPONSE_TAG,
    WEB_BOT_AUTH_TAG,
    parse_signature,
    parse_signature_input,
    signature_base,
    verify_content_digest,
    verify_message,
)
from .jws import JWS_TYPES, has_roles, key_resolver, key_valid_at, key_valid_at_signing, parse_dns_key_records, role_keys, role_resolver, thumbprint, verify_jws
from .merkle import digest, digest_bytes, is_digest, leaf_hash, node_hash, root_from_leaf_hashes, verify_inclusion
from .verify import (
    fact_id,
    facts_root,
    pages_root,
    parse_link,
    root_hash,
    semanto_id,
    state_of,
    tier_hash,
    verify_checkpoint,
    verify_consistency,
    verify_inclusion_in_log,
    verify_offer,
    verify_page_proof,
    verify_response,
    verify_revocation_list,
    verify_semanto,
    verify_tree_head,
    verify_web_bot_auth_request,
    version_id,
)

__all__ = [
    "CanonicalizeError",
    "canonicalize",
    "canonical_bytes",
    "SEMANTO_RESPONSE_COMPONENTS",
    "SEMANTO_RESPONSE_TAG",
    "WEB_BOT_AUTH_TAG",
    "parse_signature",
    "parse_signature_input",
    "signature_base",
    "verify_content_digest",
    "verify_message",
    "JWS_TYPES",
    "key_resolver",
    "key_valid_at",
    "key_valid_at_signing",
    "has_roles",
    "role_keys",
    "role_resolver",
    "parse_dns_key_records",
    "thumbprint",
    "verify_jws",
    "digest",
    "digest_bytes",
    "is_digest",
    "leaf_hash",
    "node_hash",
    "root_from_leaf_hashes",
    "verify_inclusion",
    "fact_id",
    "facts_root",
    "pages_root",
    "parse_link",
    "root_hash",
    "semanto_id",
    "state_of",
    "tier_hash",
    "verify_checkpoint",
    "verify_consistency",
    "verify_inclusion_in_log",
    "verify_offer",
    "verify_page_proof",
    "verify_response",
    "verify_revocation_list",
    "verify_semanto",
    "verify_tree_head",
    "verify_web_bot_auth_request",
    "version_id",
]

__version__ = "0.1.0"
