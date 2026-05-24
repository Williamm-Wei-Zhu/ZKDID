/**
 * Single-authority salt: derive a deterministic 16-byte salt from
 * SHA-256(secret || sub || aud), interpreted as a BigInt.
 *
 * This is the canonical "single salt source" model the zkLogin docs describe
 * and is what zkEHR's multi-authority salt is the *contrast* to. The secret
 * is held by exactly one party (this baseline) -- losing it would let an
 * attacker recompute every user's zkLogin address from their {sub, aud}.
 *
 * For the academic experiment we measure salt latency as the time to compute
 * this hash; in a production single-authority deployment the cost would be
 * dominated by the round-trip to a remote salt service (~5-30 ms).
 */

import { sha256 } from "@noble/hashes/sha256";

export function deriveSingleAuthoritySalt(
  saltSecret: string,
  sub: string,
  aud: string,
): bigint {
  const enc = new TextEncoder();
  // domain-separated input so the salt cannot be confused with another digest
  const msg = enc.encode(`zklogin-baseline-salt|${saltSecret}|${sub}|${aud}`);
  const digest = sha256(msg);
  // zkLogin salts must fit in 128 bits -- take the first 16 bytes.
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(digest[i]);
  return n;
}
