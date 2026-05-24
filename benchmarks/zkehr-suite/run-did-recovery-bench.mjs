#!/usr/bin/env node
// experiments/run-did-recovery-bench.mjs
//
// DID Recovery scaling experiment: drive the recovery flow (OAuth + N-way
// salt fan-out + local DID derivation; NO on-chain submission) at increasing
// institution counts and capture per-trial timing.
//
// For each N in [3, 5, 7, 9, 11], we run --runs trials of:
//   1. Navigate to /?page=login&prover=direct&mode=recovery
//   2. Click Google → OAuth round-trip → JWT
//   3. Fan-out parallel POST /get-salt to N institution salt-services
//   4. Merge per-institution salts via SHA-256
//   5. Compute zkLogin DID locally via jwtToAddress(jwt, merged_salt)
//   6. (Recovery flow stops here — auth.ts skips the prover request and the
//      bridge POST when ?mode=recovery is set.)
//
// Each trial's wall_login is measured by Playwright as
//   click "Login with Google"  →  "Logged in as <user>" toast
// which now precisely brackets {OAuth + salt fan-out + DID derivation}.
//
// The experiment writes a single CSV per N value, with one row per trial,
// for downstream analysis of how recovery latency scales with institution
// count under a real cross-region salt-custodian topology.
//
// Usage:
//   node run-did-recovery-bench.mjs --runs=30
//   node run-did-recovery-bench.mjs --runs=30 --institutions-list=3,5,7,9,11

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
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch { return ""; }
}

async function preflight(opts) {
  const bridge = makeBridge(opts.bridge);
  try { await bridge.getHealth(); }
  catch (e) {
    throw new Error(`Bridge not reachable at ${opts.bridge}: ${e?.message}`);
  }
  try {
    const r = await fetch(opts.frontend);
    if (!r.ok) throw new Error(`vite ${r.status}`);
  } catch (e) {
    throw new Error(`Frontend not reachable at ${opts.frontend}: ${e?.message}`);
  }
  return { bridge };
}

async function main() {
  const opts = parseArgs();
  // Custom flag: --institutions-list=3,5,7,9,11
  const listArg = process.argv.find(a => a.startsWith("--institutions-list="));
  const institutionsList = listArg
    ? listArg.split("=")[1].split(",").map(Number).filter(n => n >= 1 && n <= 11)
    : [3, 5, 7, 9, 11];
  const runs = opts.runs;

  console.log(`[recovery-bench] config:`, { ...opts, institutionsList });
  const { bridge } = await preflight(opts);
  const env = { gitCommit: gitCommit() };

  // ─────────── Browser setup (one persistent context for the whole sweep) ───────────
  console.log(`[recovery-bench] launching browser (headless=${opts.headless})`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  let page = browser.pages()[0] || await browser.newPage();
  try {
    await ensureGoogleLoggedIn(page, opts.frontend);
  } catch (e) {
    console.error(`[recovery-bench] FATAL: ensureGoogleLoggedIn failed: ${e?.message}`);
    await browser.close();
    process.exit(2);
  }

  // ─────────── Sweep across N institutions ───────────
  for (const N of institutionsList) {
    const outfile = path.join(__dirname, "results",
      `${new Date().toISOString().replace(/[:.]/g, "-")}_recovery_N${N}_runs${runs}.csv`);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    console.log(`\n[recovery-bench] ════ N=${N} institutions, ${runs} trials ════`);
    console.log(`[recovery-bench] CSV → ${outfile}`);

    // Seed salt cache state — recovery experiment uses cache=none (fetch from
    // remote) so that the salt phase exercises the real cross-region path.
    await bridge.clearSession();
    const state = await buildCacheState("none", N);
    await bridge.saveSaltSeeds(state);

    for (let i = 0; i < runs; i++) {
      const tag = `${i + 1}/${runs}`;
      console.log(`[recovery-bench] N=${N} run ${tag}`);

      // Close & reopen page for full per-trial isolation (matches --warm=false
      // semantics of the headline experiment); chrome profile / Google cookie
      // persist, but in-page sessionStorage and localStorage are fresh.
      try { await page.close(); } catch {}
      page = await browser.newPage();

      const runStart = Date.now();
      let result = null, error = null;
      try {
        result = await runSingleExperiment({
          page, bridge,
          frontend:    opts.frontend,
          op:          "did",                 // op is irrelevant in recovery mode (we exit before any /op call)
          institutions: N,
          proverMode:  "direct",
          recovery:    true,                  // ← THE FLAG that makes auth.ts skip prover + bridge POST
          onLog:       (m) => process.stdout.write(`  · ${m}\n`),
        });
        console.log(`[recovery-bench] N=${N} ${tag} OK  wall_login=${result.wall.loginMs}ms`);
      } catch (e) {
        error = e?.message || String(e);
        console.error(`[recovery-bench] N=${N} ${tag} FAILED: ${error}`);
        try { await page.screenshot({
          path: path.join(__dirname, "results", `recovery-N${N}-run${i}-failed.png`),
          fullPage: true,
        }); } catch {}
      }

      const record = {
        runId:     i,
        timestamp: new Date(runStart).toISOString(),
        config:    { ...opts, institutions: N, tag: `recovery_N${N}_${opts.tag || "30"}` },
        wall:      result?.wall,
        browser:   result?.browser,
        backend:   null,                     // recovery flow has no backend phase
        env, error,
      };
      appendCsv(outfile, [flattenRun(record)]);

      if (i < runs - 1 && opts.sleepBetween > 0) {
        await new Promise((r) => setTimeout(r, opts.sleepBetween));
      }
    }

    // Per-N summary
    const rows = parseCsvSimple(outfile);
    const ok = rows.filter((r) => r.success === "1");
    if (ok.length) {
      const pick = (key) => ok.map((r) => Number(r[key])).filter(Number.isFinite);
      console.log(`[recovery-bench] N=${N} summary (n=${ok.length}):`);
      for (const [k, label] of [
        ["wall_login_ms",   "wall_login (click→toast)"],
        ["oauth_rtt_ms",    "  oauth_rtt"],
        ["salt_ms",         "  salt fetch (parallel fan-out)"],
        ["prover_ms",       "  prover (should be 0)"],
        ["bridge_post_ms",  "  bridge_post (should be 0)"],
      ]) {
        const s = summarize(pick(k));
        console.log(`  ${label.padEnd(34)} n=${s.n}  mean=${s.mean}  p50=${s.p50}  p95=${s.p95}  min=${s.min}  max=${s.max}`);
      }
    }
  }

  await browser.close();
  console.log(`\n[recovery-bench] sweep complete.`);
}

// Tiny CSV parser, only used for per-N inline summary
function parseCsvSimple(path) {
  const text = fs.readFileSync(path, "utf-8");
  const lines = text.split("\n").filter((l) => l.length);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const f = line.split(",");
    const o = {};
    headers.forEach((h, i) => o[h] = f[i] || "");
    return o;
  });
}

main().catch((e) => { console.error("[recovery-bench] fatal:", e); process.exit(1); });
