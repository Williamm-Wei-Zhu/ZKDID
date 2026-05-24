/**
 * Build, sign, and submit a sponsored zkLogin transaction.
 *
 * Pattern (Sui sponsored tx):
 *   - Sender = the zkLogin address
 *   - Gas owner = a separate funded "sponsor" address
 *   - Sender signs with ephemeral key + zkLogin proof
 *   - Sponsor signs with their normal Ed25519 key
 *   - Submit with [zkLoginSig, sponsorSig]
 *
 * For our baseline, the sponsor is the gas-payer key configured via
 * SUI_PRIVATE_KEY in .env -- the same key the OIDC-only and private-key DID
 * baselines use. Sponsoring lets us run 100 zkLogin DID-creates without
 * having to faucet the zkLogin address (which would hit rate limits).
 */

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import { getZkLoginSignature } from "@mysten/sui/zklogin";
import type { ZkProof } from "./zkProver.js";
import { suiClient } from "./suiClient.js";
import { now, elapsedMs } from "./timer.js";

const VECTOR_U8 = bcs.vector(bcs.u8());

export interface GasCoinRef {
  objectId: string;
  version: string | number | bigint;
  digest: string;
}

export interface BuiltZkLoginTx {
  txBytes: Uint8Array;
  build_ms: number;
}

/**
 * Build the unsigned tx that calls did_registry::create_did_object on behalf
 * of the zkLogin user. Sender = zkLogin address; gas owner = sponsor.
 */
export async function buildSponsoredCreateDidTx(args: {
  packageId: string;
  zkLoginAddress: string;
  sponsorAddress: string;
  sponsorGasCoin: GasCoinRef;
  did: string;
  publicKey: Uint8Array;
  metadata: Uint8Array;
}): Promise<BuiltZkLoginTx> {
  const t0 = now();
  const tx = new Transaction();
  tx.setSender(args.zkLoginAddress);
  tx.setGasOwner(args.sponsorAddress);
  tx.setGasPayment([{
    objectId: args.sponsorGasCoin.objectId,
    version: String(args.sponsorGasCoin.version),
    digest: args.sponsorGasCoin.digest,
  }]);
  tx.moveCall({
    target: `${args.packageId}::did_registry::create_did_object`,
    arguments: [
      tx.pure(VECTOR_U8.serialize(Array.from(Buffer.from(args.did, "utf8")))),
      tx.pure(VECTOR_U8.serialize(Array.from(args.publicKey))),
      tx.pure(VECTOR_U8.serialize(Array.from(args.metadata))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  const txBytes = await tx.build({ client: suiClient() });
  return { txBytes, build_ms: elapsedMs(t0) };
}

export interface ExecResult {
  digest: string;
  /** signAndExecuteTransactionBlock RTT (matches zkEHR's submission semantics). */
  submit_ms: number;
  /** Time to extract created object id from effects.created. */
  extract_ms: number;
  objectId: string;
  nextSponsorGasCoin: GasCoinRef;
}

/**
 * Sign the tx with both the ephemeral key (wrapped into a zkLogin signature
 * carrying the proof) and the sponsor key, then submit.
 *
 * Submission semantics match the private-key DID baseline:
 *   requestType: WaitForEffectsCert
 *   options: { showEffects: true }
 * No extra waitForTransaction call.
 */
export async function signAndSubmitZkLoginTx(args: {
  txBytes: Uint8Array;
  ephemeralKp: Ed25519Keypair;
  proof: ZkProof;
  addressSeed: bigint;
  maxEpoch: number;
  sponsor: Ed25519Keypair;
}): Promise<ExecResult> {
  const client = suiClient();

  // Sign once with the ephemeral key over the (sponsored) tx bytes -- this
  // becomes the `userSignature` inside the zkLogin signature wrapper.
  const ephemeralSig = await args.ephemeralKp.signTransaction(args.txBytes);
  const zkLoginSig = getZkLoginSignature({
    inputs: { ...args.proof, addressSeed: args.addressSeed.toString() },
    maxEpoch: args.maxEpoch,
    userSignature: ephemeralSig.signature,
  });
  // Sponsor co-signs.
  const sponsorSig = await args.sponsor.signTransaction(args.txBytes);

  const tSubmit = now();
  const resp = await client.executeTransactionBlock({
    transactionBlock: args.txBytes,
    signature: [zkLoginSig, sponsorSig.signature],
    requestType: "WaitForEffectsCert",
    options: { showEffects: true },
  });
  const submit_ms = elapsedMs(tSubmit);

  const tExtract = now();
  const created = resp.effects?.created ?? [];
  if (created.length === 0) {
    throw new Error(
      `tx ${resp.digest} produced no created objects (status=${resp.effects?.status?.status ?? "unknown"})`,
    );
  }
  // The DIDObject is the only AddressOwner-owned creation in our PTB.
  const didObj = created.find((c) => {
    const owner = c.owner;
    return typeof owner === "object" && owner !== null && "AddressOwner" in owner;
  }) ?? created[0];
  const extract_ms = elapsedMs(tExtract);

  const gasObj = resp.effects?.gasObject;
  if (!gasObj?.reference) {
    throw new Error(`tx ${resp.digest} response missing effects.gasObject.reference`);
  }
  return {
    digest: resp.digest,
    submit_ms,
    extract_ms,
    objectId: didObj.reference.objectId,
    nextSponsorGasCoin: {
      objectId: gasObj.reference.objectId,
      version: gasObj.reference.version,
      digest: gasObj.reference.digest,
    },
  };
}

export async function fetchInitialGasCoin(ownerAddress: string): Promise<GasCoinRef> {
  const client = suiClient();
  const coins = await client.getCoins({ owner: ownerAddress, coinType: "0x2::sui::SUI", limit: 1 });
  if (coins.data.length === 0) {
    throw new Error(`No SUI coins owned by ${ownerAddress}. Run 'sui client faucet' first.`);
  }
  const c = coins.data[0];
  return { objectId: c.coinObjectId, version: c.version, digest: c.digest };
}
