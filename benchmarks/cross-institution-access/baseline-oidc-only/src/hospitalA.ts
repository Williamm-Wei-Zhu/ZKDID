/**
 * Hospital A — the consent-portal RP and consent registry owner.
 *
 * Responsibilities:
 *   1. Verify patient OIDC ID tokens (handled in jwtVerifier.ts; Hospital A
 *      acts as the OIDC RP).
 *   2. Maintain a registry of trusted partner institutions and their public
 *      keys (this file).
 *   3. Verify Hospital B's signed access-request JWTs (this file).
 *   4. Look up the consent database for a matching, unexpired grant
 *      (delegated to consentDb.ts).
 *
 * The institution registry is a simple in-memory Map. In production this
 * would be a TLS-protected directory service or a DID registry; for the
 * OIDC-only baseline we model it as a pre-shared map of (institutionId →
 * public JWK) so the experiment isolates the *crypto verification* and
 * *consent-lookup* costs.
 */

import { jwtVerify, importJWK, type JWK } from "jose";
import type { ConsentGrant } from "./types.js";
import type { ConsentDatabase } from "./consentDb.js";

interface RegisteredInstitution {
  institutionId: string;
  publicJwk: JWK;
}

export class HospitalA {
  private registry = new Map<string, RegisteredInstitution>();

  constructor(
    public readonly institutionId: string,
    public readonly consentDb: ConsentDatabase
  ) {}

  /** Pre-register a partner institution's public key. */
  registerInstitution(institutionId: string, publicJwk: JWK): void {
    this.registry.set(institutionId, { institutionId, publicJwk });
  }

  hasInstitution(institutionId: string): boolean {
    return this.registry.has(institutionId);
  }

  /**
   * Verify a partner institution's access-request JWT.
   *
   * Returns the verified payload on success; throws on any failure (unknown
   * iss, signature mismatch, audience mismatch, expired, missing scope).
   * The caller times this call as `a_verify_b_jwt_ms`.
   */
  async verifyInstitutionRequest(jwt: string): Promise<{
    iss: string;
    sub: string;
    patient_iss: string;
    scope: string;
    exp: number;
    iat: number;
    jti: string;
  }> {
    // Decode iss without verifying so we can pick the right key.
    // (jwtVerify with a key resolver would also work; this form keeps the
    // experiment timing exclusively on signature + claim work.)
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed institution JWT");
    }
    const payloadJson = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { iss?: unknown };
    if (typeof payloadJson.iss !== "string") {
      throw new Error("Institution JWT missing 'iss'");
    }
    const reg = this.registry.get(payloadJson.iss);
    if (!reg) {
      throw new Error(`Unknown institution iss=${payloadJson.iss}`);
    }
    const key = await importJWK(reg.publicJwk, "ES256");

    const { payload } = await jwtVerify(jwt, key, {
      issuer: payloadJson.iss,
      audience: this.institutionId,
      algorithms: ["ES256"],
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("Institution JWT missing 'sub' (patient subject)");
    }
    if (typeof payload.patient_iss !== "string" || payload.patient_iss.length === 0) {
      throw new Error("Institution JWT missing 'patient_iss'");
    }
    if (typeof payload.scope !== "string" || payload.scope.length === 0) {
      throw new Error("Institution JWT missing 'scope'");
    }
    if (typeof payload.jti !== "string") {
      throw new Error("Institution JWT missing 'jti'");
    }
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
      throw new Error("Institution JWT missing iat/exp");
    }
    return {
      iss: payloadJson.iss,
      sub: payload.sub,
      patient_iss: payload.patient_iss,
      scope: payload.scope,
      exp: payload.exp,
      iat: payload.iat,
      jti: payload.jti,
    };
  }

  /** Lookup a consent grant. Caller times this as `a_consent_lookup_ms`. */
  lookupConsent(
    patientIssuer: string,
    patientSubject: string,
    granteeId: string,
    scope: string
  ): ConsentGrant | null {
    return this.consentDb.lookup(patientIssuer, patientSubject, granteeId, scope);
  }
}
