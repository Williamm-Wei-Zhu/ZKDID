/** Per-run record for the zkEHR cross-institution access experiment
 *  in NO-SESSION mode (full zkLogin authentication per measured run). */

export interface ZkehrNoSessionRunRecord {
  run_id: number;
  mode: "zkehr-cross-access-no-session";
  start_time_iso: string;

  // ----- Phase A-D: full zkLogin authentication (per run) -----
  ephemeral_keygen_ms: number;
  epoch_fetch_ms: number;
  randomness_ms: number;
  nonce_compute_ms: number;
  oidc_login_ms: number;
  jwt_decode_ms: number;
  salt_total_ms: number;
  salt_slowest_inst_ms: number;
  address_compute_ms: number;
  prover_request_ms: number;

  // ----- Phase E: build + submit DID-bound AccessGrant -----
  tx_build_ms: number;
  zklogin_sig_assemble_ms: number;
  tx_submit_ms: number;
  object_extract_ms: number;
  local_store_ms: number;
  grant_total_ms: number;

  // ----- Access phase (Hospital B → Hospital A with DID resolution) -----
  request_construct_ms: number;
  access_grant_query_ms: number;
  grant_object_parse_ms: number;
  patient_did_resolve_ms: number;
  hospital_b_did_resolve_ms: number;
  hospital_a_did_check_ms: number;
  status_check_ms: number;
  scope_check_ms: number;
  expiration_check_ms: number;
  access_session_create_ms: number;
  access_total_ms: number;

  // ----- End-to-end + provenance -----
  total_ms: number;
  zklogin_address: string;
  patient_did: string;
  hospital_b_did: string;
  sui_tx_digest: string;
  access_grant_object_id: string;
  success: boolean;
  error_message: string;
}
