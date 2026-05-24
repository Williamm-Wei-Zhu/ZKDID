/**
 * Minimal CSV writer for RunRecord rows. Quotes any field that contains a
 * comma, double-quote, or newline (RFC 4180).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunRecord } from "./types.js";

const CSV_HEADER = [
  "run_id",
  "mode",
  "start_time_iso",
  "oidc_login_ms",
  "token_exchange_ms",
  "jwks_fetch_or_cache_ms",
  "jwt_verify_ms",
  "claim_validation_ms",
  "session_create_ms",
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

function rowToLine(r: RunRecord): string {
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
    r.total_ms.toFixed(3),
    r.success,
    r.error_message,
  ]
    .map(escapeField)
    .join(",");
}

export async function writeCsv(path: string, rows: RunRecord[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [CSV_HEADER.join(","), ...rows.map(rowToLine)];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}
