/** Types specific to the zkEHR cross-institution access experiment. */

export interface RegisteredHospitalDid {
  did: string;                  // e.g., "did:zkehr:hospital:hospital_A"
  sui_object_id: string;        // on-chain DIDObject id
  controller_address: string;   // Sui address that registered the DID
  sui_tx_digest: string;
  created_at_iso: string;
}

export interface HospitalDidRegistry {
  hospital_a: RegisteredHospitalDid;
  hospital_b: RegisteredHospitalDid;
}

export interface ResolvedDidObject {
  did: string;
  public_key: Uint8Array;
  controller: string;
  metadata: Uint8Array;
  active: boolean;
}

export interface ResolvedAccessGrant {
  patient_id: string;             // P-DID string
  data_holder_hospital_id: string;// A-DID string
  grantee_hospital_id: string;    // B-DID string
  grantee_address: string;        // B's Sui address (for additional binding)
  ehr_record_id: string;
  scope: string;
  created_at_ms: number;
  expires_at_ms: number;
  active: boolean;
  /** AddressOwner of the on-chain object — equals patient's zkLogin address. */
  on_chain_owner: string;
}

export interface StoredAccessGrant {
  run_id: number;
  access_grant_object_id: string;
  transaction_digest: string;
  zklogin_address: string;
  patient_did: string;
  hospital_a_did: string;
  hospital_b_did: string;
  ehr_record_id: string;
  scope: string;
  expires_at_ms: number;
  created_at_iso: string;
}

export interface StoredAccessRequest {
  run_id: number;
  patient_did: string;
  hospital_a_did: string;
  hospital_b_did: string;
  hospital_b_address: string;
  ehr_record_id: string;
  requested_scope: string;
  access_grant_object_id: string;
  request_timestamp_iso: string;
}

export interface AuthorizedAccessSession {
  session_id: string;
  patient_did: string;
  hospital_a_did: string;
  hospital_b_did: string;
  ehr_record_id: string;
  scope: string;
  created_at: string;
}

/**
 * Per-run record for the zkEHR cross-institution access experiment.
 * In session-reuse mode (default), the zkLogin authentication phases
 * (A–D) are paid ONCE outside the loop; the per-run grant phase only
 * covers the on-chain Move-call submission.
 */
export interface ZkehrCrossAccessRunRecord {
  run_id: number;
  mode: "zkehr-cross-access";
  start_time_iso: string;

  // ----- Grant phase: build + submit DID-bound AccessGrant -----
  tx_build_ms: number;
  zklogin_sig_assemble_ms: number;
  tx_submit_ms: number;
  object_extract_ms: number;
  local_store_ms: number;
  grant_total_ms: number;

  // ----- Access phase: Hospital A verifies via DID resolution -----
  request_construct_ms: number;
  access_grant_query_ms: number;        // getObject for the AccessGrant
  grant_object_parse_ms: number;
  patient_did_resolve_ms: number;       // parse zkLogin DID + check on-chain owner
  hospital_b_did_resolve_ms: number;    // getObject for B-DID
  hospital_a_did_check_ms: number;      // local self-check
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
