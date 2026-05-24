/**
 * CSV writer for the zkLogin cross-institution access experiment.
 * Kept separate from the existing csv.ts so the existing `establish` mode
 * continues to use its layout unchanged.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CrossAccessRunRecord } from "./types.js";

const CSV_HEADER = [
  "run_id",
  "mode",
  "start_time_iso",
  // Grant phase (zkLogin auth + create AccessGrant)
  "ephemeral_keygen_ms",
  "epoch_fetch_ms",
  "randomness_ms",
  "nonce_compute_ms",
  "oidc_login_ms",
  "jwt_decode_ms",
  "salt_fetch_ms",
  "address_compute_ms",
  "prover_request_ms",
  "tx_build_ms",
  "zklogin_sig_assemble_ms",
  "tx_submit_ms",
  "object_extract_ms",
  "local_store_ms",
  "grant_total_ms",
  // Access phase (Hospital B → Hospital A)
  "request_construct_ms",
  "blockchain_query_ms",
  "grant_object_parse_ms",
  "status_check_ms",
  "scope_check_ms",
  "expiration_check_ms",
  "address_authorization_check_ms",
  "access_session_create_ms",
  "access_total_ms",
  // End-to-end + provenance
  "total_ms",
  "zklogin_address",
  "sui_tx_digest",
  "access_grant_object_id",
  "success",
  "error_message",
] as const;

function escapeField(v: string | number | boolean): string {
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToLine(r: CrossAccessRunRecord): string {
  return [
    r.run_id,
    r.mode,
    r.start_time_iso,
    r.ephemeral_keygen_ms.toFixed(3),
    r.epoch_fetch_ms.toFixed(3),
    r.randomness_ms.toFixed(3),
    r.nonce_compute_ms.toFixed(3),
    r.oidc_login_ms.toFixed(3),
    r.jwt_decode_ms.toFixed(3),
    r.salt_fetch_ms.toFixed(3),
    r.address_compute_ms.toFixed(3),
    r.prover_request_ms.toFixed(3),
    r.tx_build_ms.toFixed(3),
    r.zklogin_sig_assemble_ms.toFixed(3),
    r.tx_submit_ms.toFixed(3),
    r.object_extract_ms.toFixed(3),
    r.local_store_ms.toFixed(3),
    r.grant_total_ms.toFixed(3),
    r.request_construct_ms.toFixed(3),
    r.blockchain_query_ms.toFixed(3),
    r.grant_object_parse_ms.toFixed(3),
    r.status_check_ms.toFixed(3),
    r.scope_check_ms.toFixed(3),
    r.expiration_check_ms.toFixed(3),
    r.address_authorization_check_ms.toFixed(3),
    r.access_session_create_ms.toFixed(3),
    r.access_total_ms.toFixed(3),
    r.total_ms.toFixed(3),
    r.zklogin_address,
    r.sui_tx_digest,
    r.access_grant_object_id,
    r.success,
    r.error_message,
  ]
    .map(escapeField)
    .join(",");
}

export async function writeCrossAccessCsv(
  path: string,
  rows: CrossAccessRunRecord[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [CSV_HEADER.join(","), ...rows.map(rowToLine)];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
