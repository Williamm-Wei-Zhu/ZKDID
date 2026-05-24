/**
 * Mode 3: VC issuance + verification (off by default).
 *
 * For each run we generate fresh issuer/subject identities, sign one VC,
 * and verify it. This isolates per-VC crypto cost without any blockchain
 * involvement, so it represents *additional* overhead on top of the DID
 * baselines, not a substitute for them.
 */

import { join } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { ed25519 } from "@noble/curves/ed25519";
import { randomBytes } from "node:crypto";
import { buildVcPayload, signVc, verifyVc } from "./vc.js";
import type { VcRecord } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "vc_create_ms", "vc_sign_ms", "vc_verify_ms", "total_ms",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): VcRecord {
  return {
    run_id, mode: "vc",
    start_time_iso: new Date().toISOString(),
    vc_create_ms: 0, vc_sign_ms: 0, vc_verify_ms: 0, total_ms: 0,
    success: false, error_message: "",
  };
}

export async function runVcExperiment(): Promise<VcRecord[]> {
  if (!cfg.enableVcExperiment) {
    console.log(
      `[vc] ENABLE_VC_EXPERIMENT=false — skipping. Set true in .env to run.`,
    );
    return [];
  }
  console.log(`\n=== Mode 3: VC issuance + verification ===\nruns=${cfg.runs} warmup=${cfg.warmupRuns}`);

  const records: VcRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);
    const tTotal = now();
    try {
      const issuerSecret = ed25519.utils.randomPrivateKey();
      const issuerPublic = ed25519.getPublicKey(issuerSecret);
      const subjectDid = `did:sui:${Buffer.from(randomBytes(8)).toString("hex")}`;
      const issuerDid = `did:sui:issuer-${Buffer.from(issuerPublic.slice(0, 6)).toString("hex")}`;

      const tCreate = now();
      const payload = buildVcPayload(issuerDid, subjectDid);
      r.vc_create_ms = elapsedMs(tCreate);

      const tSign = now();
      const signed = signVc(payload, issuerSecret);
      r.vc_sign_ms = elapsedMs(tSign);

      const tVerify = now();
      const v = verifyVc(signed, issuerPublic, subjectDid);
      if (!(v.signature_ok && v.expiration_ok && v.subject_ok)) {
        throw new Error(
          `VC failed verification: ${JSON.stringify(v)}`,
        );
      }
      r.vc_verify_ms = elapsedMs(tVerify);

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
      `${tag} run=${run_id} success=${r.success} total_ms=${r.total_ms.toFixed(3)}`,
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "private_key_did_vc.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  const ok = measured.filter((r) => r.success);
  const fail = measured.length - ok.length;
  const get = (k: keyof VcRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Mode 3 — VC ==========`);
  for (const k of ["total_ms", "vc_sign_ms", "vc_verify_ms"] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=================================\n");
  return measured;
}
