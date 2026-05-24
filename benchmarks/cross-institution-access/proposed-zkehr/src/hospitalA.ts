/**
 * Hospital A / Data-Holding Provider for the zkEHR cross-institution
 * access experiment.
 *
 * Verification flow on receipt of a Hospital B request:
 *   1. Query Sui for the AccessGrant object by id.
 *   2. Resolve the patient's DID:
 *        - parse the P-DID string (`did:zkehr:zklogin:<addr>`),
 *        - extract the embedded zkLogin Sui address,
 *        - confirm it equals the AccessGrant's on-chain `AddressOwner`
 *          (Sui already enforced via tx validation that only a valid
 *           zkLogin signature for that address could have minted it).
 *   3. Resolve Hospital B's DID:
 *        - Sui `getObject` for the registered B-DIDObject,
 *        - confirm `did` string matches the request's B-DID,
 *        - confirm `active`, and that the controller equals the
 *          B Sui address claimed in the AccessGrant.
 *   4. Confirm A-DID in the AccessGrant equals Hospital A's own DID.
 *   5. Status / scope / expiration / record id checks (same as siblings).
 *   6. Create the local authorized EHR access session.
 */

import { randomUUID } from "node:crypto";
import { resolveDidObject } from "./didRegistry.js";
import type {
  AuthorizedAccessSession,
  ResolvedAccessGrant,
  StoredAccessRequest,
} from "./zkehrTypes.js";

export class HospitalA {
  constructor(
    public readonly hospitalAId: string,
    public readonly hospitalADid: string,
  ) {}

  /**
   * Resolve P-DID from a `did:zkehr:zklogin:<sui_address>` string.
   *
   * For a zkLogin-derived DID, the "resolution" is just parsing the address
   * out of the DID string and checking it against the on-chain owner of
   * the AccessGrant. Sui's tx validation already proved the owner held a
   * valid zkLogin signature; equality here is the proof of patient consent.
   */
  resolvePatientZkLoginDid(grant: ResolvedAccessGrant, expectedPatientDid: string): void {
    if (grant.patient_id !== expectedPatientDid) {
      throw new Error(
        `patient_did mismatch: grant=${grant.patient_id} expected=${expectedPatientDid}`,
      );
    }
    const prefix = "did:zkehr:zklogin:";
    if (!expectedPatientDid.startsWith(prefix)) {
      throw new Error(
        `unsupported P-DID method (expected zkLogin): ${expectedPatientDid}`,
      );
    }
    const embeddedAddr = expectedPatientDid.slice(prefix.length).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(embeddedAddr)) {
      throw new Error(`P-DID has malformed zkLogin address: ${expectedPatientDid}`);
    }
    if (grant.on_chain_owner.toLowerCase() !== embeddedAddr) {
      throw new Error(
        `P-DID resolution failed: AccessGrant.on_chain_owner=${grant.on_chain_owner} ` +
          `does NOT match P-DID embedded address=${embeddedAddr}`,
      );
    }
  }

  /**
   * Resolve Hospital B's DID from chain — the heaviest single step in the
   * access phase (a real Sui RPC `getObject` call).
   *
   * Returns the parsed DID's controller (B's Sui address). Caller then
   * passes that into checkBindingsAndStatus().
   */
  async resolveHospitalBDid(
    granteeDidObjectId: string,
    expectedDid: string,
  ): Promise<{ controller: string; did: string; active: boolean }> {
    const resolved = await resolveDidObject(granteeDidObjectId);
    if (!resolved.active) {
      throw new Error(`Hospital B DID is inactive: ${expectedDid}`);
    }
    if (resolved.did !== expectedDid) {
      throw new Error(
        `Hospital B DID string mismatch: chain=${resolved.did} expected=${expectedDid}`,
      );
    }
    return {
      controller: resolved.controller,
      did: resolved.did,
      active: resolved.active,
    };
  }

  /** Local self-check that A-DID in the grant matches Hospital A's own DID. */
  checkOwnDid(grant: ResolvedAccessGrant): void {
    if (grant.data_holder_hospital_id !== this.hospitalADid) {
      throw new Error(
        `A-DID mismatch: grant=${grant.data_holder_hospital_id} self=${this.hospitalADid}`,
      );
    }
  }

  /**
   * Status / patient-id / data-holder / grantee / grantee-address checks.
   * Verify that the grantee address embedded in the AccessGrant equals the
   * controller of B's on-chain DIDObject — i.e., the address Sui considers
   * authoritative for B.
   */
  checkStatus(
    grant: ResolvedAccessGrant,
    req: StoredAccessRequest,
    bDidController: string,
  ): void {
    if (!grant.active) throw new Error("AccessGrant is inactive");
    if (grant.grantee_hospital_id !== req.hospital_b_did) {
      throw new Error(
        `B-DID mismatch: grant=${grant.grantee_hospital_id} request=${req.hospital_b_did}`,
      );
    }
    if (grant.grantee_address.toLowerCase() !== req.hospital_b_address.toLowerCase()) {
      throw new Error(
        `B-address mismatch: grant=${grant.grantee_address} request=${req.hospital_b_address}`,
      );
    }
    if (grant.grantee_address.toLowerCase() !== bDidController.toLowerCase()) {
      throw new Error(
        `B-address vs B-DID controller mismatch: grant=${grant.grantee_address} ` +
          `B-DID.controller=${bDidController}`,
      );
    }
  }

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

  checkExpiration(grant: ResolvedAccessGrant, nowMs: number = Date.now()): void {
    if (nowMs > grant.expires_at_ms) {
      throw new Error(
        `AccessGrant expired: exp=${grant.expires_at_ms} now=${nowMs}`,
      );
    }
  }

  createAccessSession(
    grant: ResolvedAccessGrant,
    req: StoredAccessRequest,
  ): AuthorizedAccessSession {
    return {
      session_id: randomUUID(),
      patient_did: grant.patient_id,
      hospital_a_did: this.hospitalADid,
      hospital_b_did: grant.grantee_hospital_id,
      ehr_record_id: grant.ehr_record_id,
      scope: req.requested_scope,
      created_at: new Date().toISOString(),
    };
  }
}
