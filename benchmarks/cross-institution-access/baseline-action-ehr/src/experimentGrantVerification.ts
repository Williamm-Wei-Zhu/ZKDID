/**
 * Experiment 2: Grant verification latency on Sui Devnet.
 *
 * Per run, total_ms covers: Hospital B builds the access request →
 * Hospital A queries Sui Devnet for the AccessGrant object → parses fields
 * → status check → scope check → expiration check → creates session.
 */

import { join, resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg, requirePackageId } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { resolveAccessGrant } from "./accessGrantContract.js";
import { buildAccessRequest } from "./hospitalB.js";
import { HospitalA } from "./hospitalA.js";
import { loadGrants, appendRequest } from "./storage.js";
import type { GrantVerificationRecord } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "request_construct_ms", "blockchain_query_ms", "grant_object_parse_ms",
  "status_check_ms", "scope_check_ms", "expiration_check_ms",
  "access_session_create_ms", "total_ms",
  "access_grant_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): GrantVerificationRecord {
  return {
    run_id,
    mode: "grant-verification-devnet",
    start_time_iso: new Date().toISOString(),
    request_construct_ms: 0, blockchain_query_ms: 0, grant_object_parse_ms: 0,
    status_check_ms: 0, scope_check_ms: 0, expiration_check_ms: 0,
    access_session_create_ms: 0, total_ms: 0,
    access_grant_object_id: "",
    success: false, error_message: "",
  };
}

export async function runGrantVerificationExperiment(): Promise<GrantVerificationRecord[]> {
  requirePackageId(); // surface clear error if .env missing

  const grants = await loadGrants(resolve(process.cwd(), cfg.storeGrantsIn));
  if (grants.length === 0) {
    throw new Error(
      `No AccessGrants available. Run 'npm run experiment:create-grant' ` +
        `first to populate ${cfg.storeGrantsIn}.`,
    );
  }
  const requestsPath = resolve(process.cwd(), cfg.storeRequestsIn);
  const hospitalA = new HospitalA(cfg.hospitalAId);

  console.log(
    `\n=== Experiment 2: AccessGrant verification on Sui Devnet ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} pool=${grants.length}`,
  );

  const records: GrantVerificationRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);

    // Round-robin through stored grants so the experiment doesn't hit a
    // single-object RPC cache hot path.
    const stored = grants[i % grants.length];
    r.access_grant_object_id = stored.access_grant_object_id;

    const tTotal = now();
    try {
      // Step 2 — Hospital B constructs the access request.
      const tReq = now();
      const req = buildAccessRequest({
        run_id,
        patient_id: stored.patient_id,
        hospital_a_id: cfg.hospitalAId,
        hospital_b_id: cfg.hospitalBId,
        hospital_b_address: cfg.hospitalBAddress,
        ehr_record_id: stored.ehr_record_id,
        requested_scope: stored.scope.split(/[\s,;]+/).filter(Boolean)[0] ?? cfg.scope,
        access_grant_object_id: stored.access_grant_object_id,
      });
      r.request_construct_ms = elapsedMs(tReq);

      // Step 4 — Hospital A queries Sui Devnet.
      const tQuery = now();
      const grant = await resolveAccessGrant(stored.access_grant_object_id);
      r.blockchain_query_ms = elapsedMs(tQuery);

      // Step 5 — parse object fields. (resolveAccessGrant did the bytes
      // decoding internally; the parse cost is dominated by JS-side
      // copying/coercion, which is what we time here.)
      const tParse = now();
      const parsed = {
        active: grant.active,
        patient_id: grant.patient_id,
        data_holder_hospital_id: grant.data_holder_hospital_id,
        grantee_hospital_id: grant.grantee_hospital_id,
        grantee_address: grant.grantee_address,
        ehr_record_id: grant.ehr_record_id,
        scope: grant.scope,
        created_at_ms: grant.created_at_ms,
        expires_at_ms: grant.expires_at_ms,
      };
      r.grant_object_parse_ms = elapsedMs(tParse);
      void parsed; // referenced via grant below

      // Step 6.a — status check.
      const tStat = now();
      hospitalA.checkStatus(grant, req);
      r.status_check_ms = elapsedMs(tStat);

      // Step 6.b — scope + record check.
      const tScope = now();
      hospitalA.checkScopeAndRecord(grant, req);
      r.scope_check_ms = elapsedMs(tScope);

      // Step 6.c — expiration check.
      const tExp = now();
      hospitalA.checkExpiration(grant);
      r.expiration_check_ms = elapsedMs(tExp);

      // Step 7 — create authorized EHR access session.
      const tSess = now();
      hospitalA.createAccessSession(grant, req);
      r.access_session_create_ms = elapsedMs(tSess);

      // Persist the request for audit (off the hot timing path).
      await appendRequest(requestsPath, req);

      r.total_ms = elapsedMs(tTotal);
      r.success = true;
    } catch (err) {
      r.total_ms = elapsedMs(tTotal);
      r.success = false;
      r.error_message = err instanceof Error ? err.message : String(err);
    }

    records.push(r);
    const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
    console.log(
      `${tag} run=${run_id} success=${r.success} total_ms=${r.total_ms.toFixed(2)}` +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "action_ehr_grant_verification_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printVerificationSummary(measured);
  return measured;
}

export function printVerificationSummary(rows: GrantVerificationRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof GrantVerificationRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Experiment 2 — Grant verification ==========`);
  for (const k of [
    "total_ms", "blockchain_query_ms", "grant_object_parse_ms",
    "status_check_ms", "scope_check_ms", "expiration_check_ms",
    "access_session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=========================================================\n");
}
