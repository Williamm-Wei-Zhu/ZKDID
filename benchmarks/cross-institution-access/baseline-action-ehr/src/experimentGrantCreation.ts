/**
 * Experiment 1: Grant creation latency on Sui Devnet.
 *
 * Per run, total_ms covers: build grant params → build tx → submit tx →
 * effects-cert returned → extract object id → persist locally.
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
} from "./accessGrantContract.js";
import { patientWalletFromConfigKey } from "./patientWallet.js";
import { appendGrant } from "./storage.js";
import type { GasCoinRef, GrantCreationRecord, StoredAccessGrant } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "grant_construct_ms", "tx_build_ms", "tx_submit_ms", "tx_finality_ms",
  "object_extract_ms", "local_store_ms", "total_ms",
  "sui_tx_digest", "access_grant_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): GrantCreationRecord {
  return {
    run_id,
    mode: "grant-creation-devnet",
    start_time_iso: new Date().toISOString(),
    grant_construct_ms: 0, tx_build_ms: 0, tx_submit_ms: 0, tx_finality_ms: 0,
    object_extract_ms: 0, local_store_ms: 0, total_ms: 0,
    sui_tx_digest: "", access_grant_object_id: "",
    success: false, error_message: "",
  };
}

export async function runGrantCreationExperiment(): Promise<GrantCreationRecord[]> {
  const packageId = requirePackageId();
  const wallet = patientWalletFromConfigKey(cfg.privateKey);
  console.log(
    `\n=== Experiment 1: AccessGrant creation on Sui Devnet ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} ` +
      `package=${packageId} patient=${cfg.patientId} ` +
      `signer=${wallet.address}`,
  );

  // Seed gas coin so rapid back-to-back txs don't hit "object version
  // unavailable for consumption" — same pattern as the sibling baselines.
  let gasCoin: GasCoinRef = await fetchInitialGasCoin(wallet.address);

  const records: GrantCreationRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  const enc = (s: string) => new TextEncoder().encode(s);

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);

    const tTotal = now();
    try {
      // Step 2 — construct grant parameters.
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

      // Step 3 — build tx (timed inside buildCreateAccessGrantTx).
      const built = buildCreateAccessGrantTx(params);
      r.tx_build_ms = built.build_ms;

      // Steps 4 + 5 — submit + (effects-cert returned).
      const exec = await executeAndExtractAccessGrant(built.tx, wallet.keypair);
      r.tx_submit_ms = exec.submit_ms;
      r.tx_finality_ms = exec.finality_ms;
      r.object_extract_ms = exec.extract_ms;
      r.sui_tx_digest = exec.digest;
      r.access_grant_object_id = exec.objectId;
      gasCoin = exec.nextGasCoin;

      // Step 7 — persist grant metadata locally.
      const tStore = now();
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
      await appendGrant(resolve(process.cwd(), cfg.storeGrantsIn), stored);
      r.local_store_ms = elapsedMs(tStore);

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
  const out = join(cfg.outputDir, "action_ehr_grant_creation_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printGrantCreationSummary(measured);
  return measured;
}

export function printGrantCreationSummary(rows: GrantCreationRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof GrantCreationRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Experiment 1 — Grant creation ==========`);
  for (const k of [
    "total_ms", "grant_construct_ms", "tx_submit_ms", "tx_finality_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("====================================================\n");
}
