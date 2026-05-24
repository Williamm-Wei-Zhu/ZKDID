/**
 * Tiny JSON-backed grant/request/registry store. Audit-only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  HospitalDidRegistry,
  StoredAccessGrant,
  StoredAccessRequest,
} from "./zkehrTypes.js";

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

export async function loadHospitalDidRegistry(path: string): Promise<HospitalDidRegistry | null> {
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt) as HospitalDidRegistry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
export async function writeHospitalDidRegistry(path: string, reg: HospitalDidRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(reg, null, 2), "utf8");
}
