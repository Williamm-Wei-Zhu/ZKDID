/** Shared types for the zkLogin cross-institution access baseline. */

export interface EstablishmentRecord {
  run_id: number;
  mode: "zklogin-establish";
  start_time_iso: string;
  // --- Phase A: Pre-OAuth setup ---
  ephemeral_keygen_ms: number;
  epoch_fetch_ms: number;
  randomness_ms: number;
  nonce_compute_ms: number;
  // --- Phase B: OIDC ---
  oidc_login_ms: number;
  jwt_decode_ms: number;
  // --- Phase C: Salt ---
  salt_fetch_ms: number;
  // --- Phase D: zkLogin proof + address ---
  address_compute_ms: number;
  prover_request_ms: number;
  // --- Phase E: On-chain registration ---
  tx_build_ms: number;
  zklogin_sig_assemble_ms: number;
  tx_submit_ms: number;
  object_extract_ms: number;
  // --- Totals ---
  total_ms: number;
  // --- Provenance ---
  zklogin_address: string;
  sui_tx_digest: string;
  sui_object_id: string;
  success: boolean;
  error_message: string;
}

export interface StoredSession {
  google_sub: string;
  google_aud: string;
  zklogin_address: string;
  funded_at_iso: string;
}

/**
 * Per-run record for the zkLogin cross-institution access experiment.
 *
 * Two phase totals are computed:
 *   grant_total_ms  = ephemeral_keygen + epoch_fetch + randomness + nonce_compute +
 *                     oidc_login + jwt_decode + salt_fetch +
 *                     address_compute + prover_request + tx_build +
 *                     zklogin_sig_assemble + tx_submit + object_extract +
 *                     local_store
 *   access_total_ms = request_construct + blockchain_query + grant_object_parse +
 *                     status_check + scope_check + expiration_check +
 *                     address_authorization_check + access_session_create
 *
 * total_ms = grant_total_ms + access_total_ms.
 */
export interface CrossAccessRunRecord {
  run_id: number;
  mode: "zklogin-cross-access";
  start_time_iso: string;

  // ----- Grant phase: zkLogin authentication + create AccessGrant -----
  ephemeral_keygen_ms: number;
  epoch_fetch_ms: number;
  randomness_ms: number;
  nonce_compute_ms: number;
  oidc_login_ms: number;
  jwt_decode_ms: number;
  salt_fetch_ms: number;
  address_compute_ms: number;
  prover_request_ms: number;
  tx_build_ms: number;
  zklogin_sig_assemble_ms: number;
  tx_submit_ms: number;
  object_extract_ms: number;
  local_store_ms: number;
  grant_total_ms: number;

  // ----- Access phase: Hospital B request + Hospital A verify -----
  request_construct_ms: number;
  blockchain_query_ms: number;
  grant_object_parse_ms: number;
  status_check_ms: number;
  scope_check_ms: number;
  expiration_check_ms: number;
  address_authorization_check_ms: number;
  access_session_create_ms: number;
  access_total_ms: number;

  // ----- End-to-end + diagnostics -----
  total_ms: number;
  zklogin_address: string;
  sui_tx_digest: string;
  access_grant_object_id: string;
  success: boolean;
  error_message: string;
}

/** A grant entry persisted across runs (audit trail). */
export interface StoredAccessGrant {
  run_id: number;
  access_grant_object_id: string;
  transaction_digest: string;
  zklogin_address: string;
  patient_id: string;
  hospital_a_id: string;
  hospital_b_id: string;
  ehr_record_id: string;
  scope: string;
  expires_at_ms: number;
  created_at_iso: string;
}

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

/** The on-chain AccessGrant fields after parsing, plus the on-chain owner. */
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
  /** AddressOwner extracted from the response — equal to the patient's
   *  zkLogin Sui address for any grant minted by the patient. */
  on_chain_owner: string;
}

export interface AuthorizedAccessSession {
  session_id: string;
  patient_id: string;
  hospital_a_id: string;
  hospital_b_id: string;
  ehr_record_id: string;
  scope: string;
  created_at: string;
}
