/**
 * Mode 1: Full OIDC login mode.
 *
 * Per run, total_ms covers:
 *   browser OIDC login + callback handling + token exchange + JWT verify +
 *   claim validation + local session creation.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { startCallbackServer } from "./callbackServer.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateNonce,
  generatePkce,
  generateState,
} from "./oidcClient.js";
import { buildJwksFetcher, verifyIdToken } from "./jwtVerifier.js";
import { buildLoginRunner } from "./playwrightLogin.js";
import { createEhrSession } from "./session.js";
import type { LoginStrategy } from "./playwrightLogin.js";
import { computeStats, formatStats } from "./stats.js";
import { elapsedMs, now } from "./timer.js";
import type { RunRecord, SessionCache } from "./types.js";

const SESSION_CACHE_PATH = resolve(process.cwd(), "session-cache.json");

function emptyRecord(run_id: number, mode: "full" | "reuse"): RunRecord {
  return {
    run_id,
    mode,
    start_time_iso: new Date().toISOString(),
    oidc_login_ms: 0,
    token_exchange_ms: 0,
    jwks_fetch_or_cache_ms: 0,
    jwt_verify_ms: 0,
    claim_validation_ms: 0,
    session_create_ms: 0,
    total_ms: 0,
    success: false,
    error_message: "",
  };
}

export async function runFullLoginExperiment(): Promise<RunRecord[]> {
  const fetcher = buildJwksFetcher(cfg.oidc.jwksUri, cfg.experiment.cacheJwks);
  if (cfg.experiment.cacheJwks) {
    await fetcher.warmUp();
  }

  const login = await buildLoginRunner(cfg);
  const strategy: LoginStrategy = login.strategy;

  console.log(
    `\n=== Mode 1: Full OIDC login ===\n` +
      `runs=${cfg.experiment.runs} warmup=${cfg.experiment.warmupRuns} ` +
      `cacheJwks=${cfg.experiment.cacheJwks} headless=${cfg.browser.headless} ` +
      `strategy=${strategy}`
  );
  if (strategy === "primed") {
    console.log(
      `Using primed Chromium profile (${cfg.browser.chromeProfileDir}). ` +
        `Auth URL will use prompt=none for silent SSO.`
    );
  } else if (strategy === "automated") {
    console.log(
      `Using automated username/password login. ` +
        `(For Google, run './run-in-dcv.sh prelogin' first to enable silent auth.)`
    );
  }
  const records: RunRecord[] = [];
  let lastSuccessCache: SessionCache | null = null;

  const total = cfg.experiment.warmupRuns + cfg.experiment.runs;
  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.experiment.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.experiment.warmupRuns + 1;
      const rec = emptyRecord(run_id, "full");

      // For non-cached JWKS mode, drop any cached state every run.
      if (!cfg.experiment.cacheJwks) fetcher.invalidate();

      const state = generateState();
      const nonce = generateNonce();
      const pkce = generatePkce();
      // - primed strategy: prompt=none -> silent SSO (Google checks the cached
      //   session and immediately redirects, or returns login_required as an
      //   error= callback param so the run is recorded as a failure).
      // - other strategies: prompt=login -> force fresh login each run.
      const authPrompt = strategy === "primed" ? "none" : "login";
      const authUrl = buildAuthorizationUrl({
        authorizationEndpoint: cfg.oidc.authorizationEndpoint,
        clientId: cfg.oidc.clientId,
        redirectUri: cfg.oidc.redirectUri,
        scope: cfg.oidc.scope,
        state,
        nonce,
        pkce,
        prompt: authPrompt,
      });

      const tTotal0 = now();
      let server: Awaited<ReturnType<typeof startCallbackServer>> | null = null;
      try {
        server = await startCallbackServer(cfg.callbackPort, state);

        // 1. browser-side login + callback ----------------------------------
        // Promise.all attaches rejection handlers to both promises at once,
        // so a callback-side failure (e.g. Google returns
        // error=interaction_required) propagates to this run's catch block
        // instead of triggering an unhandled-rejection process exit.
        const tLogin0 = now();
        const [cb] = await Promise.all([
          server.awaitCallback(120_000),
          login.runOnce(authUrl, cfg.oidc.redirectUri),
        ]);
        rec.oidc_login_ms = elapsedMs(tLogin0);

        // 2. authorization-code -> token exchange ---------------------------
        const tEx0 = now();
        const tokens = await exchangeCodeForTokens({
          tokenEndpoint: cfg.oidc.tokenEndpoint,
          clientId: cfg.oidc.clientId,
          clientSecret: cfg.oidc.clientSecret,
          redirectUri: cfg.oidc.redirectUri,
          code: cb.code,
          codeVerifier: pkce.code_verifier,
        });
        rec.token_exchange_ms = elapsedMs(tEx0);

        // 3. JWT verification + claim validation ----------------------------
        const v = await verifyIdToken(tokens.id_token, fetcher, {
          expectedIssuer: cfg.oidc.issuer,
          expectedAudience: cfg.oidc.clientId,
          expectedNonce: nonce,
        });
        rec.jwks_fetch_or_cache_ms = v.jwks_fetch_or_cache_ms;
        rec.jwt_verify_ms = v.jwt_verify_ms;
        rec.claim_validation_ms = v.claim_validation_ms;

        // 4. local EHR session creation -------------------------------------
        const tSess0 = now();
        createEhrSession(v.claims);
        rec.session_create_ms = elapsedMs(tSess0);

        rec.total_ms = elapsedMs(tTotal0);
        rec.success = true;

        lastSuccessCache = {
          id_token: tokens.id_token,
          nonce,
          cached_at_iso: new Date().toISOString(),
        };
      } catch (err) {
        rec.total_ms = elapsedMs(tTotal0);
        rec.success = false;
        rec.error_message = err instanceof Error ? err.message : String(err);
      } finally {
        if (server) await server.close();
      }

      records.push(rec);
      const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
      console.log(
        `${tag} run=${run_id} success=${rec.success} total_ms=${rec.total_ms.toFixed(2)}` +
          (rec.error_message ? ` err="${rec.error_message.slice(0, 120)}"` : "")
      );

      // Fast-fail: if the first three runs all fail with the same Google
      // error, abort the batch instead of burning 100+ doomed runs. This
      // catches the common setup mistakes (consent not granted, profile
      // missing, port collision with Vite, etc.) within seconds.
      if (
        records.length === 3 &&
        records.every((r) => !r.success) &&
        records.every(
          (r) => r.error_message === records[0].error_message
        )
      ) {
        const e = records[0].error_message;
        console.error(`\n[exp] ABORT — first 3 runs all failed with the same error:`);
        console.error(`        ${e}`);
        if (e.includes("interaction_required")) {
          console.error(
            `\n[exp] FIX:  Google needs you to grant OAuth consent ONCE before silent`
          );
          console.error(
            `[exp]       SSO can work. From a DCV terminal, run:`
          );
          console.error(`[exp]         cd ~/oidc-only-baseline`);
          console.error(`[exp]         ./run-in-dcv.sh prime-token`);
          console.error(
            `[exp]       Click "Allow" on the Google consent screen that appears.`
          );
          console.error(`[exp]       Then re-run ./run-in-dcv.sh full from SSH.`);
        } else if (e.includes("EADDRINUSE")) {
          console.error(
            `\n[exp] FIX:  CALLBACK_PORT (${cfg.callbackPort}) is already in use. ` +
              `Stop any other server on that port (likely the zkEHR Vite dev stack).`
          );
        }
        break;
      }
    }
  } finally {
    await login.close();
  }

  // Persist last successful tokens so reuse-mode can run without re-logging in.
  if (lastSuccessCache) {
    await writeFile(SESSION_CACHE_PATH, JSON.stringify(lastSuccessCache, null, 2), "utf8");
    console.log(`\nSaved session cache to ${SESSION_CACHE_PATH} (used by reuse mode).`);
  }

  // Drop warm-up rows from the saved CSV.
  const measuredOnly = records.filter((r) => r.run_id > 0);
  await writeCsv(cfg.experiment.outputCsv, measuredOnly);
  console.log(`\nWrote ${measuredOnly.length} rows to ${cfg.experiment.outputCsv}`);

  printSummary("Mode 1 — Full OIDC login", measuredOnly);
  return measuredOnly;
}

export function printSummary(label: string, rows: RunRecord[]): void {
  const successes = rows.filter((r) => r.success);
  const failures = rows.length - successes.length;
  const pick = (k: keyof RunRecord) => successes.map((r) => r[k] as number);

  console.log(`\n========== ${label} ==========`);
  console.log(formatStats("total_ms", computeStats(pick("total_ms"), failures)));
  console.log("\n" + formatStats("oidc_login_ms", computeStats(pick("oidc_login_ms"), failures)));
  console.log("\n" + formatStats("token_exchange_ms", computeStats(pick("token_exchange_ms"), failures)));
  console.log("\n" + formatStats("jwt_verify_ms", computeStats(pick("jwt_verify_ms"), failures)));
  console.log("\n" + formatStats("session_create_ms", computeStats(pick("session_create_ms"), failures)));
  console.log("=================================================\n");
}
