// Thin client for a standalone salt-service instance (see salt-service/ in the repo root).

export type InstitutionConfig = {
  name: string;
  url: string;     // e.g. "http://ec2-host:7001"
};

export type SaltFetchResult = {
  salt: bigint;
  /** Server-side time reported by the salt service (EC2-only, excludes network). */
  serverMs?: number;
};

export async function fetchSaltFromInstitution(inst: InstitutionConfig, jwt: string): Promise<SaltFetchResult> {
  const res = await fetch(`${inst.url.replace(/\/$/, "")}/get-salt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(`salt-service[${inst.name}]: ${data?.error || res.statusText}`);
  if (typeof data?.salt !== "string") throw new Error(`salt-service[${inst.name}]: missing salt in response`);

  // Prefer the body field (primary channel). Fall back to the Server-Timing header.
  let serverMs: number | undefined = typeof data?.computeMs === "number" ? data.computeMs : undefined;
  if (serverMs === undefined) {
    const hdr = res.headers.get("Server-Timing");
    const m = hdr && /\bcompute;\s*dur=(\d+(?:\.\d+)?)/i.exec(hdr);
    if (m) serverMs = Math.round(Number(m[1]));
  }
  return { salt: BigInt(data.salt), serverMs };
}

/**
 * Fetch the institution's long-lived seed (128-bit BigInt) from its salt-service.
 * Used by the LoginPage's "Generate" button to cache the seed locally so future
 * logins can derive salts offline via poseidonSaltFromSeed().
 */
export async function fetchSeed(inst: InstitutionConfig): Promise<{ seed: bigint; institution: string }> {
  const res = await fetch(`${inst.url.replace(/\/$/, "")}/seed`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(`salt-service[${inst.name}]: ${data?.error || res.statusText}`);
  if (typeof data?.seed !== "string") throw new Error(`salt-service[${inst.name}]: missing seed in response`);
  return { seed: BigInt(data.seed), institution: data.institution || inst.name };
}

export async function pingInstitution(inst: InstitutionConfig): Promise<{ ok: boolean; institution?: string; error?: string }> {
  try {
    const res = await fetch(`${inst.url.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && !!data?.ok, institution: data?.institution };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Merge multiple per-institution salts into a single BigInt by chained Poseidon-ish hash.
 * We avoid bundling circomlibjs in the frontend — `deriveSaltFromSelectedSeeds` already
 * uses SHA-256 locally, so to keep the merge algorithm identical between
 * "multi-institution service" and "multi-institution local seeds" we reuse the same
 * approach: concat salts with "|" and SHA-256 → first 16 bytes → u128.
 */
export async function mergeSalts(parts: bigint[]): Promise<bigint | null> {
  const strs = parts.map(s => s.toString()).filter(Boolean);
  if (!strs.length) return null;
  if (strs.length === 1) return BigInt(strs[0]);   // preserve single-value behavior
  const merged = strs.join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(merged));
  const bytes = new Uint8Array(digest).slice(0, 16);
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) + BigInt(b);
  return salt === 0n ? 1n : salt;
}
