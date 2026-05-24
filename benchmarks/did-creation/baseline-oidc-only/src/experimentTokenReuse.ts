/**
 * Mode 2: Token / session reuse mode.
 *
 * Models repeated EHR access while the OIDC session is still valid: the user
 * already has an unexpired ID token, so the relying party only re-runs the
 * crypto+claim+session steps.
 *
 * Per run, total_ms covers:
 *   JWT verify + claim validation + local session creation.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { buildJwksFetcher, verifyIdToken } from "./jwtVerifier.js";
import { createEhrSession } from "./session.js";
import { elapsedMs, now } from "./timer.js";
import { printSummary } from "./experimentFullLogin.js";
import type { RunRecord, SessionCache } from "./types.js";

const SESSION_CACHE_PATH = resolve(process.cwd(), "session-cache.json");

async function loadSessionCache(): Promise<SessionCache> {
  try {
    const raw = await readFile(SESSION_CACHE_PATH, "utf8");
    return JSON.parse(raw) as SessionCache;
  } catch (err) {
    throw new Error(
      `Could not read ${SESSION_CACHE_PATH}. Run 'npm run experiment:full' first ` +
        `so a valid ID token is captured for reuse-mode measurement. (${(err as Error).message})`
    );
  }
}

export async function runTokenReuseExperiment(): Promise<RunRecord[]> {
  console.log(
    `\n=== Mode 2: Token/Session reuse ===\n` +
      `runs=${cfg.experiment.runs} warmup=${cfg.experiment.warmupRuns} ` +
      `cacheJwks=${cfg.experiment.cacheJwks}`
  );

  const cache = await loadSessionCache();
  const fetcher = buildJwksFetcher(cfg.oidc.jwksUri, cfg.experiment.cacheJwks);
  if (cfg.experiment.cacheJwks) await fetcher.warmUp();

  const records: RunRecord[] = [];
  const total = cfg.experiment.warmupRuns + cfg.experiment.runs;

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.experiment.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.experiment.warmupRuns + 1;

    const rec: RunRecord = {
      run_id,
      mode: "reuse",
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

    if (!cfg.experiment.cacheJwks) fetcher.invalidate();

    const tTotal0 = now();
    try {
      const v = await verifyIdToken(cache.id_token, fetcher, {
        expectedIssuer: cfg.oidc.issuer,
        expectedAudience: cfg.oidc.clientId,
        expectedNonce: cache.nonce,
      });
      rec.jwks_fetch_or_cache_ms = v.jwks_fetch_or_cache_ms;
      rec.jwt_verify_ms = v.jwt_verify_ms;
      rec.claim_validation_ms = v.claim_validation_ms;

      const tSess0 = now();
      createEhrSession(v.claims);
      rec.session_create_ms = elapsedMs(tSess0);

      rec.total_ms = elapsedMs(tTotal0);
      rec.success = true;
    } catch (err) {
      rec.total_ms = elapsedMs(tTotal0);
      rec.success = false;
      rec.error_message = err instanceof Error ? err.message : String(err);
    }

    records.push(rec);
    const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
    console.log(
      `${tag} run=${run_id} success=${rec.success} total_ms=${rec.total_ms.toFixed(3)}` +
        (rec.error_message ? ` err="${rec.error_message.slice(0, 120)}"` : "")
    );
  }

  const measuredOnly = records.filter((r) => r.run_id > 0);
  // Reuse mode writes to a separate CSV so it doesn't overwrite full-login output.
  const reuseCsv = cfg.experiment.outputCsv.replace(/\.csv$/i, "_reuse.csv");
  await writeCsv(reuseCsv, measuredOnly);
  console.log(`\nWrote ${measuredOnly.length} rows to ${reuseCsv}`);

  printSummary("Mode 2 — Token/Session reuse", measuredOnly);
  return measuredOnly;
}
