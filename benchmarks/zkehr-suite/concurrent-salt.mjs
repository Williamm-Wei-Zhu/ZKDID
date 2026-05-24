#!/usr/bin/env node
// experiments/concurrent-salt.mjs
//
// Concurrent load test for the salt-service fleet. Produces a latency-vs-
// concurrency + throughput-vs-concurrency data set for TSC-style figures.
//
// Designed to run ON THE EC2 HOST (localhost → localhost) so cross-WAN
// variance doesn't pollute the measurement. From Mac, set --host=<ec2-dns>.
//
// Workload:
//   - Fixed test JWT with numeric `sub` (salt-service's only check)
//   - N concurrent workers, each in a tight fetch loop for `--duration`
//   - Each request picks a random institution of 10 (round-robins all services)
//   - Records per-request latency + status
//
// For each concurrency level, outputs:
//   - Per-request rows → CSV
//   - Summary row (mean/p50/p95/p99/throughput/error-rate) → stdout
//
// CLI:
//   node concurrent-salt.mjs --levels=1,5,10,25,50,100 --duration=30 [--raise-limit]
//   node concurrent-salt.mjs --endpoint=/seed ...      # lighter workload baseline
//   node concurrent-salt.mjs --host=ec2-xx.aws.com ... # from Mac over WAN
//
// If --raise-limit is passed, the script first pm2-restarts all salt-inst-*
// processes with RATE_LIMIT_MAX=100000 so the built-in 60/min/IP limiter
// doesn't mask the intrinsic service capacity. Restored to default on exit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------- CLI -----------------
function parseArgs() {
  const a = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--?([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] ?? "true";
  }
  return {
    levels: (a.levels || "1,5,10,25,50,100").split(",").map(Number),
    duration: Number(a.duration || 30),            // seconds per level
    cooldown: Number(a.cooldown || 3),             // seconds between levels
    host: a.host || "localhost",
    endpoint: a.endpoint || "/get-salt",           // or /seed
    ports: (a.ports || "7001,7002,7003,7004,7005,7006,7007,7008,7009,7010").split(",").map(Number),
    raiseLimit: a["raise-limit"] === "true",
    rateLimitMax: Number(a["rate-limit-max"] || 100000),
    outfile: a.outfile || path.join(
      __dirname, "results",
      `concurrent-salt-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
    ),
    tag: a.tag || "",
  };
}

// ----------------- JWT -----------------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const JWT = `${b64url({ alg: "none", kid: "test" })}.${b64url({
  sub: "118134096909382810610",
  iss: "https://accounts.google.com",
  aud: "x",
})}.sig`;

// ----------------- pm2 helper (only used with --raise-limit) -----------------
function pm2RestartWithEnv(rateLimitMax) {
  console.log(`[rate-limit] pm2-restarting all salt-inst-* with RATE_LIMIT_MAX=${rateLimitMax}`);
  const r = spawnSync(
    "pm2",
    ["restart", "all", "--update-env"],
    {
      encoding: "utf-8",
      env: { ...process.env, RATE_LIMIT_MAX: String(rateLimitMax) },
      timeout: 20_000,
    },
  );
  if (r.status !== 0) {
    console.warn("[rate-limit] pm2 restart warning:", (r.stderr || "").slice(0, 200));
  }
  // Wait for services to come back online
  console.log("[rate-limit] waiting for salt-services to come back...");
  return new Promise((resolve) => setTimeout(resolve, 3000));
}

async function pingSalt(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

// ----------------- worker -----------------
async function worker(workerId, deadline, ctx) {
  const rows = [];
  const { host, ports, endpoint } = ctx;
  let reqCount = 0;
  while (Date.now() < deadline) {
    const port = ports[Math.floor(Math.random() * ports.length)];
    const t0 = performance.now();
    let status = 0;
    let errKind = "";
    try {
      const init = endpoint === "/get-salt"
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jwt: JWT }) }
        : { method: "GET" };
      const res = await fetch(`http://${host}:${port}${endpoint}`, init);
      status = res.status;
      await res.text(); // drain body; critical for connection reuse
    } catch (e) {
      errKind = e?.name || "fetch-error";
    }
    const latency = +(performance.now() - t0).toFixed(3);
    rows.push({
      worker_id: workerId,
      req_seq: reqCount++,
      ts_ms: Date.now(),
      port,
      latency_ms: latency,
      status,
      success: status === 200 ? 1 : 0,
      err_kind: errKind,
    });
  }
  return rows;
}

// ----------------- per-level orchestrator -----------------
async function runLevel(C, ctx) {
  const deadline = Date.now() + ctx.duration * 1000;
  const promises = [];
  for (let w = 0; w < C; w++) promises.push(worker(w, deadline, ctx));
  const allRows = (await Promise.all(promises)).flat();

  // summary
  const succ = allRows.filter((r) => r.success);
  const latencies = succ.map((r) => r.latency_ms).sort((a, b) => a - b);
  const pct = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null;
  const mean = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : null;
  const errCounts = allRows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});

  return {
    C,
    total_requests: allRows.length,
    successful: succ.length,
    throughput_rps: +(succ.length / ctx.duration).toFixed(2),
    latency_mean: mean != null ? +mean.toFixed(3) : null,
    latency_p50: pct(0.5),
    latency_p95: pct(0.95),
    latency_p99: pct(0.99),
    latency_min: latencies[0] ?? null,
    latency_max: latencies[latencies.length - 1] ?? null,
    status_counts: errCounts,
    rows: allRows,
  };
}

// ----------------- CSV writer -----------------
function esc(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeRows(filePath, rows, opts) {
  const header = [
    "tag", "concurrency", "endpoint", "worker_id", "req_seq", "ts_ms",
    "port", "latency_ms", "status", "success", "err_kind",
  ];
  const needHeader = !fs.existsSync(filePath);
  const buf = needHeader ? [header.map(esc).join(",")] : [];
  for (const r of rows) {
    buf.push(header.map((h) => {
      if (h === "tag") return esc(opts.tag);
      if (h === "concurrency") return esc(opts.C);
      if (h === "endpoint") return esc(opts.endpoint);
      return esc(r[h]);
    }).join(","));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, buf.join("\n") + "\n");
}

// ----------------- main -----------------
async function main() {
  const opts = parseArgs();
  console.log("[bench] config:", opts);

  // Preflight: all salt-services healthy?
  const pings = await Promise.all(opts.ports.map((p) => pingSalt(opts.host, p)));
  const down = opts.ports.filter((_, i) => !pings[i]);
  if (down.length) {
    console.error(`[bench] ${down.length} salt-services unreachable: ${down.join(",")}`);
    process.exit(1);
  }
  console.log(`[bench] all ${opts.ports.length} salt-services responding`);

  // Optionally raise rate limit so we measure intrinsic capacity, not the limiter
  if (opts.raiseLimit) {
    await pm2RestartWithEnv(opts.rateLimitMax);
    // re-verify after restart
    const pings2 = await Promise.all(opts.ports.map((p) => pingSalt(opts.host, p)));
    const down2 = opts.ports.filter((_, i) => !pings2[i]);
    if (down2.length) {
      console.error("[bench] salt-services didn't come back up:", down2);
      process.exit(1);
    }
    console.log(`[bench] rate limit raised to ${opts.rateLimitMax}/min, services healthy`);
  }

  // Warm-up: one request per port to prime connection pool + Poseidon
  console.log("[bench] warm-up...");
  await Promise.all(opts.ports.map((p) => fetch(`http://${opts.host}:${p}/get-salt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: JWT }),
  }).catch(() => null)));

  const summaries = [];
  for (const C of opts.levels) {
    console.log(`\n[bench] ─── concurrency C=${C} for ${opts.duration}s ───`);
    const result = await runLevel(C, opts);
    summaries.push(result);
    // persist rows
    writeRows(opts.outfile, result.rows, { tag: opts.tag, C, endpoint: opts.endpoint });
    // print summary line
    console.log(
      `[bench] C=${C.toString().padStart(3)}  ` +
      `throughput=${result.throughput_rps.toString().padStart(7)} rps  ` +
      `lat mean=${String(result.latency_mean).padStart(7)}ms  ` +
      `p50=${String(result.latency_p50).padStart(5)}ms  ` +
      `p95=${String(result.latency_p95).padStart(6)}ms  ` +
      `p99=${String(result.latency_p99).padStart(6)}ms  ` +
      `status=${JSON.stringify(result.status_counts)}  ` +
      `(n=${result.total_requests}, succ=${result.successful})`,
    );

    if (C !== opts.levels[opts.levels.length - 1]) {
      await new Promise((r) => setTimeout(r, opts.cooldown * 1000));
    }
  }

  // Final per-level summary table
  console.log("\n[bench] ═══ final hockey-stick data ═══");
  console.log("C      throughput(rps)  mean_ms   p50     p95     p99     err%");
  console.log("-".repeat(75));
  for (const s of summaries) {
    const errPct = ((s.total_requests - s.successful) / Math.max(1, s.total_requests) * 100).toFixed(1);
    console.log(
      String(s.C).padStart(4) + "   " +
      String(s.throughput_rps).padStart(10) + "     " +
      String(s.latency_mean).padStart(7) + "  " +
      String(s.latency_p50).padStart(6) + "  " +
      String(s.latency_p95).padStart(6) + "  " +
      String(s.latency_p99).padStart(6) + "    " +
      errPct.padStart(4) + "%",
    );
  }

  // Restore rate limit if we changed it
  if (opts.raiseLimit) {
    console.log("\n[bench] restoring default rate limit (RATE_LIMIT_MAX=60)...");
    await pm2RestartWithEnv(60);
  }
  console.log(`\n[bench] CSV: ${opts.outfile}`);
}

main().catch((e) => { console.error("[bench] fatal:", e); process.exit(1); });
