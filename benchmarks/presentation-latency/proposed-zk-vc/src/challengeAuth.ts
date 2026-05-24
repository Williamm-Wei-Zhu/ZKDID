/**
 * Challenge / response signing primitives shared by Mode 2 (auth experiment).
 *
 * The patient signs a server-issued nonce with their long-term Ed25519 key.
 * The EHR service verifies that the signature is valid for the public key
 * stored in the DID's on-chain object.
 */

import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export function newChallenge(): Uint8Array {
  return randomBytes(32);
}

export function signChallenge(kp: Ed25519Keypair, challenge: Uint8Array): Uint8Array {
  // Sui's Ed25519Keypair signs over a 32-byte hash by default for Sui personal
  // messages; we want a raw Ed25519 signature for an arbitrary challenge so
  // the EHR-service code is provider-agnostic. Extract the secret key bytes
  // and use @noble/curves/ed25519 directly.
  const secretKey = kp.getSecretKey();
  // The bech32 export starts with `suiprivkey1`; we need raw 32 bytes. The
  // Sui SDK ships a decode function — but we already imported it elsewhere,
  // so instead use the exposed `getSecretKey` raw form when available.
  // Workaround: noble's signer wants 32 bytes; the keypair exposes them via
  // `(kp as any)._privateKey` in some SDK versions. To stay portable:
  const rawSecret = decodeSuiPrivateKeyToBytes(secretKey);
  return ed25519.sign(challenge, rawSecret);
}

export function verifySignature(
  publicKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array,
): boolean {
  return ed25519.verify(signature, challenge, publicKey);
}

// --- helpers ----------------------------------------------------------------
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
function decodeSuiPrivateKeyToBytes(bech32: string): Uint8Array {
  const { secretKey } = decodeSuiPrivateKey(bech32);
  return secretKey;
}
