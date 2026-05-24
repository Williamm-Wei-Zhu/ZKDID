/**
 * Off-chain query helper for the on-chain
 *   `access_grant::access_grant::AccessGrant`
 * Move object (the SAME package the ACTION-EHR-inspired and zkLogin-only
 * cross-access baselines use, deployed at
 * 0x41ca95117671935dbaf55b595847ffa7d7623a63494e8bf44fc1c63d6577de43).
 *
 * Hospital A queries this object and reads the on-chain `AddressOwner` —
 * for grants minted via zkLogin, that owner is the patient's zkLogin
 * Sui address, which is the address embedded in P-DID.
 */

import type { SuiClient } from "@mysten/sui/client";
import { suiClient } from "./suiClient.js";
import type { ResolvedAccessGrant } from "./zkehrTypes.js";

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
function utf8(b: Uint8Array): string { return Buffer.from(b).toString("utf8"); }
