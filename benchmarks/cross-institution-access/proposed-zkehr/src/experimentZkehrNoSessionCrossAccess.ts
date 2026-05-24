/**
 * zkEHR end-to-end cross-institution access — NO-SESSION mode.
 *
 * Differs from the session-reuse variant by paying the full zkLogin
 * authentication path (phases A–D: ephemeral key, epoch, nonce, OIDC,
 * JWT decode, multi-authority salt, address derivation, Mysten prover)
 * INSIDE every measured run. This models the per-access cost a clinician
 * would see if their zkLogin session had not been primed (or had expired).
 *
 * Same DID-bound AccessGrant + Hospital A DID-resolution verification as
 * the session-reuse variant. Same Move package and Sui Devnet endpoint
 * for byte-for-byte comparability.
 */

import { join, resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { writeNoSessionCsv } from "./csvNoSession.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { suiClient } from "./suiClient.js";
import { buildOidcRunner } from "./oidcLogin.js";
import {
  deriveMultiAuthoritySalt,
  parseInstitutionsFromEnv,
} from "./saltService.js";
import { fetchZkProof } from "./zkProver.js";
import {
  decodeJwt, deriveZkLoginAddress, buildAddressSeed,
} from "./zkLoginAddress.js";
import { fetchInitialGasCoin, type GasCoinRef } from "./zkLoginTx.js";
import {
  buildSponsoredCreateAccessGrantTx,
  signAndSubmitZkLoginAccessGrant,
} from "./zkLoginAccessGrantTx.js";
import { resolveAccessGrant } from "./accessGrantContract.js";
import { buildAccessRequest } from "./hospitalB.js";
import { HospitalA } from "./hospitalA.js";
import {
  appendGrant, appendRequest, loadHospitalDidRegistry,
} from "./storage.js";
import type { StoredAccessGrant } from "./zkehrTypes.js";
import type { ZkehrNoSessionRunRecord } from "./zkehrTypes-noss.js";

// --- Cross-institution actor configuration (matches session-reuse mode) ---

const HOSPITAL_A_DID =
  process.env.HOSPITAL_A_DID && process.env.HOSPITAL_A_DID.trim().length > 0
    ? process.env.HOSPITAL_A_DID.trim() : "did:zkehr:hospital:hospital_A";
const HOSPITAL_B_DID =
  process.env.HOSPITAL_B_DID && process.env.HOSPITAL_B_DID.trim().length > 0
    ? process.env.HOSPITAL_B_DID.trim() : "did:zkehr:hospital:hospital_B";
const HOSPITAL_A_ID =
  process.env.HOSPITAL_A_ID && process.env.HOSPITAL_A_ID.trim().length > 0
    ? process.env.HOSPITAL_A_ID.trim() : "hospital_A";
const HOSPITAL_B_ADDRESS_OVERRIDE =
  process.env.HOSPITAL_B_ADDRESS && process.env.HOSPITAL_B_ADDRESS.trim().length > 0
    ? process.env.HOSPITAL_B_ADDRESS.trim().toLowerCase() : "";
const EHR_RECORD_ID =
  process.env.DEFAULT_EHR_RECORD_ID && process.env.DEFAULT_EHR_RECORD_ID.trim().length > 0
    ? process.env.DEFAULT_EHR_RECORD_ID.trim() : "ehr_record_001";
const SHARED_SCOPE =
  process.env.DEFAULT_SCOPE && process.env.DEFAULT_SCOPE.trim().length > 0
    ? process.env.DEFAULT_SCOPE.trim() : "read";
const EXPIRATION_SECONDS = (() => {
  const raw = process.env.DEFAULT_EXPIRATION_SECONDS;
  if (!raw) return 3600;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DEFAULT_EXPIRATION_SECONDS must be positive int, got: ${raw}`);
  }
  return n;
})();
const ACCESS_GRANT_PACKAGE_ID =
  process.env.ACCESS_GRANT_PACKAGE_ID && process.env.ACCESS_GRANT_PACKAGE_ID.trim().length > 0
    ? process.env.ACCESS_GRANT_PACKAGE_ID.trim()
    : "0x41ca95117671935dbaf55b595847ffa7d7623a63494e8bf44fc1c63d6577de43";
const STORE_HOSPITAL_DIDS_IN =
  process.env.STORE_HOSPITAL_DIDS_IN && process.env.STORE_HOSPITAL_DIDS_IN.trim().length > 0
    ? process.env.STORE_HOSPITAL_DIDS_IN.trim() : "data/hospital_dids.json";
const STORE_GRANTS_IN =
  process.env.STORE_GRANTS_IN && process.env.STORE_GRANTS_IN.trim().length > 0
    ? process.env.STORE_GRANTS_IN.trim() : "data/access_grants.json";
const STORE_REQUESTS_IN =
  process.env.STORE_REQUESTS_IN && process.env.STORE_REQUESTS_IN.trim().length > 0
    ? process.env.STORE_REQUESTS_IN.trim() : "data/access_requests.json";

const SALT_INSTITUTIONS_ENV = process.env.SALT_INSTITUTIONS ?? "";

function emptyRow(run_id: number): ZkehrNoSessionRunRecord {
  return {
    run_id, mode: "zkehr-cross-access-no-session",
    start_time_iso: new Date().toISOString(),
    ephemeral_keygen_ms: 0, epoch_fetch_ms: 0, randomness_ms: 0, nonce_compute_ms: 0,
    oidc_login_ms: 0, jwt_decode_ms: 0,
    salt_total_ms: 0, salt_slowest_inst_ms: 0,
    address_compute_ms: 0, prover_request_ms: 0,
    tx_build_ms: 0, zklogin_sig_assemble_ms: 0,
    tx_submit_ms: 0, object_extract_ms: 0, local_store_ms: 0,
    grant_total_ms: 0,
    request_construct_ms: 0, access_grant_query_ms: 0, grant_object_parse_ms: 0,
    patient_did_resolve_ms: 0, hospital_b_did_resolve_ms: 0, hospital_a_did_check_ms: 0,
    status_check_ms: 0, scope_check_ms: 0, expiration_check_ms: 0,
    access_session_create_ms: 0, access_total_ms: 0,
    total_ms: 0,
    zklogin_address: "", patient_did: "", hospital_b_did: HOSPITAL_B_DID,
    sui_tx_digest: "", access_grant_object_id: "",
    success: false, error_message: "",
  };
}

function loadSponsorKeypair(): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(cfg.privateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export async function runZkehrNoSessionCrossAccessExperiment(): Promise<ZkehrNoSessionRunRecord[]> {
  const sponsor = loadSponsorKeypair();
  const sponsorAddress = sponsor.getPublicKey().toSuiAddress();
  const hospitalA = new HospitalA(HOSPITAL_A_ID, HOSPITAL_A_DID);

  const hospitalDidsPath = resolve(process.cwd(), STORE_HOSPITAL_DIDS_IN);
  const registry = await loadHospitalDidRegistry(hospitalDidsPath);
  if (!registry) {
    throw new Error(
      `Hospital DID registry not found at ${hospitalDidsPath}. ` +
        `Run 'npm run experiment:setup-hospital-dids' first.`,
    );
  }
  const hospitalBAddress = HOSPITAL_B_ADDRESS_OVERRIDE.length > 0
    ? HOSPITAL_B_ADDRESS_OVERRIDE
    : registry.hospital_b.controller_address.toLowerCase();
  const hospitalBDidObjectId = registry.hospital_b.sui_object_id;

  const institutions = parseInstitutionsFromEnv(SALT_INSTITUTIONS_ENV);
  if (institutions.length === 0) {
    throw new Error(`SALT_INSTITUTIONS env var is empty.`);
  }

  console.log(
    `\n=== zkEHR NO-SESSION cross-institution access ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns}\n` +
      `access_grant_package=${ACCESS_GRANT_PACKAGE_ID}\n` +
      `prover=${cfg.proverUrl}\n` +
      `salt_institutions=${institutions.length}\n` +
      `sponsor=${sponsorAddress}\n` +
      `A-DID=${HOSPITAL_A_DID}\n` +
      `B-DID=${HOSPITAL_B_DID}\n` +
      `B-address=${hospitalBAddress}\n` +
      `(every measured run pays the full zkLogin authentication path)`,
  );

  let sponsorGasCoin: GasCoinRef = await fetchInitialGasCoin(sponsorAddress);

  const oidc = await buildOidcRunner(cfg);
  console.log(`[oidc] strategy = ${oidc.strategy}\n`);

  const records: ZkehrNoSessionRunRecord[] = [];
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
        // ============== GRANT PHASE (FULL zkLogin per run) ==============
        const tGrant0 = now();

        // Phase A
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

        // Phase B
        const tOidc = now();
        const jwt = await oidc.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
        r.oidc_login_ms = elapsedMs(tOidc);

        const tDecode = now();
        const claims = decodeJwt(jwt);
        if (claims.nonce && claims.nonce !== nonce) {
          throw new Error(`nonce mismatch: setup=${nonce} jwt=${claims.nonce}`);
        }
        r.jwt_decode_ms = elapsedMs(tDecode);

        // Phase C — multi-authority salt
        const tSalt = now();
        const saltResult = await deriveMultiAuthoritySalt(institutions, jwt);
        r.salt_total_ms = elapsedMs(tSalt);
        r.salt_slowest_inst_ms = saltResult.slowestClientMs;
        const salt = saltResult.saltMerged;

        // Phase D
        const tAddr = now();
        const zkAddr = deriveZkLoginAddress(jwt, salt);
        const addressSeed = buildAddressSeed(salt, claims);
        r.address_compute_ms = elapsedMs(tAddr);
        r.zklogin_address = zkAddr;
        const patientDid = `did:zkehr:zklogin:${zkAddr}`;
        r.patient_did = patientDid;

        const tProver = now();
        const proof = await fetchZkProof(cfg.proverUrl, {
          jwt,
          ephemeralKeypair: ephKp,
          randomness: typeof randomness === "string" ? randomness : String(randomness),
          saltDecimal: salt.toString(),
          maxEpoch,
        });
        r.prover_request_ms = elapsedMs(tProver);

        // Phase E — build + submit
        const expiresAtMs = BigInt(Date.now() + EXPIRATION_SECONDS * 1000);
        const built = await buildSponsoredCreateAccessGrantTx({
          packageId: ACCESS_GRANT_PACKAGE_ID,
          zkLoginAddress: zkAddr,
          sponsorAddress,
          sponsorGasCoin,
          patientDid: enc(patientDid),
          dataHolderDid: enc(HOSPITAL_A_DID),
          granteeDid: enc(HOSPITAL_B_DID),
          granteeAddress: hospitalBAddress,
          ehrRecordId: enc(EHR_RECORD_ID),
          scope: enc(SHARED_SCOPE),
          expiresAtMs,
        });
        r.tx_build_ms = built.build_ms;

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

        const tStore = now();
        const stored: StoredAccessGrant = {
          run_id,
          access_grant_object_id: exec.objectId,
          transaction_digest: exec.digest,
          zklogin_address: zkAddr,
          patient_did: patientDid,
          hospital_a_did: HOSPITAL_A_DID,
          hospital_b_did: HOSPITAL_B_DID,
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
          patient_did: patientDid,
          hospital_a_did: HOSPITAL_A_DID,
          hospital_b_did: HOSPITAL_B_DID,
          hospital_b_address: hospitalBAddress,
          ehr_record_id: EHR_RECORD_ID,
          requested_scope: SHARED_SCOPE,
          access_grant_object_id: exec.objectId,
        });
        r.request_construct_ms = elapsedMs(tReq);

        const tQuery = now();
        const grant = await resolveAccessGrant(exec.objectId);
        r.access_grant_query_ms = elapsedMs(tQuery);

        const tParse = now();
        void grant.active; void grant.patient_id; void grant.scope;
        void grant.ehr_record_id; void grant.expires_at_ms;
        void grant.grantee_hospital_id; void grant.grantee_address;
        r.grant_object_parse_ms = elapsedMs(tParse);

        const tPDID = now();
        hospitalA.resolvePatientZkLoginDid(grant, patientDid);
        r.patient_did_resolve_ms = elapsedMs(tPDID);

        const tBDID = now();
        const b = await hospitalA.resolveHospitalBDid(hospitalBDidObjectId, HOSPITAL_B_DID);
        r.hospital_b_did_resolve_ms = elapsedMs(tBDID);

        const tADID = now();
        hospitalA.checkOwnDid(grant);
        r.hospital_a_did_check_ms = elapsedMs(tADID);

        const tStat = now();
        hospitalA.checkStatus(grant, req, b.controller);
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
          `oidc=${r.oidc_login_ms.toFixed(0)} salt=${r.salt_total_ms.toFixed(0)} ` +
          `prover=${r.prover_request_ms.toFixed(0)} tx=${r.tx_submit_ms.toFixed(0)} ` +
          `chain_q=${r.access_grant_query_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
      );
    }
  } finally {
    await oidc.close();
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zkehr_cross_institution_access_no_session_results.csv");
  await writeNoSessionCsv(out, measured);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);
  return measured;
}

function printSummary(rows: ZkehrNoSessionRunRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof ZkehrNoSessionRunRecord) => ok.map((r) => r[k] as number);

  console.log(`\n========== zkEHR NO-SESSION cross-institution access ==========`);
  console.log(formatStats("grant_total_ms (per run)", computeStats(get("grant_total_ms"), fail)));
  console.log("\n" + formatStats("access_total_ms (per run)", computeStats(get("access_total_ms"), fail)));
  console.log("\n" + formatStats("total_ms (per run)", computeStats(get("total_ms"), fail)));
  console.log("\n--- Phase A-D breakdown (full zkLogin auth, every run) ---");
  for (const k of [
    "oidc_login_ms", "salt_total_ms", "salt_slowest_inst_ms",
    "address_compute_ms", "prover_request_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("--- Phase E (Sui tx) ---");
  for (const k of ["tx_build_ms", "tx_submit_ms", "object_extract_ms"] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("--- Access phase ---");
  for (const k of [
    "access_grant_query_ms", "patient_did_resolve_ms",
    "hospital_b_did_resolve_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=====================================================\n");
}
