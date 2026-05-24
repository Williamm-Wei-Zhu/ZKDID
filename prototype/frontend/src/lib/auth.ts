// Pure (no React) zkLogin auth helpers extracted from the original App.tsx.
// Keeps the exact storage keys and algorithmic behavior so old sessions remain
// readable. Semantics unchanged — only the host (a React page) changed.

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  jwtToAddress,
} from "@mysten/sui/zklogin";
import { jwtDecode } from "jwt-decode";

import config from "../config.json";
import { BRIDGE_BASE } from "./bridge";
import type { InstitutionConfig } from "./saltClient";
import { fetchSaltFromInstitution, mergeSalts } from "./saltClient";
import { poseidonSaltFromSeed } from "./localPoseidon";

/* ---------------- network ---------------- */
export const NETWORK = "devnet" as const;
export const MAX_EPOCH_DELTA = 8;                  // preserved from original
export const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

/* ---------------- storage keys (unchanged) ---------------- */
export const KEY_SETUP = "zklogin-demo.setup";
export const KEY_SETUP_BY_NONCE = "zklogin-demo.setupByNonce";
export const KEY_ACCOUNTS = "zklogin-demo.accounts";
export const KEY_TIMING = "zklogin-demo.timing";
export const KEY_OAUTH_START = "zklogin-demo.oauthStartAt";
export const KEY_SALT_PICKER = "zklogin-demo.saltPicker";

/* ---------------- types ---------------- */
export type OpenIdProvider = "Google" | "Twitch" | "Facebook";

export const INSTITUTIONS = [
  "Institution 1", "Institution 2", "Institution 3", "Institution 4", "Institution 5",
  "Institution 6", "Institution 7", "Institution 8", "Institution 9", "Institution 10",
] as const;
export type InstitutionName = (typeof INSTITUTIONS)[number];
export type SaltSeedMap = Record<InstitutionName, string>;
export const DEFAULT_SALT_SEEDS: SaltSeedMap = INSTITUTIONS.reduce(
  (m, k) => ({ ...m, [k]: "" }),
  {} as SaltSeedMap,
);

export type SetupData = {
  provider: OpenIdProvider;
  maxEpoch: number;
  randomness: string | Uint8Array;
  ephemeralPrivateKey: string | Uint8Array;
  nonce: string;
};

export type AccountData = {
  provider: OpenIdProvider;
  userAddr: string;
  zkProofs: any;
  ephemeralPrivateKey: string | Uint8Array;
  userSalt: string;
  sub: string;
  aud: string;
  maxEpoch: number;
  randomness: string | Uint8Array;
  nonce: string;
  jwt: string;
};

export type TimingRecord = {
  /** Pre-OAuth: wall-clock for the whole beginZkLogin prep block (the old aggregate). */
  genParamsMs?: number;
  /** Pre-OAuth: sui_getLatestSuiSystemState to compute maxEpoch. */
  epochFetchMs?: number;
  /** Pre-OAuth: `new Ed25519Keypair()` — creates the ephemeral key. */
  ephKeyMs?: number;
  /** Pre-OAuth: generateRandomness() — 128 bits from window.crypto. */
  randomnessMs?: number;
  /** Pre-OAuth: generateNonce(pk, maxEpoch, randomness) — SHA-256 hash input prep. */
  nonceMs?: number;
  /** OAuth → back here: user-paced wall clock (kept for reference, not shown by default). */
  oauthJwtMs?: number;
  /** Post-OAuth: jwtDecode() + sub/aud sanity. */
  jwtParseMs?: number;
  /** Post-OAuth: salt derivation across selected institutions (parallel fan-out). */
  saltMs?: number;
  /** Post-OAuth: nonce verification (restore keypair, re-compute expected nonce). */
  nonceVerifyMs?: number;
  /** Post-OAuth: POST to Mysten prover for zkProof. */
  proverMs?: number;
  /** Post-OAuth: saveAccount() — localStorage write. */
  saveAccountMs?: number;
  /** Post-OAuth: postSessionToBridge() — upload session to orchestrator. */
  bridgePostMs?: number;
  /** Derived: saltMs + proverMs. */
  deriveAllMs?: number;
};
export type TimingMap = Record<string, TimingRecord>;

/* ---------------- base64 utils ---------------- */
export function u8ToB64(u8: Uint8Array): string {
  let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ---------------- normalization ---------------- */
function toUint8ArrayLike(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const length = typeof obj.length === "number" ? obj.length : undefined;
  if (typeof length === "number" && length >= 0) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = Number(obj[i] ?? 0);
    return out;
  }
  const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  if (!keys.length) return null;
  return Uint8Array.from(keys.map((k) => Number(obj[String(k)] ?? 0)));
}
export function normalizeRandomness(input: unknown): string | Uint8Array {
  if (typeof input === "string") return input;
  const u8 = toUint8ArrayLike(input);
  return u8 ?? "";
}
export function keypairFromSecretKey(input: string | Uint8Array): Ed25519Keypair {
  if (typeof input === "string") {
    const { secretKey } = decodeSuiPrivateKey(input);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(input);
}

/* ---------------- local (fallback) salt derivation ---------------- */
export async function deriveSaltFromSelectedSeeds(
  selected: string[],
  saltSeeds: SaltSeedMap,
): Promise<bigint | null> {
  const seeds = selected
    .map((i) => saltSeeds[i as InstitutionName]?.trim())
    .filter((s): s is string => Boolean(s));
  if (!seeds.length) return null;
  const merged = seeds.join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(merged));
  const bytes = new Uint8Array(digest).slice(0, 16);
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) + BigInt(b);
  return salt === 0n ? 1n : salt;
}

/* ---------------- storage helpers ---------------- */
export function saveSetupData(data: SetupData) { sessionStorage.setItem(KEY_SETUP, JSON.stringify(data)); }
export function loadSetupData(): SetupData | null {
  const raw = sessionStorage.getItem(KEY_SETUP);
  return raw ? JSON.parse(raw) : null;
}
function loadSetupMap(): Record<string, SetupData> {
  try { return JSON.parse(sessionStorage.getItem(KEY_SETUP_BY_NONCE) || "{}"); } catch { return {}; }
}
export function saveSetupByNonce(nonce: string, data: SetupData) {
  const m = loadSetupMap(); m[nonce] = data;
  sessionStorage.setItem(KEY_SETUP_BY_NONCE, JSON.stringify(m));
}
export function loadSetupByNonce(nonce: string): SetupData | null {
  return loadSetupMap()[nonce] ?? null;
}
/**
 * Pick the prover URL based on a runtime A/B switch.
 *
 *   ?prover=proxy    → bridge.mjs `/proxy-prover` (browser → bridge → Mysten)
 *   ?prover=backend  → null (skip browser-side prover entirely; backend runs it)
 *   anything else    → direct (browser → Mysten), the default
 *
 * Returning `null` instructs `completeZkLogin` to skip the prover fetch and
 * not include `ZK_PROOFS` in the bridge POST.  The backend
 * (`veramo-to-sui.js`) automatically falls back to calling Mysten itself
 * when no preloaded proof is provided — at ~33 ms vs ~2500 ms in-browser.
 *
 * The first time we see `?prover=...` in `window.location.search` we cache
 * the value in sessionStorage so it survives the OAuth round-trip page
 * navigation (which doesn't preserve query params).
 */
export const KEY_PROVER_MODE = "zklogin-demo.prover-mode";

/**
 * Stash `?prover=…` into sessionStorage at module-load time, BEFORE any
 * OAuth redirect can strip the query string. Idempotent: a clean tab with
 * no `?prover=` does nothing (preserves whatever a previous run cached).
 *
 * Important: must be called from the app's entry point (e.g. `_init.tsx`)
 * — `pickProverUrl()` only runs after the OAuth bounce returns with a JWT
 * fragment, by which time `window.location.search` is empty.
 */
export function cacheProverModeFromUrl(): void {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("prover");
    if (fromUrl) sessionStorage.setItem(KEY_PROVER_MODE, fromUrl);
  } catch { /* hostile environment, fall through */ }
}

export function pickProverUrl(directUrl: string): string | null {
  try {
    // Belt-and-suspenders: also try to capture from URL here, in case some
    // future caller invokes pickProverUrl on the initial page load.
    cacheProverModeFromUrl();
    const mode = sessionStorage.getItem(KEY_PROVER_MODE);
    if (mode === "backend") return null;
    if (mode === "proxy") return `${BRIDGE_BASE}/proxy-prover`;
  } catch { /* hostile environment, fall through */ }
  return directUrl;
}

export function clearSetupData() { sessionStorage.removeItem(KEY_SETUP); }
export function clearSetupByNonce(nonce: string) {
  const m = loadSetupMap(); delete m[nonce];
  if (!Object.keys(m).length) sessionStorage.removeItem(KEY_SETUP_BY_NONCE);
  else sessionStorage.setItem(KEY_SETUP_BY_NONCE, JSON.stringify(m));
}

export function saveAccount(account: AccountData): AccountData[] {
  const existing = loadAccounts();
  const next = [account, ...existing.filter((a) => a.userAddr !== account.userAddr)];
  sessionStorage.setItem(KEY_ACCOUNTS, JSON.stringify(next));
  return next;
}
export function loadAccounts(): AccountData[] {
  const raw = sessionStorage.getItem(KEY_ACCOUNTS);
  return raw ? JSON.parse(raw) : [];
}
export function clearAllLocalState() {
  sessionStorage.clear();
  // localStorage also has zklogin.lastEpoch; clear it too.
  localStorage.removeItem("zklogin.lastEpoch");
}

/* ---------------- timing ---------------- */
export function loadTiming(): TimingMap {
  try { return JSON.parse(sessionStorage.getItem(KEY_TIMING) || "{}"); } catch { return {}; }
}
export function saveTiming(m: TimingMap) { sessionStorage.setItem(KEY_TIMING, JSON.stringify(m)); }
export function setTimingFor(key: string, patch: Partial<TimingRecord>) {
  const m = loadTiming();
  m[key] = { ...(m[key] || {}), ...patch };
  saveTiming(m);
}
export function getTimingFor(key: string): TimingRecord {
  return loadTiming()[key] || {};
}

/* ---------------- bridge wire ---------------- */
export function postSessionToBridge(acct: AccountData): Promise<void> {
  const epk = typeof acct.ephemeralPrivateKey === "string"
    ? acct.ephemeralPrivateKey
    : u8ToB64(acct.ephemeralPrivateKey);
  // When acct.zkProofs is null/undefined (prover-mode=backend), omit the field
  // entirely so the backend's fallback path is triggered (it will call Mysten
  // itself in Node, ~33 ms vs ~2500 ms in browser).
  const payload: Record<string, unknown> = {
    GOOGLE_ID_TOKEN: acct.jwt,
    EPHEMERAL_PRIVATE_KEY: epk,
    JWT_RANDOMNESS: typeof acct.randomness === "string" ? acct.randomness : u8ToB64(acct.randomness),
    MAX_EPOCH: String(acct.maxEpoch),
    PROVIDER: acct.provider.toLowerCase(),
    USER_SALT: acct.userSalt,
  };
  if (acct.zkProofs && typeof acct.zkProofs === "object") {
    payload.ZK_PROOFS = acct.zkProofs;
  }
  return fetch(`${BRIDGE_BASE}/zklogin-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(() => undefined).catch((e) => { console.warn("[postSessionToBridge] failed:", e); });
}

/** Fire-and-forget upload of the just-finalized browser-side TimingRecord to the
 *  bridge, so EC2-side tools (e.g., experiment harnesses) can read it without
 *  scraping localStorage. Called AFTER postSessionToBridge, when timings are
 *  fully assembled. Non-fatal: errors are logged but login still succeeds. */
export function postBrowserTimingsToBridge(userAddr: string, timing: TimingRecord): Promise<void> {
  return fetch(`${BRIDGE_BASE}/browser-timings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userAddr, timing }),
  }).then(() => undefined).catch((e) => { console.warn("[postBrowserTimingsToBridge] failed:", e); });
}

/* ---------------- begin & complete zkLogin ---------------- */

export type SaltContext = {
  selectedInstitutions: string[];
  saltSeeds: SaltSeedMap;
  /** Optional: per-institution salt-service endpoints. If supplied, takes precedence over local seeds. */
  institutionServices?: InstitutionConfig[];
};

/**
 * Per-institution dispatch: for each SELECTED institution, compute its salt.
 *   - If a seed is cached in saltSeeds[name] → local Poseidon(seed, sub)
 *   - Else if an EC2 service URL is configured → remote /get-salt
 *   - Else → skip (no contribution)
 *
 * All per-institution salts are then merged via mergeSalts (SHA-256 of pipe-
 * joined decimals, truncated to 128 bits), identical to the pre-existing
 * algorithm. Because local and remote paths produce the SAME per-institution
 * salt (both use Poseidon(seed, sub) mod 2^128), caching via "Generate" and
 * calling remote at login time yield the same final zkLogin address.
 */
async function deriveEffectiveSalt(
  jwt: string,
  ctx: SaltContext,
  tProverTiming: (saltMs: number) => void,
): Promise<bigint | null> {
  const payload: any = jwtDecode(jwt);
  const subStr = String(payload?.sub || "");
  if (!/^\d+$/.test(subStr)) {
    console.warn("[deriveEffectiveSalt] jwt.sub is not numeric; remote service will reject it");
    return null;
  }
  const sub = BigInt(subStr);

  const servicesByName = new Map<string, InstitutionConfig>();
  for (const s of ctx.institutionServices || []) servicesByName.set(s.name, s);

  // Wall-clock timer: measures the whole parallel fan-out from the browser's
  // perspective, including any tunnel / network latency to the salt services.
  // This is the "user experience" duration for the Fetch salt phase.
  const t0 = performance.now();
  const results = await Promise.all(
    ctx.selectedInstitutions.map(async (name): Promise<bigint | null> => {
      const cached = ctx.saltSeeds[name as InstitutionName]?.trim();
      if (cached) {
        try { return await poseidonSaltFromSeed(BigInt(cached), sub); }
        catch (e) { console.warn(`[deriveEffectiveSalt] local Poseidon failed for ${name}:`, e); return null; }
      }
      const svc = servicesByName.get(name);
      if (svc) {
        try {
          const r = await fetchSaltFromInstitution(svc, jwt);
          return r.salt;
        } catch (e) { console.warn(`[deriveEffectiveSalt] remote fetch failed for ${name}:`, e); return null; }
      }
      // Neither cached nor remote: skip silently.
      return null;
    }),
  );
  const valid = results.filter((x): x is bigint => typeof x === "bigint");
  tProverTiming(Math.round(performance.now() - t0));

  if (valid.length) {
    const merged = await mergeSalts(valid);
    if (merged) return merged;
  }

  // No salt could be derived. We intentionally do NOT fall back to a
  // hardcoded/dummy salt — sharing a public salt across users defeats
  // zkLogin's address-unlinkability property. The caller (completeZkLogin)
  // will surface an alert telling the user to enable at least one institution
  // seed (via the "Generate" button on the Login page) or start a salt
  // service.
  return null;
}

/**
 * Step 1 — Start OAuth. Generates ephemeral key + nonce, persists setup data,
 * then navigates to the provider's authorize URL. The browser will come back
 * to this page with a JWT in the URL fragment.
 */
export async function beginZkLogin(
  provider: OpenIdProvider,
  onStatus: (s: string | null) => void,
): Promise<void> {
  onStatus(`🔑 Logging in with ${provider}...`);

  // epoch — network RPC to Sui (browser → Sui, does not go through EC2 bridge)
  const tEpochStart = performance.now();
  let currentEpoch: number;
  try {
    const { epoch } = await suiClient.getLatestSuiSystemState();
    localStorage.setItem("zklogin.lastEpoch", String(epoch));
    currentEpoch = Number(epoch);
  } catch {
    const cached = Number(localStorage.getItem("zklogin.lastEpoch") || "0");
    currentEpoch = Number.isFinite(cached) ? cached : 0;
    onStatus("⚠️ Could not fetch current Sui epoch — using cached. Proving may fail.");
    await new Promise((r) => setTimeout(r, 900));
  }
  const epochFetchMs = Math.round(performance.now() - tEpochStart);
  const maxEpoch = currentEpoch + MAX_EPOCH_DELTA;

  // ephemeral keys + nonce (sub-phases timed individually for observability)
  const tEphStart = performance.now();
  const ephemeralKeyPair = new Ed25519Keypair();
  const ephKeyMs = Math.round(performance.now() - tEphStart);

  const tRandStart = performance.now();
  const randomness = generateRandomness();
  const randomnessMs = Math.round(performance.now() - tRandStart);

  const tNonceStart = performance.now();
  const nonce = generateNonce(ephemeralKeyPair.getPublicKey(), maxEpoch, randomness);
  const nonceMs = Math.round(performance.now() - tNonceStart);

  // Keep genParamsMs as the aggregate for backward-compat with existing card.
  const genParamsMs = ephKeyMs + randomnessMs + nonceMs;
  setTimingFor("_last", { genParamsMs, epochFetchMs, ephKeyMs, randomnessMs, nonceMs });

  const setupData: SetupData = {
    provider,
    maxEpoch,
    randomness,
    ephemeralPrivateKey: ephemeralKeyPair.getSecretKey(),
    nonce,
  };
  saveSetupData(setupData);
  saveSetupByNonce(nonce, setupData);
  sessionStorage.setItem(KEY_OAUTH_START, String(Date.now()));

  // redirect to provider
  const redirectBase = window.location.origin;
  const scopeMap: Record<OpenIdProvider, string> = {
    Google: "openid profile email",
    Twitch: "openid user:read:email",
    Facebook: "openid email",
  };
  const common: Record<string, string> = {
    nonce,
    redirect_uri: redirectBase,
    response_type: "id_token",
    scope: scopeMap[provider],
  };
  const cfg = config as any;
  let url = "";
  switch (provider) {
    case "Google":
      url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ ...common, client_id: cfg.CLIENT_ID_GOOGLE }).toString();
      break;
    case "Twitch":
      url = "https://id.twitch.tv/oauth2/authorize?" + new URLSearchParams({ ...common, client_id: cfg.CLIENT_ID_TWITCH, force_verify: "true" }).toString();
      break;
    case "Facebook":
      url = "https://www.facebook.com/v19.0/dialog/oauth?" + new URLSearchParams({ ...common, client_id: cfg.CLIENT_ID_FACEBOOK }).toString();
      break;
  }
  onStatus(null);
  window.location.replace(url);
}

/**
 * Step 2 — If the URL contains id_token, finish the zkLogin flow: derive salt,
 * fetch ZK proofs from the Mysten prover, save account, post to bridge.
 * Returns the new account on success, or null if no JWT was present.
 */
export async function completeZkLogin(
  saltCtx: SaltContext,
  onStatus: (s: string | null) => void,
): Promise<AccountData | null> {
  const frag = window.location.hash.substring(1);
  const params = new URLSearchParams(frag);
  const jwt = params.get("id_token");
  if (!jwt) return null;
  window.history.replaceState(null, "", window.location.pathname);

  // OAuth timing
  const oauthStart = Number(sessionStorage.getItem(KEY_OAUTH_START) || "0");
  if (oauthStart > 0) {
    const ms = Math.round(Date.now() - oauthStart);
    setTimingFor("_last", { ...getTimingFor("_last"), oauthJwtMs: ms });
    sessionStorage.removeItem(KEY_OAUTH_START);
  }

  // JWT parse + sanity check
  const tJwtStart = performance.now();
  const payload: any = jwtDecode(jwt);
  if (!payload?.sub || !payload?.aud) {
    console.warn("[completeZkLogin] missing jwt.sub or aud");
    return null;
  }
  const jwtParseMs = Math.round(performance.now() - tJwtStart);

  let saltMs: number | undefined;
  const salt = await deriveEffectiveSalt(jwt, saltCtx, (ms) => { saltMs = ms; });
  if (salt == null) {
    onStatus(
      "❌ No salt could be derived.\n\n" +
      "Your login cannot continue because no institution contributed a salt. " +
      "To fix this, do ONE of the following and try logging in again:\n\n" +
      "• On the Login page, click \"Generate\" next to at least one institution " +
      "(stores a random seed locally — no network needed).\n" +
      "• Or start your salt-seed service and make sure the matching institution " +
      "URL in config.json is reachable.\n\n" +
      "Refresh the page to dismiss this message."
    );
    return null;
  }

  const userAddr = jwtToAddress(jwt, salt);
  const jwtNonce = typeof payload?.nonce === "string" ? payload.nonce : "";
  const setup = (jwtNonce ? loadSetupByNonce(jwtNonce) : null) || loadSetupData();
  if (!setup) { console.warn("[completeZkLogin] no setupData"); return null; }

  // Nonce verification — fast path: setupData.nonce was already computed in
  // beginZkLogin() (see column 13 `nonce_ms`), so we directly compare it
  // against JWT.nonce. This replaces the previous "recompute Poseidon and
  // compare" approach which cost ~40 ms per run for no extra security:
  // setupData.nonce IS the value that was sent to Google, and JWT.nonce IS
  // what Google echoed back, so a direct equality check is sufficient.
  // (Sui validators perform the cryptographic re-derivation themselves
  // when verifying the zkLogin signature.)
  const tNonceVerifyStart = performance.now();
  const normRandomness = normalizeRandomness(setup.randomness);
  const kp = keypairFromSecretKey(setup.ephemeralPrivateKey);
  if (jwtNonce && setup.nonce && setup.nonce !== jwtNonce) {
    console.warn("[completeZkLogin] nonce mismatch (setup.nonce vs jwt.nonce)");
    return null;
  }
  const nonceVerifyMs = Math.round(performance.now() - tNonceVerifyStart);
  clearSetupData();
  if (jwtNonce) clearSetupByNonce(jwtNonce);

  // Prover. Three modes (driven by ?prover=… URL param via pickProverUrl):
  //   • direct  → browser → Mysten          (production-default; ~2500 ms)
  //   • proxy   → browser → bridge → Mysten (CORS-eliminated; ~2500 ms still)
  //   • backend → SKIP entirely; backend (Node) calls Mysten itself (~33 ms)
  // The third mode is the one that actually wins, because >96% of the
  // browser-perspective prover_ms is V8/React/DOM overhead, not network.
  const cfg = config as any;
  const proverUrl = pickProverUrl(cfg.URL_ZK_PROVER);
  console.log(`[zkLogin] prover mode = ${proverUrl ? proverUrl : "BACKEND (skip in-browser)"}`);

  let zkProofs: any = null;
  let proverMs: number | undefined = undefined;
  if (proverUrl) {
    onStatus("⏳ Requesting ZK proof (can take a few seconds)...");
    const tProverStart = performance.now();
    zkProofs = await fetch(proverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxEpoch: setup.maxEpoch,
        jwtRandomness: typeof normRandomness === "string" ? normRandomness : u8ToB64(normRandomness),
        extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(kp.getPublicKey()),
        jwt,
        salt: salt.toString(),
        keyClaimName: "sub",
      }),
    }).then((r) => r.json()).catch((e) => { console.warn("[completeZkLogin] prover error", e); return null; });
    onStatus(null);
    proverMs = zkProofs ? Math.round(performance.now() - tProverStart) : undefined;
    if (!zkProofs) return null;
  } else {
    // backend mode — the bridge will spawn veramo-to-sui.js, which detects
    // missing ZK_PROOFS and calls Mysten itself in Node. We record 0 here
    // because the *browser* did no prover work this run.
    proverMs = 0;
  }

  const acct: AccountData = {
    provider: setup.provider,
    userAddr,
    zkProofs,
    ephemeralPrivateKey: setup.ephemeralPrivateKey,
    userSalt: salt.toString(),
    sub: payload.sub,
    aud: typeof payload.aud === "string" ? payload.aud : payload.aud[0],
    maxEpoch: setup.maxEpoch,
    randomness: normRandomness,
    nonce: setup.nonce,
    jwt,
  };
  const tSaveStart = performance.now();
  saveAccount(acct);
  const saveAccountMs = Math.round(performance.now() - tSaveStart);

  // Ship to bridge (network hop — browser → bridge → disk)
  const tBridgeStart = performance.now();
  await postSessionToBridge(acct);
  const bridgePostMs = Math.round(performance.now() - tBridgeStart);

  // Finalize timing
  const last = getTimingFor("_last");
  const merged: TimingRecord = {
    ...last,
    jwtParseMs,
    saltMs,
    nonceVerifyMs,
    proverMs,
    saveAccountMs,
    bridgePostMs,
    deriveAllMs: (saltMs ?? 0) + (proverMs ?? 0) || undefined,
  };
  const finalTiming = { ...getTimingFor(userAddr), ...merged };
  setTimingFor(userAddr, finalTiming);
  const m = loadTiming(); delete m["_last"]; saveTiming(m);

  // Fire-and-forget: ship finalized timings to bridge so EC2-side experiments
  // can read browser-side values without scraping localStorage. No await —
  // user flow doesn't care about this.
  postBrowserTimingsToBridge(userAddr, finalTiming);

  return acct;
}

/** Read the latest account (the one whose session we posted to bridge). */
export function getCurrentAccount(): AccountData | null {
  const arr = loadAccounts();
  return arr[0] || null;
}

/** Build a did:zklogin string from an account. Mirrors generateZkLoginDID() in the backend. */
export function didFromAccount(acct: AccountData): string {
  return `did:zklogin:${acct.provider.toLowerCase()}:${acct.userAddr}`;
}
