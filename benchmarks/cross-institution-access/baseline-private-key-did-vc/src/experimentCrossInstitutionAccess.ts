/**
 * End-to-end cross-institution access authorization & verification
 * latency experiment — Private-key DID/VC variant.
 *
 * Per-run flow:
 *
 *   --- Grant phase (patient side, fully local) ---
 *   1. Patient builds the consent VC payload
 *      (issuer = patient DID, subject.id = Hospital B id, scope, expiration).
 *   2. Patient signs the canonicalized payload with their DID Ed25519 private key.
 *
 *   grant_total_ms = consent_payload_build_ms + consent_sign_ms.
 *
 *   --- Access phase (Hospital B → Hospital A) ---
 *   3. Hospital B presents the signed consent / VC to Hospital A
 *      (modeled as JSON.stringify of the signed VC, the wire payload).
 *   4. Hospital A receives + parses the presented VC.
 *   5. Hospital A resolves the patient's DID on Sui Devnet (chain RPC).
 *   6. Hospital A parses the DIDObject fields (did, public_key, active).
 *   7. Hospital A verifies the Ed25519 signature on the VC against the
 *      on-chain public key.
 *   8. Hospital A checks the consent claims: scope, expiration, grantee id,
 *      patient_did consistency.
 *
 *   access_total_ms = consent_present_ms + consent_receive_ms +
 *                     did_resolve_devnet_ms + did_object_parse_ms +
 *                     signature_verify_ms + scope_expiration_check_ms.
 *
 *   total_ms = grant_total_ms + access_total_ms.
 */

import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { writeCrossAccessCsv } from "./csvCrossAccess.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { resolveDidObject } from "./didRegistry.js";
import { loadDids, loadWallets } from "./storage.js";
import {
  buildConsentPayload,
  signConsent,
  presentConsent,
  receivePresentedConsent,
  verifyConsentSignature,
  checkConsentClaims,
} from "./consentVc.js";
import type { CrossAccessRunRecord } from "./types.js";

const HOSPITAL_B_ID =
  process.env.HOSPITAL_B_ID && process.env.HOSPITAL_B_ID.trim().length > 0
    ? process.env.HOSPITAL_B_ID.trim()
    : "hospital-b";
const SHARED_SCOPE =
  process.env.CROSS_ACCESS_SCOPE && process.env.CROSS_ACCESS_SCOPE.trim().length > 0
    ? process.env.CROSS_ACCESS_SCOPE.trim()
    : "ehr.read";
const CONSENT_TTL_SECONDS = (() => {
  const raw = process.env.CONSENT_TTL_SECONDS;
  if (!raw) return 24 * 60 * 60; // 24h default
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CONSENT_TTL_SECONDS must be a positive integer, got: ${raw}`);
  }
  return n;
})();

function emptyRecord(run_id: number): CrossAccessRunRecord {
  return {
    run_id,
    mode: "cross-access",
    start_time_iso: new Date().toISOString(),
    consent_payload_build_ms: 0,
    consent_sign_ms: 0,
    grant_total_ms: 0,
    consent_present_ms: 0,
    consent_receive_ms: 0,
    did_resolve_devnet_ms: 0,
    did_object_parse_ms: 0,
    signature_verify_ms: 0,
    scope_expiration_check_ms: 0,
    access_total_ms: 0,
    total_ms: 0,
    sui_object_id: "",
    patient_did: "",
    success: false,
    error_message: "",
  };
}

export async function runCrossInstitutionAccessExperiment(): Promise<CrossAccessRunRecord[]> {
  const wallets = await loadWallets(resolve(process.cwd(), cfg.storeKeysIn));
  const dids = await loadDids(resolve(process.cwd(), cfg.storeDidsIn));
  if (wallets.length === 0 || dids.length === 0) {
    throw new Error(
      `No DIDs available. Run 'npm run experiment:establish' first to ` +
        `populate ${cfg.storeKeysIn} and ${cfg.storeDidsIn}.`
    );
  }

  console.log(
    `\n=== Mode 4: End-to-end cross-institution access (DID/VC) ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} ` +
      `pool=${dids.length} hospital_b=${HOSPITAL_B_ID} ` +
      `scope=${SHARED_SCOPE} consent_ttl_seconds=${CONSENT_TTL_SECONDS}`
  );

  const records: CrossAccessRunRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRecord(run_id);
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
    r.patient_did = storedDid.did;

    const tTotal = now();
    try {
      // Decode patient secret key bytes (32-byte Ed25519 raw seed) once.
      const { secretKey: patientSecret } = decodeSuiPrivateKey(wallet.secret_key_bech32);

      // ====================== GRANT PHASE ======================
      const tGrant0 = now();

      const tBuild0 = now();
      const payload = buildConsentPayload({
        patientDid: storedDid.did,
        patientSuiObjectId: storedDid.sui_object_id,
        granteeInstitutionId: HOSPITAL_B_ID,
        scope: SHARED_SCOPE,
        ttlSeconds: CONSENT_TTL_SECONDS,
        jti: randomUUID(),
      });
      r.consent_payload_build_ms = elapsedMs(tBuild0);

      const tSign0 = now();
      const signed = signConsent(payload, patientSecret);
      r.consent_sign_ms = elapsedMs(tSign0);

      r.grant_total_ms = elapsedMs(tGrant0);

      // ====================== ACCESS PHASE ======================
      const tAccess0 = now();

      // 3. Hospital B presents the signed consent/VC.
      const tPresent0 = now();
      const wire = presentConsent(signed);
      r.consent_present_ms = elapsedMs(tPresent0);

      // 4. Hospital A receives and parses the presentation.
      const tReceive0 = now();
      const received = receivePresentedConsent(wire);
      r.consent_receive_ms = elapsedMs(tReceive0);

      // 5. Hospital A resolves the patient's DID on Sui Devnet.
      const tRes0 = now();
      const onchain = await resolveDidObject(received.payload.issuer_sui_object_id);
      r.did_resolve_devnet_ms = elapsedMs(tRes0);

      // 6. Hospital A parses the DIDObject fields.
      const tParse0 = now();
      if (!onchain.active) throw new Error(`DIDObject is inactive`);
      if (onchain.did !== received.payload.issuer) {
        throw new Error(
          `On-chain DID mismatch: got=${onchain.did} expected=${received.payload.issuer}`
        );
      }
      r.did_object_parse_ms = elapsedMs(tParse0);

      // 7. Hospital A verifies the consent VC signature against the on-chain pubkey.
      const tVer0 = now();
      const sigOk = verifyConsentSignature(received, onchain.publicKey);
      if (!sigOk) throw new Error("Consent VC signature verification failed");
      r.signature_verify_ms = elapsedMs(tVer0);

      // 8. Hospital A checks scope + expiration (+ grantee + patient_did consistency).
      const tCk0 = now();
      const claims = checkConsentClaims(received, {
        expectedScope: SHARED_SCOPE,
        expectedGranteeId: HOSPITAL_B_ID,
        expectedPatientDid: storedDid.did,
      });
      r.scope_expiration_check_ms = elapsedMs(tCk0);
      if (!(claims.scope_ok && claims.expiration_ok && claims.grantee_ok && claims.patient_ok)) {
        throw new Error(`Consent claim check failed: ${JSON.stringify(claims)}`);
      }

      r.access_total_ms = elapsedMs(tAccess0);
      r.total_ms = elapsedMs(tTotal);
      r.success = true;
    } catch (err) {
      // If we never set grant_total_ms (failed before grant completed), keep 0.
      r.total_ms = elapsedMs(tTotal);
      r.success = false;
      r.error_message = err instanceof Error ? err.message : String(err);
    }

    records.push(r);
    const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
    console.log(
      `${tag} run=${run_id} success=${r.success} ` +
        `grant_total_ms=${r.grant_total_ms.toFixed(3)} ` +
        `access_total_ms=${r.access_total_ms.toFixed(2)} ` +
        `total_ms=${r.total_ms.toFixed(2)}` +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : "")
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "private_key_did_vc_cross_institution_access_results.csv");
  await writeCrossAccessCsv(out, measured);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);
  return measured;
}

function printSummary(rows: CrossAccessRunRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof CrossAccessRunRecord) => ok.map((r) => r[k] as number);

  console.log(`\n========== Mode 4 — Cross-institution access (DID/VC) ==========`);
  console.log(formatStats("grant_total_ms", computeStats(get("grant_total_ms"), fail)));
  console.log("\n" + formatStats("access_total_ms", computeStats(get("access_total_ms"), fail)));
  console.log("\n" + formatStats("total_ms", computeStats(get("total_ms"), fail)));
  console.log("\n--- Grant-phase breakdown ---");
  console.log(formatStats("consent_payload_build_ms", computeStats(get("consent_payload_build_ms"), fail)));
  console.log("\n" + formatStats("consent_sign_ms", computeStats(get("consent_sign_ms"), fail)));
  console.log("\n--- Access-phase breakdown ---");
  console.log(formatStats("consent_present_ms", computeStats(get("consent_present_ms"), fail)));
  console.log("\n" + formatStats("consent_receive_ms", computeStats(get("consent_receive_ms"), fail)));
  console.log("\n" + formatStats("did_resolve_devnet_ms", computeStats(get("did_resolve_devnet_ms"), fail)));
  console.log("\n" + formatStats("did_object_parse_ms", computeStats(get("did_object_parse_ms"), fail)));
  console.log("\n" + formatStats("signature_verify_ms", computeStats(get("signature_verify_ms"), fail)));
  console.log("\n" + formatStats("scope_expiration_check_ms", computeStats(get("scope_expiration_check_ms"), fail)));
  console.log("=================================================\n");
}
