/**
 * Wrapper around `@mysten/sui/zklogin`'s address derivation primitives.
 *
 * `jwtToAddress(jwt, salt)` is deterministic from the JWT's {iss, sub, aud}
 * + the salt. The `addressSeed` is an intermediate value the zkLogin
 * signature needs at submission time.
 */

import { genAddressSeed, jwtToAddress } from "@mysten/sui/zklogin";
import { jwtDecode } from "jwt-decode";

export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
}

export function decodeJwt(jwt: string): JwtClaims {
  const decoded = jwtDecode<Record<string, unknown>>(jwt);
  const iss = String(decoded.iss ?? "");
  const sub = String(decoded.sub ?? "");
  const audRaw = decoded.aud;
  const aud = typeof audRaw === "string" ? audRaw : Array.isArray(audRaw) ? String(audRaw[0]) : "";
  if (!iss || !sub || !aud) {
    throw new Error(`JWT missing iss/sub/aud (got iss=${iss} sub=${sub} aud=${aud})`);
  }
  return {
    iss, sub, aud,
    nonce: typeof decoded.nonce === "string" ? decoded.nonce : undefined,
    email: typeof decoded.email === "string" ? decoded.email : undefined,
    email_verified: decoded.email_verified === true,
  };
}

export function deriveZkLoginAddress(jwt: string, salt: bigint): string {
  return jwtToAddress(jwt, salt);
}

/** Build the addressSeed that getZkLoginSignature() expects in `inputs`. */
export function buildAddressSeed(salt: bigint, claims: JwtClaims): bigint {
  return genAddressSeed(salt, "sub", claims.sub, claims.aud);
}
