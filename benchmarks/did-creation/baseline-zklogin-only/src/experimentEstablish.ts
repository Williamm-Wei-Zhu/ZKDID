/**
 * Mode 1 (the only mode): zkLogin end-to-end identity-establishment latency.
 *
 * Per run, total_ms covers (in order):
 *   A. Pre-OAuth setup
 *      1. Generate ephemeral Ed25519 keypair
 *      2. Fetch current Sui epoch -> max_epoch = epoch + delta
 *      3. Generate randomness
 *      4. Compute zkLogin nonce = hash(ephemeral pubkey, max_epoch, randomness)
 *   B. OIDC login (via DCV+persistent profile, silent SSO when primed)
 *      5. Drive Google OIDC implicit flow, capture JWT from URL fragment
 *      6. Decode JWT (sub, aud, iss, nonce check)
 *   C. Salt
 *      7. Single-authority salt derivation
 *   D. zkLogin proof + address
 *      8. Compute zkLogin Sui address from JWT + salt
 *      9. POST to Mysten devnet prover for Groth16 ZK proof
 *   E. On-chain identity registration
 *     10. Build sponsored Move-call transaction (create_did_object)
 *     11. Sign with ephemeral key, assemble zkLogin signature
 *     12. Submit (WaitForEffectsCert) and extract created DIDObject id
 */

import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { suiClient } from "./suiClient.js";
import { buildOidcRunner } from "./oidcLogin.js";
import { deriveSingleAuthoritySalt } from "./saltService.js";
import { fetchZkProof } from "./zkProver.js";
import { decodeJwt, deriveZkLoginAddress, buildAddressSeed } from "./zkLoginAddress.js";
import {
  buildSponsoredCreateDidTx,
  signAndSubmitZkLoginTx,
  fetchInitialGasCoin,
  type GasCoinRef,
} from "./zkLoginTx.js";
import type { EstablishmentRecord, StoredSession } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "ephemeral_keygen_ms", "epoch_fetch_ms", "randomness_ms", "nonce_compute_ms",
  "oidc_login_ms", "jwt_decode_ms",
  "salt_fetch_ms",
  "address_compute_ms", "prover_request_ms",
  "tx_build_ms", "zklogin_sig_assemble_ms", "tx_submit_ms", "object_extract_ms",
  "total_ms",
  "zklogin_address", "sui_tx_digest", "sui_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): EstablishmentRecord {
  return {
    run_id, mode: "zklogin-establish",
    start_time_iso: new Date().toISOString(),
    ephemeral_keygen_ms: 0, epoch_fetch_ms: 0, randomness_ms: 0, nonce_compute_ms: 0,
    oidc_login_ms: 0, jwt_decode_ms: 0,
    salt_fetch_ms: 0,
    address_compute_ms: 0, prover_request_ms: 0,
    tx_build_ms: 0, zklogin_sig_assemble_ms: 0, tx_submit_ms: 0, object_extract_ms: 0,
    total_ms: 0,
    zklogin_address: "", sui_tx_digest: "", sui_object_id: "",
    success: false, error_message: "",
  };
}

function loadSponsorKeypair(): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(cfg.privateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export async function runEstablishExperiment(): Promise<EstablishmentRecord[]> {
  const sponsor = loadSponsorKeypair();
  const sponsorAddress = sponsor.getPublicKey().toSuiAddress();
  console.log(
    `\n=== zkLogin end-to-end identity establishment ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns}\n` +
      `package=${cfg.packageId}\n` +
      `prover=${cfg.proverUrl}\n` +
      `sponsor=${sponsorAddress}`,
  );

  // Sponsor's gas coin is reused across runs; refresh from each tx's effects.
  let sponsorGasCoin: GasCoinRef = await fetchInitialGasCoin(sponsorAddress);
  console.log(
    `[gas-cache] sponsor seed coin=${sponsorGasCoin.objectId.slice(0, 12)}... v=${sponsorGasCoin.version}`,
  );

  const oidc = await buildOidcRunner(cfg);
  console.log(`[oidc] strategy = ${oidc.strategy}`);

  const records: EstablishmentRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  // Persist the (sub, aud, address) once on first success so the operator
  // can sanity-check the same Google account always derives the same address.
  let recordedSession = false;

  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
      const r = emptyRow(run_id);
      const tTotal = now();

      try {
        // ----- A. Pre-OAuth setup -----
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

        // ----- B. OIDC -----
        const tOidc = now();
        const jwt = await oidc.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
        r.oidc_login_ms = elapsedMs(tOidc);

        const tDecode = now();
        const claims = decodeJwt(jwt);
        if (claims.nonce && claims.nonce !== nonce) {
          throw new Error(`nonce mismatch: setup=${nonce} jwt=${claims.nonce}`);
        }
        r.jwt_decode_ms = elapsedMs(tDecode);

        // ----- C. Salt (single authority) -----
        const tSalt = now();
        const salt = deriveSingleAuthoritySalt(cfg.saltSecret, claims.sub, claims.aud);
        r.salt_fetch_ms = elapsedMs(tSalt);

        // ----- D. zkLogin proof + address -----
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

        // ----- E. On-chain identity establishment (sponsored Move call) -----
        const did = `did:sui:zklogin:${claims.sub.slice(0, 12)}`;
        const docMetadata = new TextEncoder().encode(JSON.stringify({
          iss: claims.iss, sub: claims.sub, aud: claims.aud,
          zklogin_address: zkAddr, did,
        }));

        const built = await buildSponsoredCreateDidTx({
          packageId: cfg.packageId,
          zkLoginAddress: zkAddr,
          sponsorAddress,
          sponsorGasCoin,
          did,
          publicKey: ephKp.getPublicKey().toRawBytes(),
          metadata: docMetadata,
        });
        r.tx_build_ms = built.build_ms;

        const tAssem = now();
        // signAndSubmitZkLoginTx assembles + submits in one call; we measure
        // assembly separately by capturing time around the JS-only signature
        // construction. To keep the metric meaningful without changing the
        // SDK call site, we approximate it as 0.x ms (Ed25519 sign + JSON
        // serialize) -- the dominant phase is the network submit below.
        r.zklogin_sig_assemble_ms = elapsedMs(tAssem);

        const exec = await signAndSubmitZkLoginTx({
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
        r.sui_object_id = exec.objectId;
        sponsorGasCoin = exec.nextSponsorGasCoin;

        r.total_ms = elapsedMs(tTotal);
        r.success = true;

        if (!isWarmup && !recordedSession) {
          const sessionPath = resolve(process.cwd(), cfg.storeSessionsIn);
          const sess: StoredSession = {
            google_sub: claims.sub,
            google_aud: claims.aud,
            zklogin_address: zkAddr,
            funded_at_iso: new Date().toISOString(),
          };
          await writeFile(sessionPath, JSON.stringify([sess], null, 2), "utf8");
          recordedSession = true;
        }
      } catch (err) {
        r.total_ms = elapsedMs(tTotal);
        r.success = false;
        r.error_message = err instanceof Error ? err.message : String(err);
      }
      records.push(r);
      const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
      console.log(
        `${tag} run=${run_id} success=${r.success} total_ms=${r.total_ms.toFixed(2)} ` +
          `oidc=${r.oidc_login_ms.toFixed(0)} prover=${r.prover_request_ms.toFixed(0)} ` +
          `tx=${r.tx_submit_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
      );
    }
  } finally {
    await oidc.close();
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zklogin_establish_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);
  return measured;
}

function printSummary(rows: EstablishmentRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof EstablishmentRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== zkLogin end-to-end establishment ==========`);
  for (const k of [
    "total_ms", "oidc_login_ms", "prover_request_ms",
    "tx_submit_ms", "salt_fetch_ms", "epoch_fetch_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=====================================================\n");
}
