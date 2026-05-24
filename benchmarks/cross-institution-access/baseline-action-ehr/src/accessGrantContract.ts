/**
 * Off-chain client for the on-chain `access_grant::access_grant` Move module.
 *
 * Three operations the experiments care about:
 *   - buildCreateAccessGrantTx — build a transaction calling create_access_grant.
 *   - executeAndExtractAccessGrant — sign, submit, await effects, extract object id.
 *   - resolveAccessGrant — fetch the AccessGrant object by id and parse all fields.
 *
 * Per-step timing (tx_build vs tx_submit vs tx_finality vs object_extract) is
 * exposed so the per-run CSV columns reflect honest wall-clock work.
 */

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiClient } from "@mysten/sui/client";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import { suiClient } from "./suiClient.js";
import { now, elapsedMs } from "./timer.js";
import type { GasCoinRef, ResolvedAccessGrant } from "./types.js";

const VECTOR_U8 = bcs.vector(bcs.u8());

export interface BuildCreateGrantInput {
  packageId: string;
  patientId: Uint8Array;
  dataHolderHospitalId: Uint8Array;
  granteeHospitalId: Uint8Array;
  granteeAddress: string;
  ehrRecordId: Uint8Array;
  scope: Uint8Array;
  expiresAtMs: bigint;
  gasCoin?: GasCoinRef;
}

export interface BuildResult {
  tx: Transaction;
  build_ms: number;
}

export function buildCreateAccessGrantTx(i: BuildCreateGrantInput): BuildResult {
  const t0 = now();
  const tx = new Transaction();
  tx.moveCall({
    target: `${i.packageId}::access_grant::create_access_grant`,
    arguments: [
      tx.pure(VECTOR_U8.serialize(Array.from(i.patientId))),
      tx.pure(VECTOR_U8.serialize(Array.from(i.dataHolderHospitalId))),
      tx.pure(VECTOR_U8.serialize(Array.from(i.granteeHospitalId))),
      tx.pure.address(i.granteeAddress),
      tx.pure(VECTOR_U8.serialize(Array.from(i.ehrRecordId))),
      tx.pure(VECTOR_U8.serialize(Array.from(i.scope))),
      tx.pure.u64(i.expiresAtMs),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  if (i.gasCoin) {
    tx.setGasPayment([
      {
        objectId: i.gasCoin.objectId,
        version: String(i.gasCoin.version),
        digest: i.gasCoin.digest,
      },
    ]);
  }
  return { tx, build_ms: elapsedMs(t0) };
}

export interface ExecResult {
  digest: string;
  /** Time from sign+send until the RPC returns the effects certificate. */
  submit_ms: number;
  /** Time spent waiting for client-side finality confirmation
   *  (0 here — we use WaitForEffectsCert; see comment below). */
  finality_ms: number;
  /** Time spent extracting the new AccessGrant id from objectChanges. */
  extract_ms: number;
  objectId: string;
  /** Updated gas-coin reference for the next tx. */
  nextGasCoin: GasCoinRef;
}

/**
 * Execute a built create_access_grant transaction.
 *
 * Submission semantics: `requestType: 'WaitForEffectsCert'` — matches the
 * sibling private-key-DID baseline so the Sui wall-clock numbers are
 * comparable across baselines. The RPC returns once a quorum of validators
 * has certified the effects; this is sufficient for the new AccessGrant id
 * to be deterministically known and queryable. We DO request `objectChanges`
 * (per the brief) so the new object id can be extracted directly.
 */
export async function executeAndExtractAccessGrant(
  tx: Transaction,
  signer: Ed25519Keypair,
): Promise<ExecResult> {
  const client = suiClient();

  const tSubmit = now();
  const submitResp = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    requestType: "WaitForEffectsCert",
    options: { showEffects: true, showObjectChanges: true },
  });
  const submit_ms = elapsedMs(tSubmit);

  // We do not call waitForTransaction (would add ~1-2s of unfair penalty).
  // WaitForEffectsCert means the effects are certified; objectChanges is
  // available immediately in submitResp.
  const finality_ms = 0;

  const tExtract = now();
  const objectChanges = submitResp.objectChanges ?? [];
  // The new AccessGrant object is the single 'created' entry whose
  // objectType ends in `::access_grant::AccessGrant`.
  let objectId = "";
  for (const c of objectChanges) {
    if (c.type === "created" && typeof c.objectType === "string" && c.objectType.endsWith("::access_grant::AccessGrant")) {
      objectId = c.objectId;
      break;
    }
  }
  if (!objectId) {
    // Fallback: pick any AddressOwner-created object (deploy-time invariant
    // for a single-create tx). If still nothing, surface effects details.
    const created = submitResp.effects?.created ?? [];
    const addrOwned = created.find((c) => {
      const owner = c.owner;
      return typeof owner === "object" && owner !== null && "AddressOwner" in owner;
    });
    if (addrOwned?.reference?.objectId) {
      objectId = addrOwned.reference.objectId;
    }
  }
  if (!objectId) {
    throw new Error(
      `tx ${submitResp.digest} produced no AccessGrant object (status=${
        submitResp.effects?.status?.status ?? "unknown"
      })`,
    );
  }
  const extract_ms = elapsedMs(tExtract);

  const gasObj = submitResp.effects?.gasObject;
  if (!gasObj?.reference) {
    throw new Error(`tx ${submitResp.digest} response missing effects.gasObject.reference`);
  }
  const nextGasCoin: GasCoinRef = {
    objectId: gasObj.reference.objectId,
    version: gasObj.reference.version,
    digest: gasObj.reference.digest,
  };

  return {
    digest: submitResp.digest,
    submit_ms,
    finality_ms,
    extract_ms,
    objectId,
    nextGasCoin,
  };
}

/** Seed the gas-coin cache once at experiment start. */
export async function fetchInitialGasCoin(ownerAddress: string): Promise<GasCoinRef> {
  const client = suiClient();
  const coins = await client.getCoins({
    owner: ownerAddress,
    coinType: "0x2::sui::SUI",
    limit: 1,
  });
  if (coins.data.length === 0) {
    throw new Error(
      `No SUI coins owned by ${ownerAddress}. Run 'sui client faucet' first.`,
    );
  }
  const c = coins.data[0];
  return { objectId: c.coinObjectId, version: c.version, digest: c.digest };
}

/**
 * Fetch an AccessGrant object from chain and decode all fields.
 *
 * Returns the parsed grant. Throws on RPC error or malformed object.
 *
 * Retry note: with `WaitForEffectsCert` submit semantics, a freshly-created
 * object may not yet be visible at the fullnode RPC layer (effects are
 * certified at validators; the fullnode's indexer catches up shortly
 * after). The end-to-end experiment needs to wait through that lag, and
 * the wait IS part of the realistic e2e cost — so we retry on "notExists"
 * with a short bounded backoff. The caller's `blockchain_query_ms`
 * naturally absorbs the retry wait, which is the honest measurement.
 */
export async function resolveAccessGrant(objectId: string): Promise<ResolvedAccessGrant> {
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
    if (code !== "notExists" && code !== "deleted" && resp.data) break;
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
    patient_id: utf8(bytesField(fields["patient_id"], "patient_id")),
    data_holder_hospital_id: utf8(bytesField(fields["data_holder_hospital_id"], "data_holder_hospital_id")),
    grantee_hospital_id: utf8(bytesField(fields["grantee_hospital_id"], "grantee_hospital_id")),
    grantee_address: String(fields["grantee_address"]).toLowerCase(),
    ehr_record_id: utf8(bytesField(fields["ehr_record_id"], "ehr_record_id")),
    scope: utf8(bytesField(fields["scope"], "scope")),
    created_at_ms: Number(fields["created_at_ms"]),
    expires_at_ms: Number(fields["expires_at_ms"]),
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

function utf8(b: Uint8Array): string {
  return Buffer.from(b).toString("utf8");
}
