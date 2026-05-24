/**
 * Hospital A / Data-Holding Provider.
 *
 * On receipt of an access request from Hospital B:
 *   1. queries Sui Devnet for the named AccessGrant object;
 *   2. verifies grant.active, patient_id, data_holder, grantee_id,
 *      grantee_address, ehr_record_id, scope, expiration;
 *   3. if all checks pass, creates a mock authorized EHR access session.
 *
 * Each verification step is a separate function so the experiment can time
 * status_check_ms vs scope_check_ms vs expiration_check_ms independently.
 */

import { randomUUID } from "node:crypto";
import type {
  AuthorizedAccessSession,
  ResolvedAccessGrant,
  StoredAccessRequest,
} from "./types.js";

export class HospitalA {
  constructor(public readonly hospitalAId: string) {}

  /** Step 6.a — grant.active && patient_id && data_holder && grantee_id && grantee_address. */
  checkStatus(grant: ResolvedAccessGrant, req: StoredAccessRequest): void {
    if (!grant.active) throw new Error("AccessGrant is inactive");
    if (grant.patient_id !== req.patient_id) {
      throw new Error(
        `patient_id mismatch: grant=${grant.patient_id} request=${req.patient_id}`,
      );
    }
    if (grant.data_holder_hospital_id !== this.hospitalAId) {
      throw new Error(
        `data_holder mismatch: grant=${grant.data_holder_hospital_id} self=${this.hospitalAId}`,
      );
    }
    if (grant.grantee_hospital_id !== req.hospital_b_id) {
      throw new Error(
        `grantee_hospital_id mismatch: grant=${grant.grantee_hospital_id} request=${req.hospital_b_id}`,
      );
    }
    if (grant.grantee_address.toLowerCase() !== req.hospital_b_address.toLowerCase()) {
      throw new Error(
        `grantee_address mismatch: grant=${grant.grantee_address} request=${req.hospital_b_address}`,
      );
    }
  }

  /** Step 6.b — scope contains requested_scope; ehr_record_id matches. */
  checkScopeAndRecord(grant: ResolvedAccessGrant, req: StoredAccessRequest): void {
    if (grant.ehr_record_id !== req.ehr_record_id) {
      throw new Error(
        `ehr_record_id mismatch: grant=${grant.ehr_record_id} request=${req.ehr_record_id}`,
      );
    }
    // "scope contains requested_scope" — semicolon-separated multi-scope is
    // accepted, single-scope equality also passes.
    const granted = grant.scope.split(/[\s,;]+/).filter(Boolean);
    if (!granted.includes(req.requested_scope)) {
      throw new Error(
        `scope mismatch: grant=${grant.scope} request=${req.requested_scope}`,
      );
    }
  }

  /** Step 6.c — current time <= expires_at_ms. */
  checkExpiration(grant: ResolvedAccessGrant, nowMs: number = Date.now()): void {
    if (nowMs > grant.expires_at_ms) {
      throw new Error(
        `AccessGrant expired: exp=${grant.expires_at_ms} now=${nowMs}`,
      );
    }
  }

  /** Step 7 — create the local authorized EHR access session. */
  createAccessSession(
    grant: ResolvedAccessGrant,
    req: StoredAccessRequest,
  ): AuthorizedAccessSession {
    return {
      session_id: randomUUID(),
      patient_id: grant.patient_id,
      hospital_a_id: this.hospitalAId,
      hospital_b_id: grant.grantee_hospital_id,
      ehr_record_id: grant.ehr_record_id,
      scope: req.requested_scope,
      created_at: new Date().toISOString(),
    };
  }
}
