/**
 * zkEHR end-to-end cross-institution access authorization & verification
 * latency experiment.
 *
 * Per-run flow (with SESSION REUSE — phases A–D paid ONCE outside loop):
 *
 *   --- Grant phase (DID-bound AccessGrant via zkLogin/zkDID) ---
 *   1. Patient builds sponsored Move tx
 *      access_grant::access_grant::create_access_grant(...)
 *      with DID-bound fields: patient_id=P-DID, data_holder=A-DID,
 *      grantee=B-DID, grantee_address=B's Sui address.
 *   2. Sign with cached zkLogin proof + sponsor key.
 *   3. Submit (WaitForEffectsCert), extract AccessGrant id.
 *   4. Persist locally.
 *
 *   --- Access phase (Hospital B → Hospital A) ---
 *   5. Hospital B builds the access request.
 *   6. Hospital A queries Sui for the AccessGrant (1 RPC).
 *   7. Hospital A parses the on-chain fields.
 *   8. Hospital A resolves P-DID — parses zkLogin DID + checks
 *      AccessGrant.on_chain_owner equals the embedded address.
 *      (No RPC; Sui already enforced the zkLogin signature at submit.)
 *   9. Hospital A resolves B-DID — getObject for the registered B-DID
 *      object (1 RPC); verifies it's active, did string matches the
 *      grant, and controller equals B's Sui address in the grant.
 *  10. Hospital A confirms A-DID in the grant matches its own DID.
 *  11. Status / scope / expiration / record-id checks.
 *  12. Create the local authorized EHR access session.
 *
 *   total_ms = grant_total_ms + access_total_ms.
 */

import { join, resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { writeZkehrCrossAccessCsv } from "./csvCrossAccess.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { suiClient } from "./suiClient.js";
import { buildOidcRunner } from "./oidcLogin.js";
import {
  deriveMultiAuthoritySalt,
  parseInstitutionsFromEnv,
} from "./saltService.js";
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
import {
  appendGrant,
  appendRequest,
  loadHospitalDidRegistry,
} from "./storage.js";
import type {
  ZkehrCrossAccessRunRecord,
  StoredAccessGrant,
} from "./zkehrTypes.js";

// --- Cross-institution actor configuration ----------------------------------

const HOSPITAL_A_DID =
  process.env.HOSPITAL_A_DID && process.env.HOSPITAL_A_DID.trim().length > 0
    ? process.env.HOSPITAL_A_DID.trim()
    : "did:zkehr:hospital:hospital_A";
const HOSPITAL_B_DID =
  process.env.HOSPITAL_B_DID && process.env.HOSPITAL_B_DID.trim().length > 0
    ? process.env.HOSPITAL_B_DID.trim()
    : "did:zkehr:hospital:hospital_B";
const HOSPITAL_A_ID =
  process.env.HOSPITAL_A_ID && process.env.HOSPITAL_A_ID.trim().length > 0
    ? process.env.HOSPITAL_A_ID.trim()
    : "hospital_A";
const HOSPITAL_B_ADDRESS_OVERRIDE =
  process.env.HOSPITAL_B_ADDRESS && process.env.HOSPITAL_B_ADDRESS.trim().length > 0
    ? process.env.HOSPITAL_B_ADDRESS.trim().toLowerCase()
    : "";
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
const ACCESS_GRANT_PACKAGE_ID =
  process.env.ACCESS_GRANT_PACKAGE_ID && process.env.ACCESS_GRANT_PACKAGE_ID.trim().length > 0
    ? process.env.ACCESS_GRANT_PACKAGE_ID.trim()
    : "0x41ca95117671935dbaf55b595847ffa7d7623a63494e8bf44fc1c63d6577de43";
const STORE_HOSPITAL_DIDS_IN =
  process.env.STORE_HOSPITAL_DIDS_IN && process.env.STORE_HOSPITAL_DIDS_IN.trim().length > 0
    ? process.env.STORE_HOSPITAL_DIDS_IN.trim()
    : "data/hospital_dids.json";
const STORE_GRANTS_IN =
  process.env.STORE_GRANTS_IN && process.env.STORE_GRANTS_IN.trim().length > 0
    ? process.env.STORE_GRANTS_IN.trim()
    : "data/access_grants.json";
const STORE_REQUESTS_IN =
  process.env.STORE_REQUESTS_IN && process.env.STORE_REQUESTS_IN.trim().length > 0
    ? process.env.STORE_REQUESTS_IN.trim()
    : "data/access_requests.json";

const SALT_INSTITUTIONS_ENV = process.env.SALT_INSTITUTIONS ?? "";

interface ZkEhrSession {
  ephKp: Ed25519Keypair;
  jwt: string;
  claims: JwtClaims;
  maxEpoch: number;
  salt: bigint;
  zkAddr: string;
  patientDid: string;
  addressSeed: bigint;
  proof: ZkProof;
  establishment_ms: {
    ephemeral_keygen_ms: number;
    epoch_fetch_ms: number;
    randomness_ms: number;
    nonce_compute_ms: number;
    oidc_login_ms: number;
    jwt_decode_ms: number;
    salt_total_ms: number;
    salt_slowest_inst_ms: number;
    salt_n_institutions: number;
    address_compute_ms: number;
    prover_request_ms: number;
    total_ms: number;
  };
}

function emptyRow(run_id: number): ZkehrCrossAccessRunRecord {
  return {
    run_id,
    mode: "zkehr-cross-access",
    start_time_iso: new Date().toISOString(),
    tx_build_ms: 0, zklogin_sig_assemble_ms: 0,
    tx_submit_ms: 0, object_extract_ms: 0, local_store_ms: 0,
    grant_total_ms: 0,
    request_construct_ms: 0, access_grant_query_ms: 0, grant_object_parse_ms: 0,
    patient_did_resolve_ms: 0, hospital_b_did_resolve_ms: 0, hospital_a_did_check_ms: 0,
    status_check_ms: 0, scope_check_ms: 0, expiration_check_ms: 0,
    access_session_create_ms: 0,
    access_total_ms: 0,
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

async function establishZkEhrSession(
  oidc: Awaited<ReturnType<typeof buildOidcRunner>>,
): Promise<ZkEhrSession> {
  const t0 = now();
  const m = {
    ephemeral_keygen_ms: 0, epoch_fetch_ms: 0, randomness_ms: 0, nonce_compute_ms: 0,
    oidc_login_ms: 0, jwt_decode_ms: 0,
    salt_total_ms: 0, salt_slowest_inst_ms: 0, salt_n_institutions: 0,
    address_compute_ms: 0, prover_request_ms: 0,
    total_ms: 0,
  };

  const tEph = now();
  const ephKp = new Ed25519Keypair();
  m.ephemeral_keygen_ms = elapsedMs(tEph);

  const tEpoch = now();
  const sysState = await suiClient().getLatestSuiSystemState();
  const currentEpoch = Number(sysState.epoch);
  const maxEpoch = currentEpoch + cfg.maxEpochDelta;
  m.epoch_fetch_ms = elapsedMs(tEpoch);

  const tRand = now();
  const randomness = generateRandomness();
  m.randomness_ms = elapsedMs(tRand);

  const tNonce = now();
  const nonce = generateNonce(ephKp.getPublicKey(), maxEpoch, randomness);
  m.nonce_compute_ms = elapsedMs(tNonce);

  const tOidc = now();
  const jwt = await oidc.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
  m.oidc_login_ms = elapsedMs(tOidc);

  const tDecode = now();
  const claims = decodeJwt(jwt);
  if (claims.nonce && claims.nonce !== nonce) {
    throw new Error(`nonce mismatch: setup=${nonce} jwt=${claims.nonce}`);
  }
  m.jwt_decode_ms = elapsedMs(tDecode);

  // Multi-authority salt — zkEHR's defining feature. Parallel fan-out.
  const institutions = parseInstitutionsFromEnv(SALT_INSTITUTIONS_ENV);
  if (institutions.length === 0) {
    throw new Error(
      `SALT_INSTITUTIONS env var is empty. zkEHR requires multi-authority salt.`,
    );
  }
  const tSalt = now();
  const saltResult = await deriveMultiAuthoritySalt(institutions, jwt);
  m.salt_total_ms = elapsedMs(tSalt);
  m.salt_slowest_inst_ms = saltResult.slowestClientMs;
  m.salt_n_institutions = institutions.length;
  const salt = saltResult.saltMerged;

  const tAddr = now();
  const zkAddr = deriveZkLoginAddress(jwt, salt);
  const addressSeed = buildAddressSeed(salt, claims);
  m.address_compute_ms = elapsedMs(tAddr);

  const tProver = now();
  const proof = await fetchZkProof(cfg.proverUrl, {
    jwt,
    ephemeralKeypair: ephKp,
    randomness: typeof randomness === "string" ? randomness : String(randomness),
    saltDecimal: salt.toString(),
    maxEpoch,
  });
  m.prover_request_ms = elapsedMs(tProver);

  m.total_ms = elapsedMs(t0);

  // P-DID derived from the zkLogin Sui address — self-sovereign,
  // no on-chain registration.
  const patientDid = `did:zkehr:zklogin:${zkAddr}`;

  return {
    ephKp, jwt, claims, maxEpoch, salt, zkAddr, patientDid, addressSeed, proof,
    establishment_ms: m,
  };
}

export async function runZkehrCrossAccessExperiment(): Promise<ZkehrCrossAccessRunRecord[]> {
  const sponsor = loadSponsorKeypair();
  const sponsorAddress = sponsor.getPublicKey().toSuiAddress();
  const hospitalA = new HospitalA(HOSPITAL_A_ID, HOSPITAL_A_DID);

  // Load the pre-registered Hospital A and Hospital B DID objects.
  const hospitalDidsPath = resolve(process.cwd(), STORE_HOSPITAL_DIDS_IN);
  const registry = await loadHospitalDidRegistry(hospitalDidsPath);
  if (!registry) {
    throw new Error(
      `Hospital DID registry not found at ${hospitalDidsPath}. ` +
        `Run 'npm run experiment:setup-hospital-dids' first.`,
    );
  }
  if (registry.hospital_a.did !== HOSPITAL_A_DID || registry.hospital_b.did !== HOSPITAL_B_DID) {
    throw new Error(
      `DID mismatch: registry has A=${registry.hospital_a.did} B=${registry.hospital_b.did} ` +
        `but env says A=${HOSPITAL_A_DID} B=${HOSPITAL_B_DID}`,
    );
  }
  // Hospital B's authoritative Sui address: the controller of its on-chain
  // DIDObject (or the env override if the operator wants a separate address).
  const hospitalBAddress = HOSPITAL_B_ADDRESS_OVERRIDE.length > 0
    ? HOSPITAL_B_ADDRESS_OVERRIDE
    : registry.hospital_b.controller_address.toLowerCase();
  const hospitalBDidObjectId = registry.hospital_b.sui_object_id;

  console.log(
    `\n=== zkEHR cross-institution access (DID-bound, multi-auth salt, session reuse) ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns}\n` +
      `access_grant_package=${ACCESS_GRANT_PACKAGE_ID}\n` +
      `prover=${cfg.proverUrl}\n` +
      `salt_institutions=${parseInstitutionsFromEnv(SALT_INSTITUTIONS_ENV).length}\n` +
      `sponsor=${sponsorAddress}\n` +
      `A-DID=${HOSPITAL_A_DID} (object=${registry.hospital_a.sui_object_id.slice(0, 14)}…)\n` +
      `B-DID=${HOSPITAL_B_DID} (object=${hospitalBDidObjectId.slice(0, 14)}…)\n` +
      `B-address=${hospitalBAddress}\n` +
      `scope=${SHARED_SCOPE} ehr_record=${EHR_RECORD_ID}`,
  );

  let sponsorGasCoin: GasCoinRef = await fetchInitialGasCoin(sponsorAddress);

  // ====== One-time zkEHR session establishment (multi-auth salt + zkLogin) ======
  const oidc = await buildOidcRunner(cfg);
  console.log(`[oidc] strategy = ${oidc.strategy}`);

  let session: ZkEhrSession;
  try {
    console.log(`\n[session] establishing zkEHR session (multi-authority salt + zkLogin)...`);
    session = await establishZkEhrSession(oidc);
    const m = session.establishment_ms;
    console.log(
      `[session] established in ${m.total_ms.toFixed(2)}ms ` +
        `(oidc=${m.oidc_login_ms.toFixed(0)} salt=${m.salt_total_ms.toFixed(0)}@${m.salt_n_institutions}-auth ` +
        `prover=${m.prover_request_ms.toFixed(0)})\n` +
        `[session] zklogin_address = ${session.zkAddr}\n` +
        `[session] P-DID            = ${session.patientDid}\n` +
        `[session] max_epoch        = ${session.maxEpoch}\n` +
        `[session] (one-time cost; per-run loop reuses the cached proof)\n`,
    );
  } finally {
    await oidc.close();
  }

  const records: ZkehrCrossAccessRunRecord[] = [];
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
    r.patient_did = session.patientDid;

    const tTotal = now();
    try {
      // ============== GRANT PHASE ==============
      const tGrant0 = now();

      const expiresAtMs = BigInt(Date.now() + EXPIRATION_SECONDS * 1000);
      const built = await buildSponsoredCreateAccessGrantTx({
        packageId: ACCESS_GRANT_PACKAGE_ID,
        zkLoginAddress: session.zkAddr,
        sponsorAddress,
        sponsorGasCoin,
        patientDid: enc(session.patientDid),
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
        patient_did: session.patientDid,
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
        patient_did: session.patientDid,
        hospital_a_did: HOSPITAL_A_DID,
        hospital_b_did: HOSPITAL_B_DID,
        hospital_b_address: hospitalBAddress,
        ehr_record_id: EHR_RECORD_ID,
        requested_scope: SHARED_SCOPE,
        access_grant_object_id: exec.objectId,
      });
      r.request_construct_ms = elapsedMs(tReq);

      // 1 — fetch AccessGrant (Sui RPC)
      const tQuery = now();
      const grant = await resolveAccessGrant(exec.objectId);
      r.access_grant_query_ms = elapsedMs(tQuery);

      const tParse = now();
      void grant.active; void grant.patient_id; void grant.scope;
      void grant.ehr_record_id; void grant.expires_at_ms;
      void grant.grantee_hospital_id; void grant.grantee_address;
      r.grant_object_parse_ms = elapsedMs(tParse);

      // 2 — resolve P-DID locally + check on-chain owner equality (no RPC)
      const tPDID = now();
      hospitalA.resolvePatientZkLoginDid(grant, session.patientDid);
      r.patient_did_resolve_ms = elapsedMs(tPDID);

      // 3 — resolve B-DID via Sui RPC
      const tBDID = now();
      const b = await hospitalA.resolveHospitalBDid(hospitalBDidObjectId, HOSPITAL_B_DID);
      r.hospital_b_did_resolve_ms = elapsedMs(tBDID);

      // 4 — A-DID self-check (local)
      const tADID = now();
      hospitalA.checkOwnDid(grant);
      r.hospital_a_did_check_ms = elapsedMs(tADID);

      // 5 — status / grantee / address bindings
      const tStat = now();
      hospitalA.checkStatus(grant, req, b.controller);
      r.status_check_ms = elapsedMs(tStat);

      // 6 — scope + record
      const tScope = now();
      hospitalA.checkScopeAndRecord(grant, req);
      r.scope_check_ms = elapsedMs(tScope);

      // 7 — expiration
      const tExp = now();
      hospitalA.checkExpiration(grant);
      r.expiration_check_ms = elapsedMs(tExp);

      // 8 — session create
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
        `tx=${r.tx_submit_ms.toFixed(0)} chain_q=${r.access_grant_query_ms.toFixed(0)} ` +
        `B_DID=${r.hospital_b_did_resolve_ms.toFixed(0)}` +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zkehr_cross_institution_access_results.csv");
  await writeZkehrCrossAccessCsv(out, measured);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured, session.establishment_ms);
  return measured;
}

function printSummary(
  rows: ZkehrCrossAccessRunRecord[],
  establishment: ZkEhrSession["establishment_ms"],
): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof ZkehrCrossAccessRunRecord) => ok.map((r) => r[k] as number);

  console.log(`\n========== zkEHR cross-institution access (session reuse) ==========`);
  console.log(
    `One-time session establishment (paid ONCE, NOT in per-run mean):\n` +
      `  oidc_login_ms        = ${establishment.oidc_login_ms.toFixed(2)}\n` +
      `  salt_total_ms        = ${establishment.salt_total_ms.toFixed(2)} (${establishment.salt_n_institutions} authorities, parallel)\n` +
      `  salt_slowest_inst_ms = ${establishment.salt_slowest_inst_ms.toFixed(2)}\n` +
      `  prover_request_ms    = ${establishment.prover_request_ms.toFixed(2)}\n` +
      `  establishment_total  = ${establishment.total_ms.toFixed(2)}\n`,
  );
  console.log(formatStats("grant_total_ms (per run)", computeStats(get("grant_total_ms"), fail)));
  console.log("\n" + formatStats("access_total_ms (per run)", computeStats(get("access_total_ms"), fail)));
  console.log("\n" + formatStats("total_ms (per run)", computeStats(get("total_ms"), fail)));
  console.log("\n--- Grant-phase breakdown ---");
  for (const k of [
    "tx_build_ms", "tx_submit_ms", "object_extract_ms", "local_store_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("--- Access-phase breakdown ---");
  for (const k of [
    "request_construct_ms", "access_grant_query_ms", "grant_object_parse_ms",
    "patient_did_resolve_ms", "hospital_b_did_resolve_ms", "hospital_a_did_check_ms",
    "status_check_ms", "scope_check_ms", "expiration_check_ms",
    "access_session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=====================================================\n");
}
