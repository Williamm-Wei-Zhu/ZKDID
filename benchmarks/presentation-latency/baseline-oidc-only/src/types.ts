/**
 * Shared types for the OIDC-only baseline experiment.
 *
 * Naming follows the column order required by the academic measurement spec.
 */

export type ExperimentMode = "full" | "reuse";

/** One row of the per-run CSV output. */
export interface RunRecord {
  run_id: number;
  mode: ExperimentMode;
  start_time_iso: string;
  oidc_login_ms: number;
  token_exchange_ms: number;
  jwks_fetch_or_cache_ms: number;
  jwt_verify_ms: number;
  claim_validation_ms: number;
  session_create_ms: number;
  total_ms: number;
  success: boolean;
  error_message: string;
}

/** Shape of the verified-token claims we inspect in the experiment. */
export interface VerifiedClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [k: string]: unknown;
}

/** Local "EHR session" object created after successful identity verification. */
export interface EhrSession {
  session_id: string;
  subject: string;
  issuer: string;
  audience: string | string[];
  email?: string;
  name?: string;
  issued_at_ms: number;
  expires_at_ms: number;
}

/** Tokens captured from the OIDC token endpoint. */
export interface TokenSet {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Cached state shared between full-login and reuse experiments. */
export interface SessionCache {
  id_token: string;
  nonce?: string;
  cached_at_iso: string;
}
