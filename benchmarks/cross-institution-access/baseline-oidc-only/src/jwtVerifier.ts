/**
 * ID-token verification helpers.
 *
 * We measure two phases separately:
 *   (1) jwks_fetch_or_cache_ms  — JWKS retrieval (cached or fresh)
 *   (2) jwt_verify_ms           — signature verification (RSA/EC)
 *   (3) claim_validation_ms     — iss/aud/exp/iat/nonce/sub checks
 *
 * jose's `jwtVerify` performs (2)+(3) together, but for a paper we want
 * isolated numbers. So we manually:
 *   - decode the JWT header to get `kid`
 *   - resolve the key from JWKS (fetch or cache)
 *   - call `jwtVerify` for the cryptographic verification step
 *   - run claim validation in a separate, separately-timed block
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  type FlattenedJWSInput,
  type JWSHeaderParameters,
  type KeyLike,
} from "jose";
import { now, elapsedMs } from "./timer.js";
import type { VerifiedClaims } from "./types.js";

export interface JwksFetcher {
  /** jose-style key resolver. */
  getKey: (
    protectedHeader: JWSHeaderParameters,
    token: FlattenedJWSInput
  ) => Promise<KeyLike | Uint8Array>;
  /** Returns the (cached or freshly-fetched) raw JWKS. Used so we can isolate the JWKS step. */
  warmUp: () => Promise<void>;
  /** Drops any cached state — used in CACHE_JWKS=false mode to force a fresh fetch each run. */
  invalidate: () => void;
}

interface CachedJwks {
  keys: JWK[];
  fetchedAt: number;
}

/**
 * Builds a JwksFetcher honoring CACHE_JWKS:
 *   - true  => use jose's createRemoteJWKSet (caches with built-in TTL).
 *   - false => fetch raw JWKS via fetch() on every call so the JWKS step is honest cold work.
 */
export function buildJwksFetcher(jwksUri: string, cache: boolean): JwksFetcher {
  if (cache) {
    const remoteSet = createRemoteJWKSet(new URL(jwksUri), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    let warmed = false;
    return {
      async getKey(header, token) {
        return remoteSet(header, token);
      },
      async warmUp() {
        if (warmed) return;
        // Fire a header that references *some* kid; if the JWKS is empty this throws,
        // but that's a real config error worth surfacing. We avoid this path during
        // warmUp by issuing an HTTP GET directly.
        const r = await fetch(jwksUri);
        if (!r.ok) throw new Error(`JWKS warm-up failed: HTTP ${r.status}`);
        await r.json();
        warmed = true;
      },
      invalidate() {
        warmed = false;
      },
    };
  }

  // Fresh-fetch mode: fetch the JWKS document each time getKey is called.
  let lastFetch: CachedJwks | null = null;
  return {
    async getKey(header) {
      const r = await fetch(jwksUri);
      if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
      const body = (await r.json()) as { keys?: JWK[] };
      lastFetch = { keys: body.keys ?? [], fetchedAt: Date.now() };
      const jwk =
        lastFetch.keys.find((k) => k.kid === header.kid) ?? lastFetch.keys[0];
      if (!jwk) throw new Error(`No JWK matching kid=${header.kid}`);
      return importJWK(jwk, header.alg);
    },
    async warmUp() {
      // No-op in fresh-fetch mode.
    },
    invalidate() {
      lastFetch = null;
    },
  };
}

export interface VerificationTiming {
  jwks_fetch_or_cache_ms: number;
  jwt_verify_ms: number;
  claim_validation_ms: number;
  claims: VerifiedClaims;
}

export interface ClaimExpectations {
  expectedIssuer: string;
  expectedAudience: string;
  expectedNonce?: string;
}

/** Validate standard OIDC claims. Throws on failure with a precise reason. */
export function validateClaims(payload: JWTPayload, exp: ClaimExpectations): VerifiedClaims {
  const nowSec = Math.floor(Date.now() / 1000);

  if (typeof payload.iss !== "string" || payload.iss !== exp.expectedIssuer) {
    throw new Error(`Invalid 'iss': got=${String(payload.iss)} expected=${exp.expectedIssuer}`);
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error(`Invalid 'sub': must be a non-empty string`);
  }
  // aud may be a string or array; the expected client_id must be present.
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(exp.expectedAudience)
    : payload.aud === exp.expectedAudience;
  if (!audOk) {
    throw new Error(`Invalid 'aud': got=${JSON.stringify(payload.aud)} expected=${exp.expectedAudience}`);
  }
  if (typeof payload.exp !== "number" || payload.exp < nowSec) {
    throw new Error(`Token expired or missing 'exp' (exp=${payload.exp}, now=${nowSec})`);
  }
  if (payload.iat !== undefined && typeof payload.iat !== "number") {
    throw new Error(`Invalid 'iat': must be a number when present`);
  }
  if (exp.expectedNonce !== undefined) {
    if (payload.nonce !== exp.expectedNonce) {
      throw new Error(`Nonce mismatch: got=${String(payload.nonce)} expected=${exp.expectedNonce}`);
    }
  }
  return payload as VerifiedClaims;
}

/**
 * Verify an ID token: split into (jwks resolve), (jwt signature verify),
 * (claim validation) so the experiment can record each step.
 */
export async function verifyIdToken(
  idToken: string,
  fetcher: JwksFetcher,
  exp: ClaimExpectations
): Promise<VerificationTiming> {
  // (1) JWKS step — we do a single getKey resolution; in cache mode the second call costs O(map lookup).
  const tJwks0 = now();
  const header = decodeProtectedHeader(idToken);
  // Force the key resolution path here for honest timing.
  // We pass an empty FlattenedJWSInput because jose's resolver only inspects header.kid/alg.
  const key = await fetcher.getKey(header, { payload: "", signature: "" } as FlattenedJWSInput);
  const jwks_fetch_or_cache_ms = elapsedMs(tJwks0);

  // (2) JWT signature verification using the resolved key.
  const tVerify0 = now();
  const { payload } = await jwtVerify(idToken, key, {
    // We do NOT let jose enforce iss/aud here — we validate manually in step (3)
    // for separable timing.
  });
  const jwt_verify_ms = elapsedMs(tVerify0);

  // (3) Claim validation.
  const tClaim0 = now();
  const claims = validateClaims(payload, exp);
  const claim_validation_ms = elapsedMs(tClaim0);

  return { jwks_fetch_or_cache_ms, jwt_verify_ms, claim_validation_ms, claims };
}
