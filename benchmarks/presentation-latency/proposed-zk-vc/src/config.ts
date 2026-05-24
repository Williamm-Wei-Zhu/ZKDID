/**
 * Typed env loader. Refuses to start unless SUI_NETWORK=devnet so a stray
 * mainnet config can never accidentally pay real gas.
 *
 * As of the OIDC4VCI extension, this config also exposes nested `oidc`,
 * `browser`, `test`, and `issuer` blocks used by the realistic VC-acquisition
 * flow. Existing flat fields (cfg.runs, cfg.privateKey, ...) are kept intact
 * so legacy experiment files compile unchanged.
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
  // ---- Sui devnet (legacy flat fields) ------------------------------------
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

  // ---- OIDC4VCI extension (new) -------------------------------------------
  oidc: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scope: string;
    providerKind: "google" | "keycloak" | "generic";
  };
  test: { username: string; password: string };
  browser: { headless: boolean; manualLogin: boolean; chromeProfileDir: string };
  callbackPort: number;
  issuer: { url: string };
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

const manualLogin = asBool(optional("MANUAL_LOGIN", "false"));
const headlessRaw = asBool(optional("HEADLESS", "true"));

export const cfg: AppConfig = {
  network: "devnet",
  rpcUrl,
  privateKey: required("SUI_PRIVATE_KEY"),
  packageId: optional("SUI_PACKAGE_ID", ""),
  runs: asInt(optional("RUNS", "100"), "RUNS"),
  warmupRuns: asInt(optional("WARMUP_RUNS", "10"), "WARMUP_RUNS"),
  outputDir: optional("OUTPUT_DIR", "results"),
  didMethod: optional("DID_METHOD", "did:sui"),
  storeKeysIn: optional("STORE_KEYS_IN", "data/wallets.json"),
  storeDidsIn: optional("STORE_DIDS_IN", "data/dids.json"),
  enableVcExperiment: asBool(optional("ENABLE_VC_EXPERIMENT", "false")),

  oidc: {
    issuer: optional("OIDC_ISSUER", "https://accounts.google.com"),
    authorizationEndpoint: optional(
      "OIDC_AUTHORIZATION_ENDPOINT",
      "https://accounts.google.com/o/oauth2/v2/auth",
    ),
    tokenEndpoint: optional("OIDC_TOKEN_ENDPOINT", "https://oauth2.googleapis.com/token"),
    jwksUri: optional("OIDC_JWKS_URI", "https://www.googleapis.com/oauth2/v3/certs"),
    clientId: optional("OIDC_CLIENT_ID", ""),
    clientSecret: optional("OIDC_CLIENT_SECRET", ""),
    redirectUri: optional("OIDC_REDIRECT_URI", "http://localhost:1234"),
    scope: optional("OIDC_SCOPE", "openid email profile"),
    providerKind: (optional("OIDC_PROVIDER_KIND", "google") as AppConfig["oidc"]["providerKind"]),
  },
  test: {
    username: optional("OIDC_TEST_USERNAME", ""),
    password: optional("OIDC_TEST_PASSWORD", ""),
  },
  browser: {
    headless: manualLogin ? false : headlessRaw,
    manualLogin,
    chromeProfileDir: optional("CHROME_PROFILE_DIR", ".chrome-profile"),
  },
  callbackPort: asInt(optional("CALLBACK_PORT", "1234"), "CALLBACK_PORT"),
  issuer: { url: optional("ISSUER_URL", "http://127.0.0.1:4321") },
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
