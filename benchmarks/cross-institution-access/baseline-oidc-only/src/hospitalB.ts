/**
 * Hospital B — the requesting institution.
 *
 * Hospital B has a long-lived ES256 (P-256) signing keypair, generated once
 * per process and pre-registered with Hospital A in the institution registry.
 * To request access to patient data, Hospital B builds + signs a
 * "JWT bearer assertion" (RFC 7523) carrying:
 *   iss = hospital-b's institution id
 *   aud = hospital-a's institution id
 *   sub = patient OIDC subject the access is for
 *   scope = e.g. "ehr.read"
 *   iat, exp, jti
 *
 * This matches what production EHR/HIE systems do: each institution is its
 * own OAuth client, and inter-institutional API calls use signed JWTs whose
 * verifying public keys are pre-registered out of band.
 */

import { generateKeyPair, exportJWK, SignJWT, type JWK, type KeyLike } from "jose";
import { randomUUID } from "node:crypto";

export interface HospitalBKeyMaterial {
  /** Long-lived institutional signing key (ES256, P-256 private). */
  privateKey: KeyLike | Uint8Array;
  /** The matching public key as a JWK, for registration with Hospital A. */
  publicJwk: JWK;
  /** Stable kid used in the JWT header. */
  kid: string;
  /** Stable institution identifier (used as the JWT `iss`). */
  institutionId: string;
}

export async function createHospitalB(institutionId: string): Promise<HospitalBKeyMaterial> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = `hospital-b-${randomUUID()}`;
  publicJwk.kid = kid;
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
  return {
    privateKey,
    publicJwk,
    kid,
    institutionId,
  };
}

export interface BuildAccessRequestInput {
  /** Hospital A's institution id (becomes `aud` in the assertion). */
  hospitalAId: string;
  /** Patient OIDC `sub` whose data B is requesting. */
  patientSubject: string;
  /** Patient OIDC `iss` — Hospital A keys consent grants on (iss, sub). */
  patientIssuer: string;
  /** Requested scope, e.g. "ehr.read". */
  scope: string;
  /** Assertion lifetime; defaults to 60s as is conventional for client assertions. */
  ttlSeconds?: number;
}

export interface SignedAccessRequest {
  jwt: string;
  jti: string;
}

/**
 * Build + sign Hospital B's institutional JWT bearer assertion.
 * Caller times this whole function as `b_request_build_ms`.
 */
export async function buildAccessRequestJwt(
  hb: HospitalBKeyMaterial,
  input: BuildAccessRequestInput
): Promise<SignedAccessRequest> {
  const ttl = input.ttlSeconds ?? 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const jti = randomUUID();

  const jwt = await new SignJWT({
    sub: input.patientSubject,
    patient_iss: input.patientIssuer,
    scope: input.scope,
  })
    .setProtectedHeader({ alg: "ES256", kid: hb.kid, typ: "JWT" })
    .setIssuer(hb.institutionId)
    .setAudience(input.hospitalAId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .setJti(jti)
    .sign(hb.privateKey);

  return { jwt, jti };
}
