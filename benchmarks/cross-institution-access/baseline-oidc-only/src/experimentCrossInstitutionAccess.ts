/**
 * End-to-end cross-institution access authorization & verification
 * latency experiment (OIDC-only baseline).
 *
 * Per-run flow:
 *
 *   --- Grant phase (Hospital A side) ---
 *   1. Patient logs into Hospital A's consent portal with OIDC
 *      (browser → Google → callback → token exchange).
 *   2. Hospital A verifies the patient's ID token (JWKS resolve, signature
 *      verify, claim validation) and creates a local EHR session.
 *   3. The authenticated patient creates a centralized consent grant for
 *      Hospital B (Hospital A persists the (patient, hospital_b, scope)
 *      record in its consent database).
 *
 *   grant_total_ms = sum of all grant-phase steps (oidc_login_ms +
 *                    token_exchange_ms + jwks_fetch_or_cache_ms +
 *                    jwt_verify_ms + claim_validation_ms +
 *                    session_create_ms + consent_create_ms).
 *
 *   --- Access phase (Hospital B side) ---
 *   4. Hospital B builds + signs an institutional JWT bearer assertion
 *      requesting access to the patient's record at Hospital A.
 *   5. Hospital A verifies Hospital B's identity (signature against the
 *      pre-registered institutional public key, plus iss / aud / exp claims).
 *   6. Hospital A looks up its consent database for an unexpired grant
 *      matching (patient, hospital_b, scope).
 *
 *   access_total_ms = b_request_build_ms + a_verify_b_jwt_ms +
 *                     a_consent_lookup_ms.
 *
 *   total_ms = grant_total_ms + access_total_ms.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeCrossAccessCsv } from "./csvCrossAccess.js";
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
import { ConsentDatabase } from "./consentDb.js";
import { HospitalA } from "./hospitalA.js";
import { buildAccessRequestJwt, createHospitalB } from "./hospitalB.js";
import { computeStats, formatStats } from "./stats.js";
import { elapsedMs, now } from "./timer.js";
import type { LoginStrategy } from "./playwrightLogin.js";
import type { CrossAccessRunRecord, SessionCache } from "./types.js";

const SESSION_CACHE_PATH = resolve(process.cwd(), "session-cache.json");

const HOSPITAL_A_ID =
  process.env.HOSPITAL_A_ID && process.env.HOSPITAL_A_ID.trim().length > 0
    ? process.env.HOSPITAL_A_ID.trim()
    : "hospital-a";
const HOSPITAL_B_ID =
  process.env.HOSPITAL_B_ID && process.env.HOSPITAL_B_ID.trim().length > 0
    ? process.env.HOSPITAL_B_ID.trim()
    : "hospital-b";
const SHARED_SCOPE =
  process.env.CROSS_ACCESS_SCOPE && process.env.CROSS_ACCESS_SCOPE.trim().length > 0
    ? process.env.CROSS_ACCESS_SCOPE.trim()
    : "ehr.read";
const CONSENT_TTL_MS = (() => {
  const raw = process.env.CONSENT_TTL_MS;
  if (!raw) return 24 * 60 * 60 * 1000; // 24h default
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CONSENT_TTL_MS must be a positive integer, got: ${raw}`);
  }
  return n;
})();

const CROSS_ACCESS_CSV =
  process.env.OUTPUT_CSV_CROSS_ACCESS && process.env.OUTPUT_CSV_CROSS_ACCESS.trim().length > 0
    ? process.env.OUTPUT_CSV_CROSS_ACCESS.trim()
    : "results/cross_institution_access_results.csv";

function emptyRecord(run_id: number): CrossAccessRunRecord {
  return {
    run_id,
    mode: "cross-access",
    start_time_iso: new Date().toISOString(),
    oidc_login_ms: 0,
    token_exchange_ms: 0,
    jwks_fetch_or_cache_ms: 0,
    jwt_verify_ms: 0,
    claim_validation_ms: 0,
    session_create_ms: 0,
    consent_create_ms: 0,
    grant_total_ms: 0,
    b_request_build_ms: 0,
    a_verify_b_jwt_ms: 0,
    a_consent_lookup_ms: 0,
    access_total_ms: 0,
    total_ms: 0,
    success: false,
    error_message: "",
  };
}

export async function runCrossInstitutionAccessExperiment(): Promise<CrossAccessRunRecord[]> {
  // --- One-time setup: build Hospital A + Hospital B + register B with A ---
  const consentDb = new ConsentDatabase();
  const hospitalA = new HospitalA(HOSPITAL_A_ID, consentDb);
  const hospitalB = await createHospitalB(HOSPITAL_B_ID);
  hospitalA.registerInstitution(hospitalB.institutionId, hospitalB.publicJwk);

  // --- JWKS prep (Hospital A's RP-side patient ID-token verifier) ---
  const fetcher = buildJwksFetcher(cfg.oidc.jwksUri, cfg.experiment.cacheJwks);
  if (cfg.experiment.cacheJwks) {
    await fetcher.warmUp();
  }

  // --- Playwright login runner (silent SSO via primed profile) ---
  const login = await buildLoginRunner(cfg);
  const strategy: LoginStrategy = login.strategy;

  console.log(
    `\n=== Mode 3: End-to-end cross-institution access ===\n` +
      `runs=${cfg.experiment.runs} warmup=${cfg.experiment.warmupRuns} ` +
      `cacheJwks=${cfg.experiment.cacheJwks} headless=${cfg.browser.headless} ` +
      `strategy=${strategy}\n` +
      `hospital_a=${HOSPITAL_A_ID} hospital_b=${HOSPITAL_B_ID} ` +
      `scope=${SHARED_SCOPE} consent_ttl_ms=${CONSENT_TTL_MS}`
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

  const records: CrossAccessRunRecord[] = [];
  let lastSuccessCache: SessionCache | null = null;
  const total = cfg.experiment.warmupRuns + cfg.experiment.runs;

  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.experiment.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.experiment.warmupRuns + 1;
      const rec = emptyRecord(run_id);

      // For non-cached JWKS mode, drop any cached state every run.
      if (!cfg.experiment.cacheJwks) fetcher.invalidate();

      const state = generateState();
      const nonce = generateNonce();
      const pkce = generatePkce();
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

      let server: Awaited<ReturnType<typeof startCallbackServer>> | null = null;
      const tGrant0 = now();
      try {
        // ====================== GRANT PHASE ======================

        server = await startCallbackServer(cfg.callbackPort, state);

        // 1. Patient logs into Hospital A's consent portal with OIDC --------
        const tLogin0 = now();
        const [cb] = await Promise.all([
          server.awaitCallback(120_000),
          login.runOnce(authUrl, cfg.oidc.redirectUri),
        ]);
        rec.oidc_login_ms = elapsedMs(tLogin0);

        // 2. authorization-code -> token exchange -----------------------
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

        // 3. Hospital A verifies the patient's JWT ---------------------------
        const v = await verifyIdToken(tokens.id_token, fetcher, {
          expectedIssuer: cfg.oidc.issuer,
          expectedAudience: cfg.oidc.clientId,
          expectedNonce: nonce,
        });
        rec.jwks_fetch_or_cache_ms = v.jwks_fetch_or_cache_ms;
        rec.jwt_verify_ms = v.jwt_verify_ms;
        rec.claim_validation_ms = v.claim_validation_ms;

        // 4. Hospital A creates the local EHR session ------------------------
        const tSess0 = now();
        const ehrSession = createEhrSession(v.claims);
        rec.session_create_ms = elapsedMs(tSess0);

        // 5. Patient creates centralized consent grant for Hospital B -------
        const tConsent0 = now();
        const grant = consentDb.put({
          patient_subject: v.claims.sub,
          patient_issuer: v.claims.iss,
          grantee_institution_id: HOSPITAL_B_ID,
          scope: SHARED_SCOPE,
          granted_by_session: ehrSession.session_id,
          ttl_ms: CONSENT_TTL_MS,
        });
        rec.consent_create_ms = elapsedMs(tConsent0);

        rec.grant_total_ms = elapsedMs(tGrant0);

        // ====================== ACCESS PHASE ======================
        const tAccess0 = now();

        // 6. Hospital B builds + signs its institutional JWT request --------
        const tBBuild0 = now();
        const accessRequest = await buildAccessRequestJwt(hospitalB, {
          hospitalAId: HOSPITAL_A_ID,
          patientSubject: v.claims.sub,
          patientIssuer: v.claims.iss,
          scope: SHARED_SCOPE,
        });
        rec.b_request_build_ms = elapsedMs(tBBuild0);

        // 7. Hospital A verifies Hospital B's identity ----------------------
        const tBVerify0 = now();
        const verifiedReq = await hospitalA.verifyInstitutionRequest(accessRequest.jwt);
        rec.a_verify_b_jwt_ms = elapsedMs(tBVerify0);

        // 8. Hospital A looks up consent database ---------------------------
        const tLookup0 = now();
        const found = hospitalA.lookupConsent(
          verifiedReq.patient_iss,
          verifiedReq.sub,
          verifiedReq.iss,
          verifiedReq.scope
        );
        rec.a_consent_lookup_ms = elapsedMs(tLookup0);
        if (!found) {
          throw new Error(
            `Hospital A could not find a consent grant for ` +
              `(patient_iss=${verifiedReq.patient_iss}, sub=${verifiedReq.sub}, ` +
              `grantee=${verifiedReq.iss}, scope=${verifiedReq.scope}). ` +
              `Expected grant id ${grant.consent_id}.`
          );
        }

        rec.access_total_ms = elapsedMs(tAccess0);
        rec.total_ms = rec.grant_total_ms + rec.access_total_ms;
        rec.success = true;

        lastSuccessCache = {
          id_token: tokens.id_token,
          nonce,
          cached_at_iso: new Date().toISOString(),
        };
      } catch (err) {
        // If we never reached the access phase, grant_total_ms tracks the
        // time-to-failure; access_total_ms stays 0. This still gets recorded
        // as a failure row.
        if (rec.grant_total_ms === 0) {
          rec.grant_total_ms = elapsedMs(tGrant0);
        }
        rec.total_ms = rec.grant_total_ms + rec.access_total_ms;
        rec.success = false;
        rec.error_message = err instanceof Error ? err.message : String(err);
      } finally {
        if (server) await server.close();
      }

      records.push(rec);
      const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
      console.log(
        `${tag} run=${run_id} success=${rec.success} ` +
          `grant_total_ms=${rec.grant_total_ms.toFixed(2)} ` +
          `access_total_ms=${rec.access_total_ms.toFixed(3)} ` +
          `total_ms=${rec.total_ms.toFixed(2)}` +
          (rec.error_message ? ` err="${rec.error_message.slice(0, 120)}"` : "")
      );

      // Fast-fail: same heuristic as Mode 1.
      if (
        records.length === 3 &&
        records.every((r) => !r.success) &&
        records.every((r) => r.error_message === records[0].error_message)
      ) {
        const e = records[0].error_message;
        console.error(`\n[exp] ABORT — first 3 runs all failed with the same error:`);
        console.error(`        ${e}`);
        if (e.includes("interaction_required")) {
          console.error(
            `\n[exp] FIX:  Google needs OAuth consent ONCE before silent SSO works.`
          );
          console.error(
            `[exp]       From a DCV terminal, run: ./run-in-dcv.sh prime-token`
          );
        } else if (e.includes("EADDRINUSE")) {
          console.error(
            `\n[exp] FIX:  CALLBACK_PORT (${cfg.callbackPort}) is already in use.`
          );
        }
        break;
      }
    }
  } finally {
    await login.close();
  }

  if (lastSuccessCache) {
    await writeFile(SESSION_CACHE_PATH, JSON.stringify(lastSuccessCache, null, 2), "utf8");
    console.log(`\nSaved session cache to ${SESSION_CACHE_PATH}.`);
  }

  // Drop warm-up rows from the saved CSV.
  const measuredOnly = records.filter((r) => r.run_id > 0);
  await writeCrossAccessCsv(CROSS_ACCESS_CSV, measuredOnly);
  console.log(`\nWrote ${measuredOnly.length} rows to ${CROSS_ACCESS_CSV}`);

  printCrossAccessSummary("Mode 3 — Cross-institution access", measuredOnly);
  return measuredOnly;
}

function printCrossAccessSummary(label: string, rows: CrossAccessRunRecord[]): void {
  const successes = rows.filter((r) => r.success);
  const failures = rows.length - successes.length;
  const pick = (k: keyof CrossAccessRunRecord) =>
    successes.map((r) => r[k] as number);

  console.log(`\n========== ${label} ==========`);
  console.log(formatStats("grant_total_ms", computeStats(pick("grant_total_ms"), failures)));
  console.log("\n" + formatStats("access_total_ms", computeStats(pick("access_total_ms"), failures)));
  console.log("\n" + formatStats("total_ms", computeStats(pick("total_ms"), failures)));
  console.log("\n--- Grant-phase breakdown ---");
  console.log(formatStats("oidc_login_ms", computeStats(pick("oidc_login_ms"), failures)));
  console.log("\n" + formatStats("token_exchange_ms", computeStats(pick("token_exchange_ms"), failures)));
  console.log("\n" + formatStats("jwks_fetch_or_cache_ms", computeStats(pick("jwks_fetch_or_cache_ms"), failures)));
  console.log("\n" + formatStats("jwt_verify_ms", computeStats(pick("jwt_verify_ms"), failures)));
  console.log("\n" + formatStats("claim_validation_ms", computeStats(pick("claim_validation_ms"), failures)));
  console.log("\n" + formatStats("session_create_ms", computeStats(pick("session_create_ms"), failures)));
  console.log("\n" + formatStats("consent_create_ms", computeStats(pick("consent_create_ms"), failures)));
  console.log("\n--- Access-phase breakdown ---");
  console.log(formatStats("b_request_build_ms", computeStats(pick("b_request_build_ms"), failures)));
  console.log("\n" + formatStats("a_verify_b_jwt_ms", computeStats(pick("a_verify_b_jwt_ms"), failures)));
  console.log("\n" + formatStats("a_consent_lookup_ms", computeStats(pick("a_consent_lookup_ms"), failures)));
  console.log("=================================================\n");
}
