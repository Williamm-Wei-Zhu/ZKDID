/**
 * End-to-end Off-Chain Identity / Credential Presentation Latency
 * — zkDIDProof variant (this paper's solution).
 *
 * Per run, total_ms covers the full user-spec'd flow:
 *
 *   1. Hospital issues challenge            (random field element)
 *   2. Nonce generation                     (nonce_jwt = Poseidon(r, T_exp, chal))
 *   3. Google JWT request                   (OIDC silent SSO with our Poseidon-bound nonce)
 *   4. Patient generates challenge-bound ZK proof over OIDC-derived DID
 *   5. Hospital verifies ZK proof LOCALLY   (no blockchain access)
 *   6. Hospital creates local patient session
 *
 * Key advantage over Private-key DID/VC and ZK-VC variants: the hospital
 * verifies the ZK proof against a static verification key — no Sui RPC, no
 * DID-registry lookup, no on-chain finality wait. The DID is derived in-
 * circuit from the OIDC subject + issuer + a salt; the hospital only checks
 * that the proof's public DID was produced by the trusted OIDC OP for this
 * specific challenge.
 *
 * The circuit (`circuits/zkdid.circom`, compiled in
 * `build/zkdid.generated_js/...wasm` + `build/zkdid_final.zkey`) verifies
 * an EdDSA-Poseidon signature by the OP authority over m_jwt. Real Google
 * RS256 JWTs would need an in-circuit RS256 verifier (a future engineering
 * step per the zkdid-circuit README); for measurement purposes we model
 * the OP signature with the same EdDSA-Poseidon scheme the circuit was
 * compiled with — the per-presentation Groth16 cost is the structural
 * quantity we care about.
 */

import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomFillSync } from "node:crypto";
import { decodeJwt } from "jose";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { startCallbackServer } from "./callbackServer.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkce,
  generateState,
} from "./oidcClient.js";
import { buildLoginRunner } from "./playwrightLogin.js";
import { createEhrSession } from "./session.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import * as snarkjs from "snarkjs";
import { buildEddsa, buildPoseidon, type Eddsa, type Poseidon } from "circomlibjs";

/** Per-run record. Column order in the emitted CSV mirrors this object. */
export interface ZkdidProofRecord {
  run_id: number;
  mode: "presentation-latency-zkdidproof";
  start_time_iso: string;
  /** Step 1: hospital generates challenge field element. */
  challenge_create_ms: number;
  /** Step 2: nonce_jwt = Poseidon(r, T_exp, chal). */
  nonce_gen_ms: number;
  /** Step 3a: browser-side OIDC redirect + callback (Google silent SSO). */
  oidc_login_ms: number;
  /** Step 3b: authorization-code -> token exchange. */
  token_exchange_ms: number;
  /** Step 3c: parse JWT, extract sub/iss/aud/nonce as field elements. */
  jwt_parse_ms: number;
  /** Step 4a: build circuit input (Poseidon hashes for DID, m_jwt; mock OP signature). */
  zk_input_build_ms: number;
  /** Step 4b: snarkjs.groth16.fullProve — witness calc + Groth16 prove. */
  zk_proof_gen_ms: number;
  /** Step 5: snarkjs.groth16.verify — hospital's LOCAL Groth16 verify (no blockchain). */
  zk_proof_verify_ms: number;
  /** Step 6: create local EHR session record. */
  session_create_ms: number;
  /** End-to-end. */
  total_ms: number;
  success: boolean;
  error_message: string;
}

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "challenge_create_ms", "nonce_gen_ms",
  "oidc_login_ms", "token_exchange_ms", "jwt_parse_ms",
  "zk_input_build_ms", "zk_proof_gen_ms",
  "zk_proof_verify_ms",
  "session_create_ms",
  "total_ms",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): ZkdidProofRecord {
  return {
    run_id,
    mode: "presentation-latency-zkdidproof",
    start_time_iso: new Date().toISOString(),
    challenge_create_ms: 0, nonce_gen_ms: 0,
    oidc_login_ms: 0, token_exchange_ms: 0, jwt_parse_ms: 0,
    zk_input_build_ms: 0, zk_proof_gen_ms: 0,
    zk_proof_verify_ms: 0,
    session_create_ms: 0,
    total_ms: 0,
    success: false, error_message: "",
  };
}

const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function textToFieldDecimal(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return ((BigInt("0x" + digest) % SCALAR_FIELD)).toString();
}

function dec(F: { toObject(v: unknown): bigint }, value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  return F.toObject(value).toString();
}

/** Random field element under the bn128 scalar field. */
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
    `ZK artifact '${name}' not found at ${p}. Copy the compiled circuit + ` +
      `zkey + vkey from ../zkdid-circuit/build/ (or sibling) into ./build/.`,
  );
}

/** The OIDC OP's mock EdDSA-Poseidon authority key — must match the key the
 *  zkdid-circuit was compiled with (default `0x...01`). For real-deployment
 *  zkDIDProof, replace `JWTValidity` in the circuit with an RS256 verifier;
 *  here we use the same mock key the prebuilt artifacts expect. */
const AUTHORITY_PRIVATE_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

/** A stable salt the patient picks once when binding their OIDC sub/iss to a
 *  DID. In real systems this is split across a multi-authority salt service;
 *  here it's a fixed value so per-run cost is purely the Groth16 work. */
const PATIENT_SALT = "4004";

/** OIDC ID-token expiry — fixed far in the future for the demo so iss-time
 *  drift between Google's actual `exp` and our public `T_exp` doesn't matter. */
const T_EXP_FIELD = "1893456000";

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

export async function runZkdidProofExperiment(): Promise<ZkdidProofRecord[]> {
  // Locate ZK artifacts.
  const wasmPath = findArtifact("zkdid.generated_js/zkdid.generated.wasm");
  const zkeyPath = findArtifact("zkdid_final.zkey");
  const vkeyPath = findArtifact("verification_key.json");
  const vkey = JSON.parse(await readFile(vkeyPath, "utf8")) as unknown;

  // Heavy-init circomlibjs primitives once. Loading the Poseidon WASM here
  // would otherwise dominate the first run.
  const eddsa: Eddsa = await buildEddsa();
  const poseidon: Poseidon = await buildPoseidon();
  const F = poseidon.F;

  // OP authority key (mock OIDC OP signing scheme expected by the circuit).
  const authoritySecret = Buffer.from(AUTHORITY_PRIVATE_KEY_HEX, "hex");

  // Audience field element — the relying-party's audience claim, fixed.
  const audField = textToFieldDecimal(cfg.oidc.clientId);

  // Spin up the Playwright login runner once. Reused across all runs.
  const login = await buildLoginRunner(cfg);

  console.log(
    `\n=== End-to-end Off-Chain Identity / Credential Presentation Latency ===\n` +
      `mode=zkdidproof  runs=${cfg.experiment.runs}  warmup=${cfg.experiment.warmupRuns}\n` +
      `headless=${cfg.browser.headless}  strategy=${login.strategy}\n` +
      `wasm=${wasmPath}\n` +
      `zkey=${zkeyPath}\n` +
      `vkey=${vkeyPath}`,
  );
  if (login.strategy !== "primed") {
    console.warn(
      `[exp] WARNING: login strategy is '${login.strategy}', not 'primed'. ` +
        `Run './run-in-dcv.sh prelogin' to enable silent SSO for accurate timing.`,
    );
  }

  const records: ZkdidProofRecord[] = [];
  const total = cfg.experiment.warmupRuns + cfg.experiment.runs;

  try {
    for (let i = 0; i < total; i++) {
      const isWarmup = i < cfg.experiment.warmupRuns;
      const run_id = isWarmup ? -(i + 1) : i - cfg.experiment.warmupRuns + 1;
      const r = emptyRow(run_id);

      const tTotal = now();
      let server: Awaited<ReturnType<typeof startCallbackServer>> | null = null;

      try {
        // --- Step 1: Hospital issues challenge -----------------------------
        const tChal = now();
        const chalField = randomFieldElement();
        r.challenge_create_ms = elapsedMs(tChal);

        // --- Step 2: Nonce generation (Poseidon-bound) ---------------------
        const tNonce = now();
        const rField = randomFieldElement();
        const nonceJwtFE = poseidon([
          BigInt(rField),
          BigInt(T_EXP_FIELD),
          BigInt(chalField),
        ]);
        const nonceJwtDec = dec(F, nonceJwtFE);
        r.nonce_gen_ms = elapsedMs(tNonce);

        // --- Step 3: Google JWT request (silent SSO with our nonce) --------
        const state = generateState();
        const pkce = generatePkce();
        // Pass the Poseidon-bound nonce as the OIDC `nonce` parameter.
        // Google echoes it verbatim into the issued ID token's `nonce` claim.
        const authPrompt = login.strategy === "primed" ? "none" : "login";
        const authUrl = buildAuthorizationUrl({
          authorizationEndpoint: cfg.oidc.authorizationEndpoint,
          clientId: cfg.oidc.clientId,
          redirectUri: cfg.oidc.redirectUri,
          scope: cfg.oidc.scope,
          state,
          nonce: nonceJwtDec,
          pkce,
          prompt: authPrompt,
        });

        const tLogin = now();
        server = await startCallbackServer(cfg.callbackPort, state);
        const [cb] = await Promise.all([
          server.awaitCallback(120_000),
          login.runOnce(authUrl, cfg.oidc.redirectUri),
        ]);
        r.oidc_login_ms = elapsedMs(tLogin);

        const tEx = now();
        const tokens = await exchangeCodeForTokens({
          tokenEndpoint: cfg.oidc.tokenEndpoint,
          clientId: cfg.oidc.clientId,
          clientSecret: cfg.oidc.clientSecret,
          redirectUri: cfg.oidc.redirectUri,
          code: cb.code,
          codeVerifier: pkce.code_verifier,
        });
        r.token_exchange_ms = elapsedMs(tEx);

        // --- Step 3c: Parse JWT, extract canonical claim field elements -----
        const tParse = now();
        const payload = decodeJwt(tokens.id_token);
        if (typeof payload.sub !== "string") throw new Error("JWT missing 'sub'");
        if (typeof payload.iss !== "string") throw new Error("JWT missing 'iss'");
        const audClaim = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
        if (typeof audClaim !== "string") throw new Error("JWT missing 'aud'");
        if (payload.nonce !== nonceJwtDec) {
          throw new Error(
            `Google nonce mismatch: got=${String(payload.nonce)} expected=${nonceJwtDec}`,
          );
        }
        const subFE = textToFieldDecimal(payload.sub);
        const issFE = textToFieldDecimal(payload.iss);
        const audFE = textToFieldDecimal(audClaim);
        if (audFE !== audField) {
          throw new Error(
            `Audience field mismatch: jwt-aud-field=${audFE} cfg-aud-field=${audField}`,
          );
        }
        r.jwt_parse_ms = elapsedMs(tParse);

        // --- Step 4a: Build circuit input ----------------------------------
        // m_jwt = Poseidon(sub, iss, aud_jwt, nonce_jwt)
        // The OP authority (mock) signs m_jwt; circuit verifies that signature
        // along with DID = Poseidon(sub, iss, salt) and nonce binding.
        const tInput = now();
        const mJwt = poseidon([BigInt(subFE), BigInt(issFE), BigInt(audFE), BigInt(nonceJwtDec)]);
        const opSig = eddsa.signPoseidon(authoritySecret, mJwt);
        const did = poseidon([BigInt(subFE), BigInt(issFE), BigInt(PATIENT_SALT)]);
        const input: CircuitInput = {
          DID: dec(F, did),
          aud: audField,
          T_exp: T_EXP_FIELD,
          chal: chalField,
          m_jwt: dec(F, mJwt),
          sig_r8x: dec(eddsa.F, opSig.R8[0]),
          sig_r8y: dec(eddsa.F, opSig.R8[1]),
          sig_s: opSig.S.toString(),
          sub: subFE,
          iss: issFE,
          aud_jwt: audFE,
          nonce_jwt: nonceJwtDec,
          salt: PATIENT_SALT,
          r: rField,
        };
        r.zk_input_build_ms = elapsedMs(tInput);

        // --- Step 4b: Generate ZK proof (Groth16) --------------------------
        const tProve = now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input as unknown as Record<string, unknown>,
          wasmPath,
          zkeyPath,
        );
        r.zk_proof_gen_ms = elapsedMs(tProve);

        // --- Step 5: Hospital verifies proof LOCALLY (no blockchain) -------
        const tVerify = now();
        const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
        if (!ok) throw new Error("Groth16 zkDIDProof verification failed");
        r.zk_proof_verify_ms = elapsedMs(tVerify);

        // --- Step 6: Create local patient session --------------------------
        const tSess = now();
        createEhrSession({
          iss: payload.iss,
          sub: payload.sub,
          aud: audClaim,
          exp: typeof payload.exp === "number" ? payload.exp : 0,
          iat: typeof payload.iat === "number" ? payload.iat : undefined,
          email: typeof payload.email === "string" ? payload.email : undefined,
          name: typeof payload.name === "string" ? payload.name : undefined,
          nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
        });
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
        `${tag} run=${run_id} success=${r.success} total_ms=${r.total_ms.toFixed(2)}` +
          ` oidc=${r.oidc_login_ms.toFixed(0)} prove=${r.zk_proof_gen_ms.toFixed(0)} verify=${r.zk_proof_verify_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 120)}"` : ""),
      );

      // Fast-fail: if first three runs all fail with the same error, abort.
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
  const out = cfg.experiment.outputCsv;
  await writeCsv(out, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);

  setTimeout(() => process.exit(0), 200).unref();
  return measured;
}

function printSummary(rows: ZkdidProofRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof ZkdidProofRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Presentation latency — zkDIDProof ==========`);
  for (const k of [
    "total_ms",
    "challenge_create_ms",
    "nonce_gen_ms",
    "oidc_login_ms",
    "token_exchange_ms",
    "jwt_parse_ms",
    "zk_input_build_ms",
    "zk_proof_gen_ms",
    "zk_proof_verify_ms",
    "session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("========================================================\n");
}
