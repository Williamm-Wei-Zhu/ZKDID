/**
 * Tiny JSON-backed wallet/DID store. Only used so the auth experiment can
 * load DIDs the establishment experiment created. Not encrypted — this is a
 * local academic artifact.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredDid, StoredWallet } from "./types.js";

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

export async function appendWallet(path: string, w: StoredWallet): Promise<void> {
  const rows = await readJsonArray<StoredWallet>(path);
  rows.push(w);
  await writeJsonArray(path, rows);
}
export async function appendDid(path: string, d: StoredDid): Promise<void> {
  const rows = await readJsonArray<StoredDid>(path);
  rows.push(d);
  await writeJsonArray(path, rows);
}
export async function loadWallets(path: string): Promise<StoredWallet[]> {
  return readJsonArray<StoredWallet>(path);
}
export async function loadDids(path: string): Promise<StoredDid[]> {
  return readJsonArray<StoredDid>(path);
}
