/**
 * End-to-end cross-institution access authorization & verification latency
 * experiment for the zkLogin baseline.
 *
 * Per-run flow:
 *
 *   --- Grant phase (patient, via zkLogin) ---
 *   A. Pre-OAuth setup (ephemeral key + epoch + randomness + nonce)
 *   B. OIDC login + JWT decode
 *   C. Single-authority salt
 *   D. zkLogin address derivation + Mysten prover ZK proof
 *   E. Build sponsored Sui tx calling
 *      access_grant::access_grant::create_access_grant(...)
 *   F. Sign with zkLogin (ephemeral + proof) + sponsor; submit; extract
 *      AccessGrant object id; persist locally.
 *
 *   grant_total_ms = sum of A through F.
 *
 *   --- Access phase (Hospital B → Hospital A) ---
 *   1. Hospital B builds the access request.
 *   2. Hospital A queries Sui Devnet for the AccessGrant object.
 *   3. Hospital A parses fields.
 *   4. Hospital A checks status / patient_id / data_holder / grantee.
 *   5. Hospital A checks scope + ehr_record_id.
 *   6. Hospital A checks expiration.
 *   7. Hospital A performs the **address-based authorization check**:
 *      the on-chain `AddressOwner` of the grant must equal the patient's
 *      zkLogin address. (Sui's tx-validation rules already enforce that
 *      only a valid zkLogin signature for that address could have minted
 *      the grant — this single equality is the proof of P-DID consent.)
 *   8. Hospital A creates the local authorized EHR access session.
 *
 *   access_total_ms = sum of 1 through 8.
 *
 *   total_ms = grant_total_ms + access_total_ms.
 */

import { join, resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { writeCrossAccessCsv } from "./csvCrossAccess.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { suiClient } from "./suiClient.js";
import { buildOidcRunner } from "./oidcLogin.js";
import { deriveSingleAuthoritySalt } from "./saltService.js";
import { fetchZkProof } from "./zkProver.js";
import { decodeJwt, deriveZkLoginAddress, buildAddressSeed } from "./zkLoginAddress.js";
import { fetchInitialGasCoin, type GasCoinRef } from "./zkLoginTx.js";
import {
  buildSponsoredCreateAccessGrantTx,
  signAndSubmitZkLoginAccessGrant,
} from "./zkLoginAccessGrantTx.js";
import { resolveAccessGrant } from "./accessGrantContract.js";
import { buildAccessRequest } from "./hospitalB.js";
import { HospitalA } from "./hospitalA.js";
import { appendGrant, appendRequest } from "./storage.js";
import type { CrossAccessRunRecord, StoredAccessGrant } from "./types.js";

const HOSPITAL_A_ID =
  process.env.HOSPITAL_A_ID && process.env.HOSPITAL_A_ID.trim().length > 0
    ? process.env.HOSPITAL_A_ID.trim()
    : "hospital_A";
const HOSPITAL_A_ADDRESS = (() => {
  const a =
    process.env.HOSPITAL_A_ADDRESS && process.env.HOSPITAL_A_ADDRESS.trim().length > 0
      ? process.env.HOSPITAL_A_ADDRESS.trim().toLowerCase()
      : "0x" + "a".repeat(64);
  if (!/^0x[0-9a-f]{64}$/.test(a)) {
    throw new Error(`HOSPITAL_A_ADDRESS must be a 0x-prefixed 32-byte hex address; got ${a}`);
  }
  return a;
})();
const HOSPITAL_B_ID =
  process.env.HOSPITAL_B_ID && process.env.HOSPITAL_B_ID.trim().length > 0
    ? process.env.HOSPITAL_B_ID.trim()
    : "hospital_B";
const HOSPITAL_B_ADDRESS = (() => {
  const a =
    process.env.HOSPITAL_B_ADDRESS && process.env.HOSPITAL_B_ADDRESS.trim().length > 0
      ? process.env.HOSPITAL_B_ADDRESS.trim().toLowerCase()
      : "0x" + "b".repeat(64);
  if (!/^0x[0-9a-f]{64}$/.test(a)) {
    throw new Error(`HOSPITAL_B_ADDRESS must be a 0x-prefixed 32-byte hex address; got ${a}`);
  }
  return a;
})();
const EHR_RECORD_ID =
  process.env.DEFAULT_EHR_RECORD_ID && process.env.DEFAULT_EHR_RECORD_ID.trim().length > 0
    ? process.env.DEFAULT_EHR_RECORD_ID.trim()
    : "ehr_record_001";
const SHARED_SCOPE =
  process.env.DEFAULT_SCOPE && process.env.DEFAULT_SCOPE.trim().length > 0
    ? process.env.DEFAULT_SCOPE.trim()
    : "read";
const EXPIRATION_SECONDS = (() => {
  const raw = process.env.DEFAULT_EXPIRATION_SECONDS;
  if (!raw) return 3600;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DEFAULT_EXPIRATION_SECONDS must be a positive integer, got: ${raw}`);
  }
  return n;
})();
const STORE_GRANTS_IN =
  process.env.STORE_GRANTS_IN && process.env.STORE_GRANTS_IN.trim().length > 0
    ? process.env.STORE_GRANTS_IN.trim()
    : "data/access_grants.json";
const STORE_REQUESTS_IN =
  process.env.STORE_REQUESTS_IN && process.env.STORE_REQUESTS_IN.trim().length > 0
    ? process.env.STORE_REQUESTS_IN.trim()
    : "data/access_requests.json";
const ACCESS_GRANT_PACKAGE_ID =
  process.env.ACCESS_GRANT_PACKAGE_ID && process.env.ACCESS_GRANT_PACKAGE_ID.trim().length > 0
    ? process.env.ACCESS_GRANT_PACKAGE_ID.trim()
    : cfg.packageId;

function emptyRow(run_id: number): CrossAccessRunRecord {
  return {
    run_id,
    mode: "zklogin-cross-access",
    start_time_iso: new Date().toISOString(),
    ephemeral_keygen_ms: 0, epoch_fetch_ms: 0, randomness_ms: 0, nonce_compute_ms: 0,
    oidc_login_ms: 0, jwt_decode_ms: 0,
    salt_fetch_ms: 0,
    address_compute_ms: 0, prover_request_ms: 0,
    tx_build_ms: 0, zklogin_sig_assemble_ms: 0,
    tx_submit_ms: 0, object_extract_ms: 0, local_store_ms: 0,
    grant_total_ms: 0,
    request_construct_ms: 0, blockchain_query_ms: 0, grant_object_parse_ms: 0,
    status_check_ms: 0, scope_check_ms: 0, expiration_check_ms: 0,
    address_authorization_check_ms: 0, access_session_create_ms: 0,
    access_total_ms: 0,
    total_ms: 0,
    zklogin_address: "", sui_tx_digest: "", access_grant_object_id: "",
    success: false, error_message: "",
  };
}

function loadSponsorKeypair(): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(cfg.privateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export async function runCrossInstitutionAccessExperiment(): Promise<CrossAccessRunRecord[]> {
  const sponsor = loadSponsorKeypair();
  const sponsorAddress = sponsor.getPublicKey().toSuiAddress();
  const hospitalA = new HospitalA(HOSPITAL_A_ID);

  console.log(
    `\n=== zkLogin end-to-end cross-institution access ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns}\n` +
      `access_grant_package=${ACCESS_GRANT_PACKAGE_ID}\n` +
      `prover=${cfg.proverUrl}\n` +
      `sponsor=${sponsorAddress}\n` +
      `hospital_a=${HOSPITAL_A_ID} hospital_b=${HOSPITAL_B_ID} ` +
      `scope=${SHARED_SCOPE} ehr_record=${EHR_RECORD_ID}`,
  );

  let sponsorGasCoin: GasCoinRef = await fetchInitialGasCoin(sponsorAddress);
  const oidc = await buildOidcRunner(cfg);
  console.log(`[oidc] strategy = ${oidc.strategy}`);

  const records: CrossAccessRunRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  const enc = (s: string) => new TextEncoder().encode(s);
  const grantsPath = resolve(process.cwd(), STORE_GRANTS_IN);
  const requestsPath = resolve(process.cwd(), STORE_REQUESTS_IN);

  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
      const r = emptyRow(run_id);
      const tTotal = now();

      try {
        // ============== GRANT PHASE ==============
        const tGrant0 = now();

        // Phase A — pre-OAuth setup
        const tEph = now();
        const ephKp = new Ed25519Keypair();
        r.ephemeral_keygen_ms = elapsedMs(tEph);

        const tEpoch = now();
        const sysState = await suiClient().getLatestSuiSystemState();
        const currentEpoch = Number(sysState.epoch);
        const maxEpoch = currentEpoch + cfg.maxEpochDelta;
        r.epoch_fetch_ms = elapsedMs(tEpoch);

        const tRand = now();
        const randomness = generateRandomness();
        r.randomness_ms = elapsedMs(tRand);

        const tNonce = now();
        const nonce = generateNonce(ephKp.getPublicKey(), maxEpoch, randomness);
        r.nonce_compute_ms = elapsedMs(tNonce);

        // Phase B — OIDC
        const tOidc = now();
        const jwt = await oidc.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
        r.oidc_login_ms = elapsedMs(tOidc);

        const tDecode = now();
        const claims = decodeJwt(jwt);
        if (claims.nonce && claims.nonce !== nonce) {
          throw new Error(`nonce mismatch: setup=${nonce} jwt=${claims.nonce}`);
        }
        r.jwt_decode_ms = elapsedMs(tDecode);

        // Phase C — salt
        const tSalt = now();
        const salt = deriveSingleAuthoritySalt(cfg.saltSecret, claims.sub, claims.aud);
        r.salt_fetch_ms = elapsedMs(tSalt);

        // Phase D — zkLogin proof + address
        const tAddr = now();
        const zkAddr = deriveZkLoginAddress(jwt, salt);
        const addressSeed = buildAddressSeed(salt, claims);
        r.address_compute_ms = elapsedMs(tAddr);
        r.zklogin_address = zkAddr;

        const tProver = now();
        const proof = await fetchZkProof(cfg.proverUrl, {
          jwt,
          ephemeralKeypair: ephKp,
          randomness: typeof randomness === "string" ? randomness : String(randomness),
          saltDecimal: salt.toString(),
          maxEpoch,
        });
        r.prover_request_ms = elapsedMs(tProver);

        // Phase E — build the sponsored AccessGrant tx.
        // patient_id is the patient's zkLogin Sui address — that's what
        // makes this an "address-based access grant".
        const expiresAtMs = BigInt(Date.now() + EXPIRATION_SECONDS * 1000);
        const built = await buildSponsoredCreateAccessGrantTx({
          packageId: ACCESS_GRANT_PACKAGE_ID,
          zkLoginAddress: zkAddr,
          sponsorAddress,
          sponsorGasCoin,
          patientId: enc(zkAddr),
          dataHolderHospitalId: enc(HOSPITAL_A_ID),
          granteeHospitalId: enc(HOSPITAL_B_ID),
          granteeAddress: HOSPITAL_B_ADDRESS,
          ehrRecordId: enc(EHR_RECORD_ID),
          scope: enc(SHARED_SCOPE),
          expiresAtMs,
        });
        r.tx_build_ms = built.build_ms;

        // Phase F — sign + submit (zkLogin signature assembly + sponsor cosig
        // happen inside signAndSubmitZkLoginAccessGrant). We approximate
        // zklogin_sig_assemble_ms as an instant snapshot before submit so
        // the column has stable semantics with the establish baseline.
        const tAssem = now();
        r.zklogin_sig_assemble_ms = elapsedMs(tAssem);

        const exec = await signAndSubmitZkLoginAccessGrant({
          txBytes: built.txBytes,
          ephemeralKp: ephKp,
          proof,
          addressSeed,
          maxEpoch,
          sponsor,
        });
        r.tx_submit_ms = exec.submit_ms;
        r.object_extract_ms = exec.extract_ms;
        r.sui_tx_digest = exec.digest;
        r.access_grant_object_id = exec.objectId;
        sponsorGasCoin = exec.nextSponsorGasCoin;

        // Persist grant metadata locally.
        const tStore = now();
        const stored: StoredAccessGrant = {
          run_id,
          access_grant_object_id: exec.objectId,
          transaction_digest: exec.digest,
          zklogin_address: zkAddr,
          patient_id: zkAddr,
          hospital_a_id: HOSPITAL_A_ID,
          hospital_b_id: HOSPITAL_B_ID,
          ehr_record_id: EHR_RECORD_ID,
          scope: SHARED_SCOPE,
          expires_at_ms: Number(expiresAtMs),
          created_at_iso: new Date().toISOString(),
        };
        await appendGrant(grantsPath, stored);
        r.local_store_ms = elapsedMs(tStore);

        r.grant_total_ms = elapsedMs(tGrant0);

        // ============== ACCESS PHASE ==============
        const tAccess0 = now();

        const tReq = now();
        const req = buildAccessRequest({
          run_id,
          patient_id: zkAddr,
          hospital_a_id: HOSPITAL_A_ID,
          hospital_b_id: HOSPITAL_B_ID,
          hospital_b_address: HOSPITAL_B_ADDRESS,
          ehr_record_id: EHR_RECORD_ID,
          requested_scope: SHARED_SCOPE,
          access_grant_object_id: exec.objectId,
        });
        r.request_construct_ms = elapsedMs(tReq);

        const tQuery = now();
        const grant = await resolveAccessGrant(exec.objectId);
        r.blockchain_query_ms = elapsedMs(tQuery);

        const tParse = now();
        // Touch parsed fields so JIT can't elide.
        void grant.active; void grant.patient_id; void grant.scope;
        void grant.ehr_record_id; void grant.expires_at_ms; void grant.on_chain_owner;
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

        const tAuth = now();
        hospitalA.checkAddressAuthorization(grant, zkAddr);
        r.address_authorization_check_ms = elapsedMs(tAuth);

        const tSess = now();
        hospitalA.createAccessSession(grant, req);
        r.access_session_create_ms = elapsedMs(tSess);

        await appendRequest(requestsPath, req);

        r.access_total_ms = elapsedMs(tAccess0);
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
        `${tag} run=${run_id} success=${r.success} ` +
          `grant_total_ms=${r.grant_total_ms.toFixed(2)} ` +
          `access_total_ms=${r.access_total_ms.toFixed(2)} ` +
          `total_ms=${r.total_ms.toFixed(2)} ` +
          `oidc=${r.oidc_login_ms.toFixed(0)} prover=${r.prover_request_ms.toFixed(0)} ` +
          `tx=${r.tx_submit_ms.toFixed(0)} chain_q=${r.blockchain_query_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
      );
    }
  } finally {
    await oidc.close();
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zklogin_cross_institution_access_results.csv");
  await writeCrossAccessCsv(out, measured);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);
  return measured;
}

function printSummary(rows: CrossAccessRunRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof CrossAccessRunRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== zkLogin cross-institution access ==========`);
  console.log(formatStats("grant_total_ms", computeStats(get("grant_total_ms"), fail)));
  console.log("\n" + formatStats("access_total_ms", computeStats(get("access_total_ms"), fail)));
  console.log("\n" + formatStats("total_ms", computeStats(get("total_ms"), fail)));
  console.log("\n--- Grant-phase breakdown ---");
  for (const k of [
    "ephemeral_keygen_ms", "epoch_fetch_ms", "nonce_compute_ms",
    "oidc_login_ms", "jwt_decode_ms", "salt_fetch_ms",
    "address_compute_ms", "prover_request_ms",
    "tx_build_ms", "tx_submit_ms", "object_extract_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("--- Access-phase breakdown ---");
  for (const k of [
    "request_construct_ms", "blockchain_query_ms", "grant_object_parse_ms",
    "status_check_ms", "scope_check_ms", "expiration_check_ms",
    "address_authorization_check_ms", "access_session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=====================================================\n");
}
