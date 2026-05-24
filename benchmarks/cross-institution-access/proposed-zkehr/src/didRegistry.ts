/**
 * Off-chain client for the on-chain `did_registry::did_registry` Move module
 * (the SAME package the private-key DID baseline deploys at
 *  0x64dd915fb8e5bff5b79a9e5e2ea3880588e054aa03630b47e7f43c5d48c1091b).
 *
 * Used for two purposes in this experiment:
 *  1. ONE-TIME setup — register `did:zkehr:hospital:hospital_A` and
 *     `did:zkehr:hospital:hospital_B` on Sui Devnet so Hospital A can
 *     resolve B's DID at access-verify time.
 *  2. PER-RUN access verification — Hospital A queries B's DIDObject by
 *     id, verifies it's active, and confirms the controller matches B's
 *     expected Sui address.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import type { SuiClient } from "@mysten/sui/client";
import { suiClient } from "./suiClient.js";
import { now, elapsedMs } from "./timer.js";
import type { ResolvedDidObject } from "./zkehrTypes.js";

const VECTOR_U8 = bcs.vector(bcs.u8());

export interface CreateDidObjectInput {
  packageId: string;
  did: string;
  publicKey: Uint8Array;
  metadata: Uint8Array;
  signer: Ed25519Keypair;
}

export interface CreateDidResult {
  digest: string;
  objectId: string;
  build_ms: number;
  submit_ms: number;
}

/**
 * Build + submit a `did_registry::create_did_object` transaction.
 *
 * This is the same Move call the private-key DID baseline uses; we reuse
 * the deployed package so the experiments share state. The transaction is
 * signed by the institution's Sui keypair (Hospital A or Hospital B), and
 * the resulting DIDObject is owned by that institution.
 */
export async function createDidObject(input: CreateDidObjectInput): Promise<CreateDidResult> {
  const client = suiClient();
  const tBuild = now();
  const tx = new Transaction();
  tx.moveCall({
    target: `${input.packageId}::did_registry::create_did_object`,
    arguments: [
      tx.pure(VECTOR_U8.serialize(Array.from(Buffer.from(input.did, "utf8")))),
      tx.pure(VECTOR_U8.serialize(Array.from(input.publicKey))),
      tx.pure(VECTOR_U8.serialize(Array.from(input.metadata))),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  const build_ms = elapsedMs(tBuild);

  const tSubmit = now();
  const resp = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: input.signer,
    requestType: "WaitForEffectsCert",
    options: { showEffects: true, showObjectChanges: true },
  });
  const submit_ms = elapsedMs(tSubmit);

  const created = resp.effects?.created ?? [];
  if (created.length === 0) {
    throw new Error(
      `tx ${resp.digest} produced no DIDObject (status=${resp.effects?.status?.status ?? "unknown"})`,
    );
  }
  const didObj = created.find((c) => {
    const owner = c.owner;
    return typeof owner === "object" && owner !== null && "AddressOwner" in owner;
  }) ?? created[0];
  return {
    digest: resp.digest,
    objectId: didObj.reference.objectId,
    build_ms,
    submit_ms,
  };
}

/**
 * Fetch a DIDObject by id and decode its fields.
 * Used at access-verify time to resolve Hospital B's DID. With short
 * bounded retries on `notExists` to absorb fullnode index lag (mirrors
 * the access-grant resolver pattern).
 */
export async function resolveDidObject(objectId: string): Promise<ResolvedDidObject> {
  const client = suiClient();
  const maxAttempts = 10;
  const backoffMs = 50;
  let resp: Awaited<ReturnType<SuiClient["getObject"]>> | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    resp = await client.getObject({
      id: objectId,
      options: { showContent: true, showOwner: true },
    });
    const code = (resp.error as { code?: string } | undefined)?.code;
    if (code !== "notExists" && resp.data) break;
    if (code !== "notExists") break;
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (!resp) throw new Error(`getObject(${objectId}) returned no response`);
  if (resp.error || !resp.data) {
    throw new Error(`getObject(${objectId}) failed: ${JSON.stringify(resp.error)}`);
  }
  const content = resp.data.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`Object ${objectId} is not a Move object`);
  }
  const fields = (content as { fields: Record<string, unknown> }).fields;
  return {
    did: utf8(bytesField(fields["did"], "did")),
    public_key: bytesField(fields["public_key"], "public_key"),
    controller: String(fields["controller"]).toLowerCase(),
    metadata: bytesField(fields["metadata"], "metadata"),
    active: Boolean(fields["active"]),
  };
}

function bytesField(v: unknown, name: string): Uint8Array {
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  if (typeof v === "string") return new Uint8Array(Buffer.from(v, "base64"));
  if (v && typeof v === "object" && Array.isArray((v as { fields?: unknown[] }).fields)) {
    return new Uint8Array((v as { fields: number[] }).fields);
  }
  throw new Error(`Unexpected shape for field '${name}': ${JSON.stringify(v)}`);
}
function utf8(b: Uint8Array): string { return Buffer.from(b).toString("utf8"); }
