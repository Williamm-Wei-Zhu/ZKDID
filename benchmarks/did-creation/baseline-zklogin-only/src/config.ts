/**
 * Typed env loader. Refuses to start unless SUI_NETWORK=devnet.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) throw new Error(`Missing required env var: ${name}. See .env.example.`);
  return v.trim();
}
function optional(name: string, fallback: string): string {
  const v = process.env[name]; return v && v.trim().length > 0 ? v.trim() : fallback;
}
function asInt(v: string, name: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be int, got ${v}`);
  return n;
}
function asBool(v: string): boolean { return v.toLowerCase() === "true" || v === "1"; }

export interface AppConfig {
  network: "devnet";
  rpcUrl: string;
  packageId: string;
  privateKey: string;
  oidc: {
    clientId: string;
    redirectUri: string;
    callbackPort: number;
  };
  proverUrl: string;
  maxEpochDelta: number;
  saltSecret: string;
  runs: number;
  warmupRuns: number;
  outputDir: string;
  browser: {
    chromeProfileDir: string;
    headless: boolean;
    manualLogin: boolean;
  };
  storeSessionsIn: string;
}

const network = optional("SUI_NETWORK", "devnet").toLowerCase();
if (network !== "devnet") throw new Error(`SUI_NETWORK must be 'devnet' (got '${network}').`);
const rpcUrl = optional("SUI_RPC_URL", "https://fullnode.devnet.sui.io:443");
if (!rpcUrl.includes("devnet")) {
  console.warn(`[config] WARNING: SUI_RPC_URL=${rpcUrl} does not contain 'devnet'.`);
}

const manualLogin = asBool(optional("MANUAL_LOGIN", "false"));
const headlessRaw = asBool(optional("HEADLESS", "true"));

export const cfg: AppConfig = {
  network: "devnet",
  rpcUrl,
  packageId: required("SUI_PACKAGE_ID"),
  privateKey: required("SUI_PRIVATE_KEY"),
  oidc: {
    clientId: required("OIDC_CLIENT_ID"),
    redirectUri: optional("OIDC_REDIRECT_URI", "http://localhost:1234"),
    callbackPort: asInt(optional("CALLBACK_PORT", "1234"), "CALLBACK_PORT"),
  },
  proverUrl: optional("ZK_PROVER_URL", "https://prover-dev.mystenlabs.com/v1"),
  maxEpochDelta: asInt(optional("MAX_EPOCH_DELTA", "8"), "MAX_EPOCH_DELTA"),
  saltSecret: required("SALT_SECRET"),
  runs: asInt(optional("RUNS", "100"), "RUNS"),
  warmupRuns: asInt(optional("WARMUP_RUNS", "10"), "WARMUP_RUNS"),
  outputDir: optional("OUTPUT_DIR", "results"),
  browser: {
    chromeProfileDir: optional("CHROME_PROFILE_DIR", ".chrome-profile"),
    headless: manualLogin ? false : headlessRaw,
    manualLogin,
  },
  storeSessionsIn: optional("STORE_SESSIONS_IN", "data/sessions.json"),
};
