/**
 * Mysten Labs zkLogin prover client. POSTs the JWT, ephemeral pubkey,
 * randomness, salt, and max_epoch -- gets back a Groth16 proof + auxiliary
 * inputs that the Sui zkLogin signature scheme consumes.
 *
 * Endpoint: https://prover-dev.mystenlabs.com/v1 (devnet prover).
 */

import { getExtendedEphemeralPublicKey } from "@mysten/sui/zklogin";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface ProverInputs {
  jwt: string;
  ephemeralKeypair: Ed25519Keypair;
  randomness: string;
  saltDecimal: string; // BigInt as decimal string per Mysten's API
  maxEpoch: number;
}

export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
}

export async function fetchZkProof(url: string, inputs: ProverInputs): Promise<ZkProof> {
  const body = {
    jwt: inputs.jwt,
    extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(
      inputs.ephemeralKeypair.getPublicKey(),
    ),
    maxEpoch: inputs.maxEpoch,
    jwtRandomness: inputs.randomness,
    salt: inputs.saltDecimal,
    keyClaimName: "sub",
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Prover returned HTTP ${r.status}: ${text.slice(0, 500)}`);
  }
  let proof: unknown;
  try { proof = JSON.parse(text); }
  catch { throw new Error(`Prover returned non-JSON: ${text.slice(0, 500)}`); }
  return proof as ZkProof;
}
