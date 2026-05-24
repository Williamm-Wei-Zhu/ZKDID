/**
 * Typed env loader. Refuses to start unless SUI_NETWORK=devnet so a stray
 * mainnet config can never accidentally pay real gas.
 */

import { config as loadDotenv } from "dotenv";

loadDotenv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}. See .env.example.`);
  }
  return v.trim();
}
function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}
function asInt(v: string, name: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${v}`);
  return n;
}
function asBool(v: string): boolean {
  return v.toLowerCase() === "true" || v === "1";
}

export interface AppConfig {
  network: "devnet";
  rpcUrl: string;
  privateKey: string;
  packageId: string;
  runs: number;
  warmupRuns: number;
  outputDir: string;
  didMethod: string;
  storeKeysIn: string;
  storeDidsIn: string;
  enableVcExperiment: boolean;
}

const network = optional("SUI_NETWORK", "devnet").toLowerCase();
if (network !== "devnet") {
  throw new Error(
    `SUI_NETWORK must be 'devnet' (got '${network}'). This baseline runs on Devnet only.`
  );
}
const rpcUrl = optional("SUI_RPC_URL", "https://fullnode.devnet.sui.io:443");
if (!rpcUrl.includes("devnet")) {
  console.warn(
    `[config] WARNING: SUI_RPC_URL=${rpcUrl} does not contain 'devnet'. ` +
      `Continuing — but make sure this URL points at Sui Devnet.`
  );
}

export const cfg: AppConfig = {
  network: "devnet",
  rpcUrl,
  privateKey: required("SUI_PRIVATE_KEY"),
  packageId: optional("SUI_PACKAGE_ID", ""), // checked at experiment-start
  runs: asInt(optional("RUNS", "100"), "RUNS"),
  warmupRuns: asInt(optional("WARMUP_RUNS", "10"), "WARMUP_RUNS"),
  outputDir: optional("OUTPUT_DIR", "results"),
  didMethod: optional("DID_METHOD", "did:sui"),
  storeKeysIn: optional("STORE_KEYS_IN", "data/wallets.json"),
  storeDidsIn: optional("STORE_DIDS_IN", "data/dids.json"),
  enableVcExperiment: asBool(optional("ENABLE_VC_EXPERIMENT", "false")),
};

export function requirePackageId(): string {
  if (!cfg.packageId || cfg.packageId.length === 0) {
    throw new Error(
      `SUI_PACKAGE_ID is empty. Run 'npm run deploy:devnet' first, then ` +
        `paste the published package ID into .env as SUI_PACKAGE_ID.`
    );
  }
  return cfg.packageId;
}
