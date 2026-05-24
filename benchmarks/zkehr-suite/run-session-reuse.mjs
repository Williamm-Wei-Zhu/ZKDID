#!/usr/bin/env node
// experiments/run-session-reuse.mjs
//
// Session-reuse experiment: amortize the one-time costs (OAuth, salt fetch,
// ZK proof generation) by performing them ONCE and then submitting N DID
// transactions against the saved session.
//
// Phase 1 (one-time): full Playwright login flow → JWT + ZK proof saved to
//                     bridge .zk-session.json
// Phase 2 (N times):  direct POST http://bridge/op/did, each builds + signs
//                     + submits a NEW Move transaction reusing the saved
//                     (jwt, eph key, ZK_PROOFS) tuple.
//
// Why this isolates per-DID-post cost:
//   • OAuth (~666 ms), salt fetch (~187 ms), ZK proof (~2615 ms) all happen
//     once in Phase 1 only.
//   • Each Phase 2 iteration spawns veramo-to-sui.js, which detects
//     preloaded ZK_PROOFS and SKIPS the prover request, reducing per-call
//     cost to ~Node spawn + JWK precheck + build_sign + chain submit + finality.
//
// Output:
//   • CSV: results/<ts>_session-reuse_runs<N>.csv (one row per iteration)
//   • Console: per-iteration line + summary stats
//
// Usage:
//   node experiments/run-session-reuse.mjs --runs=30
//   node experiments/run-session-reuse.mjs --runs=30 --institutions=4 --bridge=http://localhost:4317

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import { parseArgs } from "./lib/cli.mjs";
import { appendCsv, summarize } from "./lib/metrics.mjs";
import { makeBridge } from "./lib/bridge.mjs";
import { buildCacheState } from "./lib/salt-cache.mjs";
import { ensureGoogleLoggedIn, runSingleExperiment } from "./lib/playwright-steps.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch { return ""; }
}

async function preflightChecks(opts) {
  const bridge = makeBridge(opts.bridge);
  try { await bridge.getHealth(); }
  catch (e) {
    throw new Error(`Bridge not reachable at ${opts.bridge}.\n  Cause: ${e?.message}`);
  }
  try {
    const res = await fetch(opts.frontend);
    if (!res.ok) throw new Error(`vite ${res.status}`);
  } catch (e) {
    throw new Error(`Frontend not reachable at ${opts.frontend}.\n  Cause: ${e?.message}`);
  }
  return { bridge };
}

function flattenSessionRow({ runId, timestamp, wallMs, ok, error, timings, digest, env, config }) {
  const t = timings?.timings || {};   // veramo-to-sui T.summary() emits keys like "6.1b_JWK_precheck"
  const pickBe = (k) => {
    // Names in BackendTimings JSON. veramo-to-sui prints "- 6.X_phase: N ms";
    // the JSON form drops the "6." prefix in some places. Search both.
    return t[k] ?? t[`6.${k}`] ?? "";
  };
  // Gas info lives under timings.gasReport
  const g = timings?.gasReport || {};
  return {
    run_id: runId,
    timestamp,
    tag: config.tag,
    success: ok ? 1 : 0,
    error_msg: error || "",
    wall_post_ms: wallMs,
    backend_restore_ms:           t["6.1-3_restore_key+randomness+nonce_verify+address_seed"] ?? "",
    backend_jwk_precheck_ms:      t["6.1b_JWK_precheck"] ?? "",
    backend_prover_request_ms:    t["6.4_request_Prover"] ?? "",
    backend_faucet_ms:            t["6.4b_request_Faucet"] ?? "",
    backend_build_sign_ms:        t["6.5_build_and_sign_Move_tx"] ?? "",
    backend_assemble_sig_ms:      t["6.6a_assemble_zkLogin_signature"] ?? "",
    backend_submit_ms:            t["6.6b_submit_tx_and_return"] ?? "",
    backend_total_ms:             timings?.totalMs ?? "",
    gas_computation_mist:         g.computationMist ?? "",
    gas_storage_mist:             g.storageMist ?? "",
    gas_rebate_mist:              g.storageRebateMist ?? "",
    gas_nonrefundable_mist:       g.nonRefundableStorageFeeMist ?? "",
    gas_net_mist:                 g.netGasMist ?? "",
    tx_digest:                    timings?.digest ?? "",
    tx_status:                    timings?.txStatus ?? "",
    git_commit:                   env.gitCommit,
  };
}

async function main() {
  const opts = parseArgs();
  console.log(`[session-reuse] config:`, opts);
  const { bridge } = await preflightChecks(opts);

  const runs = opts.runs;
  const outfile = path.isAbsolute(opts.outfile)
    ? opts.outfile.replace(/\.csv$/, `_sessionreuse.csv`)
    : path.join(__dirname, opts.outfile.replace(/\.csv$/, `_sessionreuse.csv`));
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  console.log(`[session-reuse] CSV → ${outfile}`);

  // ──────────────── Phase 1: one-time browser login ────────────────
  console.log(`\n[session-reuse] Phase 1 — one-time login (OAuth + salt + ZK proof)`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  let page = browser.pages()[0] || await browser.newPage();

  const env = { gitCommit: gitCommit() };
  let setupResult = null;
  let setupError = null;

  try {
    await ensureGoogleLoggedIn(page, opts.frontend);
    await bridge.clearSession();
    const state = await buildCacheState(opts.cache, opts.institutions);
    await bridge.saveSaltSeeds(state);

    // Drive ONE full DID-creation through the UI. This populates:
    //   bridge .zk-session.json  with { GOOGLE_ID_TOKEN, EPHEMERAL_PRIVATE_KEY,
    //                                   JWT_RANDOMNESS, MAX_EPOCH, USER_SALT,
    //                                   ZK_PROOFS }
    // and submits the FIRST on-chain DID. The bridge keeps the session for
    // subsequent /op/did calls in Phase 2.
    setupResult = await runSingleExperiment({
      page, bridge,
      frontend: opts.frontend,
      op: "did",
      institutions: opts.institutions,
      proverMode: opts.proverMode,
      onLog: (m) => process.stdout.write(`  · ${m}\n`),
    });
    console.log(`[session-reuse] Phase 1 OK: setup digest=${(setupResult.digest || "").slice(0, 12)}…  ` +
                `login=${setupResult.wall.loginMs}ms submit=${setupResult.wall.submitMs}ms`);
  } catch (e) {
    setupError = e?.message || String(e);
    console.error(`[session-reuse] Phase 1 FAILED:`, setupError);
    await browser.close();
    process.exit(2);
  }
  // We can close the browser now; Phase 2 is purely HTTP from this Node process.
  await browser.close();

  // ──────────────── Op selection + setup-derived state for op=access ─────
  const phase2Op = opts.op || "did";   // op=did|vc|access; opts.op respected
  if (!["did", "vc", "access"].includes(phase2Op)) {
    console.error(`[session-reuse] FATAL: --op=${phase2Op} not supported in Phase 2`);
    process.exit(2);
  }

  // For op=access we need the patient's zkLogin DID for both hospital and
  // grantee fields (self-grant), plus a unique recordId per call. Read these
  // from the bridge's most recent backend-timings JSON, which Phase 1's first
  // DID submission populated.
  let selfDid = null;
  if (phase2Op === "access") {
    try {
      const resp = await fetch(`${opts.bridge.replace(/\/$/, "")}/latest-timings`);
      const j = await resp.json();
      selfDid = j?.zkDid || null;
      if (!selfDid) throw new Error(`no zkDid in /latest-timings: ${JSON.stringify(j).slice(0, 200)}`);
      console.log(`[session-reuse] derived selfDid = ${selfDid}`);
    } catch (e) {
      console.error(`[session-reuse] FATAL: cannot derive selfDid for op=access:`, e?.message);
      process.exit(2);
    }
  }

  // ──────────────── Phase 2: N direct /op/<phase2Op> calls ────────────────
  console.log(`\n[session-reuse] Phase 2 — ${runs} direct POST /op/${phase2Op} against saved session`);
  const records = [];
  for (let i = 0; i < runs; i++) {
    const tag = `${i + 1}/${runs}`;
    const t0 = performance.now();
    let ok = false, error = null, body = null;
    try {
      let bodyPayload = null;
      if (phase2Op === "access") {
        bodyPayload = {
          hospitalDid: selfDid,
          granteeDid:  selfDid,
          recordId:    `rec-${Date.now()}-${i + 1}`,
        };
      }
      const resp = await fetch(`${opts.bridge.replace(/\/$/, "")}/op/${phase2Op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyPayload ? JSON.stringify(bodyPayload) : undefined,
      });
      body = await resp.json().catch(() => null);
      if (!resp.ok) {
        error = `HTTP ${resp.status}: ${JSON.stringify(body)?.slice(0, 200)}`;
      } else {
        ok = body?.ok === true;
        if (!ok) error = body?.error || "ok=false";
      }
    } catch (e) {
      error = e?.message || String(e);
    }
    const wallMs = Math.round(performance.now() - t0);

    const timings = body?.timings || null;
    const digestShort = (timings?.digest || "").slice(0, 12);
    const submitMs    = timings?.timings?.["6.6b_submit_tx_and_return"];
    const totalMs     = timings?.totalMs;
    if (ok) {
      console.log(`  ${tag} OK  wall=${wallMs}ms  backend_total=${totalMs}ms  ` +
                  `submit=${submitMs}ms  digest=${digestShort}…`);
    } else {
      console.error(`  ${tag} FAIL wall=${wallMs}ms  ${error}`);
    }

    const rec = flattenSessionRow({
      runId: i,
      timestamp: new Date().toISOString(),
      wallMs, ok, error,
      timings,
      env,
      config: { ...opts },
    });
    records.push(rec);
    appendCsv(outfile, [rec]);

    if (i < runs - 1 && opts.sleepBetween > 0) {
      await new Promise((r) => setTimeout(r, opts.sleepBetween));
    }
  }

  // ──────────────── Summary ────────────────
  console.log(`\n[session-reuse] done. ${records.filter(r => r.success).length}/${runs} successful.`);
  console.log(`[session-reuse] CSV: ${outfile}`);

  const ok = records.filter(r => r.success);
  if (ok.length) {
    const pick = (key) => ok.map(r => Number(r[key])).filter(Number.isFinite);
    console.log(`\n[session-reuse] Phase 2 per-iteration summary (n=${ok.length}):`);
    const rows = [
      ["wall_post_ms",                  "wall: HTTP request → response"],
      ["backend_restore_ms",            "BE: 6.1-3 restore+nonce+addrSeed"],
      ["backend_jwk_precheck_ms",       "BE: 6.1b JWK precheck"],
      ["backend_prover_request_ms",     "BE: 6.4 prover (should be 0)"],
      ["backend_faucet_ms",             "BE: 6.4b faucet"],
      ["backend_build_sign_ms",         "BE: 6.5 build+sign tx"],
      ["backend_submit_ms",             "BE: 6.6b submit+finality"],
      ["backend_total_ms",              "BE: total"],
      ["gas_net_mist",                  "Gas: net (MIST)"],
    ];
    for (const [k, label] of rows) {
      const s = summarize(pick(k));
      console.log(`  ${label.padEnd(38)} n=${s.n}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  min=${s.min}  max=${s.max}`);
    }

    if (setupResult) {
      console.log(`\n[session-reuse] Phase 1 (one-time setup) timings, for context:`);
      console.log(`  setup wall_login   = ${setupResult.wall.loginMs} ms  (OAuth + salt + ZK proof)`);
      console.log(`  setup wall_submit  = ${setupResult.wall.submitMs} ms  (first DID submit)`);
      console.log(`  setup wall_total   = ${setupResult.wall.totalMs} ms`);
      console.log(`  prover_ms          = ${setupResult.browser?.timing?.proverMs} ms (browser → Mysten)`);
      console.log(`  salt_ms            = ${setupResult.browser?.timing?.saltMs} ms (parallel fan-out)`);
      console.log(`  oauth_rtt_ms       = ${setupResult.browser?.timing?.oauthJwtMs ?? "(see log)"} ms`);
    }
  }
}

main().catch((e) => {
  console.error("[session-reuse] fatal:", e);
  process.exit(1);
});
