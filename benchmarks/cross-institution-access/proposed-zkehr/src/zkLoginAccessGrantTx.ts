/**
 * Sponsored zkLogin transaction that calls the on-chain
 *   access_grant::access_grant::create_access_grant(...)
 * Move function with DID-bound fields:
 *   - patient_id              -> P-DID string ("did:zkehr:zklogin:<addr>")
 *   - data_holder_hospital_id -> A-DID string ("did:zkehr:hospital:hospital_A")
 *   - grantee_hospital_id     -> B-DID string ("did:zkehr:hospital:hospital_B")
 *   - grantee_address         -> B's Sui address (additional binding)
 *   - ehr_record_id, scope, expiration
 *
 * The patient's zkLogin Sui address is the sender (and becomes the on-chain
 * owner of the new AccessGrant). The sponsor key (cfg.privateKey) pays gas.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import { getZkLoginSignature } from "@mysten/sui/zklogin";
import type { ZkProof } from "./zkProver.js";
import { suiClient } from "./suiClient.js";
import { now, elapsedMs } from "./timer.js";
import type { GasCoinRef } from "./zkLoginTx.js";

const VECTOR_U8 = bcs.vector(bcs.u8());

export interface BuiltZkLoginAccessGrantTx {
  txBytes: Uint8Array;
  build_ms: number;
}

export interface BuildSponsoredCreateAccessGrantInput {
  packageId: string;
  zkLoginAddress: string;
  sponsorAddress: string;
  sponsorGasCoin: GasCoinRef;
  patientDid: Uint8Array;
  dataHolderDid: Uint8Array;
  granteeDid: Uint8Array;
  granteeAddress: string;
  ehrRecordId: Uint8Array;
  scope: Uint8Array;
  expiresAtMs: bigint;
}

export async function buildSponsoredCreateAccessGrantTx(
  args: BuildSponsoredCreateAccessGrantInput,
): Promise<BuiltZkLoginAccessGrantTx> {
  const t0 = now();
  const tx = new Transaction();
  tx.setSender(args.zkLoginAddress);
  tx.setGasOwner(args.sponsorAddress);
  tx.setGasPayment([
    {
      objectId: args.sponsorGasCoin.objectId,
      version: String(args.sponsorGasCoin.version),
      digest: args.sponsorGasCoin.digest,
    },
  ]);
  tx.moveCall({
    target: `${args.packageId}::access_grant::create_access_grant`,
    arguments: [
      tx.pure(VECTOR_U8.serialize(Array.from(args.patientDid))),
      tx.pure(VECTOR_U8.serialize(Array.from(args.dataHolderDid))),
      tx.pure(VECTOR_U8.serialize(Array.from(args.granteeDid))),
      tx.pure.address(args.granteeAddress),
      tx.pure(VECTOR_U8.serialize(Array.from(args.ehrRecordId))),
      tx.pure(VECTOR_U8.serialize(Array.from(args.scope))),
      tx.pure.u64(args.expiresAtMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  const txBytes = await tx.build({ client: suiClient() });
  return { txBytes, build_ms: elapsedMs(t0) };
}

export interface ExecAccessGrantResult {
  digest: string;
  submit_ms: number;
  extract_ms: number;
  objectId: string;
  nextSponsorGasCoin: GasCoinRef;
}

export async function signAndSubmitZkLoginAccessGrant(args: {
  txBytes: Uint8Array;
  ephemeralKp: Ed25519Keypair;
  proof: ZkProof;
  addressSeed: bigint;
  maxEpoch: number;
  sponsor: Ed25519Keypair;
}): Promise<ExecAccessGrantResult> {
  const client = suiClient();

  const ephemeralSig = await args.ephemeralKp.signTransaction(args.txBytes);
  const zkLoginSig = getZkLoginSignature({
    inputs: { ...args.proof, addressSeed: args.addressSeed.toString() },
    maxEpoch: args.maxEpoch,
    userSignature: ephemeralSig.signature,
  });
  const sponsorSig = await args.sponsor.signTransaction(args.txBytes);

  const tSubmit = now();
  const resp = await client.executeTransactionBlock({
    transactionBlock: args.txBytes,
    signature: [zkLoginSig, sponsorSig.signature],
    requestType: "WaitForEffectsCert",
    options: { showEffects: true, showObjectChanges: true },
  });
  const submit_ms = elapsedMs(tSubmit);

  const tExtract = now();
  let objectId = "";
  for (const c of resp.objectChanges ?? []) {
    if (c.type === "created" && typeof c.objectType === "string" && c.objectType.endsWith("::access_grant::AccessGrant")) {
      objectId = c.objectId;
      break;
    }
  }
  if (!objectId) {
    const created = resp.effects?.created ?? [];
    const addrOwned = created.find((c) => {
      const owner = c.owner;
      return typeof owner === "object" && owner !== null && "AddressOwner" in owner;
    });
    if (addrOwned?.reference?.objectId) objectId = addrOwned.reference.objectId;
  }
  if (!objectId) {
    throw new Error(
      `tx ${resp.digest} produced no AccessGrant (status=${resp.effects?.status?.status ?? "unknown"})`,
    );
  }
  const extract_ms = elapsedMs(tExtract);

  const gasObj = resp.effects?.gasObject;
  if (!gasObj?.reference) {
    throw new Error(`tx ${resp.digest} response missing effects.gasObject.reference`);
  }
  return {
    digest: resp.digest,
    submit_ms,
    extract_ms,
    objectId,
    nextSponsorGasCoin: {
      objectId: gasObj.reference.objectId,
      version: gasObj.reference.version,
      digest: gasObj.reference.digest,
    },
  };
}
