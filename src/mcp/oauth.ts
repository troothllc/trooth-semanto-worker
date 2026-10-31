// SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
// Copyright (c) 2026 Trooth, LLC
//
// SIGN-IN FOR THE SEMANTO MCP SERVER: https://api.trooth.co/os/semanto/mcp as an OAuth 2.0 protected resource, the
// way the MCP authorization specification (2025-11-25, basic/authorization) asks and the way Stripe's, Supabase's and
// GitHub's remote servers do it, so Claude.ai, Claude Desktop and ChatGPT add it by signing in instead of with a key.
//
//   - an unauthenticated request answers 401 with WWW-Authenticate naming this resource's metadata (RFC 9728), which
//     names the authorization server: WorkOS AuthKit, the same one that signs people in to trooth.co and that the
//     Trooth Network MCP server (/public/mcp) already uses. One Trooth sign-in, two servers, each its own resource,
//     as Cloudflare runs one server per product behind one account sign-in;
//   - the client registers itself (dynamic client registration or a client ID metadata document, both of which
//     AuthKit offers) and asks for a token for this resource (RFC 8707), so the token's audience is this server;
//   - every token is checked here before anything else: the shape, an algorithm this server chose (RS256 or ES256,
//     no key named inside the token), the issuer, the signature with a key from the issuer's own metadata, expiry,
//     the audience, and a client id (RFC 9700, the OAuth security BCP);
//   - the token's subject is the WorkOS user, which trooth.co linked to the person's Trooth workspace when they
//     signed in (worker-f's oauth_subject_links, read from its database), with the role they hold there.
//
// A signed-in AI tool acts as that person but is still an agent: it is refused what only a person may do, as an
// agent key is (src/serve/routes.ts PEOPLE_ONLY_ROUTES), and the audit trail names the person and the AI tool.

export const SEMANTO_MCP_RESOURCE = "https://api.trooth.co/os/semanto/mcp";
export const SEMANTO_MCP_METADATA_URL = "https://api.trooth.co/.well-known/oauth-protected-resource/os/semanto/mcp";

/** The RFC 9728 document for this resource, or null when no authorization server is configured. */
export function protectedResourceMetadata(issuer: string | null): Record<string, unknown> | null {
  if (!issuer) return null;
  return {
    resource: SEMANTO_MCP_RESOURCE,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Semanto by Trooth",
    resource_documentation: "https://trooth.co/docs/semanto#mcp",
  };
}

/** The challenge a request without a working credential gets (RFC 9728 section 5.1, RFC 6750 section 3). */
export function wwwAuthenticate(error?: "invalid_token", description?: string): string {
  const parts = [`resource_metadata="${SEMANTO_MCP_METADATA_URL}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/["\\]/g, "").slice(0, 200)}"`);
  return `Bearer ${parts.join(", ")}`;
}

export interface OAuthPrincipal {
  issuer: string;
  subject: string;
  clientId: string;
  expiresAt: number;
}

export type TokenVerdict = { ok: true; principal: OAuthPrincipal } | { ok: false; status: 401 | 503; description: string };

/** Does a bearer look like a JWT access token (not an agent key, not a session token)? */
export const looksLikeJwt = (token: string): boolean => /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };
type AsMeta = { issuer: string; jwks_uri: string };
const ALGS: Record<string, { kty: string; importAlg: RsaHashedImportParams | EcKeyImportParams; verifyAlg: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: { kty: "RSA", importAlg: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAlg: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", importAlg: { name: "ECDSA", namedCurve: "P-256" }, verifyAlg: { name: "ECDSA", hash: "SHA-256" } },
};
const LEEWAY_S = 60;
const CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 4000;

export interface OAuthVerifierDeps {
  issuer: string;
  /** fetch for the issuer's metadata and keys; tests pass their own. */
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
}

function b64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
function b64urlJson(s: string): Record<string, unknown> | null {
  const b = b64url(s);
  if (!b) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Checks AuthKit access tokens for this resource. Metadata and keys are cached for ten minutes per isolate. */
export class OAuthVerifier {
  private meta: { at: number; value: AsMeta } | null = null;
  private keys: { at: number; value: Jwk[] } | null = null;
  constructor(private readonly d: OAuthVerifierDeps) {}

  private get(url: string): Promise<Response> {
    return this.d.fetch ? this.d.fetch(url) : fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  }
  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private async metadata(): Promise<AsMeta | null> {
    if (this.meta && this.now() - this.meta.at < CACHE_MS) return this.meta.value;
    try {
      const u = new URL(this.d.issuer);
      const res = await this.get(`${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/+$/, "")}`);
      if (!res.ok) return null;
      const m = (await res.json()) as AsMeta;
      // RFC 8414 3.3: the document's issuer is the issuer asked about, and its keys are on https.
      if (!m || m.issuer !== this.d.issuer || typeof m.jwks_uri !== "string" || !m.jwks_uri.startsWith("https://")) return null;
      this.meta = { at: this.now(), value: m };
      return m;
    } catch {
      return null;
    }
  }

  private async key(kid: string): Promise<Jwk | null> {
    const find = (list: Jwk[]) => list.find((k) => k.kid === kid && k.use !== "enc") ?? null;
    if (this.keys && this.now() - this.keys.at < CACHE_MS) {
      const k = find(this.keys.value);
      if (k) return k;
    }
    const m = await this.metadata();
    if (!m) return null;
    try {
      const res = await this.get(m.jwks_uri);
      if (!res.ok) return this.keys ? find(this.keys.value) : null;
      const body = (await res.json()) as { keys?: Jwk[] };
      this.keys = { at: this.now(), value: Array.isArray(body?.keys) ? body.keys : [] };
      return find(this.keys.value);
    } catch {
      return null;
    }
  }

  async verify(token: string): Promise<TokenVerdict> {
    const no = (description: string): TokenVerdict => ({ ok: false, status: 401, description });
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 16_384) return no("The access token is not a signed JWT.");
    const header = b64urlJson(parts[0]!);
    const payload = b64urlJson(parts[1]!);
    const sig = b64url(parts[2]!);
    if (!header || !payload || !sig || sig.length === 0) return no("The access token is not a signed JWT.");
    const alg = ALGS[String(header.alg)];
    if (!alg) return no("The token's algorithm is not one this server accepts.");
    if (["jku", "jwk", "x5u", "x5c", "crit"].some((k) => k in header)) return no("Keys come only from the issuer's metadata.");
    if (typeof header.kid !== "string" || !header.kid) return no("The token names no key id.");
    if (payload.iss !== this.d.issuer) return no("The token was not issued by Trooth's sign-in.");
    const jwk = await this.key(header.kid);
    if (!jwk) return (await this.metadata()) ? no("No key from the issuer matches this token.") : { ok: false, status: 503, description: "Trooth's sign-in could not be reached. Try again." };
    if (jwk.kty !== alg.kty || (jwk.alg && jwk.alg !== header.alg)) return no("No key from the issuer matches this token.");
    let valid = false;
    try {
      const { kid: _kid, use: _use, alg: _alg, ...material } = jwk;
      const cryptoKey = await crypto.subtle.importKey("jwk", material, alg.importAlg, false, ["verify"]);
      valid = await crypto.subtle.verify(alg.verifyAlg, cryptoKey, new Uint8Array(sig), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    } catch {
      valid = false;
    }
    if (!valid) return no("The token's signature does not check out.");
    const now = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < now) return no("The access token has expired. Sign in again.");
    if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > now) return no("The access token is not valid yet.");
    const aud = payload.aud;
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.includes(SEMANTO_MCP_RESOURCE)) return no("The token was issued for another server, not the Semanto MCP server.");
    const clientId = typeof payload.client_id === "string" ? payload.client_id : typeof payload.azp === "string" ? payload.azp : "";
    if (!clientId) return no("The token names no client.");
    if (typeof payload.sub !== "string" || !payload.sub) return no("The token names no person.");
    return { ok: true, principal: { issuer: this.d.issuer, subject: payload.sub, clientId, expiresAt: payload.exp } };
  }
}

/** The Trooth workspace a signed-in person belongs to, as trooth.co linked it at sign-in. */
export interface SubjectLink {
  os_company_id: string;
  user_id: string;
  email: string | null;
  /** The person's role in that workspace on trooth.co: owner, admin, editor or viewer. */
  role: string | null;
}
export interface SubjectLinks {
  find(issuer: string, subject: string): Promise<SubjectLink | null>;
}

/** Reads worker-f's database (trooth_os_prod), which records the link when a person signs in to trooth.co. Read only. */
export class D1SubjectLinks implements SubjectLinks {
  constructor(private readonly db: D1Database) {}
  async find(issuer: string, subject: string): Promise<SubjectLink | null> {
    try {
      const row = await this.db
        .prepare(
          `SELECT l.company_id AS os_company_id, l.user_id AS user_id, u.email AS email, m.role AS role
             FROM oauth_subject_links l
             LEFT JOIN app_users u ON u.user_id = l.user_id
             LEFT JOIN app_memberships m ON m.company_id = l.company_id AND lower(m.email) = lower(u.email)
            WHERE l.issuer = ?1 AND l.subject = ?2`,
        )
        .bind(issuer, subject.slice(0, 200))
        .first<SubjectLink>();
      return row ?? null;
    } catch {
      return null;
    }
  }
}

export class MemorySubjectLinks implements SubjectLinks {
  readonly rows = new Map<string, SubjectLink>();
  async find(issuer: string, subject: string): Promise<SubjectLink | null> {
    return this.rows.get(`${issuer} ${subject}`) ?? null;
  }
}

/** The Semanto workspace role for a trooth.co role: editors run things, viewers only read, anyone else reads. */
export function semantoRole(role: string | null): "owner" | "admin" | "member" | "viewer" {
  return role === "owner" ? "owner" : role === "admin" ? "admin" : role === "editor" ? "member" : "viewer";
}
