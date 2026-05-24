/**
 * Off-chain query helper: fetch an AccessGrant by object id from Sui Devnet
 * and decode its fields, including the on-chain `AddressOwner` (which is
 * the patient's zkLogin Sui address — used by Hospital A to perform the
 * "address-based authorization" check).
 *
 * Retry note: with `WaitForEffectsCert` submit semantics, a freshly-created
 * object may not yet be visible at the fullnode RPC layer (effects are
 * certified at validators; the fullnode's indexer catches up shortly
 * after). The end-to-end flow needs to wait through that lag, and the wait
 * IS part of the realistic e2e cost — so we retry on "notExists" with a
 * short bounded backoff. The caller's `blockchain_query_ms` naturally
 * absorbs the retry wait, which is the honest measurement.
 */

import type { SuiClient } from "@mysten/sui/client";
import { suiClient } from "./suiClient.js";
import type { ResolvedAccessGrant } from "./types.js";

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

  // Pull the AddressOwner from the response — for grants minted by a
  // patient via zkLogin, this is the patient's zkLogin Sui address.
  const owner = resp.data.owner;
  let on_chain_owner = "";
  if (owner && typeof owner === "object" && "AddressOwner" in owner) {
    on_chain_owner = String(
      (owner as { AddressOwner: string }).AddressOwner,
    ).toLowerCase();
  }

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
    on_chain_owner,
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
