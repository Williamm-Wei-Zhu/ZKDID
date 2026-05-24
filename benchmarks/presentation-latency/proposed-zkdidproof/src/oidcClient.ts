/**
 * OIDC client primitives: PKCE, state/nonce generation, authorization URL,
 * and authorization-code -> token exchange.
 *
 * No external OIDC SDK is used. The primitives here are deliberately small
 * so the measurement is reproducible from first principles.
 */

import { createHash, randomBytes } from "node:crypto";
import type { TokenSet } from "./types.js";

/** Base64-URL (RFC 7636 / RFC 4648 §5) without padding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface PkcePair {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: "S256";
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { code_verifier: verifier, code_challenge: challenge, code_challenge_method: "S256" };
}

export function generateState(): string {
  return b64url(randomBytes(16));
}

export function generateNonce(): string {
  return b64url(randomBytes(16));
}

export interface AuthUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  pkce: PkcePair;
  /** When set, forces account selection — useful for repeat measurement runs on Google. */
  prompt?: string;
}

export function buildAuthorizationUrl(i: AuthUrlInput): string {
  const u = new URL(i.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", i.clientId);
  u.searchParams.set("redirect_uri", i.redirectUri);
  u.searchParams.set("scope", i.scope);
  u.searchParams.set("state", i.state);
  u.searchParams.set("nonce", i.nonce);
  u.searchParams.set("code_challenge", i.pkce.code_challenge);
  u.searchParams.set("code_challenge_method", i.pkce.code_challenge_method);
  if (i.prompt) u.searchParams.set("prompt", i.prompt);
  return u.toString();
}

export interface TokenExchangeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

/**
 * Exchange the authorization code for a token set.
 *
 * Uses HTTP Basic auth when client_secret is provided (common for confidential
 * clients); otherwise sends client_id in the body (public-client / PKCE-only).
 */
export async function exchangeCodeForTokens(i: TokenExchangeInput): Promise<TokenSet> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", i.code);
  body.set("redirect_uri", i.redirectUri);
  body.set("code_verifier", i.codeVerifier);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (i.clientSecret && i.clientSecret.length > 0) {
    const basic = Buffer.from(`${i.clientId}:${i.clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  } else {
    body.set("client_id", i.clientId);
  }

  const res = await fetch(i.tokenEndpoint, { method: "POST", headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token endpoint returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON body: ${text.slice(0, 500)}`);
  }
  const t = json as Partial<TokenSet>;
  if (typeof t.id_token !== "string" || t.id_token.length === 0) {
    throw new Error(`Token response missing id_token: ${text.slice(0, 500)}`);
  }
  return {
    id_token: t.id_token,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    token_type: t.token_type,
    expires_in: t.expires_in,
    scope: t.scope,
  };
}
