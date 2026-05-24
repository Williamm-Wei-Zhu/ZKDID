/**
 * Hospital A's centralized consent database.
 *
 * The OIDC-only baseline models the consent registry as a single in-process
 * Map (no blockchain, no multi-authority quorum, no DID resolution). Each
 * grant is keyed on the triple (patient_issuer, patient_subject,
 * grantee_institution_id, scope) — i.e. a patient may grant the same scope
 * to multiple institutions, but only one canonical grant exists per
 * (patient, grantee, scope) tuple.
 *
 * This file deliberately keeps the surface area minimal so the experiment
 * isolates consent-write and consent-lookup costs cleanly.
 */

import { randomUUID } from "node:crypto";
import type { ConsentGrant } from "./types.js";

function key(
  patientIssuer: string,
  patientSubject: string,
  granteeId: string,
  scope: string
): string {
  return `${patientIssuer}${patientSubject}${granteeId}${scope}`;
}

export interface CreateConsentInput {
  patient_subject: string;
  patient_issuer: string;
  grantee_institution_id: string;
  scope: string;
  granted_by_session: string;
  ttl_ms: number;
}

export class ConsentDatabase {
  private grants = new Map<string, ConsentGrant>();

  /** Persist a consent grant. Overwrites any existing grant for the same key. */
  put(input: CreateConsentInput): ConsentGrant {
    const now = Date.now();
    const grant: ConsentGrant = {
      consent_id: randomUUID(),
      patient_subject: input.patient_subject,
      patient_issuer: input.patient_issuer,
      grantee_institution_id: input.grantee_institution_id,
      scope: input.scope,
      granted_by_session: input.granted_by_session,
      issued_at_ms: now,
      expires_at_ms: now + input.ttl_ms,
      jti: randomUUID(),
    };
    const k = key(
      grant.patient_issuer,
      grant.patient_subject,
      grant.grantee_institution_id,
      grant.scope
    );
    this.grants.set(k, grant);
    return grant;
  }

  /**
   * Lookup a non-expired grant. Returns `null` if no grant exists or if the
   * grant has expired (the experiment treats expired grants as cache misses,
   * matching production behavior).
   */
  lookup(
    patientIssuer: string,
    patientSubject: string,
    granteeId: string,
    scope: string
  ): ConsentGrant | null {
    const g = this.grants.get(key(patientIssuer, patientSubject, granteeId, scope));
    if (!g) return null;
    if (g.expires_at_ms < Date.now()) return null;
    return g;
  }

  /** Test-only: drop all grants. */
  clear(): void {
    this.grants.clear();
  }

  /** Test-only: how many grants are stored. */
  size(): number {
    return this.grants.size;
  }
}
