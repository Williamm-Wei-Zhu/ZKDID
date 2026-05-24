/**
 * zkLogin **session-reuse** end-to-end cross-institution access experiment.
 *
 * Differs from the full-establishment experiment in one important way:
 * we pay phases A–D of the zkLogin flow **once** (session establishment),
 * then reuse the resulting (ephemeralKp, proof, addressSeed, maxEpoch)
 * for every measured run. This models the realistic per-access cost a
 * clinician's primed-session UI would see — no second OIDC round-trip,
 * no second Mysten prover request, just a Sui tx and Hospital A's chain
 * verification.
 *
 * Per measured run, total_ms covers:
 *
 *   --- Grant phase (session reuse — phases E only) ---
 *   1. Build sponsored access_grant::create_access_grant tx.
 *   2. Sign with the cached ephemeral key + cached zkLogin proof.
 *   3. Submit (WaitForEffectsCert) and extract the AccessGrant id.
 *   4. Persist locally.
 *
 *   --- Access phase (Hospital B → Hospital A, identical to full-establish) ---
 *   5. Hospital B builds the access request.
 *   6. Hospital A queries Sui Devnet (with retry-on-notExists).
 *   7. Hospital A parses fields.
 *   8. Status / scope / expiration / address-authorization checks.
 *   9. Hospital A creates the local authorized session.
 *
 * The one-time session-establishment cost is logged separately so the
 * paper can report it as an "amortized" first-access overhead.
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
import { fetchZkProof, type ZkProof } from "./zkProver.js";
import {
  decodeJwt,
  deriveZkLoginAddress,
  buildAddressSeed,
  type JwtClaims,
} from "./zkLoginAddress.js";
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

// --- Cross-institution actor configuration (matches full-establish mode) ---

const HOSPITAL_A_ID =
  process.env.HOSPITAL_A_ID && process.env.HOSPITAL_A_ID.trim().length > 0
    ? process.env.HOSPITAL_A_ID.trim()
    : "hospital_A";
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

interface ZkLoginSession {
  ephKp: Ed25519Keypair;
  jwt: string;
  claims: JwtClaims;
  maxEpoch: number;
  salt: bigint;
  zkAddr: string;
  addressSeed: bigint;
  proof: ZkProof;
  /** Per-step cost of THIS session establishment (informational). */
  establishment_ms: {
    ephemeral_keygen_ms: number;
    epoch_fetch_ms: number;
    randomness_ms: number;
    nonce_compute_ms: number;
    oidc_login_ms: number;
    jwt_decode_ms: number;
    salt_fetch_ms: number;
    address_compute_ms: number;
    prover_request_ms: number;
    total_ms: number;
  };
}

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

/** One-time zkLogin session establishment. NOT counted in per-run latency. */
async function establishZkLoginSession(
  oidc: Awaited<ReturnType<typeof buildOidcRunner>>,
): Promise<ZkLoginSession> {
  const t0 = now();
  const out: ZkLoginSession["establishment_ms"] = {
    ephemeral_keygen_ms: 0, epoch_fetch_ms: 0, randomness_ms: 0, nonce_compute_ms: 0,
    oidc_login_ms: 0, jwt_decode_ms: 0,
    salt_fetch_ms: 0,
    address_compute_ms: 0, prover_request_ms: 0,
    total_ms: 0,
  };

  const tEph = now();
  const ephKp = new Ed25519Keypair();
  out.ephemeral_keygen_ms = elapsedMs(tEph);

  const tEpoch = now();
  const sysState = await suiClient().getLatestSuiSystemState();
  const currentEpoch = Number(sysState.epoch);
  const maxEpoch = currentEpoch + cfg.maxEpochDelta;
  out.epoch_fetch_ms = elapsedMs(tEpoch);

  const tRand = now();
  const randomness = generateRandomness();
  out.randomness_ms = elapsedMs(tRand);

  const tNonce = now();
  const nonce = generateNonce(ephKp.getPublicKey(), maxEpoch, randomness);
  out.nonce_compute_ms = elapsedMs(tNonce);

  const tOidc = now();
  const jwt = await oidc.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
  out.oidc_login_ms = elapsedMs(tOidc);

  const tDecode = now();
  const claims = decodeJwt(jwt);
  if (claims.nonce && claims.nonce !== nonce) {
    throw new Error(`nonce mismatch: setup=${nonce} jwt=${claims.nonce}`);
  }
  out.jwt_decode_ms = elapsedMs(tDecode);

  const tSalt = now();
  const salt = deriveSingleAuthoritySalt(cfg.saltSecret, claims.sub, claims.aud);
  out.salt_fetch_ms = elapsedMs(tSalt);

  const tAddr = now();
  const zkAddr = deriveZkLoginAddress(jwt, salt);
  const addressSeed = buildAddressSeed(salt, claims);
  out.address_compute_ms = elapsedMs(tAddr);

  const tProver = now();
  const proof = await fetchZkProof(cfg.proverUrl, {
    jwt,
    ephemeralKeypair: ephKp,
    randomness: typeof randomness === "string" ? randomness : String(randomness),
    saltDecimal: salt.toString(),
    maxEpoch,
  });
  out.prover_request_ms = elapsedMs(tProver);

  out.total_ms = elapsedMs(t0);

  return {
    ephKp, jwt, claims, maxEpoch, salt, zkAddr, addressSeed, proof,
    establishment_ms: out,
  };
}

export async function runCrossAccessSessionReuseExperiment(): Promise<CrossAccessRunRecord[]> {
  const sponsor = loadSponsorKeypair();
  const sponsorAddress = sponsor.getPublicKey().toSuiAddress();
  const hospitalA = new HospitalA(HOSPITAL_A_ID);

  console.log(
    `\n=== zkLogin SESSION-REUSE cross-institution access ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns}\n` +
      `access_grant_package=${ACCESS_GRANT_PACKAGE_ID}\n` +
      `sponsor=${sponsorAddress}\n` +
      `hospital_a=${HOSPITAL_A_ID} hospital_b=${HOSPITAL_B_ID} ` +
      `scope=${SHARED_SCOPE} ehr_record=${EHR_RECORD_ID}`,
  );

  let sponsorGasCoin: GasCoinRef = await fetchInitialGasCoin(sponsorAddress);

  // ====== One-time session establishment (NOT timed in measured loop) ======
  const oidc = await buildOidcRunner(cfg);
  console.log(`[oidc] strategy = ${oidc.strategy}`);

  let session: ZkLoginSession;
  try {
    console.log(`\n[session] establishing zkLogin session (one-time, off the measured loop)...`);
    session = await establishZkLoginSession(oidc);
    const m = session.establishment_ms;
    console.log(
      `[session] established in ${m.total_ms.toFixed(2)}ms ` +
        `(oidc=${m.oidc_login_ms.toFixed(0)} prover=${m.prover_request_ms.toFixed(0)} ` +
        `salt=${m.salt_fetch_ms.toFixed(2)} addr=${m.address_compute_ms.toFixed(2)})\n` +
        `[session] zklogin_address = ${session.zkAddr}\n` +
        `[session] max_epoch       = ${session.maxEpoch}\n` +
        `[session] (these per-step costs are PAID ONCE; reuse runs skip them)\n`,
    );
  } finally {
    // Browser is no longer needed after the single OIDC round-trip.
    await oidc.close();
  }

  const records: CrossAccessRunRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  const enc = (s: string) => new TextEncoder().encode(s);
  const grantsPath = resolve(process.cwd(), STORE_GRANTS_IN);
  const requestsPath = resolve(process.cwd(), STORE_REQUESTS_IN);

  // ====== Measured loop: each run reuses the cached session ======
  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);
    r.zklogin_address = session.zkAddr;

    const tTotal = now();
    try {
      // ============== GRANT PHASE (session reuse) ==============
      const tGrant0 = now();

      const expiresAtMs = BigInt(Date.now() + EXPIRATION_SECONDS * 1000);
      const built = await buildSponsoredCreateAccessGrantTx({
        packageId: ACCESS_GRANT_PACKAGE_ID,
        zkLoginAddress: session.zkAddr,
        sponsorAddress,
        sponsorGasCoin,
        patientId: enc(session.zkAddr),
        dataHolderHospitalId: enc(HOSPITAL_A_ID),
        granteeHospitalId: enc(HOSPITAL_B_ID),
        granteeAddress: HOSPITAL_B_ADDRESS,
        ehrRecordId: enc(EHR_RECORD_ID),
        scope: enc(SHARED_SCOPE),
        expiresAtMs,
      });
      r.tx_build_ms = built.build_ms;

      const tAssem = now();
      r.zklogin_sig_assemble_ms = elapsedMs(tAssem);

      const exec = await signAndSubmitZkLoginAccessGrant({
        txBytes: built.txBytes,
        ephemeralKp: session.ephKp,
        proof: session.proof,
        addressSeed: session.addressSeed,
        maxEpoch: session.maxEpoch,
        sponsor,
      });
      r.tx_submit_ms = exec.submit_ms;
      r.object_extract_ms = exec.extract_ms;
      r.sui_tx_digest = exec.digest;
      r.access_grant_object_id = exec.objectId;
      sponsorGasCoin = exec.nextSponsorGasCoin;

      const tStore = now();
      const stored: StoredAccessGrant = {
        run_id,
        access_grant_object_id: exec.objectId,
        transaction_digest: exec.digest,
        zklogin_address: session.zkAddr,
        patient_id: session.zkAddr,
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
        patient_id: session.zkAddr,
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
      hospitalA.checkAddressAuthorization(grant, session.zkAddr);
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
        `tx=${r.tx_submit_ms.toFixed(0)} chain_q=${r.blockchain_query_ms.toFixed(0)}` +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zklogin_cross_institution_access_session_reuse_results.csv");
  await writeCrossAccessCsv(out, measured);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured, session.establishment_ms);
  return measured;
}

function printSummary(
  rows: CrossAccessRunRecord[],
  establishment: ZkLoginSession["establishment_ms"],
): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof CrossAccessRunRecord) => ok.map((r) => r[k] as number);

  console.log(`\n========== zkLogin SESSION-REUSE cross-institution access ==========`);
  console.log(
    `One-time session establishment cost (paid ONCE, NOT in per-run mean):\n` +
      `  oidc_login_ms     = ${establishment.oidc_login_ms.toFixed(2)}\n` +
      `  prover_request_ms = ${establishment.prover_request_ms.toFixed(2)}\n` +
      `  total_ms          = ${establishment.total_ms.toFixed(2)}\n`,
  );
  console.log(formatStats("grant_total_ms (per measured run)", computeStats(get("grant_total_ms"), fail)));
  console.log("\n" + formatStats("access_total_ms (per measured run)", computeStats(get("access_total_ms"), fail)));
  console.log("\n" + formatStats("total_ms (per measured run)", computeStats(get("total_ms"), fail)));
  console.log("\n--- Grant-phase breakdown (reuse mode) ---");
  for (const k of [
    "tx_build_ms", "tx_submit_ms", "object_extract_ms", "local_store_ms",
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
