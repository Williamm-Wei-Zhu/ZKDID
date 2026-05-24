/**
 * Generic RFC-4180 CSV writer that takes an array of records and auto-derives
 * the header from the first row's keys. Numbers are emitted with 3-decimal
 * precision; any field containing a comma, double-quote, or newline is quoted.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function escapeField(v: string | number | boolean | null | undefined): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCsv(
  path: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = rows.length > 0 ? Object.keys(rows[0]) : [];
  const headerLine = header.join(",");
  const body = rows
    .map((row) =>
      header
        .map((k) => {
          const v = row[k];
          if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(3) : "";
          return escapeField(v as string | boolean | null | undefined);
        })
        .join(","),
    )
    .join("\n");
  await writeFile(path, `${headerLine}\n${body}\n`, "utf8");
}
