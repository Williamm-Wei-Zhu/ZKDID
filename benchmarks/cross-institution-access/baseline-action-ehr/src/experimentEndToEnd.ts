/**
 * Experiment 3: End-to-end cross-institution access authorization +
 * verification latency on Sui Devnet.
 *
 * Per run, total_ms covers:
 *   1. Patient creates AccessGrant on Sui Devnet (build + submit + extract).
 *   2. Hospital B builds + sends access request.
 *   3. Hospital A queries Sui Devnet for the AccessGrant.
 *   4. Hospital A verifies status / scope / expiration.
 *   5. Hospital A creates the authorized EHR access session.
 */

import { join, resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg, requirePackageId } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import {
  buildCreateAccessGrantTx,
  executeAndExtractAccessGrant,
  fetchInitialGasCoin,
  resolveAccessGrant,
} from "./accessGrantContract.js";
import { patientWalletFromConfigKey } from "./patientWallet.js";
import { buildAccessRequest } from "./hospitalB.js";
import { HospitalA } from "./hospitalA.js";
import { appendGrant, appendRequest } from "./storage.js";
import type {
  EndToEndRecord,
  GasCoinRef,
  StoredAccessGrant,
} from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "grant_construct_ms", "tx_build_ms", "tx_submit_ms", "tx_finality_ms",
  "object_extract_ms",
  "request_construct_ms", "blockchain_query_ms", "grant_object_parse_ms",
  "status_check_ms", "scope_check_ms", "expiration_check_ms",
  "access_session_create_ms",
  "total_ms", "sui_tx_digest", "access_grant_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): EndToEndRecord {
  return {
    run_id,
    mode: "end-to-end-access-authorization-devnet",
    start_time_iso: new Date().toISOString(),
    grant_construct_ms: 0, tx_build_ms: 0, tx_submit_ms: 0, tx_finality_ms: 0,
    object_extract_ms: 0,
    request_construct_ms: 0, blockchain_query_ms: 0, grant_object_parse_ms: 0,
    status_check_ms: 0, scope_check_ms: 0, expiration_check_ms: 0,
    access_session_create_ms: 0,
    total_ms: 0, sui_tx_digest: "", access_grant_object_id: "",
    success: false, error_message: "",
  };
}

export async function runEndToEndExperiment(): Promise<EndToEndRecord[]> {
  const packageId = requirePackageId();
  const wallet = patientWalletFromConfigKey(cfg.privateKey);
  const hospitalA = new HospitalA(cfg.hospitalAId);
  let gasCoin: GasCoinRef = await fetchInitialGasCoin(wallet.address);

  console.log(
    `\n=== Experiment 3: End-to-end access authorization + verification ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} ` +
      `package=${packageId} patient=${cfg.patientId}`,
  );

  const records: EndToEndRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  const enc = (s: string) => new TextEncoder().encode(s);
  const grantsPath = resolve(process.cwd(), cfg.storeGrantsIn);
  const requestsPath = resolve(process.cwd(), cfg.storeRequestsIn);

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);

    const tTotal = now();
    try {
      // ============== Phase 1: grant creation on chain ==============
      const tConstruct = now();
      const expiresAtMs = BigInt(Date.now() + cfg.expirationSeconds * 1000);
      const params = {
        packageId,
        patientId: enc(cfg.patientId),
        dataHolderHospitalId: enc(cfg.hospitalAId),
        granteeHospitalId: enc(cfg.hospitalBId),
        granteeAddress: cfg.hospitalBAddress,
        ehrRecordId: enc(cfg.ehrRecordId),
        scope: enc(cfg.scope),
        expiresAtMs,
        gasCoin,
      };
      r.grant_construct_ms = elapsedMs(tConstruct);

      const built = buildCreateAccessGrantTx(params);
      r.tx_build_ms = built.build_ms;

      const exec = await executeAndExtractAccessGrant(built.tx, wallet.keypair);
      r.tx_submit_ms = exec.submit_ms;
      r.tx_finality_ms = exec.finality_ms;
      r.object_extract_ms = exec.extract_ms;
      r.sui_tx_digest = exec.digest;
      r.access_grant_object_id = exec.objectId;
      gasCoin = exec.nextGasCoin;

      // Persist (off the hot path so it doesn't pollute timing — but still
      // counted in total_ms via tTotal).
      const stored: StoredAccessGrant = {
        run_id,
        access_grant_object_id: exec.objectId,
        transaction_digest: exec.digest,
        patient_id: cfg.patientId,
        hospital_a_id: cfg.hospitalAId,
        hospital_b_id: cfg.hospitalBId,
        ehr_record_id: cfg.ehrRecordId,
        scope: cfg.scope,
        expires_at_ms: Number(expiresAtMs),
        created_at_iso: new Date().toISOString(),
      };
      await appendGrant(grantsPath, stored);

      // ============== Phase 2: access request + verify ==============
      const tReq = now();
      const req = buildAccessRequest({
        run_id,
        patient_id: cfg.patientId,
        hospital_a_id: cfg.hospitalAId,
        hospital_b_id: cfg.hospitalBId,
        hospital_b_address: cfg.hospitalBAddress,
        ehr_record_id: cfg.ehrRecordId,
        requested_scope: cfg.scope,
        access_grant_object_id: exec.objectId,
      });
      r.request_construct_ms = elapsedMs(tReq);

      const tQuery = now();
      const grant = await resolveAccessGrant(exec.objectId);
      r.blockchain_query_ms = elapsedMs(tQuery);

      const tParse = now();
      // Touch the parsed fields so the JIT can't elide the work.
      void grant.active; void grant.patient_id; void grant.scope;
      void grant.ehr_record_id; void grant.expires_at_ms;
      r.grant_object_parse_ms = elapsedMs(tParse);

      const tStat = now();
      hospitalA.checkStatus(grant, req);
      r.status_check_ms = elapsedMs(tStat);

      const tScope = now();
      hospitalA.checkScopeAndRecord(grant, req);
      r.scope_check_ms = elapsedMs(tScope);

      const tExp = now();
      hospitalA.checkExpiration(grant);
      r.expiration_check_ms = elapsedMs(tExp);

      const tSess = now();
      hospitalA.createAccessSession(grant, req);
      r.access_session_create_ms = elapsedMs(tSess);

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
        (r.access_grant_object_id ? ` grant=${r.access_grant_object_id.slice(0, 18)}…` : "") +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "action_ehr_end_to_end_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printE2ESummary(measured);
  return measured;
}

export function printE2ESummary(rows: EndToEndRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof EndToEndRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Experiment 3 — End-to-end ==========`);
  for (const k of ["total_ms", "tx_finality_ms", "blockchain_query_ms"] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  // Phase totals (helpful for the cross-baseline comparison).
  const grantTotals = ok.map(
    (r) => r.grant_construct_ms + r.tx_build_ms + r.tx_submit_ms +
      r.tx_finality_ms + r.object_extract_ms,
  );
  const verifyTotals = ok.map(
    (r) => r.request_construct_ms + r.blockchain_query_ms +
      r.grant_object_parse_ms + r.status_check_ms + r.scope_check_ms +
      r.expiration_check_ms + r.access_session_create_ms,
  );
  console.log(formatStats("phase1_grant_total_ms (derived)", computeStats(grantTotals, fail)) + "\n");
  console.log(formatStats("phase2_verify_total_ms (derived)", computeStats(verifyTotals, fail)) + "\n");
  console.log("================================================\n");
}
