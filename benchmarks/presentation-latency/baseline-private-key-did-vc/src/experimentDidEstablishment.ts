/**
 * Mode 1: First-time DID establishment with mandatory Sui Devnet registration.
 *
 * Per run, total_ms is the wall clock from Ed25519 key generation through to
 * the moment the on-chain DIDObject id has been extracted from devnet
 * objectChanges and the local artifact has been persisted.
 */

import { join, resolve } from "node:path";
import { writeCsv } from "./csv.js";
import { cfg, requirePackageId } from "./config.js";
import { computeStats, formatStats } from "./stats.js";
import { now, elapsedMs } from "./timer.js";
import { generatePatientKeypair, exportSuiPrivateKey, publicKeyHex, suiAddress, keypairFromSuiPrivateKey } from "./keypair.js";
import { deriveDid } from "./did.js";
import { buildDidDocument } from "./didDocument.js";
import { buildCreateDidObjectTx, executeAndExtractDidObject, fetchInitialGasCoin, type GasCoinRef } from "./didRegistry.js";
import { appendDid, appendWallet } from "./storage.js";
import type { DidEstablishmentRecord } from "./types.js";

const HEADER = [
  "run_id", "mode", "start_time_iso",
  "keygen_ms", "did_derivation_ms", "did_document_create_ms",
  "tx_build_ms", "tx_submit_ms", "tx_finality_ms",
  "object_extract_ms", "local_store_ms", "total_ms",
  "sui_tx_digest", "sui_object_id",
  "success", "error_message",
] as const;

function emptyRow(run_id: number): DidEstablishmentRecord {
  return {
    run_id,
    mode: "did-establishment-devnet",
    start_time_iso: new Date().toISOString(),
    keygen_ms: 0, did_derivation_ms: 0, did_document_create_ms: 0,
    tx_build_ms: 0, tx_submit_ms: 0, tx_finality_ms: 0,
    object_extract_ms: 0, local_store_ms: 0, total_ms: 0,
    sui_tx_digest: "", sui_object_id: "",
    success: false, error_message: "",
  };
}

export async function runEstablishmentExperiment(): Promise<DidEstablishmentRecord[]> {
  const packageId = requirePackageId();
  // The Move module exports `did_registry::DIDObject`; objectChanges arrive
  // with the fully-qualified type, so we match on the suffix.
  const expectedType = "did_registry::DIDObject";

  // Load the funded gas-payer keypair once. It signs every establishment tx
  // because each run generates a *new* unfunded patient keypair. The patient
  // key still controls the DID logically (it is what `public_key` on chain
  // stores and what Mode 2 verifies signatures against); the gas-payer is
  // simply the on-chain `controller`. This is a measurement convenience and
  // is documented in the README as a fairness consideration.
  const gasPayer = keypairFromSuiPrivateKey(cfg.privateKey);
  console.log(
    `\n=== Mode 1: DID establishment on Sui Devnet ===\n` +
      `runs=${cfg.runs} warmup=${cfg.warmupRuns} packageId=${packageId} rpc=${cfg.rpcUrl}\n` +
      `gas-payer (also tx signer / on-chain controller) = ${suiAddress(gasPayer)}`,
  );

  // Seed the gas-coin cache once at the start. After each successful tx we
  // refresh it from `effects.gasObject.reference`. This mirrors zkEHR's
  // gas-coin caching in `zkdid/veramo-to-sui.js` (lines 1389-1410) and is
  // required when running rapid back-to-back txs against Sui Devnet without
  // waitForTransaction -- otherwise the SDK's auto-fetched gas coin is stale
  // and 1/3+ of validators reject with "version unavailable for consumption".
  let gasCoin: GasCoinRef = await fetchInitialGasCoin(suiAddress(gasPayer));
  console.log(
    `[gas-cache] seed coin=${gasCoin.objectId.slice(0, 12)}... v=${gasCoin.version}`,
  );

  const total = cfg.warmupRuns + cfg.runs;
  const records: DidEstablishmentRecord[] = [];

  for (let i = 0; i < total; i++) {
    const isWarmup = i < cfg.warmupRuns;
    const run_id = isWarmup ? -(i + 1) : i - cfg.warmupRuns + 1;
    const r = emptyRow(run_id);
    const tTotal = now();
    try {
      // 1. keygen
      const tKey = now();
      const kp = generatePatientKeypair();
      r.keygen_ms = elapsedMs(tKey);

      // 2. DID derivation
      const tDid = now();
      const pubKeyBytes = kp.getPublicKey().toRawBytes();
      const did = deriveDid(cfg.didMethod, pubKeyBytes);
      r.did_derivation_ms = elapsedMs(tDid);

      // 3. DID document
      const tDoc = now();
      const docObj = buildDidDocument(did, suiAddress(kp), pubKeyBytes);
      const docJson = JSON.stringify(docObj);
      r.did_document_create_ms = elapsedMs(tDoc);

      // 4. Build transaction (with the cached gas-coin reference pinned).
      const built = buildCreateDidObjectTx(
        packageId,
        did,
        pubKeyBytes,
        new TextEncoder().encode(docJson), // metadata = serialized DID document
        gasCoin,
      );
      r.tx_build_ms = built.build_ms;

      // 5-8. Submit, await finality, extract object id.
      // Signed by the gas-payer (funded), not the per-run patient keypair.
      const exec = await executeAndExtractDidObject(built.tx, gasPayer, expectedType);
      r.tx_submit_ms = exec.submit_ms;
      r.tx_finality_ms = exec.finality_ms;
      r.object_extract_ms = exec.extract_ms;
      r.sui_tx_digest = exec.digest;
      r.sui_object_id = exec.objectId;
      // Refresh the cache for the next run.
      gasCoin = exec.nextGasCoin;

      // 9. Persist locally so the auth experiment can replay this DID
      const tStore = now();
      if (!isWarmup) {
        await appendWallet(resolve(process.cwd(), cfg.storeKeysIn), {
          did,
          public_key_hex: publicKeyHex(kp),
          secret_key_bech32: exportSuiPrivateKey(kp),
          sui_address: suiAddress(kp),
        });
        await appendDid(resolve(process.cwd(), cfg.storeDidsIn), {
          did,
          sui_object_id: exec.objectId,
          sui_tx_digest: exec.digest,
          controller_address: suiAddress(kp),
          created_at_iso: r.start_time_iso,
        });
      }
      r.local_store_ms = elapsedMs(tStore);
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
      `${tag} run=${run_id} success=${r.success} total_ms=${r.total_ms.toFixed(2)} ` +
        `digest=${r.sui_tx_digest.slice(0, 12)}…` +
        (r.error_message ? ` err="${r.error_message.slice(0, 100)}"` : ""),
    );
  }

  const measured = records.filter((r) => r.run_id > 0);
  const out = join(cfg.outputDir, "private_key_did_establishment_devnet.csv");
  await writeCsv(out, HEADER, measured as unknown as Record<string, unknown>[]);
  console.log(`\nWrote ${measured.length} rows to ${out}`);

  printEstablishmentSummary(measured);
  return measured;
}

export function printEstablishmentSummary(rows: DidEstablishmentRecord[]): void {
  const ok = rows.filter((r) => r.success);
  const fail = rows.length - ok.length;
  const get = (k: keyof DidEstablishmentRecord) => ok.map((r) => r[k] as number);
  console.log(`\n========== Mode 1 — DID establishment ==========`);
  for (const k of [
    "total_ms", "keygen_ms", "did_derivation_ms", "did_document_create_ms",
    "tx_submit_ms", "tx_finality_ms",
  ] as const) {
    console.log(formatStats(k, computeStats(get(k), fail)) + "\n");
  }
  console.log("=================================================\n");
}
