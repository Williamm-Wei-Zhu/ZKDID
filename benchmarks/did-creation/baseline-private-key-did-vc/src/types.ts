/**
 * Shared types for the Private-key DID/VC baseline.
 * Column order in each CSV row mirrors the spec exactly.
 */

export type ExperimentMode = "did-establishment-devnet" | "challenge-auth-devnet" | "vc";

export interface DidEstablishmentRecord {
  run_id: number;
  mode: "did-establishment-devnet";
  start_time_iso: string;
  keygen_ms: number;
  did_derivation_ms: number;
  did_document_create_ms: number;
  tx_build_ms: number;
  tx_submit_ms: number;
  tx_finality_ms: number;
  object_extract_ms: number;
  local_store_ms: number;
  total_ms: number;
  sui_tx_digest: string;
  sui_object_id: string;
  success: boolean;
  error_message: string;
}

export interface ChallengeAuthRecord {
  run_id: number;
  mode: "challenge-auth-devnet";
  start_time_iso: string;
  challenge_create_ms: number;
  sign_challenge_ms: number;
  did_resolve_devnet_ms: number;
  did_object_parse_ms: number;
  signature_verify_ms: number;
  patient_mapping_ms: number;
  session_create_ms: number;
  total_ms: number;
  sui_object_id: string;
  success: boolean;
  error_message: string;
}

export interface VcRecord {
  run_id: number;
  mode: "vc";
  start_time_iso: string;
  vc_create_ms: number;
  vc_sign_ms: number;
  vc_verify_ms: number;
  total_ms: number;
  success: boolean;
  error_message: string;
}

/** Persisted wallet entry (academic artifact only — not for production). */
export interface StoredWallet {
  did: string;
  public_key_hex: string;
  /** Bech32 `suiprivkey1...` exported by Sui SDK. */
  secret_key_bech32: string;
  sui_address: string;
}

/** Persisted DID entry pointing at the on-chain object. */
export interface StoredDid {
  did: string;
  sui_object_id: string;
  sui_tx_digest: string;
  controller_address: string;
  created_at_iso: string;
}

export interface DidDocument {
  "@context": string[];
  id: string;
  controller: string;
  verificationMethod: Array<{
    id: string;
    type: "Ed25519VerificationKey2020";
    controller: string;
    publicKeyMultibase?: string;
    publicKeyHex: string;
  }>;
  authentication: string[];
  service?: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}
