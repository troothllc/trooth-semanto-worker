// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The app's request signing: RFC 9421 HTTP Message Signatures with an RFC 9530
// Content-Digest, Ed25519, tag trooth-connector, covering "@method"
// "@target-uri" "content-digest" "content-type", with created, expires, keyid
// (the RFC 7638 thumbprint), alg and a fresh nonce. It is not a second copy:
// it is the repository's one connector signer, adapters/shared/sign-request.mjs,
// which the commerce scripts and host adapters already use and the Worker's
// tests check against src/core/httpsig.ts. test/sign.test.ts runs this module's
// output through the Worker's verifyMessage and verifyContentDigest byte for
// byte. Every attempt is signed afresh, so a retry never reuses a nonce the
// Worker has already claimed.

import { generateConnectorKey, signPost, thumbprint, CONNECTOR_TAG, CONNECTOR_COMPONENTS } from "../../../../adapters/shared/sign-request.mjs";
import type { ConnectorPrivateJwk, ConnectorPublicJwk } from "../../../../adapters/shared/sign-request.mjs";

export { generateConnectorKey, signPost, thumbprint, CONNECTOR_TAG, CONNECTOR_COMPONENTS };
export type { ConnectorPrivateJwk, ConnectorPublicJwk };

/** The headers and the exact body bytes of one signed JSON POST. */
export async function signJson(url: string, document: unknown, privateJwk: ConnectorPrivateJwk, now: Date = new Date()): Promise<{ body: string; headers: Record<string, string> }> {
  const body = JSON.stringify(document);
  const headers = await signPost({ url, body, privateJwk, created: Math.floor(now.getTime() / 1000) });
  return { body, headers: { ...headers } };
}

/** The public half of a private connector JWK, as the connect session sends it. */
export function publicOf(privateJwk: ConnectorPrivateJwk): ConnectorPublicJwk {
  const { d: _d, ...pub } = privateJwk;
  return pub;
}
