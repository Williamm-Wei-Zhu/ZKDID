/**
 * RFC 4180 CSV writer for the cross-institution access (DID/VC) experiment.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CrossAccessRunRecord } from "./types.js";

const CSV_HEADER = [
  "run_id",
  "mode",
  "start_time_iso",
  // Grant phase (patient-side, no chain or network)
  "consent_payload_build_ms",
  "consent_sign_ms",
  "grant_total_ms",
  // Access phase (Hospital B → Hospital A; chain involved at A)
  "consent_present_ms",
  "consent_receive_ms",
  "did_resolve_devnet_ms",
  "did_object_parse_ms",
  "signature_verify_ms",
  "scope_expiration_check_ms",
  "access_total_ms",
  // End-to-end
  "total_ms",
  "sui_object_id",
  "patient_did",
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
    r.consent_payload_build_ms.toFixed(3),
    r.consent_sign_ms.toFixed(3),
    r.grant_total_ms.toFixed(3),
    r.consent_present_ms.toFixed(3),
    r.consent_receive_ms.toFixed(3),
    r.did_resolve_devnet_ms.toFixed(3),
    r.did_object_parse_ms.toFixed(3),
    r.signature_verify_ms.toFixed(3),
    r.scope_expiration_check_ms.toFixed(3),
    r.access_total_ms.toFixed(3),
    r.total_ms.toFixed(3),
    r.sui_object_id,
    r.patient_did,
    r.success,
    r.error_message,
  ]
    .map(escapeField)
    .join(",");
}

export async function writeCrossAccessCsv(
  path: string,
  rows: CrossAccessRunRecord[]
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [CSV_HEADER.join(","), ...rows.map(rowToLine)];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
