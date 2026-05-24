/**
 * CSV writer for the zkEHR cross-institution access experiment.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZkehrCrossAccessRunRecord } from "./zkehrTypes.js";

const CSV_HEADER = [
  "run_id",
  "mode",
  "start_time_iso",
  // Grant phase
  "tx_build_ms",
  "zklogin_sig_assemble_ms",
  "tx_submit_ms",
  "object_extract_ms",
  "local_store_ms",
  "grant_total_ms",
  // Access phase
  "request_construct_ms",
  "access_grant_query_ms",
  "grant_object_parse_ms",
  "patient_did_resolve_ms",
  "hospital_b_did_resolve_ms",
  "hospital_a_did_check_ms",
  "status_check_ms",
  "scope_check_ms",
  "expiration_check_ms",
  "access_session_create_ms",
  "access_total_ms",
  // End-to-end + provenance
  "total_ms",
  "zklogin_address",
  "patient_did",
  "hospital_b_did",
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

function rowToLine(r: ZkehrCrossAccessRunRecord): string {
  return [
    r.run_id, r.mode, r.start_time_iso,
    r.tx_build_ms.toFixed(3),
    r.zklogin_sig_assemble_ms.toFixed(3),
    r.tx_submit_ms.toFixed(3),
    r.object_extract_ms.toFixed(3),
    r.local_store_ms.toFixed(3),
    r.grant_total_ms.toFixed(3),
    r.request_construct_ms.toFixed(3),
    r.access_grant_query_ms.toFixed(3),
    r.grant_object_parse_ms.toFixed(3),
    r.patient_did_resolve_ms.toFixed(3),
    r.hospital_b_did_resolve_ms.toFixed(3),
    r.hospital_a_did_check_ms.toFixed(3),
    r.status_check_ms.toFixed(3),
    r.scope_check_ms.toFixed(3),
    r.expiration_check_ms.toFixed(3),
    r.access_session_create_ms.toFixed(3),
    r.access_total_ms.toFixed(3),
    r.total_ms.toFixed(3),
    r.zklogin_address,
    r.patient_did,
    r.hospital_b_did,
    r.sui_tx_digest,
    r.access_grant_object_id,
    r.success,
    r.error_message,
  ].map(escapeField).join(",");
}

export async function writeZkehrCrossAccessCsv(
  path: string,
  rows: ZkehrCrossAccessRunRecord[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [CSV_HEADER.join(","), ...rows.map(rowToLine)];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
