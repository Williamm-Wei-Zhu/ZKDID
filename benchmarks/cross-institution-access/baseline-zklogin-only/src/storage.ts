/**
 * Tiny JSON-backed grant/request store. Used so the cross-access experiment
 * can persist grants across runs (audit trail) and resume from previous runs.
 * Local academic artifact only — not encrypted.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredAccessGrant, StoredAccessRequest } from "./types.js";

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const txt = await readFile(path, "utf8");
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeJsonArray<T>(path: string, rows: T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(rows, null, 2), "utf8");
}

export async function appendGrant(path: string, g: StoredAccessGrant): Promise<void> {
  const rows = await readJsonArray<StoredAccessGrant>(path);
  rows.push(g);
  await writeJsonArray(path, rows);
}

export async function appendRequest(path: string, r: StoredAccessRequest): Promise<void> {
  const rows = await readJsonArray<StoredAccessRequest>(path);
  rows.push(r);
  await writeJsonArray(path, rows);
}
