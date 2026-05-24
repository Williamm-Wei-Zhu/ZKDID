/** Shared types for the zkEHR-protocol-harness. */

export interface EstablishmentRecord {
  run_id: number;
  mode: "zkehr-protocol-establish";
  start_time_iso: string;
  // --- Phase A: Pre-OAuth setup ---
  ephemeral_keygen_ms: number;
  epoch_fetch_ms: number;
  randomness_ms: number;
  nonce_compute_ms: number;
  // --- Phase B: OIDC ---
  oidc_login_ms: number;
  jwt_decode_ms: number;
  // --- Phase C: Multi-authority salt (zkEHR's defining feature) ---
  /** Total wall clock for parallel fan-out + merge. */
  salt_total_ms: number;
  /** Slowest single salt-service response (parallel-bound critical path). */
  salt_slowest_inst_ms: number;
  /** Mean of per-institution server-side compute times (Poseidon cost). */
  salt_mean_server_ms: number;
  /** Number of institutions queried. */
  salt_n_institutions: number;
  /** SHA-256 merge of N salts -> u128. Sub-millisecond. */
  salt_merge_ms: number;
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
  n_institutions: number;
  funded_at_iso: string;
}
