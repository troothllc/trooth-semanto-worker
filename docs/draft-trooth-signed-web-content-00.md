---
title: Signed Web Content Responses
abbrev: Signed Web Content
docname: draft-trooth-signed-web-content-00
category: std
submissiontype: IETF
ipr: trust200902
area: Web and Internet Transport
workgroup: Web Bot Auth
keyword:
  - HTTP
  - message signatures
  - provenance
  - transparency log
date: 2026-10

stand_alone: yes
smart_quotes: no
pi: [toc, sortrefs, symrefs]

author:
  -
    ins: D. Heggie
    name: D'Andre Heggie
    organization: Trooth LLC
    email: dandre@trooth.co

normative:
  RFC2119:
  RFC8174:
  RFC9421:
  RFC9530:
  RFC6962:
  RFC8785:
  RFC7515:
  RFC7638:
  RFC8037:
  RFC8615:
  RFC8288:
  RFC8552:
  RFC9110:

informative:
  I-D.ietf-webbotauth-httpsig-protocol:
  I-D.ietf-httpapi-deprecation-header:
  RFC8594:
  RFC9457:
  RFC6648:
  C2SP-CHECKPOINT:
    title: "Checkpoint format (C2SP tlog-checkpoint)"
    author:
      org: Community Cryptography Specification Project
    date: 2024
    target: https://github.com/C2SP/C2SP/blob/main/tlog-checkpoint.md

--- abstract

Web Bot Auth lets an automated client sign its HTTP request so an origin can tell who is asking. Nothing in that exchange signs the answer. This document specifies how an origin signs an HTTP response so that a client, or anyone it hands the response to, can check later that the content came from that origin, has not changed, and was the current version at the time. It profiles HTTP Message Signatures (RFC 9421) with Digest Fields (RFC 9530) for responses, defines two header fields that bind a response to a published content version, defines key discovery through a well-known JWK Set and a DNS record, defines validity windows and a revocation list, and defines how a response links to an inclusion proof in a public append-only log (RFC 6962). The mechanism is independent of the content format and of who serves the bytes.

--- note_Note_to_Readers

This is an individual submission. The Web Bot Auth working group is named as the intended venue because the mechanism is the response-side counterpart of the request signatures that group defines. Discussion is welcome on the working group list. Source and an open verifier in three languages are maintained by the author.

--- middle

# Introduction

An automated client that fetches a web page today can prove, with Web Bot Auth {{I-D.ietf-webbotauth-httpsig-protocol}}, who it is. The origin cannot prove anything back. The bytes the client receives may have been changed by an intermediary, served from a stale cache, rewritten by a conversion layer, or produced by a host that is not the publisher. When the client later quotes the content, nobody can tell whether the quote is what the publisher said.

This document gives the origin a way to sign the response. The signature is made with HTTP Message Signatures {{RFC9421}}, the same mechanism and the same key format Web Bot Auth uses for requests, so a client that already verifies request signatures can verify response signatures with the same code. The signature covers the status, the content type, a digest of the body {{RFC9530}}, and two header fields that name the content version and the content hash the publisher stands behind. Keys are discovered from the publisher's domain. A response can link to a proof that its content version is recorded in a public append-only log, so a reader can also check that it was the current version at the time and that the publisher cannot later deny having served it.

The mechanism signs bytes, not meaning. It proves who published content, when, and that it has not changed since. It does not say the content is true.

## Relationship to Web Bot Auth

Web Bot Auth signs the request with tag `web-bot-auth`, covering `@authority` and `Signature-Agent`, with keys at a directory the client names. This document signs the response with tag `signed-web-content`, covering the status and the body, with keys at a location derived from the publisher's domain. The two can be used together or alone. A response signed under this document is not a reply to a particular request and carries no request material; it is the same for every reader who receives the same bytes, which is what lets it be cached and shared.

## Relationship to other signed content

C2PA signs individual assets with manifests embedded in or linked from the asset. Signed HTTP Exchanges bundle a request and response for offline delivery. Transparency logs record certificates and software artifacts. This document composes existing pieces for ordinary HTTP responses: a message signature any HTTP library can produce, a body digest, a published key, and an optional log proof. It does not define a content format.

# Conventions and Definitions

{::boilerplate bcp14-tagged}

Publisher:
: The party that stands behind the content and holds the signing key. The publisher may or may not operate the server that serves the bytes.

Origin:
: The server that serves the response, in the sense of {{RFC9110}}.

Content version:
: A publisher-assigned identifier for a set of content as published at one time. A version identifier is opaque to this document, but a publisher SHOULD derive it from the content so that the same content always has the same identifier.

Content hash:
: The SHA-256 digest of the response body exactly as the publisher published it, written as `sha256:` followed by 64 lowercase hexadecimal characters.

Log:
: An append-only Merkle tree of leaves hashed per {{RFC6962}}, operated by the publisher or by a third party, whose tree heads are signed.

All JSON that is hashed or signed under this document is serialized with the JSON Canonicalization Scheme {{RFC8785}} before hashing or signing.

# Overview

A signed response carries, in addition to its ordinary fields:

- `Content-Digest` ({{RFC9530}}) over the body with the `sha-256` algorithm;
- `Content-Version`, the content version identifier ({{header-fields}});
- `Content-Hash`, the content hash ({{header-fields}});
- `Signature-Input` and `Signature` ({{RFC9421}}) with tag `signed-web-content`, covering the components in {{components}};
- optionally, `Link` relations to the signing keys and to a proof ({{links}}).

A verifier fetches the publisher's JWK Set, checks that the key is bound to the domain, verifies the signature base, verifies the body against `Content-Digest` and `Content-Hash`, checks the validity window and the revocation list, and, when a proof is linked, verifies the inclusion proof against a signed tree head.

# Signing a Response

## Covered Components {#components}

A signature under this document MUST cover at least these components, in any order:

- the derived component `@status`;
- the field `content-type`;
- the field `content-digest`;
- the field `content-version`;
- the field `content-hash`.

When any of the following fields is present in the response, the signature MUST cover it, because each changes what the response means: `location` (a redirect is signed like any other response), a field naming which party signed (when a party other than the publisher, such as a log operator or witness, may sign), and a field stating that the content is behind or not signed by the publisher. When `content-signal` or `link` is present the signature SHOULD cover it; a verifier MUST NOT rely on an uncovered `link` or `content-signal`. A verifier MUST reject a response that carries a field this paragraph requires to be covered when the signature does not cover it. Covered components follow the required ones, in a fixed order the publisher documents.

It MAY cover additional fields. It MUST NOT cover request-derived components such as `@method`, `@target-uri` or `@authority`, because the signed response is meant to be the same for every reader of the same bytes and to survive being stored and forwarded. A verifier that needs to bind a response to a URL does so through the content version and its proof, not through the signature.

## Signature Parameters

The signature parameters MUST include:

- `created`, the time of signing in seconds since the Unix epoch;
- `keyid`, the key identifier, which MUST be the RFC 7638 thumbprint {{RFC7638}} of the signing key;
- `alg`, which MUST be `ed25519`;
- `tag`, which MUST be `signed-web-content`.

`created` and `expires` MUST be Integers as defined by {{RFC9421}}; a verifier MUST reject a decimal, a string or any other type as malformed rather than coerce it.

The parameters SHOULD include `expires`. A signature without `expires` is valid as long as the key and the content version are valid. When responses are cached, `expires` SHOULD be at least `created` plus the response's `max-age` plus its `stale-while-revalidate`, so a response a cache may still serve still verifies; the implementation uses 300 plus 3600, 3900 seconds. The transport signature only says the bytes left the publisher unchanged; the freshness of what was said is carried by the content version's window and the revocation list ({{proofs}}), not by `expires`. The parameters MUST NOT include `nonce`; a response signature is not bound to a request.

Only Ed25519 is defined for this document. A verifier MUST reject a signature with any other `alg`.

## Content-Digest

The response MUST carry a `Content-Digest` field {{RFC9530}} with a `sha-256` entry over the exact body bytes sent. When a representation is sent with a content coding, the digest is over the representation data as defined in {{RFC9530}}; publishers SHOULD serve signed responses with the `identity` coding so the digest and the content hash are the same bytes.

## The Content-Version and Content-Hash Fields {#header-fields}

Two new response header fields bind the response to what the publisher published.

`Content-Version` is a String Structured Field whose value is the content version identifier. The format is publisher-defined and opaque to verifiers.

`Content-Hash` is a String Structured Field whose value is the SHA-256 of the exact body bytes of this response. It is always the digest of the body sent, for every representation, so a verifier can always check it. When the body is derived from a published page rather than being its bytes (for example the page's JSON-LD, or the page preceded by a notice that it is behind), the publisher SHOULD also send the page's published hash in a separate covered field (the implementation sends `Trooth-Signed-Page-Hash`), which the verifier checks against the proof. A verifier MUST compute SHA-256 over the body it received and compare it with `Content-Hash`. When the two differ, the response does not carry the published content, even if the signature verifies, because the signature could have been copied onto other bytes only by also copying `Content-Digest`, which would then fail; the check on `Content-Hash` protects against a publisher-side mismatch between what was published and what was signed.

Both fields use names without an `X-` prefix per {{RFC6648}}.

Implementation note: Trooth serves these fields as `Trooth-Semanto-Version` and `Trooth-Page-Hash`, with tag `trooth-semanto`, in deployed software predating this document. An implementation MAY accept those names as aliases. Once this document is adopted, the generic names are the ones to send.

## Links {#links}

A signed response SHOULD carry a `Link` field {{RFC8288}} with:

- `rel="signing-keys"`: the URL of the JWK Set that holds the signing key, when it differs from the default location in {{key-discovery}};
- `rel="content-proof"`: the URL of the proof document for this content version ({{proofs}}).

## Example

A response to `GET /security` with `Accept: text/markdown`:

~~~
HTTP/1.1 200 OK
Content-Type: text/markdown; charset=utf-8
Content-Length: 221
Content-Digest: sha-256=:YfSIot2m45x3ctsg60TBP+ccy1YRMZn5VNiAQtXSxBA=:
Content-Version: smv_sf26uv6f5niw6xllfj2i6ru6ym
Content-Hash: sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f954d
  88042d5d2c410
Link: </proofs/smp_mh2iriw5u3rzy53s3mqowrgbh7>; rel="content-proof"
Signature-Input: sig1=("@status" "content-type" "content-digest"
  "content-version" "content-hash" "link");created=1792670400;
  expires=1792674300;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";
  alg="ed25519";tag="signed-web-content"
Signature: sig1=:<Ed25519 signature over the base below>:

# Security at Acme

Every employee account uses multi-factor authentication.
~~~

The signature base, per {{RFC9421}}, is:

~~~
"@status": 200
"content-type": text/markdown; charset=utf-8
"content-digest": sha-256=:YfSIot2m45x3ctsg60TBP+ccy1YRMZn5VNiAQtXSxBA=:
"content-version": smv_sf26uv6f5niw6xllfj2i6ru6ym
"content-hash": sha256:61f488a2dda6e39c7772db20eb44c13fe71ccb56113199f
  954d88042d5d2c410
"link": </proofs/smp_mh2iriw5u3rzy53s3mqowrgbh7>; rel="content-proof"
"@signature-params": ("@status" "content-type" "content-digest"
  "content-version" "content-hash" "link");created=1792670400;
  expires=1792674300;keyid="F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI";
  alg="ed25519";tag="signed-web-content"
~~~

Line breaks inside field values above are for display only. The byte-stable signature for this response under the deployed field names (`Trooth-Semanto-Version`, `Trooth-Page-Hash`, tag `trooth-semanto`) is in the test vectors (`response.json`).

# Key Discovery {#key-discovery}

## The JWK Set

A publisher publishes its signing keys as a JWK Set at the well-known URI `/.well-known/signed-web-content-keys.json` on each domain whose content it signs ({{RFC8615}}). Each key is an OKP key with `crv` `Ed25519` {{RFC8037}}, `alg` `EdDSA`, `use` `sig`, and a `kid` equal to its RFC 7638 thumbprint. A key MAY carry `nbf` and `exp` members, ISO 8601 timestamps in UTC, bounding when it may be used, and a `revoked_at` member once it is withdrawn.

~~~
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "eSzna8JSYTi1wcIsGtPiRlWt9GSjLCv-85d5lG10PJ4",
      "kid": "F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI",
      "alg": "EdDSA",
      "use": "sig"
    }
  ]
}
~~~

The JWK Set MUST be served over HTTPS. It SHOULD be served with `Cache-Control` allowing caching for at least one hour and at most one day, so that rotation takes effect within a day while verifiers do not fetch it on every response.

Implementation note: Trooth publishes the set at `/.well-known/trooth-keys.json` in deployed software; see {{header-fields}}.

## The DNS Record

A JWK Set on a domain proves that whoever controls the web server published the key. To bind the key to the domain itself, independent of the web host, the publisher also publishes a TXT record at `_swc.<domain>`:

~~~
_swc.acme.com. IN TXT "v=swc1; kid=F46vbrrcJTQOgzWl4D8es3IgEPELxv7-Tldk6tp2qhI"
~~~

One record per key. A verifier that finds the signing key's `kid` both in the JWK Set and in a `_swc` record treats the key as bound to the domain. A verifier that finds it only in the JWK Set treats the key as bound to the host. Verifiers SHOULD report which binding they found rather than fail, because many publishers cannot edit DNS quickly; applications decide what binding they require.

Implementation note: Trooth uses `_trooth-keys.<domain>` with `v=trooth1` in deployed software.

## Key Rotation

A publisher rotates by adding the new key to the JWK Set and the DNS record, signing with it, and, after the longest `expires` it issued under the old key has passed, setting `revoked_at` on the old key or removing it. A key is judged at the moment it signed: the signature's `created`, or the `iat` of a JWS. A verifier MUST reject a signature whose signing moment is at or after the key's `revoked_at`, before its `nbf`, or at or after its `exp`. A key rotated out or revoked after it signed still verifies what it signed while it was valid, and a verifier SHOULD report that the key was revoked later. When a key is revoked because it was compromised, the publisher MUST set `revoked_at` to the earliest moment the compromise could have begun, so that everything signed from then on is refused, and SHOULD re-sign earlier content it wants carried by a live key.

A publisher's keys and a log operator's or witness's keys are different sets. A verifier MUST resolve a publisher's signature only against the publisher's JWK Set and a log or witness statement only against the operator's set, and MUST NOT merge the two, so a key of one party never signs for the other.

# Validity and Revocation

## Windows

A signature's `created` and `expires` bound the signature. A content version has its own window, carried in the version record the proof points to ({{proofs}}) as `not_before` and `not_after`. A verifier judges a response at a chosen instant, normally the time of verification, and reports one of: current, not yet valid, expired, withdrawn.

Publishers that retire a content version SHOULD announce it ahead of time the way APIs announce retirement: a `Deprecation` field {{I-D.ietf-httpapi-deprecation-header}} naming the date the version stopped being the current one, and a `Sunset` field {{RFC8594}} naming the date after which it will not be served. A reader that holds an older signed response can then tell whether it is merely superseded or no longer standing.

## The Revocation List

A publisher, or a log operator on behalf of publishers, publishes a revocation list: a compact JWS {{RFC7515}} with `alg` `EdDSA`, a `typ` naming the list type, and a canonical JSON payload:

~~~
{
  "issuer": "Trooth",
  "issued_at": "2026-10-22T12:00:00Z",
  "entries": [
    {
      "kind": "version",
      "ref": "smv_fixtureoneaaaaaaaaaaaaaaaaaaa",
      "revoked_at": "2026-10-20T12:00:00Z",
      "reason": "superseded"
    }
  ]
}
~~~

`kind` is `version`, `key`, or `record`. `ref` names the thing revoked. A verifier that has a current list treats a content version named in it, with `revoked_at` at or before the judging instant, as withdrawn, whatever the signature says. A revocation is a statement about the future, not the past: a response that passed every check before `revoked_at` stays a valid record of what was served at that time.

The list's location is published in the JWK Set document under a `revocations` member, or linked from the proof document. Lists SHOULD be appended to the log like any other record so that a withdrawn version cannot later be un-withdrawn in secret.

# Proofs {#proofs}

## What Is Proven

A signature proves that the publisher's key signed these bytes. It does not prove that the publisher did not also sign different bytes under the same version identifier for a different reader, or that this version was current at the time. An append-only log closes both gaps: every content version the publisher signs is appended as a leaf, tree heads are signed, and a reader checks that the version is in the log and that the log only grows.

## Leaves

A leaf is the canonical JSON of a leaf record:

~~~
{
  "kind": "content_version",
  "publisher": "acme",
  "ref": "smv_sf26uv6f5niw6xllfj2i6ru6ym",
  "hash": "sha256:9175ea57c5eb516f5d6b2a748f469ec33f8e3e0ea9cde9beacad4d
    b4226fbf76",
  "at": "2026-10-22T12:00:00Z"
}
~~~

The leaf hash is `SHA-256(0x00 || leaf)` and interior nodes are `SHA-256(0x01 || left || right)`, per {{RFC6962}} section 2.1. Inclusion and consistency proofs are those of {{RFC6962}} sections 2.1.1 and 2.1.2 and are checked with the procedures of sections 2.1.3 and 2.1.4.

`hash` is the digest of the canonical version record the publisher signed (the implementation names the member `trooth_id` where this document says `publisher`). For a multi-page site that record is itself a Merkle commitment to every page, so one leaf commits to the whole site; a per-page proof then carries the page's path to the site root and the site's path to the log root.

## Tree Heads and Checkpoints

A tree head is a compact JWS over the canonical payload `{ "log", "tree_size", "root_hash", "signed_at" }`, signed by the log operator's key with a `typ` naming it a tree head.

The same tree head MUST also be available as a checkpoint in the C2SP format {{C2SP-CHECKPOINT}}: the origin line, the tree size, the base64 root hash, a blank line, and a signature line. Verifiers and monitors built for other transparency logs can then consume this log without new code.

~~~
trooth.co/semanto/log/v1
5
LxwOGQofnBWw4LFRgj5REWmeauLzcTFOKOEcUTnpjOU=

— trooth.co <base64 of 4-byte key hash followed by the Ed25519 signature>
~~~

The first line is the log's origin, the signature line names the signer (the log operator), and the 4-byte key hash is the first four bytes of SHA-256 over the signer name, a newline, the byte 0x01 and the public key, so a verifier can pick the right key from a set. A verifier MUST check that the origin line is exactly the log it expects and that the signature line names the expected signer, using only the log operator's keys.

## The Proof Document

The `content-proof` link resolves to a JSON document that holds, for the content the response carried:

- `page_hash`: the content hash, and `inclusion`: its index, the size of the publisher's page tree and the inclusion path to `pages_root`;
- `root_hash` and `signature`: the digest of the canonical version record and the publisher's detached JWS over it; the version record itself is fetched beside the proof (the implementation serves it at `/versions/{n}` and names it the header);
- `witness` and `witnessed_at`: when a third party witnessed the version, its signed statement over `{ "root_hash", "witnessed_at" }`;
- `ledger`: the log name, the leaf index, the tree size, the leaf record and its hash, the inclusion path to the log root, and the signed tree head.

A verifier works outward: the bytes hash to `page_hash`; the page is in `pages_root`; the version record hashes to `root_hash` and lists the page; the publisher signed the version record; the leaf names `root_hash`; the leaf is under the tree head; the tree head is signed by the log. Each step is a hash comparison or an Ed25519 verification and needs no network once the documents and the keys are in hand. Every step is required: a proof without the version record, the publisher's signature, the witness statement (when the application requires a witness) or the log section fails, naming what is absent. An application MAY explicitly accept content not yet witnessed or not yet logged, and the verifier then reports which parts were absent. A JWS in the proof that carries an embedded payload MUST be refused unless that payload equals, byte for byte, the canonical record the verifier recomputed.

## Log Endpoints

A log serves at least:

- `GET <log>/tree-head` and `GET <log>/tree-head?size=<n>`: the current, or a historical, signed tree head;
- `GET <log>/checkpoint`: the current checkpoint in C2SP form;
- `GET <log>/proof?index=<i>&size=<n>`: an inclusion proof;
- `GET <log>/consistency?from=<m>&to=<n>`: a consistency proof.

Monitors fetch tree heads on a schedule, verify consistency between each pair, and raise an alarm when the log presents two tree heads of the same size with different roots or a consistency proof fails. A split view, where different readers are shown different logs, is detected by readers gossiping tree heads among themselves or with independent witnesses.

# Verification Procedure

Given a response with status `S`, header fields `H` and body `B`, judged at instant `T`:

1. Parse `Signature-Input` and `Signature`. Select the signature whose `tag` is `signed-web-content`. If none, the response is unsigned.
2. Reject if `created` or `expires` is not an Integer, if `alg` is not `ed25519`, if any required component in {{components}} is not covered, if a field that must be covered when present is present and not covered, if `T` is not before `expires`, or if `created` is more than a small skew in the future.
3. Resolve `keyid` to a key in the JWK Set of the party that signed: the publisher's, unless a covered field names the log operator or witness as the signer, then that party's set; never both. Reject if absent, or if at `created` the key was outside its `nbf`/`exp` window or at or past `revoked_at`. Record whether the `kid` also appears in the `_swc` DNS record.
4. Build the signature base per {{RFC9421}} and verify the Ed25519 signature.
5. Verify `Content-Digest` against `B`. Verify that SHA-256 of `B` equals `Content-Hash`.
6. If a `content-proof` link is present and the application wants it, fetch the proof document and verify it per {{proofs}} using the log's keys.
7. If a revocation list is available, check `Content-Version` against it.
8. Report, in order: what was checked, which key signed, how the key is bound, the version's state at `T`, and the log position.

A verifier MUST report the first failing step and MUST NOT present later steps as passed when an earlier one failed.

# Security Considerations

## Replay

A signed response is meant to be replayable: the point is that a reader can hold it and show it later. What must not be replayable is a stale version presented as current. That is why the signature has `expires`, the version has a window, the revocation list exists, and the log lets a reader check which version was current at a time. Applications that need freshness MUST check `expires` and SHOULD check the log; applications that need a record of what was said MAY accept an expired signature as a record of the past.

## Downgrade

A client that asks for a signed representation and receives an unsigned one has no way to tell, from the response alone, whether the publisher does not sign or an intermediary stripped the signature. Publishers that sign SHOULD say so in a long-lived place a stripper cannot reach: the DNS record's presence, or a policy member in the JWK Set document stating which paths are always signed. Clients that have seen a domain sign SHOULD treat an unsigned response from that domain as a failure rather than as plain content.

## Key Compromise

An attacker holding the publisher's private key can sign any content. The log limits the damage: every version the attacker signs that is appended to the log is visible to the publisher's own monitor, and a version served without appearing in the log is detectable by any reader who asks for its proof. Publishers SHOULD keep signing keys in hardware or a managed key service and MUST publish `revoked_at` promptly, set to the earliest moment of possible compromise. Verifiers MUST honor `revoked_at`, judged at the signing moment, and the revocation list.

## Request Signatures Through Intermediaries

A publisher may count reads by agents that sign their requests with {{I-D.ietf-webbotauth-httpsig-protocol}}. A verifier of such a request MUST pick exactly one signature by its tag and refuse a request with more than one, check that signature's parameters and nonce before fetching anything, fetch the agent's key directory only at the origin of `Signature-Agent` and only over HTTPS to a public address (refusing IP literals, private, reserved and local names, and checking the resolved addresses), refuse redirects, cap the size and time of the fetch, verify that one signature, and only then claim its nonce atomically. When an edge adapter on the publisher's domain forwards the request, the adapter forwards the agent's signature fields unchanged, names the authority the agent addressed in its own field, and signs the forwarding with its own key in separate signature fields that cover the agent's; the verifier checks the adapter's signature first and only then checks the agent's against the forwarded authority. An intermediary that cannot sign MUST NOT be trusted to forward an agent's identity.

## Cloaking and the Same-Content Requirement

Serving different content to different readers of the same URL is cloaking. This mechanism makes cloaking detectable but does not by itself prevent it: a publisher could sign two different versions. Two protections apply. First, the content version and the content hash are in the signature, so two readers who compare notes see the difference immediately. Second, the log records every version, so a monitor that fetches the URL under different identities and finds versions that are both signed but differ raises an alarm. Publishers MUST serve the same signed content to every reader of the same URL and representation. Choosing a representation by `Accept` is negotiation and is allowed; choosing it by `User-Agent` is not what this document covers, and verifiers that detect per-agent differences SHOULD report them.

## Privacy of Readers

Verification can be done without contacting the publisher: the JWK Set and the proof document can be fetched by anyone, cached, and shared, and the signature itself contains nothing about the reader. A verifier that fetches the proof document for a specific page tells the proof server which page it read. Verifiers that want to avoid this SHOULD fetch proofs through a cache, in bulk, or from a mirror of the log. Publishers MUST NOT include reader-identifying material in signed responses. Logs record what publishers published, never who read it.

## Canonicalization

Every signed JSON object is canonicalized with {{RFC8785}} before hashing or signing. Implementations MUST serialize integers only; a non-integer number is rejected, because implementations differ in floating point formatting and a disagreement would produce a different hash for the same value. Amounts are written in minor units.

# IANA Considerations

## HTTP Field Names

IANA is requested to register the following in the "Hypertext Transfer Protocol (HTTP) Field Name Registry":

- Field name: `Content-Version`; Status: permanent; Reference: this document, {{header-fields}}.
- Field name: `Content-Hash`; Status: permanent; Reference: this document, {{header-fields}}.

## Signature Tag

{{RFC9421}} defines the `tag` signature parameter as an application-chosen string and does not establish a registry. This document defines the tag `signed-web-content`. Should a registry of signature tags be established, IANA is requested to register `signed-web-content` with this document as the reference.

## Link Relation Types

IANA is requested to register the following in the "Link Relation Types" registry {{RFC8288}}:

- Relation name: `content-proof`; Description: a proof that the content of the response is recorded in an append-only log; Reference: this document, {{proofs}}.
- Relation name: `signing-keys`; Description: the JWK Set that holds the key that signed the response; Reference: this document, {{key-discovery}}.

## Well-Known URI

IANA is requested to register the following in the "Well-Known URIs" registry {{RFC8615}}:

- URI suffix: `signed-web-content-keys.json`; Change controller: IETF; Reference: this document, {{key-discovery}}; Status: permanent.

## Underscored DNS Node Name

IANA is requested to register the following in the "Underscored and Globally Scoped DNS Node Names" registry {{RFC8552}}:

- RR type: TXT; _NODE NAME: `_swc`; Reference: this document, {{key-discovery}}.

--- back

# Test Vectors

A set of byte-stable test vectors, with a fictional publisher, fixture keys, a signed response, a proof document, a five-leaf log with tree heads and a checkpoint, and negative cases (a changed body, an expired signature, an unknown key), is maintained with the author's open verifier. The response in {{components}} is taken from them. The vectors are judged at 2026-10-22T12:00:10Z.

# Acknowledgments
{:numbered="false"}

The mechanism composes the work of the HTTP Working Group on message signatures and digest fields, the Web Bot Auth Working Group on request signatures, the Certificate Transparency authors on Merkle proofs, and the transparency log community on the checkpoint format.
