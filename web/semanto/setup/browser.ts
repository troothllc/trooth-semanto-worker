// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// The few browser facilities the wizard touches (visibility, focus, the
// clipboard, WebAuthn), behind small typed accessors. The worker repository
// typechecks web/ against the WebWorker library, which has no document or
// window; these keep the components honest in both places, and give the
// harness one seam. In trooth-web they read the real browser objects.

export interface VisibilityApi {
  hidden(): boolean;
  /** Calls back when the tab becomes visible again or the window regains focus; returns the unsubscribe. */
  onReturn(cb: () => void): () => void;
  /** Calls back when the tab is hidden; returns the unsubscribe. */
  onHide(cb: () => void): () => void;
}

interface DocLike {
  visibilityState?: string;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  title?: string;
}

interface WinLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const g = globalThis as unknown as { document?: DocLike; window?: WinLike; navigator?: NavigatorLike };

export const visibility: VisibilityApi = {
  hidden: () => g.document?.visibilityState === "hidden",
  onReturn(cb) {
    const onVis = () => {
      if (g.document?.visibilityState !== "hidden") cb();
    };
    g.document?.addEventListener("visibilitychange", onVis);
    g.window?.addEventListener("focus", cb);
    return () => {
      g.document?.removeEventListener("visibilitychange", onVis);
      g.window?.removeEventListener("focus", cb);
    };
  },
  onHide(cb) {
    const onVis = () => {
      if (g.document?.visibilityState === "hidden") cb();
    };
    g.document?.addEventListener("visibilitychange", onVis);
    return () => g.document?.removeEventListener("visibilitychange", onVis);
  },
};

interface NavigatorLike {
  clipboard?: { writeText(text: string): Promise<void> };
  credentials?: { get(options: unknown): Promise<unknown>; create(options: unknown): Promise<unknown> };
}

/** Writes text to the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!g.navigator?.clipboard) return false;
    await g.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A focus target, typed loosely so a callback ref of any element fits. */
export interface Focusable {
  focus(options?: { preventScroll?: boolean }): void;
}

/** The parts of a WebAuthn assertion the sign route checks (W3C WebAuthn Level 3, 7.2), every buffer base64url. */
export interface PasskeyAssertion {
  id: string;
  rawId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

/** A new passkey as POST passkeys takes it: PublicKeyCredential.toJSON() for create, every buffer base64url. */
export interface PasskeyCredential {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

const b64url = (buf: ArrayBuffer | null | undefined): string => {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** base64url text to bytes, for the buffers in the server's options. */
export function fromB64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class PasskeyError extends Error {
  constructor(message: "no_webauthn" | "cancelled") {
    super(message);
    this.name = "PasskeyError";
  }
}

type DescriptorJSON = { type: "public-key"; id: string; transports?: string[] };
const descriptors = (list: DescriptorJSON[] | undefined) => (list ?? []).map((d) => ({ type: d.type, id: fromB64url(d.id), ...(d.transports ? { transports: d.transports } : {}) }));

/**
 * Runs navigator.credentials.get with the options the sign/options route
 * gave (GitHub's passkey prompt: one device sheet, no extra screen). The
 * challenge is always the server's: it is bound to the version and root
 * hash being signed, and works once. Throws PasskeyError when the device has
 * no passkey support or the person cancels.
 */
export async function getPasskeyAssertion(publicKey: { challenge: string; rpId: string; allowCredentials?: DescriptorJSON[]; userVerification?: string; timeout?: number }): Promise<PasskeyAssertion> {
  const creds = g.navigator?.credentials;
  if (!creds) throw new PasskeyError("no_webauthn");
  let cred: unknown;
  try {
    cred = await creds.get({
      publicKey: {
        challenge: fromB64url(publicKey.challenge),
        rpId: publicKey.rpId,
        allowCredentials: descriptors(publicKey.allowCredentials),
        userVerification: "required",
        timeout: publicKey.timeout ?? 300_000,
      },
    });
  } catch {
    throw new PasskeyError("cancelled");
  }
  const c = cred as { id?: string; rawId?: ArrayBuffer; response?: { clientDataJSON?: ArrayBuffer; authenticatorData?: ArrayBuffer; signature?: ArrayBuffer; userHandle?: ArrayBuffer | null } } | null;
  if (!c || !c.response || !c.response.signature) throw new PasskeyError("cancelled");
  return {
    id: c.id ?? b64url(c.rawId),
    rawId: b64url(c.rawId),
    clientDataJSON: b64url(c.response.clientDataJSON),
    authenticatorData: b64url(c.response.authenticatorData),
    signature: b64url(c.response.signature),
    userHandle: c.response.userHandle ? b64url(c.response.userHandle) : null,
  };
}

/**
 * Runs navigator.credentials.create with the options the passkeys/options
 * route gave, and answers the credential for POST passkeys. Throws
 * PasskeyError when the device has no passkey support or the person cancels.
 */
export async function createPasskey(publicKey: {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: DescriptorJSON[];
  authenticatorSelection?: Record<string, unknown>;
  attestation?: string;
}): Promise<PasskeyCredential> {
  const creds = g.navigator?.credentials;
  if (!creds) throw new PasskeyError("no_webauthn");
  let cred: unknown;
  try {
    cred = await creds.create({
      publicKey: {
        rp: publicKey.rp,
        user: { id: fromB64url(publicKey.user.id), name: publicKey.user.name, displayName: publicKey.user.displayName },
        challenge: fromB64url(publicKey.challenge),
        pubKeyCredParams: publicKey.pubKeyCredParams,
        timeout: publicKey.timeout ?? 300_000,
        excludeCredentials: descriptors(publicKey.excludeCredentials),
        authenticatorSelection: publicKey.authenticatorSelection ?? { residentKey: "preferred", userVerification: "required" },
        attestation: publicKey.attestation ?? "none",
      },
    });
  } catch {
    throw new PasskeyError("cancelled");
  }
  const c = cred as { id?: string; rawId?: ArrayBuffer; response?: { clientDataJSON?: ArrayBuffer; attestationObject?: ArrayBuffer; getTransports?: () => string[] } } | null;
  if (!c || !c.response || !c.response.attestationObject) throw new PasskeyError("cancelled");
  let transports: string[] = [];
  try {
    transports = c.response.getTransports ? c.response.getTransports() : [];
  } catch {
    transports = [];
  }
  return { id: c.id ?? b64url(c.rawId), rawId: b64url(c.rawId), type: "public-key", response: { clientDataJSON: b64url(c.response.clientDataJSON), attestationObject: b64url(c.response.attestationObject), transports } };
}

export function setTitle(title: string): void {
  if (g.document) g.document.title = title;
}

export function later(cb: () => void, ms: number): () => void {
  const id = setTimeout(cb, ms);
  return () => clearTimeout(id);
}
