/**
 * End-to-end Off-Chain Identity / Credential Presentation Latency
 * — ZK-based VC presentation variant with OIDC4VCI-style realistic VC acquisition.
 *
 * Per run, total_ms covers:
 *
 *   1. Patient obtains VC from issuer        (real OIDC4VCI flow)
 *      1a. Silent-SSO Google ID token
 *      1b. POST id_token + DID + (aud, nonce_jwt) field elements to issuer;
 *          receive m_jwt + EdDSA-Poseidon signature (sig_r8x, sig_r8y, sig_s)
 *   2. Patient stores VC                     (in-memory)
 *   3. Hospital issues challenge             (random field element)
 *   4. Patient signs challenge with DID key  (Ed25519)
 *   5. Patient generates ZK proof over VC    (Groth16 / bn128)
 *   6. Patient presents (ZK-VC proof + DID signature) envelope
 *   7a. Hospital resolves DID on Sui devnet  (RPC fetch DIDObject)
 *   7b. Hospital verifies DID signature       (Ed25519)
 *   7c. Hospital verifies ZK-VC proof         (Groth16 verify)
 *   8. Hospital creates local patient session
 *
 * The dominant per-presentation cost is ZK proof generation in step 5; the
 * VC acquisition step (1a + 1b) now adds a real OIDC round-trip + a HTTP
 * round-trip to the issuer, making credential-acquisition cost apples-to-
 * apples comparable to zkDIDProof's per-presentation JWT fetch.
 *
 * Circuit / proving artifacts come from the sibling `zkdid-circuit/`:
 *   - build/zkdid.generated_js/zkdid.generated.wasm
 *   - build/zkdid_final.zkey
 *   - build/verification_key.json
 *
 * The mock issuer must be running (boot from ../mock-vc-issuer):
 *   GOOGLE_CLIENT_ID=<id> node server.mjs
 */

import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { keypairFromSuiPrivateKey } from "./keypair.js";
import { newChallenge, signChallenge, verifySignature } from "./challengeAuth.js";
import { resolveDidObject } from "./didRegistry.js";
import { createEhrSession, mapDidToPatientId } from "./ehrService.js";
import { loadDids, loadWallets } from "./storage.js";
import { startCallbackServer } from "./callbackServer.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateNonce,
  generatePkce,
  generateState,
} from "./oidcClient.js";
import { buildLoginRunner } from "./playwrightLogin.js";
import * as snarkjs from "snarkjs";
import { buildPoseidon, type Poseidon } from "circomlibjs";

/** Per-run record. Column order in the emitted CSV mirrors this object. */
export interface ZkVcPresentationLatencyRecord {
  run_id: number;
  mode: "presentation-latency-zk-vc";
  start_time_iso: string;
  /** Step 1a: silent-SSO Google ID token for the issuer's authentication. */
  vc_acquire_oidc_ms: number;
  /** Step 1b: HTTP POST to mock issuer + receive EdDSA-Poseidon-signed claims. */
  vc_acquire_issuer_rt_ms: number;
  /** Step 2: patient persists VC locally (in-memory). */
  vc_store_ms: number;
  /** Step 3: hospital generates challenge field element. */
  challenge_create_ms: number;
  /** Step 4: patient signs challenge with DID private key (Ed25519). */
  sign_challenge_ms: number;
  /** Step 5a: build circuit witness input (Poseidon hashes for nonce / DID). */
  zk_input_build_ms: number;
  /** Step 5b: snarkjs.groth16.fullProve. */
  zk_proof_gen_ms: number;
  /** Step 6: assemble presentation envelope. */
  present_ms: number;
  /** Step 7a: hospital fetches DIDObject from Sui devnet via RPC. */
  did_resolve_devnet_ms: number;
  /** Step 7a-cont: parse / sanity-check on-chain DID. */
  did_object_parse_ms: number;
  /** Step 7b: verify patient's challenge signature against DID pubkey. */
  did_signature_verify_ms: number;
  /** Step 7c: snarkjs.groth16.verify. */
  zk_proof_verify_ms: number;
  /** Map DID -> patient_id. */
  patient_mapping_ms: number;
  /** Step 8: create local EHR session record. */
  session_create_ms: number;
  /** End-to-end. */
  total_ms: number;
  /** On-chain object id used in this run. */
  sui_object_id: string;
  success: boolean;
  error_message: string;
}

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "vc_acquire_oidc_ms", "vc_acquire_issuer_rt_ms", "vc_store_ms",
  "challenge_create_ms", "sign_challenge_ms",
  "zk_input_build_ms", "zk_proof_gen_ms",
  "present_ms",
  "did_resolve_devnet_ms", "did_object_parse_ms",
  "did_signature_verify_ms", "zk_proof_verify_ms",
  "patient_mapping_ms", "session_create_ms",
  "total_ms", "sui_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): ZkVcPresentationLatencyRecord {
  return {
    run_id,
    mode: "presentation-latency-zk-vc",
    start_time_iso: new Date().toISOString(),
    vc_acquire_oidc_ms: 0, vc_acquire_issuer_rt_ms: 0, vc_store_ms: 0,
    challenge_create_ms: 0, sign_challenge_ms: 0,
    zk_input_build_ms: 0, zk_proof_gen_ms: 0,
    present_ms: 0,
    did_resolve_devnet_ms: 0, did_object_parse_ms: 0,
    did_signature_verify_ms: 0, zk_proof_verify_ms: 0,
    patient_mapping_ms: 0, session_create_ms: 0,
    total_ms: 0, sui_object_id: "",
    success: false, error_message: "",
  };
}

const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function dec(F: { toObject(v: unknown): bigint }, value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return F.toObject(value).toString();
}

function randomFieldElement(): string {
  const bytes = new Uint8Array(31);
  randomFillSync(bytes);
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return (acc % SCALAR_FIELD).toString();
}

function findArtifact(name: string): string {
  const p = resolve(process.cwd(), "build", name);
  if (existsSync(p)) return p;
  throw new Error(
    `ZK artifact '${name}' not found at ${p}. Copy from ../zkdid-circuit/build/.`,
  );
}

/** Audience field element for the relying party (relying-party-bound binding). */
const AUDIENCE_LABEL = "zkehr-relying-party";

/** Issuer's response shape for /issue-vc/eddsa-poseidon. */
interface IssuerEddsaResponse {
  sub: string;
  iss: string;
  m_jwt: string;
  sig_r8x: string;
  sig_r8y: string;
  sig_s: string;
  issuer_pubkey: { x: string; y: string };
  issuer_did: string;
  issuer_did_field: string;
  subject_did: string;
}

interface CircuitInput {
  DID: string;
  aud: string;
  T_exp: string;
  chal: string;
  m_jwt: string;
  sig_r8x: string;
  sig_r8y: string;
  sig_s: string;
  sub: string;
  iss: string;
  aud_jwt: string;
  nonce_jwt: string;
  salt: string;
  r: string;
}

const T_EXP_FIELD = "1893456000";
const PATIENT_SALT = "4004";

export async function runZkVcPresentationLatencyExperiment(): Promise<ZkVcPresentationLatencyRecord[]> {
  const wallets = await loadWallets(resolve(process.cwd(), cfg.storeKeysIn));
  const dids = await loadDids(resolve(process.cwd(), cfg.storeDidsIn));
  if (wallets.length === 0 || dids.length === 0) {
    throw new Error(
      `No DIDs available. Run 'npm run experiment:establish' first to ` +
        `populate ${cfg.storeKeysIn} and ${cfg.storeDidsIn}.`,
    );
  }

  const wasmPath = findArtifact("zkdid.generated_js/zkdid.generated.wasm");
  const zkeyPath = findArtifact("zkdid_final.zkey");
  const vkeyPath = findArtifact("verification_key.json");
  const vkey = JSON.parse(await readFile(vkeyPath, "utf8")) as unknown;

  const poseidon: Poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Hash AUDIENCE_LABEL to a field element. The issuer must agree.
  const { createHash } = await import("node:crypto");
  const audField = (
    BigInt("0x" + createHash("sha256").update(AUDIENCE_LABEL, "utf8").digest("hex"))
    % SCALAR_FIELD
  ).toString();

  // Issuer health check — verifies issuer is up + caches its EdDSA-Poseidon
  // pubkey so the circuit's static authority key is consistent with what
  // the issuer signs with.
  const healthResp = await fetch(`${cfg.issuer.url}/healthz`);
  if (!healthResp.ok) {
    throw new Error(
      `Issuer healthz returned HTTP ${healthResp.status}. ` +
        `Boot the mock issuer first: cd ../mock-vc-issuer && ` +
        `GOOGLE_CLIENT_ID=${cfg.oidc.clientId} node server.mjs`,
    );
  }
  const health = (await healthResp.json()) as {
    issuer_did: string;
    eddsa_poseidon_pubkey: { x: string; y: string };
  };

  const login = await buildLoginRunner(cfg);

  console.log(
    `\n=== End-to-end Off-Chain Identity / Credential Presentation Latency ===\n` +
      `mode=zk-vc + OIDC4VCI  network=devnet  pool=${dids.length}\n` +
      `runs=${cfg.runs}  warmup=${cfg.warmupRuns}\n` +
      `issuer=${health.issuer_did} (${cfg.issuer.url})\n` +
      `oidc_strategy=${login.strategy}\n` +
      `wasm=${wasmPath}\n  zkey=${zkeyPath}`,
  );

  const records: ZkVcPresentationLatencyRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  // Patient credential cache (issued m_jwt + sig per DID).
  const credStore = new Map<string, IssuerEddsaResponse>();

  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
      const r = emptyRow(run_id);
      const which = i % dids.length;
      const storedDid = dids[which];
      const wallet = wallets.find((w) => w.did === storedDid.did);
      if (!wallet) {
        r.error_message = `wallet not found for did=${storedDid.did}`;
        records.push(r);
        continue;
      }
      r.sui_object_id = storedDid.sui_object_id;

      const tTotal = now();
      let server: Awaited<ReturnType<typeof startCallbackServer>> | null = null;
      try {
        const patientKp = keypairFromSuiPrivateKey(wallet.secret_key_bech32);

        // Per-run randoms (chal, r) used in the Poseidon-bound nonce that
        // binds the VC issuance to a specific session.
        const chalField = randomFieldElement();
        const rField = randomFieldElement();
        const nonceJwt = F.toObject(
          poseidon([BigInt(rField), BigInt(T_EXP_FIELD), BigInt(chalField)]),
        ).toString();

        // --- Step 1a: Patient gets fresh Google ID token via silent SSO ----
        const tOidc = now();
        const state = generateState();
        const oidcNonce = generateNonce();
        const pkce = generatePkce();
        const authPrompt = login.strategy === "primed" ? "none" : "login";
        const authUrl = buildAuthorizationUrl({
          authorizationEndpoint: cfg.oidc.authorizationEndpoint,
          clientId: cfg.oidc.clientId,
          redirectUri: cfg.oidc.redirectUri,
          scope: cfg.oidc.scope,
          state,
          nonce: oidcNonce,
          pkce,
          prompt: authPrompt,
        });
        server = await startCallbackServer(cfg.callbackPort, state);
        const [cb] = await Promise.all([
          server.awaitCallback(120_000),
          login.runOnce(authUrl, cfg.oidc.redirectUri),
        ]);
        const tokens = await exchangeCodeForTokens({
          tokenEndpoint: cfg.oidc.tokenEndpoint,
          clientId: cfg.oidc.clientId,
          clientSecret: cfg.oidc.clientSecret,
          redirectUri: cfg.oidc.redirectUri,
          code: cb.code,
          codeVerifier: pkce.code_verifier,
        });
        r.vc_acquire_oidc_ms = elapsedMs(tOidc);

        // --- Step 1b: POST to issuer; receive EdDSA-Poseidon-signed VC ----
        const tIssuerRt = now();
        const issuerResp = await fetch(`${cfg.issuer.url}/issue-vc/eddsa-poseidon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id_token: tokens.id_token,
            subject_did: storedDid.did,
            aud_field: audField,
            nonce_jwt_field: nonceJwt,
          }),
        });
        if (!issuerResp.ok) {
          const txt = await issuerResp.text();
          throw new Error(`issuer returned HTTP ${issuerResp.status}: ${txt.slice(0, 200)}`);
        }
        const issued = (await issuerResp.json()) as IssuerEddsaResponse;
        r.vc_acquire_issuer_rt_ms = elapsedMs(tIssuerRt);

        // --- Step 2: Patient stores VC -------------------------------------
        const tStore = now();
        credStore.set(storedDid.did, issued);
        r.vc_store_ms = elapsedMs(tStore);

        // --- Step 3: Hospital issues challenge (already sampled above) -----
        const tChal = now();
        const hospitalChallengeBytes = newChallenge();
        void hospitalChallengeBytes;
        r.challenge_create_ms = elapsedMs(tChal);

        // --- Step 4: Patient signs challenge with DID private key ----------
        const tSign = now();
        const chalBytes = bigintToBe32(BigInt(chalField));
        const didSignature = signChallenge(patientKp, chalBytes);
        r.sign_challenge_ms = elapsedMs(tSign);

        // --- Step 5a: Build circuit input ----------------------------------
        const tInput = now();
        const did = poseidon([
          BigInt(issued.sub),
          BigInt(issued.iss),
          BigInt(PATIENT_SALT),
        ]);
        const input: CircuitInput = {
          DID: dec(F, did),
          aud: audField,
          T_exp: T_EXP_FIELD,
          chal: chalField,
          m_jwt: issued.m_jwt,
          sig_r8x: issued.sig_r8x,
          sig_r8y: issued.sig_r8y,
          sig_s: issued.sig_s,
          sub: issued.sub,
          iss: issued.iss,
          aud_jwt: audField,
          nonce_jwt: nonceJwt,
          salt: PATIENT_SALT,
          r: rField,
        };
        r.zk_input_build_ms = elapsedMs(tInput);

        // --- Step 5b: Generate ZK proof (Groth16) --------------------------
        const tProve = now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input as unknown as Record<string, unknown>,
          wasmPath,
          zkeyPath,
        );
        r.zk_proof_gen_ms = elapsedMs(tProve);

        // --- Step 6: Patient presents envelope -----------------------------
        const tPresent = now();
        const envelope = {
          zk_proof: proof,
          zk_public_signals: publicSignals,
          challenge_hex: Buffer.from(chalBytes).toString("hex"),
          did_signature_hex: Buffer.from(didSignature).toString("hex"),
          subject_did: storedDid.did,
        };
        r.present_ms = elapsedMs(tPresent);

        // --- Step 7a: Hospital resolves DID --------------------------------
        const tRes = now();
        const onchain = await resolveDidObject(storedDid.sui_object_id);
        r.did_resolve_devnet_ms = elapsedMs(tRes);

        const tParse = now();
        if (!onchain.active) throw new Error("on-chain DIDObject is inactive");
        if (onchain.did !== envelope.subject_did) {
          throw new Error(`DID mismatch: onchain=${onchain.did} envelope=${envelope.subject_did}`);
        }
        r.did_object_parse_ms = elapsedMs(tParse);

        // --- Step 7b: Verify DID challenge signature -----------------------
        const tVerifyDid = now();
        const recoveredChallenge = Uint8Array.from(Buffer.from(envelope.challenge_hex, "hex"));
        const recoveredSig = Uint8Array.from(Buffer.from(envelope.did_signature_hex, "hex"));
        const didSigOk = verifySignature(onchain.publicKey, recoveredChallenge, recoveredSig);
        if (!didSigOk) throw new Error("DID signature verification failed");
        r.did_signature_verify_ms = elapsedMs(tVerifyDid);

        // --- Step 7c: Verify ZK proof --------------------------------------
        const tVerifyZk = now();
        const zkOk = await snarkjs.groth16.verify(
          vkey,
          envelope.zk_public_signals,
          envelope.zk_proof,
        );
        if (!zkOk) throw new Error("Groth16 ZK-VC proof verification failed");
        r.zk_proof_verify_ms = elapsedMs(tVerifyZk);

        // --- Map DID -> patient ID ----------------------------------------
        const tMap = now();
        const patient_id = mapDidToPatientId(onchain.did);
        r.patient_mapping_ms = elapsedMs(tMap);

        // --- Step 8: Create local EHR session ----------------------------
        const tSess = now();
        createEhrSession(onchain.did, patient_id);
        r.session_create_ms = elapsedMs(tSess);

        r.total_ms = elapsedMs(tTotal);
        r.success = true;
      } catch (err) {
        r.total_ms = elapsedMs(tTotal);
        r.success = false;
        r.error_message = err instanceof Error ? err.message : String(err);
      } finally {
        if (server) await server.close();
      }

      records.push(r);
      const tag = isWarmup ? "[WARMUP]" : "[MEASURE]";
      console.log(
        `${tag} run=${run_id} success=${r.success} total=${r.total_ms.toFixed(0)} ` +
          `oidc=${r.vc_acquire_oidc_ms.toFixed(0)} issuer=${r.vc_acquire_issuer_rt_ms.toFixed(0)} ` +
          `prove=${r.zk_proof_gen_ms.toFixed(0)} verify=${r.zk_proof_verify_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
      );

      if (
        records.length === 3 &&
        records.every((x) => !x.success) &&
        records.every((x) => x.error_message === records[0].error_message)
      ) {
        console.error(
          `\n[exp] ABORT — first 3 runs all failed with the same error: ${records[0].error_message}`,
        );
        break;
      }
    }
  } finally {
    await login.close();
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "zk_vc_presentation_latency.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);
  setTimeout(() => process.exit(0), 200).unref();
  return measured;
}

function bigintToBe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function printSummary(rows: ZkVcPresentationLatencyRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof ZkVcPresentationLatencyRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Presentation latency — ZK-based VC + OIDC4VCI (Groth16) ==========`);
  for (const k of [
    "total_ms",
    "vc_acquire_oidc_ms",
    "vc_acquire_issuer_rt_ms",
    "sign_challenge_ms",
    "zk_input_build_ms",
    "zk_proof_gen_ms",
    "did_resolve_devnet_ms",
    "did_signature_verify_ms",
    "zk_proof_verify_ms",
    "session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("============================================================================\n");
}
