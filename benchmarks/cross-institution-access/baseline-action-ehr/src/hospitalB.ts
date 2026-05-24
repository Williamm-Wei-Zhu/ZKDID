/**
 * Hospital B / Requesting Provider.
 *
 * Builds an access request to send to Hospital A. The request carries
 * everything Hospital A needs to look up the on-chain AccessGrant and
 * verify it covers Hospital B for this scope/record.
 */

import type { StoredAccessRequest } from "./types.js";

export interface BuildAccessRequestInput {
  run_id: number;
  patient_id: string;
  hospital_a_id: string;
  hospital_b_id: string;
  hospital_b_address: string;
  ehr_record_id: string;
  requested_scope: string;
  access_grant_object_id: string;
}

/** Hospital B builds the access request. The caller times this call as
 *  `request_construct_ms`. */
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
