// Typed wrappers for the zkorchestrator bridge (http://localhost:4317).
// All routes live in ../../../zkorchestrator/bridge.mjs.

export const BRIDGE_BASE = "http://localhost:4317";

export type SessionSummary =
  | { hasSession: false }
  | {
      hasSession: true;
      provider: "google" | "twitch" | "facebook" | "unknown";
      savedAt: string | null;
      maxEpoch: number;
      currentEpoch: number | null;
      remainingEpochs: number | null;
      expired: boolean;
      hasZkProofs: boolean;
      userSaltPresent: boolean;
      jwtClaims: {
        iss?: string;
        sub?: string;
        aud?: string;
        iat?: number;
        exp?: number;
        email?: string;
        name?: string;
        picture?: string;
      } | null;
    };

/** Gas breakdown extracted from Sui tx effects (all values in MIST; 1 SUI = 1e9 MIST). */
export type GasReport = {
  computationCostMist: number;
  storageCostMist: number;
  storageRebateMist: number;
  nonRefundableStorageFeeMist: number;
  /** Convenience: computationCost + storageCost - storageRebate. */
  netGasMist: number;
};

/** Per-object storage detail. `bcsBytes` is the BCS-serialized object content size. */
export type StorageEntry = {
  objectId?: string;
  owner?: string;
  bcsBytes?: number | null;
};

/** Shape of the per-phase timings record the backend produces after each op. */
export type BackendTimings = {
  op?: string;
  userAddress?: string;
  zkDid?: string;
  status?: "success" | "failed" | string;
  digest?: string | null;
  error?: string;
  timestampMs: number;
  timings: Record<string, number>;
  /** Gas breakdown from tx effects (only present on successful submits). */
  gasReport?: GasReport;
  /** Per-created-object storage details (array may be empty for ops that create nothing). */
  storageReport?: StorageEntry[];
};

export type OpResult =
  | { ok: true; op: string; spawned: boolean; args?: unknown; timings: BackendTimings }
  | { ok: false; error: string; timings?: BackendTimings | null };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE_BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = parsed?.error || `${res.status} ${res.statusText}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  return parsed as T;
}

/** GET /epoch — returns the current Sui epoch the bridge sees. */
export const getEpoch = () => request<{ epoch: number }>("GET", "/epoch");

/** GET /session — safe summary of saved session (no JWT, no eph key). */
export const getSession = () => request<SessionSummary>("GET", "/session");

/** POST /session/clear — remove .zk-session.json + .zklogin-ok and kill running backend. */
export const clearSession = () => request<{ ok: true; cleared: string[] }>("POST", "/session/clear");

/** POST /op/did — spawn backend with OP=did. Requires valid saved session. */
export const opDID = () => request<OpResult>("POST", "/op/did");

/** POST /op/vc — spawn backend with OP=vc. */
export const opVC = () => request<OpResult>("POST", "/op/vc");

/** POST /op/access — spawn backend with OP=access + params. */
export const opAccess = (args: { hospitalDid: string; granteeDid: string; recordId: string }) =>
  request<OpResult>("POST", "/op/access", args);

/** GET /salt-seeds — read per-institution salt config the bridge persists. */
export type SaltSeedsPayload = {
  saltSeeds?: Record<string, string>;
  selectedInstitutions?: string[];
};
export const getSaltSeeds = () => request<SaltSeedsPayload>("GET", "/salt-seeds");

/** POST /salt-seeds — persist salt config. */
export const saveSaltSeeds = (p: SaltSeedsPayload) => request<{ ok: true }>("POST", "/salt-seeds", p);

/** POST /run-with-last-session — reuse .zk-session.json to re-spawn backend. */
export const runWithLastSession = () => request<{ ok: true }>("POST", "/run-with-last-session");

/** GET /latest-timings — last op's timings (same payload as returned by /op/* now).
 * Kept for initial page load when the user hasn't run an op yet but we still
 * want to populate the DID page's backend card from the persisted snapshot.
 * Returns null if the backend hasn't run yet (HTTP 404). */
export async function getLatestBackendTimings(): Promise<BackendTimings | null> {
  try {
    return await request<BackendTimings>("GET", "/latest-timings");
  } catch (e: any) {
    if (/404/.test(String(e?.message))) return null;
    throw e;
  }
}
