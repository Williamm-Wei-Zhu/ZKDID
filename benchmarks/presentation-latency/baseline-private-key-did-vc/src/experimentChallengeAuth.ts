/**
 * Mode 2: DID challenge authentication using on-chain DID resolution.
 *
 * Per run, total_ms covers: server-issued challenge → patient signs →
 * server resolves DID object from devnet → parses fields → verifies signature
 * → maps DID to patient id → creates local EHR session.
 */

import { join, resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { keypairFromSuiPrivateKey } from "./keypair.js";
import { newChallenge, signChallenge, verifySignature } from "./challengeAuth.js";
import { resolveDidObject } from "./didRegistry.js";
import { createEhrSession, mapDidToPatientId } from "./ehrService.js";
import { loadDids, loadWallets } from "./storage.js";
import type { ChallengeAuthRecord } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "challenge_create_ms", "sign_challenge_ms", "did_resolve_devnet_ms",
  "did_object_parse_ms", "signature_verify_ms", "patient_mapping_ms",
  "session_create_ms", "total_ms", "sui_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): ChallengeAuthRecord {
  return {
    run_id,
    mode: "challenge-auth-devnet",
    start_time_iso: new Date().toISOString(),
    challenge_create_ms: 0, sign_challenge_ms: 0, did_resolve_devnet_ms: 0,
    did_object_parse_ms: 0, signature_verify_ms: 0, patient_mapping_ms: 0,
    session_create_ms: 0, total_ms: 0, sui_object_id: "",
    success: false, error_message: "",
  };
}

export async function runChallengeAuthExperiment(): Promise<ChallengeAuthRecord[]> {
  const wallets = await loadWallets(resolve(process.cwd(), cfg.storeKeysIn));
  const dids    = await loadDids(resolve(process.cwd(), cfg.storeDidsIn));
  if (wallets.length === 0 || dids.length === 0) {
    throw new Error(
      `No DIDs available. Run 'npm run experiment:establish' first to ` +
        `populate ${cfg.storeKeysIn} and ${cfg.storeDidsIn}.`,
    );
  }

  console.log(
    `\n=== Mode 2: DID challenge auth (devnet resolve) ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} pool=${dids.length}`,
  );

  // Round-robin through the established DIDs so the experiment exercises
  // varied object-ids (avoids any RPC-level cache hot path on a single object).
  const records: ChallengeAuthRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);
    const which = i % dids.length;
    const storedDid = dids[which];
    const wallet = wallets.find((w) => w.did === storedDid.did);
    if (!wallet) {
      r.success = false;
      r.error_message = `wallet not found for did=${storedDid.did}`;
      records.push(r);
      continue;
    }
    r.sui_object_id = storedDid.sui_object_id;

    const tTotal = now();
    try {
      const kp = keypairFromSuiPrivateKey(wallet.secret_key_bech32);

      const tChal = now();
      const challenge = newChallenge();
      r.challenge_create_ms = elapsedMs(tChal);

      const tSign = now();
      const signature = signChallenge(kp, challenge);
      r.sign_challenge_ms = elapsedMs(tSign);

      const tRes = now();
      const onchain = await resolveDidObject(storedDid.sui_object_id);
      r.did_resolve_devnet_ms = elapsedMs(tRes);

      const tParse = now();
      if (!onchain.active) throw new Error(`DIDObject is inactive`);
      if (onchain.did !== storedDid.did) {
        throw new Error(`On-chain DID mismatch: got=${onchain.did} expected=${storedDid.did}`);
      }
      r.did_object_parse_ms = elapsedMs(tParse);

      const tVerify = now();
      const ok = verifySignature(onchain.publicKey, challenge, signature);
      if (!ok) throw new Error("signature verification failed");
      r.signature_verify_ms = elapsedMs(tVerify);

      const tMap = now();
      const patient_id = mapDidToPatientId(onchain.did);
      r.patient_mapping_ms = elapsedMs(tMap);

      const tSess = now();
      createEhrSession(onchain.did, patient_id);
      r.session_create_ms = elapsedMs(tSess);

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
  const out = join(cfg.outputDir, "private_key_did_auth_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printAuthSummary(measured);
  return measured;
}

export function printAuthSummary(rows: ChallengeAuthRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof ChallengeAuthRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Mode 2 — Challenge auth ==========`);
  for (const k of [
    "total_ms", "sign_challenge_ms", "did_resolve_devnet_ms",
    "signature_verify_ms", "session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=============================================\n");
}
