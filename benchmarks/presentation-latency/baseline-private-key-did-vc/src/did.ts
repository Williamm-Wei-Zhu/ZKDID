/**
 * DID derivation. We hash the raw 32-byte Ed25519 public key with SHA-256 and
 * encode the digest as base64url, prefixed with the DID method.
 *
 * Format:    did:sui:<base64url(sha256(public_key))>
 *
 * This keeps the DID short, deterministic from the key, and uses no
 * blockchain-derived state. (The on-chain DIDObject uses this string verbatim.)
 */

import { sha256 } from "@noble/hashes/sha256";

export function deriveDid(method: string, publicKeyBytes: Uint8Array): string {
  const digest = sha256(publicKeyBytes);
  const b64url = Buffer.from(digest)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${method}:${b64url}`;
}
