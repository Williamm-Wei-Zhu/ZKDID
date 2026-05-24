/**
 * Local "EHR session" creation.
 *
 * Mirrors what a real EHR backend does after federated login: persists a
 * session id mapped to the verified OIDC subject. The baseline uses an
 * in-memory map; we measure the construct + Map.set cost only.
 */

import { randomUUID } from "node:crypto";
import type { EhrSession, VerifiedClaims } from "./types.js";

const sessionStore = new Map<string, EhrSession>();

export function createEhrSession(claims: VerifiedClaims): EhrSession {
  const session: EhrSession = {
    session_id: randomUUID(),
    subject: claims.sub,
    issuer: claims.iss,
    audience: claims.aud,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
    issued_at_ms: Date.now(),
    expires_at_ms: claims.exp * 1000,
  };
  sessionStore.set(session.session_id, session);
  return session;
}

export function clearSessions(): void {
  sessionStore.clear();
}
