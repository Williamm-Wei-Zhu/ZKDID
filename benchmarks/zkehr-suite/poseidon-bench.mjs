#!/usr/bin/env node
// experiments/poseidon-bench.mjs
//
// Micro-benchmark: measure the cost of `poseidonSaltFromSeed(seed, sub)`
// in the browser across N consecutive calls. The first call pays
// `buildPoseidon()` cold-init (~150-250 ms on a warm EC2 host), the rest are
// pure field arithmetic (~1-2 ms).
//
// The benchmark runs INSIDE the already-served Login page (http://localhost:1234)
// so the same module singleton you'd hit during a real zkLogin is exercised.
// No OAuth / prover / on-chain; this is a pure crypto primitive benchmark.
//
// Output: CSV with columns
//   call_index, latency_ms, is_cold, seed_hex, sub
//
// Usage (on EC2, any terminal — doesn't need DCV since no headed browser):
//   cd ~/zkdid-patient/experiments
//   node poseidon-bench.mjs --iterations=50 --repeats=10
//
// Flags:
//   --iterations=N   per-run calls (default 50)
//   --repeats=R      how many browser-page reloads to average over (default 10)
//                    Each repeat re-initializes buildPoseidon — giving R
//                    independent cold-init samples.
//   --headless=true  (default true — no display needed)
//   --outfile=...    (default results/poseidon-bench-<ts>.csv)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
const FRONTEND = process.env.FRONTEND_URL || "http://localhost:1234";

function parseArgs() {
  const a = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--?([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] ?? "true";
  }
  return {
    iterations: Number(a.iterations || 50),
    repeats: Number(a.repeats || 10),
    headless: (a.headless ?? "true").toLowerCase() === "true",
    outfile: a.outfile || path.join(
      __dirname,
      "results",
      `poseidon-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
    ),
  };
}

function esc(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const opts = parseArgs();
  console.log("[bench] config:", opts);
  fs.mkdirSync(path.dirname(opts.outfile), { recursive: true });

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    viewport: { width: 1024, height: 768 },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run"],
  });

  const allRows = [];

  for (let rep = 0; rep < opts.repeats; rep++) {
    // Fresh page per repeat -> fresh module singleton -> `buildPoseidon()`
    // runs again. This is exactly the condition a new browser tab hits.
    const page = await browser.newPage();
    await page.goto(`${FRONTEND}/?page=login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("button:has-text(\"Google\")", { timeout: 15_000 });

    const rows = await page.evaluate(async (N) => {
      // Dynamic import via Vite's served module — same path the real app uses.
      const mod = await import("/src/lib/localPoseidon.ts");
      const { poseidonSaltFromSeed } = mod;
      // Fixed sub so only seed varies across calls.
      const sub = 118134096909382810610n;
      const out = [];
      for (let i = 0; i < N; i++) {
        // Deterministic but distinct seed per call.
        const seed = (1n << 127n) + BigInt(i);
        const t0 = performance.now();
        await poseidonSaltFromSeed(seed, sub);
        const t1 = performance.now();
        out.push({
          call_index: i,
          latency_ms: +(t1 - t0).toFixed(3),
          is_cold: i === 0,
          seed_hex: "0x" + seed.toString(16),
          sub: sub.toString(),
        });
      }
      return out;
    }, opts.iterations);

    rows.forEach((r) => allRows.push({ repeat: rep, ...r }));
    console.log(
      `[bench] repeat ${rep + 1}/${opts.repeats}: cold=${rows[0].latency_ms}ms, ` +
      `warm(median of rest)=${[...rows.slice(1)].sort((a,b)=>a.latency_ms-b.latency_ms)[Math.floor((rows.length-1)/2)].latency_ms}ms`,
    );
    await page.close();
  }

  // Write CSV
  const header = ["repeat", "call_index", "latency_ms", "is_cold", "seed_hex", "sub"];
  const lines = [header.map(esc).join(",")];
  for (const r of allRows) lines.push(header.map((h) => esc(r[h])).join(","));
  fs.writeFileSync(opts.outfile, lines.join("\n") + "\n");
  console.log(`[bench] wrote ${allRows.length} rows → ${opts.outfile}`);

  // Summary
  const cold = allRows.filter((r) => r.is_cold).map((r) => r.latency_ms).sort((a, b) => a - b);
  const warm = allRows.filter((r) => !r.is_cold).map((r) => r.latency_ms).sort((a, b) => a - b);
  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  console.log("\n=== summary ===");
  console.log(`cold (first call per page,  n=${cold.length}): mean=${mean(cold).toFixed(1)}  p50=${pct(cold,0.5)}  p95=${pct(cold,0.95)}  min=${cold[0]}  max=${cold[cold.length-1]}`);
  console.log(`warm (2nd+ calls per page, n=${warm.length}): mean=${mean(warm).toFixed(2)} p50=${pct(warm,0.5)} p95=${pct(warm,0.95)} min=${warm[0]} max=${warm[warm.length-1]}`);
  console.log(`\ncold/warm ratio ≈ ${(mean(cold) / mean(warm)).toFixed(0)}x`);

  await browser.close();
}

main().catch((e) => { console.error("[bench] fatal:", e); process.exit(1); });
