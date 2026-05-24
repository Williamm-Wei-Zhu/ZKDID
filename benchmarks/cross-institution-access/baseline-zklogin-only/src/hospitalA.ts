/**
 * Hospital A / Data-Holding Provider for the zkLogin cross-institution
 * access experiment.
 *
 * On receipt of an access request from Hospital B:
 *   1. queries Sui Devnet for the named AccessGrant object;
 *   2. parses the on-chain fields;
 *   3. verifies status / scope / expiration (same as ACTION-EHR-inspired);
 *   4. **performs the zkLogin/address-based authorization check** —
 *      confirms that the AccessGrant's on-chain `AddressOwner` equals the
 *      patient's zkLogin Sui address recorded inside the grant; that
 *      single equality is what proves "the patient (P-DID) signed this
 *      grant via zkLogin", because Sui's transaction-validation rules
 *      already enforce that only a valid zkLogin signature for that
 *      address could have minted the object;
 *   5. creates the local authorized EHR access session.
 */

import { randomUUID } from "node:crypto";
import type {
  AuthorizedAccessSession,
  ResolvedAccessGrant,
  StoredAccessRequest,
} from "./types.js";

export class HospitalA {
  constructor(public readonly hospitalAId: string) {}

  /** active + patient_id + data_holder + grantee_id + grantee_address. */
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

  /** scope + ehr_record_id. */
  checkScopeAndRecord(grant: ResolvedAccessGrant, req: StoredAccessRequest): void {
    if (grant.ehr_record_id !== req.ehr_record_id) {
      throw new Error(
        `ehr_record_id mismatch: grant=${grant.ehr_record_id} request=${req.ehr_record_id}`,
      );
    }
    const granted = grant.scope.split(/[\s,;]+/).filter(Boolean);
    if (!granted.includes(req.requested_scope)) {
      throw new Error(
        `scope mismatch: grant=${grant.scope} request=${req.requested_scope}`,
      );
    }
  }

  /** current time <= expires_at_ms. */
  checkExpiration(grant: ResolvedAccessGrant, nowMs: number = Date.now()): void {
    if (nowMs > grant.expires_at_ms) {
      throw new Error(
        `AccessGrant expired: exp=${grant.expires_at_ms} now=${nowMs}`,
      );
    }
  }

  /**
   * zkLogin / address-based authorization check.
   *
   * The grant's on-chain `AddressOwner` is the address Sui assigned at
   * mint time — Sui's transaction-validation rules enforce that only a
   * valid zkLogin signature for *that* address could have produced the
   * `tx_context::sender(ctx)` used by the Move call. So if the on-chain
   * owner equals the patient's zkLogin address that the grant claims,
   * we have cryptographic proof the patient (P-DID) authorized this grant
   * — without Hospital A having to evaluate the zkLogin proof itself.
   *
   * `expectedZkLoginAddress` is whatever the grant carries as the
   * patient identity (we mirror it into `patient_id` at mint time).
   */
  checkAddressAuthorization(
    grant: ResolvedAccessGrant,
    expectedZkLoginAddress: string,
  ): void {
    if (grant.on_chain_owner.toLowerCase() !== expectedZkLoginAddress.toLowerCase()) {
      throw new Error(
        `address authorization failed: on_chain_owner=${grant.on_chain_owner} ` +
          `expected_patient_zklogin_address=${expectedZkLoginAddress}`,
      );
    }
    // Also enforce that patient_id matches — defends against an attacker
    // who somehow produces a grant whose on-chain owner is the patient
    // but whose patient_id field claims a different identity.
    if (grant.patient_id.toLowerCase() !== expectedZkLoginAddress.toLowerCase()) {
      throw new Error(
        `patient_id field does not match zkLogin address: ` +
          `patient_id=${grant.patient_id} expected=${expectedZkLoginAddress}`,
      );
    }
  }

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
