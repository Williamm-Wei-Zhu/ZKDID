/**
 * Hospital B / Requesting Provider — builds the access request to send
 * to Hospital A. Same shape as the ACTION-EHR-inspired baseline, except
 * the patient identity is the patient's zkLogin Sui address.
 */

import type { StoredAccessRequest } from "./types.js";

export interface BuildAccessRequestInput {
  run_id: number;
  patient_id: string;             // patient zkLogin Sui address (string form)
  hospital_a_id: string;
  hospital_b_id: string;
  hospital_b_address: string;
  ehr_record_id: string;
  requested_scope: string;
  access_grant_object_id: string;
}

export function buildAccessRequest(i: BuildAccessRequestInput): StoredAccessRequest {
  return {
    run_id: i.run_id,
    patient_id: i.patient_id,
    hospital_b_id: i.hospital_b_id,
    hospital_b_address: i.hospital_b_address,
    hospital_a_id: i.hospital_a_id,
    ehr_record_id: i.ehr_record_id,
    requested_scope: i.requested_scope,
    access_grant_object_id: i.access_grant_object_id,
    request_timestamp_iso: new Date().toISOString(),
  };
}
