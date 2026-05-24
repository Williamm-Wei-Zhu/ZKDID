/**
 * Mock EHR Service / Relying Party logic.
 *
 * In production this would be a separate service in the hospital data center.
 * Co-located here so we can isolate the *protocol* cost (which would be
 * identical regardless of process layout — see notes in the OIDC-only baseline).
 */

import { randomUUID } from "node:crypto";

export interface EhrSession {
  session_id: string;
  patient_id: string;
  did: string;
  authenticated_at_ms: number;
}

const SESSION_STORE = new Map<string, EhrSession>();
const PATIENT_INDEX = new Map<string, string>(); // did -> patient_id

export function mapDidToPatientId(did: string): string {
  let pid = PATIENT_INDEX.get(did);
  if (pid === undefined) {
    // First-time mapping — assign a stable mock patient ID so repeated
    // authentications for the same DID resolve to the same record.
    pid = `P-${PATIENT_INDEX.size + 1}`;
    PATIENT_INDEX.set(did, pid);
  }
  return pid;
}

export function createEhrSession(did: string, patient_id: string): EhrSession {
  const sess: EhrSession = {
    session_id: randomUUID(),
    patient_id,
    did,
    authenticated_at_ms: Date.now(),
  };
  SESSION_STORE.set(sess.session_id, sess);
  return sess;
}

export function clearEhrState(): void {
  SESSION_STORE.clear();
  PATIENT_INDEX.clear();
}
