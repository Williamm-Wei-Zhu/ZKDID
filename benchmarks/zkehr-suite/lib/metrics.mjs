// Flatten nested timing records into flat CSV rows and write them.
// Wide format: one row per run, ~40 columns. Easy to load into pandas/R/Excel.

import fs from "node:fs";
import path from "node:path";

/**
 * Flatten a single run's records into a plain key→value object suitable for a CSV row.
 * Shape of `run`:
 *   {
 *     runId, timestamp, config: {op, institutions, cache, tag, ...},
 *     wall: { totalMs, loginMs, submitMs, ... },
 *     browser: { timing: {...per-phase ms} } | null,
 *     backend: BackendTimings | null,
 *     error: string | null,
 *   }
 */
export function flattenRun(run) {
  const c = run.config || {};
  const b = run.browser?.timing || {};
  const bk = run.backend || null;
  const bkt = bk?.timings || {};
  const gas = bk?.gasReport || {};
  const store = Array.isArray(bk?.storageReport) ? bk.storageReport : [];
  const firstObj = store[0] || {};

  return {
    // identity
    run_id: run.runId,
    timestamp: run.timestamp,
    tag: c.tag || "",
    success: run.error ? 0 : 1,
    error_msg: run.error || "",
    // config
    op: c.op,
    institutions: c.institutions,
    cache_mode: c.cache,
    warm: c.warm ? 1 : 0,
    // --- BROWSER: pre-OAuth (beginZkLogin) ---
    epoch_fetch_ms: b.epochFetchMs ?? "",
    eph_key_ms: b.ephKeyMs ?? "",
    randomness_ms: b.randomnessMs ?? "",
    nonce_ms: b.nonceMs ?? "",
    gen_params_total_ms: b.genParamsMs ?? "",
    // --- BROWSER: OAuth round-trip ---
    oauth_rtt_ms: b.oauthJwtMs ?? "",
    // --- BROWSER: post-OAuth (completeZkLogin) ---
    jwt_parse_ms: b.jwtParseMs ?? "",
    salt_ms: b.saltMs ?? "",
    nonce_verify_ms: b.nonceVerifyMs ?? "",
    prover_ms: b.proverMs ?? "",
    save_account_ms: b.saveAccountMs ?? "",
    bridge_post_ms: b.bridgePostMs ?? "",
    derive_all_ms: b.deriveAllMs ?? "",
    // --- BACKEND: per-phase (from .backend-timings.json) ---
    backend_restore_ms: bkt["6.1-3_restore_key+randomness+nonce_verify+address_seed"] ?? "",
    backend_jwk_precheck_ms: bkt["6.1b_JWK_precheck"] ?? "",
    backend_prover_request_ms: bkt["6.4_request_Prover"] ?? "",
    backend_faucet_ms: bkt["6.4b_request_Faucet"] ?? "",
    backend_build_sign_ms: bkt["6.5_build_and_sign_Move_tx"] ?? "",
    backend_assemble_sig_ms: bkt["6.6a_assemble_zkLogin_signature"] ?? "",
    backend_submit_ms: bkt["6.6b_submit_tx_and_return"] ?? "",
    backend_query_chain_ms: bkt["8_query_chain_and_update_DID_doc"] ?? "",
    backend_total_ms: Object.values(bkt).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) || "",
    // --- CHAIN: gas ---
    gas_computation_mist: gas.computationCostMist ?? "",
    gas_storage_mist: gas.storageCostMist ?? "",
    gas_rebate_mist: gas.storageRebateMist ?? "",
    gas_nonrefundable_mist: gas.nonRefundableStorageFeeMist ?? "",
    gas_net_mist: gas.netGasMist ?? "",
    // --- CHAIN: object size ---
    object_id: firstObj.objectId ?? "",
    object_bcs_bytes: firstObj.bcsBytes ?? "",
    objects_created: store.length,
    // --- CHAIN: tx ---
    tx_digest: bk?.digest ?? "",
    tx_status: bk?.status ?? "",
    // --- WALL-CLOCK (Playwright-measured) ---
    wall_login_ms: run.wall?.loginMs ?? "",
    wall_submit_ms: run.wall?.submitMs ?? "",
    wall_total_ms: run.wall?.totalMs ?? "",
    // --- environment ---
    node_version: process.version,
    git_commit: run.env?.gitCommit || "",
  };
}

function esc(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Append rows to a CSV file. Writes header on first call (when file doesn't exist).
 */
export function appendCsv(filePath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Object.keys(rows[0]);
  const needHeader = !fs.existsSync(filePath);
  const out = [];
  if (needHeader) out.push(header.map(esc).join(","));
  for (const r of rows) out.push(header.map((h) => esc(r[h])).join(","));
  fs.appendFileSync(filePath, out.join("\n") + "\n");
}

/** Basic summary stats over an array of numbers (drops NaN/empty). */
export function summarize(values) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return { n: 0, mean: null, p50: null, p95: null, p99: null, min: null, max: null, stddev: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return {
    n: nums.length,
    mean: Math.round(mean),
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: Math.round(Math.sqrt(variance)),
  };
}
