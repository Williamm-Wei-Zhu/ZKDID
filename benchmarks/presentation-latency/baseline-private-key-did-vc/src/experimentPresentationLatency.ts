/**
 * End-to-end Off-Chain Identity / Credential Presentation Latency
 * — Private-key DID/VC variant with OIDC4VCI-style realistic VC acquisition.
 *
 * Per run, total_ms covers the full user-spec'd flow:
 *
 *   1. Patient obtains VC from issuer        (real OIDC4VCI flow)
 *      1a. Silent-SSO Google ID token
 *      1b. POST id_token + DID to issuer; receive Ed25519-signed VC
 *   2. Patient stores VC                     (in-memory; sub-microsecond)
 *   3. Hospital issues challenge             (32-byte nonce)
 *   4. Patient signs challenge with DID key  (Ed25519 sign)
 *   5. Patient presents VC + DID signature   (assemble envelope)
 *   6. Hospital resolves DID                 (Sui devnet RPC fetch)
 *   7a. Hospital verifies DID signature       (Ed25519 verify with on-chain pubkey)
 *   7b. Hospital verifies VC                  (Ed25519 verify + exp + subject)
 *   8. Hospital creates local patient session (in-memory EHR session record)
 *
 * Compared to the prior `vc_issue_ms`-only measurement, the per-run budget
 * now includes a real Google OIDC silent-SSO round-trip and a real HTTP POST
 * to the mock issuer service. This makes the credential-acquisition cost
 * apples-to-apples comparable to zkDIDProof's per-presentation JWT fetch.
 *
 * Pool of established DIDs is loaded from data/dids.json + data/wallets.json
 * (populated by `npm run experiment:establish` ahead of time).
 *
 * The mock issuer must be running on http://127.0.0.1:4321 (or wherever
 * ISSUER_URL points). Boot it from ../mock-vc-issuer:
 *   GOOGLE_CLIENT_ID=<id> node server.mjs
 */

import { join, resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { ed25519 } from "@noble/curves/ed25519";
import { keypairFromSuiPrivateKey } from "./keypair.js";
import { newChallenge, signChallenge, verifySignature } from "./challengeAuth.js";
import { resolveDidObject } from "./didRegistry.js";
import { createEhrSession, mapDidToPatientId } from "./ehrService.js";
import { loadDids, loadWallets } from "./storage.js";
import { verifyVc, type SignedVc, type VcPayload } from "./vc.js";
import { startCallbackServer } from "./callbackServer.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateNonce,
  generatePkce,
  generateState,
} from "./oidcClient.js";
import { buildLoginRunner } from "./playwrightLogin.js";

/** Per-run record. Column order in the emitted CSV mirrors this object. */
export interface PresentationLatencyRecord {
  run_id: number;
  mode: "presentation-latency-private-key-did-vc";
  start_time_iso: string;
  /** Step 1a: silent-SSO Google ID token for the issuer's authentication. */
  vc_acquire_oidc_ms: number;
  /** Step 1b: HTTP POST to mock issuer + receive signed VC. */
  vc_acquire_issuer_rt_ms: number;
  /** Step 2: patient persists VC in local store. */
  vc_store_ms: number;
  /** Step 3: hospital generates challenge nonce. */
  challenge_create_ms: number;
  /** Step 4: patient signs challenge with DID private key. */
  sign_challenge_ms: number;
  /** Step 5: patient assembles presentation envelope. */
  present_ms: number;
  /** Step 6a: hospital fetches DIDObject from Sui devnet via RPC. */
  did_resolve_devnet_ms: number;
  /** Step 6b: parse on-chain fields, check `active` and DID match. */
  did_object_parse_ms: number;
  /** Step 7a: verify patient's challenge signature against DID pubkey. */
  did_signature_verify_ms: number;
  /** Step 7b: verify VC issuer signature, expiration, subject binding. */
  vc_verify_ms: number;
  /** Map DID -> patient_id (mock EHR lookup). */
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
  "challenge_create_ms", "sign_challenge_ms", "present_ms",
  "did_resolve_devnet_ms", "did_object_parse_ms",
  "did_signature_verify_ms", "vc_verify_ms",
  "patient_mapping_ms", "session_create_ms",
  "total_ms", "sui_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): PresentationLatencyRecord {
  return {
    run_id,
    mode: "presentation-latency-private-key-did-vc",
    start_time_iso: new Date().toISOString(),
    vc_acquire_oidc_ms: 0, vc_acquire_issuer_rt_ms: 0, vc_store_ms: 0,
    challenge_create_ms: 0, sign_challenge_ms: 0, present_ms: 0,
    did_resolve_devnet_ms: 0, did_object_parse_ms: 0,
    did_signature_verify_ms: 0, vc_verify_ms: 0,
    patient_mapping_ms: 0, session_create_ms: 0,
    total_ms: 0, sui_object_id: "",
    success: false, error_message: "",
  };
}

class PatientCredentialStore {
  private readonly creds = new Map<string, SignedVc>();
  put(subjectDid: string, vc: SignedVc): void { this.creds.set(subjectDid, vc); }
  get(subjectDid: string): SignedVc | undefined { return this.creds.get(subjectDid); }
}

interface PresentationEnvelope {
  vc: SignedVc;
  challenge_hex: string;
  did_signature_hex: string;
  subject_did: string;
}

/** Issuer's response shape for /issue-vc/ed25519. */
interface IssuerVcResponse {
  vc: VcPayload;
  canonical: string;
  signature_hex: string;
  issuer_pubkey_hex: string;
  issuer_did: string;
}

export async function runPresentationLatencyExperiment(): Promise<PresentationLatencyRecord[]> {
  const wallets = await loadWallets(resolve(process.cwd(), cfg.storeKeysIn));
  const dids = await loadDids(resolve(process.cwd(), cfg.storeDidsIn));
  if (wallets.length === 0 || dids.length === 0) {
    throw new Error(
      `No DIDs available. Run 'npm run experiment:establish' first to ` +
        `populate ${cfg.storeKeysIn} and ${cfg.storeDidsIn}.`,
    );
  }

  // ---- One-time setup (NOT in per-run budget) -------------------------------

  // Verify issuer is reachable + cache its public key (the hospital's trust
  // anchor for this VC issuer). In production this would be the issuer's DID
  // document, fetched once and pinned.
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
    ed25519_pubkey_hex: string;
  };
  const trustedIssuerPubKey = Uint8Array.from(
    Buffer.from(health.ed25519_pubkey_hex, "hex"),
  );

  const login = await buildLoginRunner(cfg);

  console.log(
    `\n=== End-to-end Off-Chain Identity / Credential Presentation Latency ===\n` +
      `mode=private-key-did-vc + OIDC4VCI  network=devnet  pool=${dids.length}\n` +
      `runs=${cfg.runs}  warmup=${cfg.warmupRuns}\n` +
      `issuer=${health.issuer_did} (${cfg.issuer.url})\n` +
      `oidc_strategy=${login.strategy}`,
  );

  const records: PresentationLatencyRecord[] = [];
  const total = cfg.warmupRuns + cfg.runs;
  const credStore = new PatientCredentialStore();

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

        // --- Step 1a: Patient gets fresh Google ID token via silent SSO -----
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

        // --- Step 1b: Patient POSTs id_token + DID; receives signed VC ------
        const tIssuerRt = now();
        const issuerResp = await fetch(`${cfg.issuer.url}/issue-vc/ed25519`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id_token: tokens.id_token,
            subject_did: storedDid.did,
          }),
        });
        if (!issuerResp.ok) {
          const txt = await issuerResp.text();
          throw new Error(`issuer returned HTTP ${issuerResp.status}: ${txt.slice(0, 200)}`);
        }
        const issued = (await issuerResp.json()) as IssuerVcResponse;
        const signedVc: SignedVc = {
          payload: issued.vc,
          canonical: issued.canonical,
          signature_hex: issued.signature_hex,
        };
        r.vc_acquire_issuer_rt_ms = elapsedMs(tIssuerRt);

        // --- Step 2: Patient stores VC --------------------------------------
        const tStore = now();
        credStore.put(storedDid.did, signedVc);
        r.vc_store_ms = elapsedMs(tStore);

        // --- Step 3: Hospital issues challenge ------------------------------
        const tChal = now();
        const challenge = newChallenge();
        r.challenge_create_ms = elapsedMs(tChal);

        // --- Step 4: Patient signs challenge with DID private key -----------
        const tSign = now();
        const didSignature = signChallenge(patientKp, challenge);
        r.sign_challenge_ms = elapsedMs(tSign);

        // --- Step 5: Patient presents VC + DID signature --------------------
        const tPresent = now();
        const presented = credStore.get(storedDid.did);
        if (!presented) throw new Error(`VC not in patient store for ${storedDid.did}`);
        const envelope: PresentationEnvelope = {
          vc: presented,
          challenge_hex: Buffer.from(challenge).toString("hex"),
          did_signature_hex: Buffer.from(didSignature).toString("hex"),
          subject_did: storedDid.did,
        };
        r.present_ms = elapsedMs(tPresent);

        // --- Step 6a: Hospital resolves DID from devnet ---------------------
        const tRes = now();
        const onchain = await resolveDidObject(storedDid.sui_object_id);
        r.did_resolve_devnet_ms = elapsedMs(tRes);

        // --- Step 6b: Parse + sanity-check on-chain DID ---------------------
        const tParse = now();
        if (!onchain.active) throw new Error("on-chain DIDObject is inactive");
        if (onchain.did !== envelope.subject_did) {
          throw new Error(`DID mismatch: onchain=${onchain.did} envelope=${envelope.subject_did}`);
        }
        r.did_object_parse_ms = elapsedMs(tParse);

        // --- Step 7a: Verify patient's challenge signature ------------------
        const tVerifyDid = now();
        const recoveredChallenge = Uint8Array.from(Buffer.from(envelope.challenge_hex, "hex"));
        const recoveredSig = Uint8Array.from(Buffer.from(envelope.did_signature_hex, "hex"));
        const didSigOk = verifySignature(onchain.publicKey, recoveredChallenge, recoveredSig);
        if (!didSigOk) throw new Error("DID signature verification failed");
        r.did_signature_verify_ms = elapsedMs(tVerifyDid);

        // --- Step 7b: Verify VC issuer signature + binding ------------------
        const tVerifyVc = now();
        const vcResult = verifyVc(envelope.vc, trustedIssuerPubKey, envelope.subject_did);
        if (!(vcResult.signature_ok && vcResult.expiration_ok && vcResult.subject_ok)) {
          throw new Error(`VC verification failed: ${JSON.stringify(vcResult)}`);
        }
        r.vc_verify_ms = elapsedMs(tVerifyVc);

        // --- Map DID -> patient ID -----------------------------------------
        const tMap = now();
        const patient_id = mapDidToPatientId(onchain.did);
        r.patient_mapping_ms = elapsedMs(tMap);

        // --- Step 8: Create local EHR session ------------------------------
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
          `chain=${r.did_resolve_devnet_ms.toFixed(0)}` +
          (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
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
  const out = join(cfg.outputDir, "private_key_did_vc_presentation_latency.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printSummary(measured);

  // Force exit because Playwright sometimes leaves stray workers alive.
  setTimeout(() => process.exit(0), 200).unref();
  return measured;
}

function printSummary(rows: PresentationLatencyRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof PresentationLatencyRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Presentation latency — Private-key DID/VC + OIDC4VCI ==========`);
  for (const k of [
    "total_ms",
    "vc_acquire_oidc_ms",
    "vc_acquire_issuer_rt_ms",
    "sign_challenge_ms",
    "did_resolve_devnet_ms",
    "did_signature_verify_ms",
    "vc_verify_ms",
    "session_create_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("===========================================================================\n");
}
