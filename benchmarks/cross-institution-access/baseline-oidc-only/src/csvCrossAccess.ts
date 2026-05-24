/**
 * RFC 4180 CSV writer for the cross-institution access experiment.
 *
 * Kept separate from csv.ts so that the original baseline modes (full / reuse)
 * continue to write the canonical OIDC-only CSV layout. This file owns the
 * extended layout that includes the consent-create + Hospital-B + lookup
 * columns.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CrossAccessRunRecord } from "./types.js";

const CSV_HEADER = [
  "run_id",
  "mode",
  "start_time_iso",
  // Grant-phase steps
  "oidc_login_ms",
  "token_exchange_ms",
  "jwks_fetch_or_cache_ms",
  "jwt_verify_ms",
  "claim_validation_ms",
  "session_create_ms",
  "consent_create_ms",
  "grant_total_ms",
  // Access-phase steps
  "b_request_build_ms",
  "a_verify_b_jwt_ms",
  "a_consent_lookup_ms",
  "access_total_ms",
  // End-to-end
  "total_ms",
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
    r.oidc_login_ms.toFixed(3),
    r.token_exchange_ms.toFixed(3),
    r.jwks_fetch_or_cache_ms.toFixed(3),
    r.jwt_verify_ms.toFixed(3),
    r.claim_validation_ms.toFixed(3),
    r.session_create_ms.toFixed(3),
    r.consent_create_ms.toFixed(3),
    r.grant_total_ms.toFixed(3),
    r.b_request_build_ms.toFixed(3),
    r.a_verify_b_jwt_ms.toFixed(3),
    r.a_consent_lookup_ms.toFixed(3),
    r.access_total_ms.toFixed(3),
    r.total_ms.toFixed(3),
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
