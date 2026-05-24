/**
 * Hospital B — builds the access request to send to Hospital A. Carries
 * DID-bound identifiers (P-DID, A-DID, B-DID) plus B's Sui address and
 * the AccessGrant object id Hospital A will resolve.
 */

import type { StoredAccessRequest } from "./zkehrTypes.js";

export interface BuildAccessRequestInput {
  run_id: number;
  patient_did: string;
  hospital_a_did: string;
  hospital_b_did: string;
  hospital_b_address: string;
  ehr_record_id: string;
  requested_scope: string;
  access_grant_object_id: string;
}

export function buildAccessRequest(i: BuildAccessRequestInput): StoredAccessRequest {
  return {
    run_id: i.run_id,
    patient_did: i.patient_did,
    hospital_a_did: i.hospital_a_did,
    hospital_b_did: i.hospital_b_did,
    hospital_b_address: i.hospital_b_address,
    ehr_record_id: i.ehr_record_id,
    requested_scope: i.requested_scope,
    access_grant_object_id: i.access_grant_object_id,
    request_timestamp_iso: new Date().toISOString(),
  };
}
