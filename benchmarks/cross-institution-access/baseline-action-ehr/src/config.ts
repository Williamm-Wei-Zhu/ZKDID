/**
 * Typed env loader for the ACTION-EHR-inspired baseline.
 *
 * Refuses to start unless SUI_NETWORK=devnet — the brief explicitly forbids
 * a local-only mode and the experiment must record real on-chain effects.
 *
 * NEVER prints SUI_PRIVATE_KEY (or any field containing 'KEY' / 'SECRET') to
 * stdout — see `redactedConfigForLogging()` below.
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

export interface AppConfig {
  network: "devnet";
  rpcUrl: string;
  privateKey: string;
  packageId: string;
  runs: number;
  warmupRuns: number;
  outputDir: string;
  patientId: string;
  hospitalAId: string;
  hospitalAAddress: string;
  hospitalBId: string;
  hospitalBAddress: string;
  ehrRecordId: string;
  scope: string;
  expirationSeconds: number;
  storeGrantsIn: string;
  storeRequestsIn: string;
}

const network = optional("SUI_NETWORK", "devnet").toLowerCase();
if (network !== "devnet") {
  throw new Error(
    `SUI_NETWORK must be 'devnet' (got '${network}'). This baseline runs on Devnet only.`
  );
}
const rpcUrl = optional("SUI_RPC_URL", "https://fullnode.devnet.sui.io:443");
if (!rpcUrl.includes("devnet")) {
  throw new Error(
    `SUI_RPC_URL must point at Sui Devnet (got '${rpcUrl}'). The baseline ` +
      `must run only on devnet for experimental consistency.`
  );
}

function validateSuiAddress(name: string, addr: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(addr)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex address; got ${addr}`);
  }
  return addr.toLowerCase();
}

export const cfg: AppConfig = {
  network: "devnet",
  rpcUrl,
  privateKey: required("SUI_PRIVATE_KEY"),
  packageId: optional("SUI_PACKAGE_ID", ""),
  runs: asInt(optional("RUNS", "100"), "RUNS"),
  warmupRuns: asInt(optional("WARMUP_RUNS", "10"), "WARMUP_RUNS"),
  outputDir: optional("OUTPUT_DIR", "results"),

  patientId: optional("PATIENT_ID", "patient_001"),
  hospitalAId: optional("HOSPITAL_A_ID", "hospital_A"),
  hospitalAAddress: validateSuiAddress(
    "HOSPITAL_A_ADDRESS",
    optional("HOSPITAL_A_ADDRESS", "0x" + "a".repeat(64)),
  ),
  hospitalBId: optional("HOSPITAL_B_ID", "hospital_B"),
  hospitalBAddress: validateSuiAddress(
    "HOSPITAL_B_ADDRESS",
    optional("HOSPITAL_B_ADDRESS", "0x" + "b".repeat(64)),
  ),
  ehrRecordId: optional("DEFAULT_EHR_RECORD_ID", "ehr_record_001"),
  scope: optional("DEFAULT_SCOPE", "read"),
  expirationSeconds: asInt(
    optional("DEFAULT_EXPIRATION_SECONDS", "3600"),
    "DEFAULT_EXPIRATION_SECONDS",
  ),

  storeGrantsIn: optional("STORE_GRANTS_IN", "data/access_grants.json"),
  storeRequestsIn: optional("STORE_REQUESTS_IN", "data/access_requests.json"),
};

/** Throws if SUI_PACKAGE_ID is empty — call this before starting any
 *  experiment that interacts with the on-chain Move module. */
export function requirePackageId(): string {
  if (!cfg.packageId || cfg.packageId.length === 0) {
    throw new Error(
      `SUI_PACKAGE_ID is empty. Run 'npm run deploy:devnet' first, then ` +
        `paste the published package ID into .env as SUI_PACKAGE_ID.`,
    );
  }
  return cfg.packageId;
}

/**
 * Returns a copy of `cfg` with sensitive values redacted. Use this any time
 * a config snapshot needs to go to the console or a log file.
 */
export function redactedConfigForLogging(): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...cfg };
  redacted.privateKey = "<redacted>";
  return redacted;
}
