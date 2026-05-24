/**
 * Multi-authority salt fan-out -- zkEHR's defining protocol feature.
 *
 * Mirrors `polymedia-zklogin-demo/web/src/lib/saltClient.ts` exactly:
 *   - parallel POST /get-salt to each configured institution
 *   - merge via SHA-256(salt1 | salt2 | ...) -> first 16 bytes -> u128
 *
 * Using the same merge function here keeps the harness's salt phase
 * byte-for-byte identical to what the zkEHR web client computes.
 */

import { sha256 } from "@noble/hashes/sha256";

export interface InstitutionConfig {
  name: string;
  url: string;
}

export interface SaltFetchResult {
  institution: string;
  salt: bigint;
  /** Server-reported compute time (excludes network RTT). */
  serverMs?: number;
  /** Client-side wall clock for this single fetch. */
  clientMs: number;
}

export async function fetchSaltFromInstitution(
  inst: InstitutionConfig,
  jwt: string,
): Promise<SaltFetchResult> {
  const t0 = performance.now();
  const res = await fetch(`${inst.url.replace(/\/$/, "")}/get-salt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`salt-service[${inst.name}]: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let body: { salt?: string; computeMs?: number };
  try { body = JSON.parse(text); }
  catch { throw new Error(`salt-service[${inst.name}]: non-JSON body: ${text.slice(0, 200)}`); }
  if (typeof body.salt !== "string") {
    throw new Error(`salt-service[${inst.name}]: missing salt: ${text.slice(0, 200)}`);
  }
  return {
    institution: inst.name,
    salt: BigInt(body.salt),
    serverMs: typeof body.computeMs === "number" ? body.computeMs : undefined,
    clientMs: performance.now() - t0,
  };
}

/**
 * SHA-256 merge of N salts -> single u128 BigInt.
 * Matches polymedia-zklogin-demo/web/src/lib/saltClient.ts:67 exactly.
 */
export function mergeSalts(parts: bigint[]): bigint {
  const strs = parts.map((s) => s.toString()).filter(Boolean);
  if (strs.length === 0) throw new Error("mergeSalts: no parts to merge");
  if (strs.length === 1) return BigInt(strs[0]);
  const merged = strs.join("|");
  const digest = sha256(new TextEncoder().encode(merged));
  let salt = 0n;
  for (let i = 0; i < 16; i++) salt = (salt << 8n) | BigInt(digest[i]);
  return salt === 0n ? 1n : salt;
}

export interface MultiAuthSaltResult {
  saltMerged: bigint;
  perInstitution: SaltFetchResult[];
  totalMs: number;
  slowestClientMs: number;
}

export async function deriveMultiAuthoritySalt(
  institutions: InstitutionConfig[],
  jwt: string,
): Promise<MultiAuthSaltResult> {
  const t0 = performance.now();
  const fetched = await Promise.all(institutions.map((i) => fetchSaltFromInstitution(i, jwt)));
  const saltMerged = mergeSalts(fetched.map((f) => f.salt));
  return {
    saltMerged,
    perInstitution: fetched,
    totalMs: performance.now() - t0,
    slowestClientMs: Math.max(...fetched.map((f) => f.clientMs)),
  };
}

export function parseInstitutionsFromEnv(envValue: string): InstitutionConfig[] {
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((url, i) => ({ name: `Institution ${i + 1}`, url }));
}
