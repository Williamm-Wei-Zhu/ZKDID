/**
 * One-time setup: register Hospital A's DID and Hospital B's DID on Sui
 * Devnet via the existing did_registry::create_did_object Move call.
 *
 * Both DIDs are signed by the *sponsor* keypair (cfg.privateKey) — that
 * key acts as the "controller" for both hospitals in the academic
 * experiment (i.e., one Sui address represents both clinic-side parties).
 * This keeps gas low and avoids needing two separately funded Sui
 * accounts; the DID strings themselves still differentiate the two.
 *
 * Persists ids to data/hospital_dids.json so the cross-access experiment
 * can reference them deterministically across runs.
 */

import { resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { cfg } from "./config.js";
import { createDidObject } from "./didRegistry.js";
import { writeHospitalDidRegistry } from "./storage.js";
import type { HospitalDidRegistry, RegisteredHospitalDid } from "./zkehrTypes.js";

const HOSPITAL_A_DID =
  process.env.HOSPITAL_A_DID && process.env.HOSPITAL_A_DID.trim().length > 0
    ? process.env.HOSPITAL_A_DID.trim()
    : "did:zkehr:hospital:hospital_A";
const HOSPITAL_B_DID =
  process.env.HOSPITAL_B_DID && process.env.HOSPITAL_B_DID.trim().length > 0
    ? process.env.HOSPITAL_B_DID.trim()
    : "did:zkehr:hospital:hospital_B";
const DID_REGISTRY_PACKAGE_ID =
  process.env.DID_REGISTRY_PACKAGE_ID && process.env.DID_REGISTRY_PACKAGE_ID.trim().length > 0
    ? process.env.DID_REGISTRY_PACKAGE_ID.trim()
    : "0x64dd915fb8e5bff5b79a9e5e2ea3880588e054aa03630b47e7f43c5d48c1091b";
const STORE_HOSPITAL_DIDS_IN =
  process.env.STORE_HOSPITAL_DIDS_IN && process.env.STORE_HOSPITAL_DIDS_IN.trim().length > 0
    ? process.env.STORE_HOSPITAL_DIDS_IN.trim()
    : "data/hospital_dids.json";

function loadSponsorKeypair(): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(cfg.privateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

async function registerOne(
  signer: Ed25519Keypair,
  did: string,
  metadataObj: Record<string, unknown>,
): Promise<RegisteredHospitalDid> {
  const metadata = new TextEncoder().encode(JSON.stringify(metadataObj));
  // The "public_key" field of the DIDObject is required by the Move
  // contract; we use the institution signer's raw Ed25519 pubkey for
  // simplicity. The latency study doesn't depend on what's stored here.
  const publicKey = signer.getPublicKey().toRawBytes();
  const result = await createDidObject({
    packageId: DID_REGISTRY_PACKAGE_ID,
    did,
    publicKey,
    metadata,
    signer,
  });
  return {
    did,
    sui_object_id: result.objectId,
    controller_address: signer.getPublicKey().toSuiAddress(),
    sui_tx_digest: result.digest,
    created_at_iso: new Date().toISOString(),
  };
}

export async function runSetupHospitalDidsExperiment(): Promise<void> {
  console.log(
    `\n=== Setup: register Hospital A and Hospital B DIDs on Sui Devnet ===\n` +
      `did_registry_package=${DID_REGISTRY_PACKAGE_ID}\n` +
      `A=${HOSPITAL_A_DID}\nB=${HOSPITAL_B_DID}`,
  );

  const sponsor = loadSponsorKeypair();
  console.log(`signer = ${sponsor.getPublicKey().toSuiAddress()}`);

  console.log(`[setup] registering A-DID...`);
  const a = await registerOne(sponsor, HOSPITAL_A_DID, {
    role: "data_holder",
    name: "Hospital A",
  });
  console.log(`        objectId=${a.sui_object_id}`);

  // The SDK auto-fetches the latest gas coin per-tx, but back-to-back submits
  // can race against the fullnode index — give it ~2s to refresh between
  // the two one-time registrations.
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`[setup] registering B-DID...`);
  const b = await registerOne(sponsor, HOSPITAL_B_DID, {
    role: "grantee",
    name: "Hospital B",
  });
  console.log(`        objectId=${b.sui_object_id}`);

  const reg: HospitalDidRegistry = { hospital_a: a, hospital_b: b };
  const path = resolve(process.cwd(), STORE_HOSPITAL_DIDS_IN);
  await writeHospitalDidRegistry(path, reg);
  console.log(`\nWrote registry to ${path}`);
  console.log(`(The cross-access experiment will load this file at startup.)`);
}
