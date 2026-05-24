/**
 * Centralized config loader. Reads `.env` once and exposes a typed object.
 *
 * The baseline intentionally does NOT call the OIDC discovery endpoint — every
 * URL must be explicit so the measurement does not include a discovery
 * round-trip on the critical path.
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

function asBool(v: string): boolean {
  return v.toLowerCase() === "true" || v === "1";
}

function asInt(v: string, name: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  return n;
}

export interface AppConfig {
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
  test: {
    username: string;
    password: string;
  };
  experiment: {
    runs: number;
    warmupRuns: number;
    outputCsv: string;
    cacheJwks: boolean;
  };
  browser: {
    headless: boolean;
    manualLogin: boolean;
    /** Persistent Chromium profile directory. Modeled on
     * experiments/run.mjs — `launchPersistentContext` keeps Google's session
     * cookie across measured runs so OAuth redirects are silent. */
    chromeProfileDir: string;
  };
  callbackPort: number;
}

const manualLogin = asBool(optional("MANUAL_LOGIN", "false"));
const headlessRaw = asBool(optional("HEADLESS", "true"));

export const cfg: AppConfig = {
  oidc: {
    issuer: required("OIDC_ISSUER"),
    authorizationEndpoint: required("OIDC_AUTHORIZATION_ENDPOINT"),
    tokenEndpoint: required("OIDC_TOKEN_ENDPOINT"),
    jwksUri: required("OIDC_JWKS_URI"),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: optional("OIDC_CLIENT_SECRET", ""),
    redirectUri: required("OIDC_REDIRECT_URI"),
    scope: optional("OIDC_SCOPE", "openid email profile"),
    providerKind: (optional("OIDC_PROVIDER_KIND", "generic") as AppConfig["oidc"]["providerKind"]),
  },
  test: {
    username: optional("OIDC_TEST_USERNAME", ""),
    password: optional("OIDC_TEST_PASSWORD", ""),
  },
  experiment: {
    runs: asInt(optional("RUNS", "100"), "RUNS"),
    warmupRuns: asInt(optional("WARMUP_RUNS", "10"), "WARMUP_RUNS"),
    outputCsv: optional("OUTPUT_CSV", "results/oidc_only_results.csv"),
    cacheJwks: asBool(optional("CACHE_JWKS", "true")),
  },
  browser: {
    // Manual-login mode forces a visible browser regardless of HEADLESS.
    headless: manualLogin ? false : headlessRaw,
    manualLogin,
    chromeProfileDir: optional("CHROME_PROFILE_DIR", ".chrome-profile"),
  },
  callbackPort: asInt(optional("CALLBACK_PORT", "8765"), "CALLBACK_PORT"),
};
