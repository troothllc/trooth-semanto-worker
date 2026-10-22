// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// Types for sign-request.mjs.

export const CONNECTOR_TAG: string;
export const CONNECTOR_COMPONENTS: readonly string[];
export const FORWARDING_COMPONENTS: readonly string[];
export function randomNonce(): string;

export interface ConnectorPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}
export interface ConnectorPrivateJwk extends ConnectorPublicJwk {
  d: string;
}

export function thumbprint(jwk: { x: string }): Promise<string>;
export function generateConnectorKey(): Promise<{ publicJwk: ConnectorPublicJwk; privateJwk: ConnectorPrivateJwk }>;
export function contentDigest(bodyBytes: Uint8Array): Promise<string>;
export function signPost(options: {
  url: string;
  body: string | Uint8Array;
  contentType?: string;
  privateJwk: ConnectorPrivateJwk;
  created?: number;
  ttlSeconds?: number;
  label?: string;
  nonce?: string;
}): Promise<{ "Content-Type": string; "Content-Digest": string; "Signature-Input": string; Signature: string }>;
export function signForwarding(options: {
  method?: string;
  url: string;
  headers: Headers | Record<string, string>;
  privateJwk: ConnectorPrivateJwk;
  created?: number;
  ttlSeconds?: number;
  label?: string;
  nonce?: string;
}): Promise<{ "Trooth-Connector-Signature-Input": string; "Trooth-Connector-Signature": string }>;
export function postSigned(options: { url: string; document: unknown; privateJwk: ConnectorPrivateJwk; fetchImpl?: typeof fetch }): Promise<Response>;
