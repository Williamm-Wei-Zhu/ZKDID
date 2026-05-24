/**
 * Minimal Verifiable Credential support for Mode 3.
 *
 * The VC follows W3C VC Data Model 1.1 shape but uses raw Ed25519 detached
 * signatures over a canonicalized JSON payload — no JSON-LD signature suite
 * because that would add expensive normalization that is not part of the
 * conventional-DID baseline we are characterizing.
 */

import { ed25519 } from "@noble/curves/ed25519";

export interface VcPayload {
  "@context": string[];
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: {
    id: string; // subject DID
    role?: string;
    eligible?: boolean;
    /** Allow OIDC4VCI-issued VCs to carry the holder's google_sub etc. */
    [k: string]: unknown;
  };
}

export interface SignedVc {
  payload: VcPayload;
  signature_hex: string;
  /** Cached canonical bytes used for signing/verifying. */
  canonical: string;
}

function canonicalize(p: VcPayload): string {
  return JSON.stringify(p);
}

export function buildVcPayload(
  issuerDid: string,
  subjectDid: string,
  ttlSeconds = 3600,
): VcPayload {
  const now = new Date();
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
    ],
    type: ["VerifiableCredential", "PatientEligibility"],
    issuer: issuerDid,
    issuanceDate: now.toISOString(),
    expirationDate: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    credentialSubject: { id: subjectDid, role: "patient", eligible: true },
  };
}

export function signVc(payload: VcPayload, issuerSecretKey: Uint8Array): SignedVc {
  const canonical = canonicalize(payload);
  const sig = ed25519.sign(new TextEncoder().encode(canonical), issuerSecretKey);
  return { payload, canonical, signature_hex: Buffer.from(sig).toString("hex") };
}

export interface VcVerifyResult {
  signature_ok: boolean;
  expiration_ok: boolean;
  subject_ok: boolean;
}

export function verifyVc(
  vc: SignedVc,
  issuerPublicKey: Uint8Array,
  expectedSubjectDid: string,
): VcVerifyResult {
  const sig = Uint8Array.from(Buffer.from(vc.signature_hex, "hex"));
  const msg = new TextEncoder().encode(vc.canonical);
  const signature_ok = ed25519.verify(sig, msg, issuerPublicKey);
  const expiration_ok = new Date(vc.payload.expirationDate).getTime() > Date.now();
  const subject_ok = vc.payload.credentialSubject.id === expectedSubjectDid;
  return { signature_ok, expiration_ok, subject_ok };
}
