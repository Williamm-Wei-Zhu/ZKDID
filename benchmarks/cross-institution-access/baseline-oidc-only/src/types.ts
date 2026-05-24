/**
 * Shared types for the OIDC-only experiments in this folder.
 *
 * Naming follows the column order required by the academic measurement spec.
 */

export type ExperimentMode = "full" | "reuse" | "cross-access";

/** One row of the per-run CSV output for the original baseline modes. */
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

/**
 * One row of the per-run CSV output for the cross-institution access experiment.
 *
 * Two phase totals are computed:
 *   grant_total_ms  = oidc_login + token_exchange + jwks + jwt_verify +
 *                     claim_validation + session_create + consent_create
 *   access_total_ms = b_request_build + a_verify_b_jwt + a_consent_lookup
 *
 * total_ms = grant_total_ms + access_total_ms (kept for completeness)
 */
export interface CrossAccessRunRecord {
  run_id: number;
  mode: "cross-access";
  start_time_iso: string;

  // --- Grant phase steps (Hospital A side) ---
  oidc_login_ms: number;
  token_exchange_ms: number;
  jwks_fetch_or_cache_ms: number;
  jwt_verify_ms: number;
  claim_validation_ms: number;
  session_create_ms: number;
  consent_create_ms: number;
  grant_total_ms: number;

  // --- Access phase steps (Hospital B → Hospital A) ---
  b_request_build_ms: number;
  a_verify_b_jwt_ms: number;
  a_consent_lookup_ms: number;
  access_total_ms: number;

  // --- End-to-end ---
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

/**
 * A consent grant stored in Hospital A's centralized consent database.
 *
 * Modeled on the standard healthcare-consent shape used in HL7 FHIR Consent /
 * UMA 2.0 grants: a triple (patient, grantee_institution, scope) with an
 * expiry. The `granted_by_session` link captures *which authenticated patient
 * session* created the grant — Hospital A only honors grants made through a
 * verified OIDC session of the patient.
 */
export interface ConsentGrant {
  consent_id: string;
  patient_subject: string;       // OIDC `sub` of the patient (issuer-scoped)
  patient_issuer: string;        // OIDC `iss` (so a sub from a different IdP can't collide)
  grantee_institution_id: string;
  scope: string;                 // e.g. "ehr.read"
  granted_by_session: string;    // EHR session id at Hospital A
  issued_at_ms: number;
  expires_at_ms: number;
  jti?: string;                  // optional opaque grant id
}

/** Cached cross-institution state shared between phases (and across runs). */
export interface CrossAccessCache {
  /** A successful patient OIDC ID token, captured during a previous full-login. */
  id_token: string;
  /** The nonce used when that ID token was minted (so reuse-style verification works). */
  nonce?: string;
  cached_at_iso: string;
}
