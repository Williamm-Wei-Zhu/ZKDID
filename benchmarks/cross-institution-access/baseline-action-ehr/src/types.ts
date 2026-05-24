/**
 * Shared types for the ACTION-EHR-inspired access-control baseline.
 * Column order in each CSV row mirrors the spec exactly.
 */

export type ExperimentMode =
  | "grant-creation-devnet"
  | "grant-verification-devnet"
  | "end-to-end-access-authorization-devnet";

/** Mode 1: grant-creation-devnet */
export interface GrantCreationRecord {
  run_id: number;
  mode: "grant-creation-devnet";
  start_time_iso: string;
  grant_construct_ms: number;
  tx_build_ms: number;
  tx_submit_ms: number;
  tx_finality_ms: number;
  object_extract_ms: number;
  local_store_ms: number;
  total_ms: number;
  sui_tx_digest: string;
  access_grant_object_id: string;
  success: boolean;
  error_message: string;
}

/** Mode 2: grant-verification-devnet */
export interface GrantVerificationRecord {
  run_id: number;
  mode: "grant-verification-devnet";
  start_time_iso: string;
  request_construct_ms: number;
  blockchain_query_ms: number;
  grant_object_parse_ms: number;
  status_check_ms: number;
  scope_check_ms: number;
  expiration_check_ms: number;
  access_session_create_ms: number;
  total_ms: number;
  access_grant_object_id: string;
  success: boolean;
  error_message: string;
}

/** Mode 3: end-to-end-access-authorization-devnet */
export interface EndToEndRecord {
  run_id: number;
  mode: "end-to-end-access-authorization-devnet";
  start_time_iso: string;
  grant_construct_ms: number;
  tx_build_ms: number;
  tx_submit_ms: number;
  tx_finality_ms: number;
  object_extract_ms: number;
  request_construct_ms: number;
  blockchain_query_ms: number;
  grant_object_parse_ms: number;
  status_check_ms: number;
  scope_check_ms: number;
  expiration_check_ms: number;
  access_session_create_ms: number;
  total_ms: number;
  sui_tx_digest: string;
  access_grant_object_id: string;
  success: boolean;
  error_message: string;
}

/** Persisted grant entry (academic artifact only). */
export interface StoredAccessGrant {
  run_id: number;
  access_grant_object_id: string;
  transaction_digest: string;
  patient_id: string;
  hospital_a_id: string;
  hospital_b_id: string;
  ehr_record_id: string;
  scope: string;
  expires_at_ms: number;
  created_at_iso: string;
}

/** Persisted access request (audit-only artifact). */
export interface StoredAccessRequest {
  run_id: number;
  patient_id: string;
  hospital_b_id: string;
  hospital_b_address: string;
  hospital_a_id: string;
  ehr_record_id: string;
  requested_scope: string;
  access_grant_object_id: string;
  request_timestamp_iso: string;
}

/** The on-chain AccessGrant fields after parsing. */
export interface ResolvedAccessGrant {
  patient_id: string;
  data_holder_hospital_id: string;
  grantee_hospital_id: string;
  grantee_address: string;
  ehr_record_id: string;
  scope: string;
  created_at_ms: number;
  expires_at_ms: number;
  active: boolean;
}

/** Hospital A's authorized session. */
export interface AuthorizedAccessSession {
  session_id: string;
  patient_id: string;
  hospital_a_id: string;
  hospital_b_id: string;
  ehr_record_id: string;
  scope: string;
  created_at: string;
}

/** Reference to a gas coin -- mirrors `effects.gasObject.reference`. */
export interface GasCoinRef {
  objectId: string;
  version: string | number | bigint;
  digest: string;
}
