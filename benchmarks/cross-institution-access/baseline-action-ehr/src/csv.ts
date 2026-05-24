/** RFC 4180 CSV writer that takes a header order + array of records. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function escapeField(v: string | number | boolean | undefined | null): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCsv<T extends Record<string, unknown>>(
  path: string,
  header: readonly (keyof T)[],
  rows: T[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const headerLine = header.join(",");
  const body = rows
    .map((row) =>
      header
        .map((k) => {
          const v = row[k];
          if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(3) : "";
          return escapeField(v as string | number | boolean | undefined | null);
        })
        .join(","),
    )
    .join("\n");
  await writeFile(path, `${headerLine}\n${body}\n`, "utf8");
}
