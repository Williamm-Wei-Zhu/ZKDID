#!/usr/bin/env node
// experiments/run.mjs — Automated DID-creation + on-chain POST benchmark.
//
// Special flag: --prelogin  →  delegate to ./prelogin.mjs (one-time Google auth)
// so users only need to remember one command: `./run-in-dcv.sh --prelogin`.
//
// Drives the zkDID Patient frontend via Playwright, executes N runs under a
// fixed ablation configuration (op × institutions × cache mode), and writes
// a per-run CSV with all browser- and backend-side timings, gas, storage, and
// wall-clock metrics — the measurements recommended for a TSC-style eval.
//
// Prerequisites:
//   1. `npm run dev` is running (bridge :4317 + Vite :1234)
//   2. EC2 salt-services are reachable
//   3. On first run, the launched browser will open and the user must sign
//      into Google manually once. After that, the cookie persists in
//      ./.chrome-profile/ and subsequent runs are fully automatic.
//
// See README.md for usage examples.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

import { parseArgs } from "./lib/cli.mjs";
import { appendCsv, flattenRun, summarize } from "./lib/metrics.mjs";
import { makeBridge } from "./lib/bridge.mjs";
import { buildCacheState } from "./lib/salt-cache.mjs";
import { ensureGoogleLoggedIn, runSingleExperiment } from "./lib/playwright-steps.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

function gitCommit() {
  // Using execFileSync with an argv array — no shell interpolation, no injection surface.
  // Resolve the git repo root from the parent directory (experiments/ isn't itself
  // the repo root — the repo is at ../).
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
    throw new Error(`Bridge not reachable at ${opts.bridge} — start dev stack first (npm run dev).\n  Cause: ${e?.message}`);
  }
  try {
    const res = await fetch(opts.frontend);
    if (!res.ok) throw new Error(`vite returned ${res.status}`);
  } catch (e) {
    throw new Error(`Frontend not reachable at ${opts.frontend} — is Vite up?\n  Cause: ${e?.message}`);
  }
  return { bridge };
}

async function main() {
  // Before normal CLI parsing: if --prelogin is in argv, hand off to prelogin.mjs.
  if (process.argv.slice(2).includes("--prelogin")) {
    console.log(`[exp] --prelogin detected → delegating to prelogin.mjs`);
    const m = await import("./prelogin.mjs").catch((e) => {
      console.error(`[exp] failed to load prelogin.mjs:`, e?.message);
      process.exit(1);
    });
    return; // prelogin.mjs runs its own main() on import
  }
  const opts = parseArgs();
  console.log(`[exp] config:`, opts);
  const { bridge } = await preflightChecks(opts);

  const outfile = path.isAbsolute(opts.outfile) ? opts.outfile : path.join(__dirname, opts.outfile);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  console.log(`[exp] CSV → ${outfile}`);

  console.log(`[exp] launching browser (headless=${opts.headless}, profile=${PROFILE_DIR})`);
  // Stealth flags: hide that we're a Playwright/automation Chromium so Google's
  // "This browser or app may not be secure" heuristic doesn't fire on OAuth login.
  // Belt-and-suspenders: launch args + init script that removes navigator.webdriver.
  // The single most important trick is that the user should manually log into
  // https://accounts.google.com once via prelogin.mjs — OAuth redirects thereafter
  // skip Google's sign-in UI entirely, so these heuristics never run.
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  // Remove common automation fingerprints BEFORE any page loads.
  await browser.addInitScript(() => {
    // @ts-expect-error - erase the webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error - spoof plugins / languages (Chrome has both)
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-expect-error
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  let page = browser.pages()[0] || await browser.newPage();

  try {
    await ensureGoogleLoggedIn(page, opts.frontend);

    const env = { gitCommit: gitCommit() };
    const runResults = [];

    for (let i = 0; i < opts.runs; i++) {
      const runTag = `${i + 1}/${opts.runs}`;
      console.log(`\n[exp] ──────── run ${runTag} ────────`);

      try {
        await bridge.clearSession();
        const state = await buildCacheState(opts.cache, opts.institutions);
        await bridge.saveSaltSeeds(state);
        console.log(`[exp] ${runTag} state: selected=${state.selectedInstitutions.length}, cached=${Object.values(state.saltSeeds).filter(Boolean).length}`);
      } catch (e) {
        console.error(`[exp] ${runTag} state-reset failed:`, e?.message);
        runResults.push({ runId: i, timestamp: new Date().toISOString(), config: { ...opts }, error: `state-reset: ${e?.message}`, env });
        continue;
      }

      if (!opts.warm && i > 0) {
        await page.close();
        page = await browser.newPage();
      }

      const runStart = Date.now();
      let result = null;
      let error = null;
      try {
        result = await runSingleExperiment({
          page, bridge,
          frontend: opts.frontend,
          op: opts.op,
          institutions: opts.institutions,
          proverMode: opts.proverMode,
          onLog: (m) => process.stdout.write(`  · ${m}\n`),
        });
        console.log(`[exp] ${runTag} OK: digest=${(result.digest || "").slice(0, 10)}… login=${result.wall.loginMs}ms submit=${result.wall.submitMs}ms`);
      } catch (e) {
        error = e?.message || String(e);
        console.error(`[exp] ${runTag} FAILED: ${error}`);
        try { await page.screenshot({ path: path.join(__dirname, "results", `run-${i}-failed.png`), fullPage: true }); } catch {}
      }

      const record = {
        runId: i,
        timestamp: new Date(runStart).toISOString(),
        config: { ...opts },
        wall: result?.wall,
        browser: result?.browser,
        backend: result?.backend,
        env,
        error,
      };
      runResults.push(record);

      // Write CSV after EVERY run so a crash mid-batch doesn't lose data.
      appendCsv(outfile, [flattenRun(record)]);

      if (i < opts.runs - 1 && opts.sleepBetween > 0) {
        await new Promise((r) => setTimeout(r, opts.sleepBetween));
      }
    }

    console.log(`\n[exp] done. ${runResults.filter(r => !r.error).length}/${opts.runs} runs successful.`);
    console.log(`[exp] CSV: ${outfile}`);
    printSummary(runResults);
  } finally {
    await browser.close();
  }
}

function printSummary(runs) {
  const ok = runs.filter((r) => !r.error);
  if (!ok.length) { console.log("[exp] no successful runs to summarize"); return; }
  const pick = (key) => ok.map((r) => key.split(".").reduce((a, k) => (a ? a[k] : undefined), r));
  const rows = [
    ["wall.loginMs",                                 "Wall: click→login toast"],
    ["wall.submitMs",                                "Wall: click→DID toast"],
    ["wall.totalMs",                                 "Wall: total"],
    ["browser.timing.genParamsMs",                   "FE: gen params"],
    ["browser.timing.saltMs",                        "FE: fetch salt"],
    ["browser.timing.proverMs",                      "FE: ZK prover"],
    ["browser.timing.bridgePostMs",                  "FE: bridge post"],
    ["backend.timings.6.5_build_and_sign_Move_tx",   "BE: build+sign tx"],
    ["backend.timings.6.6b_submit_tx_and_return",    "BE: submit tx"],
    ["backend.gasReport.netGasMist",                 "Gas: net (MIST)"],
  ];
  console.log("\n[exp] per-metric summary (n, mean, p50, p95, p99):");
  for (const [k, label] of rows) {
    const s = summarize(pick(k));
    console.log(`  ${label.padEnd(32)} n=${s.n}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}`);
  }
}

main().catch((e) => {
  console.error("[exp] fatal:", e);
  process.exit(1);
});
