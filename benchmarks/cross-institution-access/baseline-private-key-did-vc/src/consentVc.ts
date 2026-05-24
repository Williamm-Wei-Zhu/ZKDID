/**
 * Consent grant as a Verifiable Credential — signed by the patient's DID
 * private key, held by Hospital B, presented to Hospital A.
 *
 * The shape follows W3C VC Data Model 1.1 with detached Ed25519 signatures
 * over a canonicalized JSON payload (no JSON-LD normalization — that would
 * be on the protocol cost we are characterizing for *zk*-EHR comparison).
 */

import { ed25519 } from "@noble/curves/ed25519";

export interface ConsentVcPayload {
  "@context": string[];
  type: string[];
  /** Patient DID (the issuer of this consent). */
  issuer: string;
  /** Pointer to the on-chain DIDObject so Hospital A can resolve it. */
  issuer_sui_object_id: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: {
    /** The institution the patient is granting access to (Hospital B's id). */
    id: string;
    /** What is being granted (e.g. "ehr.read"). */
    scope: string;
    /** The patient DID whose record may be accessed. */
    patient_did: string;
    /** A unique grant id. */
    jti: string;
  };
}

export interface SignedConsentVc {
  payload: ConsentVcPayload;
  /** Hex-encoded Ed25519 signature over `canonical`. */
  signature_hex: string;
  /** Cached canonical bytes used for signing/verifying. */
  canonical: string;
}

function canonicalize(p: ConsentVcPayload): string {
  // Match the convention used in src/vc.ts — JSON.stringify is sufficient
  // for the baseline because the same canonical form is shared by signer
  // and verifier (no cross-implementation interop required).
  return JSON.stringify(p);
}

export interface BuildConsentInput {
  patientDid: string;
  patientSuiObjectId: string;
  granteeInstitutionId: string;
  scope: string;
  ttlSeconds: number;
  jti: string;
}

export function buildConsentPayload(input: BuildConsentInput): ConsentVcPayload {
  const now = new Date();
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential", "ConsentGrant"],
    issuer: input.patientDid,
    issuer_sui_object_id: input.patientSuiObjectId,
    issuanceDate: now.toISOString(),
    expirationDate: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
    credentialSubject: {
      id: input.granteeInstitutionId,
      scope: input.scope,
      patient_did: input.patientDid,
      jti: input.jti,
    },
  };
}

export function signConsent(
  payload: ConsentVcPayload,
  patientSecretKey: Uint8Array
): SignedConsentVc {
  const canonical = canonicalize(payload);
  const sig = ed25519.sign(new TextEncoder().encode(canonical), patientSecretKey);
  return {
    payload,
    canonical,
    signature_hex: Buffer.from(sig).toString("hex"),
  };
}

/**
 * Hospital B's "presentation" step: serialize the signed VC to a wire-format
 * string (what would be sent over the network). For an in-process
 * measurement this is the JSON-stringify cost — we model just the
 * serialization, not the network — to keep the timing apples-to-apples with
 * the OIDC-only access phase which is also in-process.
 */
export function presentConsent(vc: SignedConsentVc): string {
  return JSON.stringify(vc);
}

/**
 * Hospital A's "receive" step: parse the wire-format string back into a
 * SignedConsentVc the verifier can use.
 */
export function receivePresentedConsent(wire: string): SignedConsentVc {
  return JSON.parse(wire) as SignedConsentVc;
}

/**
 * Hospital A verifies the signature on a received VC using the patient's
 * public key (which Hospital A obtained by resolving the patient's DID
 * object on Sui devnet). This isolates the *signature-verify* cost only.
 */
export function verifyConsentSignature(
  vc: SignedConsentVc,
  patientPublicKey: Uint8Array
): boolean {
  const sig = Uint8Array.from(Buffer.from(vc.signature_hex, "hex"));
  const msg = new TextEncoder().encode(vc.canonical);
  return ed25519.verify(sig, msg, patientPublicKey);
}

export interface ConsentClaimCheck {
  scope_ok: boolean;
  expiration_ok: boolean;
  grantee_ok: boolean;
  patient_ok: boolean;
}

export interface ConsentExpectations {
  expectedScope: string;
  expectedGranteeId: string;
  expectedPatientDid: string;
}

/**
 * Hospital A's claim check: scope match + expiration + grantee match +
 * patient_did match. Returns a boolean breakdown (so the caller can record
 * which check failed if any).
 */
export function checkConsentClaims(
  vc: SignedConsentVc,
  exp: ConsentExpectations
): ConsentClaimCheck {
  return {
    scope_ok: vc.payload.credentialSubject.scope === exp.expectedScope,
    expiration_ok:
      new Date(vc.payload.expirationDate).getTime() > Date.now(),
    grantee_ok:
      vc.payload.credentialSubject.id === exp.expectedGranteeId,
    patient_ok:
      vc.payload.credentialSubject.patient_did === exp.expectedPatientDid &&
      vc.payload.issuer === exp.expectedPatientDid,
  };
}
