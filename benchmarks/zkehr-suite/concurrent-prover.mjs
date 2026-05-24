#!/usr/bin/env node
// experiments/concurrent-prover.mjs
//
// Concurrent load test against the Mysten zkLogin ZK prover.
// Designed to run on EC2 us-east-1 (co-located with the prover) so network
// variance is minimal — the number measured reflects Mysten's compute capacity,
// not cross-WAN latency.
//
// Methodology:
//   - Load a fixture from .zk-session.json (a recent successful login)
//   - Replay the SAME proverBody at varying concurrency levels C ∈ {1,2,3,5,10,20}
//   - Duration 60s per level, 15s cooldown between levels
//   - Per-request latency, status, error classification
//
// Since the prover is stateless and idempotent w.r.t. its inputs, replaying
// the same body is a valid load test — each call still does a full Groth16
// proof, server-side.
//
// CLI:
//   node concurrent-prover.mjs [--fixture=/path/to/.zk-session.json]
//                              [--levels=1,2,3,5,10,20]
//                              [--duration=60]
//                              [--cooldown=15]
//                              [--max-requests=1000]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getExtendedEphemeralPublicKey } from "@mysten/sui/zklogin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default fixture path: .zk-session.json lives in the backend dir
const DEFAULT_FIXTURE = path.resolve(__dirname, "../../prototype/backend/.zk-session.json");

function parseArgs() {
  const a = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--?([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] ?? "true";
  }
  return {
    fixture: a.fixture || DEFAULT_FIXTURE,
    levels: (a.levels || "1,2,3,5,10,20").split(",").map(Number),
    duration: Number(a.duration || 60),
    cooldown: Number(a.cooldown || 15),
    maxRequests: Number(a["max-requests"] || 1000),
    proverUrl: a["prover-url"] || "https://prover-dev.mystenlabs.com/v1",
    tag: a.tag || "",
    outfile: a.outfile || path.join(
      __dirname, "results",
      `concurrent-prover-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
    ),
  };
}

/* ----------------- fixture loading + validation ----------------- */
function toStdB64(u8) { return Buffer.from(u8).toString("base64"); }

function decodeJwtPayload(jwt) {
  const b64 = String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
}

// Mirror veramo-to-sui.js parseEphemeralSecretKey
function parseEphemeralSecretKey(input) {
  if (typeof input === "string") {
    const { secretKey } = decodeSuiPrivateKey(input);
    return secretKey;
  }
  throw new Error("unexpected ephemeral key format: " + typeof input);
}

// Randomness normalization: session file may have it as decimal string or base64.
// Mysten prover accepts either a 16-byte base64 string OR a decimal string
// (which it internally pads to 16 bytes).  We forward whatever we have.
function normalizeRandomness(s) {
  if (typeof s !== "string" || !s) throw new Error("JWT_RANDOMNESS missing");
  // If it looks like pure decimal, pass through; prover handles.
  // If it's base64-ish, pass through too.
  return s;
}

async function buildProverBody(session) {
  const secretBytes = parseEphemeralSecretKey(session.EPHEMERAL_PRIVATE_KEY);
  const kp = Ed25519Keypair.fromSecretKey(secretBytes);
  const extAny = getExtendedEphemeralPublicKey(kp.getPublicKey());
  const extendedB64 = extAny instanceof Uint8Array
    ? toStdB64(extAny)
    : String(extAny);

  return {
    jwt: String(session.GOOGLE_ID_TOKEN),
    extendedEphemeralPublicKey: extendedB64,
    maxEpoch: String(session.MAX_EPOCH),
    jwtRandomness: normalizeRandomness(session.JWT_RANDOMNESS),
    salt: String(session.USER_SALT),
    keyClaimName: "sub",
  };
}

async function validateFixture(fixturePath) {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `Fixture not found at ${fixturePath}.\n` +
      `Generate one by running one successful end-to-end flow:\n` +
      `  cd ~/zkdid-patient/experiments\n` +
      `  ./run-in-dcv.sh --op=did --institutions=3 --cache=all --runs=1 --headless=true\n` +
      `Then re-run this script.`,
    );
  }
  const session = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const required = ["GOOGLE_ID_TOKEN", "EPHEMERAL_PRIVATE_KEY", "JWT_RANDOMNESS", "MAX_EPOCH", "USER_SALT"];
  for (const k of required) {
    if (!session[k]) throw new Error(`fixture missing field: ${k}`);
  }
  const payload = decodeJwtPayload(session.GOOGLE_ID_TOKEN);
  const now = Math.floor(Date.now() / 1000);
  const expLeft = (payload.exp || 0) - now;
  if (expLeft < 60) {
    throw new Error(
      `JWT expired or nearly expired (exp in ${expLeft}s).\n` +
      `Re-run a successful login to refresh the fixture.`,
    );
  }
  console.log(`[fixture] OK`);
  console.log(`  jwt.sub:     ${payload.sub}`);
  console.log(`  jwt exp:     ${new Date(payload.exp * 1000).toISOString()} (${Math.floor(expLeft/60)} min left)`);
  console.log(`  MAX_EPOCH:   ${session.MAX_EPOCH}`);
  console.log(`  salt (prefix): ${String(session.USER_SALT).slice(0, 16)}…`);
  return session;
}

/* ----------------- worker ----------------- */
async function worker(workerId, deadline, ctx) {
  const rows = [];
  let seq = 0;
  while (Date.now() < deadline && ctx.totalSoFar.count < ctx.maxRequests) {
    ctx.totalSoFar.count++;
    const t0 = performance.now();
    let status = 0;
    let errKind = "";
    let bodyBytes = 0;
    try {
      const res = await fetch(ctx.proverUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ctx.bodyJson,
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      const text = await res.text();
      bodyBytes = text.length;
    } catch (e) {
      errKind = (e?.name || "fetch-error") + (e?.message ? ": " + e.message.slice(0, 80) : "");
    }
    const latency = +(performance.now() - t0).toFixed(3);
    rows.push({
      worker_id: workerId,
      req_seq: seq++,
      ts_ms: Date.now(),
      latency_ms: latency,
      status,
      success: status === 200 ? 1 : 0,
      body_bytes: bodyBytes,
      err_kind: errKind,
    });
  }
  return rows;
}

function pct(arr, q) {
  return arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null;
}

/* ----------------- per-level orchestrator ----------------- */
async function runLevel(C, ctx) {
  const deadline = Date.now() + ctx.duration * 1000;
  const counter = { count: 0 };
  const workerCtx = { ...ctx, totalSoFar: counter };
  const workers = [];
  for (let w = 0; w < C; w++) workers.push(worker(w, deadline, workerCtx));
  const rows = (await Promise.all(workers)).flat();

  const succ = rows.filter((r) => r.success);
  const lats = succ.map((r) => r.latency_ms).sort((a, b) => a - b);
  const statuses = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const errCounts = rows.filter((r) => r.err_kind).reduce((m, r) => { m[r.err_kind] = (m[r.err_kind] || 0) + 1; return m; }, {});
  const mean = lats.length ? lats.reduce((s, v) => s + v, 0) / lats.length : null;

  return {
    C,
    total: rows.length,
    successful: succ.length,
    throughput_rps: +(succ.length / ctx.duration).toFixed(3),
    mean: mean ? +mean.toFixed(1) : null,
    p50: pct(lats, 0.5),
    p95: pct(lats, 0.95),
    p99: pct(lats, 0.99),
    min: lats[0] ?? null,
    max: lats[lats.length - 1] ?? null,
    statuses,
    errCounts,
    rows,
  };
}

/* ----------------- CSV writer ----------------- */
function esc(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function appendRows(filePath, rows, meta) {
  const header = ["tag", "concurrency", "worker_id", "req_seq", "ts_ms", "latency_ms", "status", "success", "body_bytes", "err_kind"];
  const needHeader = !fs.existsSync(filePath);
  const buf = needHeader ? [header.map(esc).join(",")] : [];
  for (const r of rows) {
    buf.push(header.map((h) => {
      if (h === "tag") return esc(meta.tag);
      if (h === "concurrency") return esc(meta.C);
      return esc(r[h]);
    }).join(","));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, buf.join("\n") + "\n");
}

/* ----------------- main ----------------- */
async function main() {
  const opts = parseArgs();
  console.log("[bench] config:", opts);

  const session = await validateFixture(opts.fixture);
  const proverBody = await buildProverBody(session);
  const bodyJson = JSON.stringify(proverBody);
  console.log(`[fixture] prover body size: ${bodyJson.length} bytes`);

  // --- smoke: 1 request, verify 200 ---
  console.log(`\n[smoke] single prover call...`);
  const sm0 = performance.now();
  const smokeRes = await fetch(opts.proverUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
    signal: AbortSignal.timeout(30_000),
  });
  const smokeText = await smokeRes.text();
  const smokeMs = Math.round(performance.now() - sm0);
  console.log(`[smoke] HTTP ${smokeRes.status}, ${smokeText.length} bytes, ${smokeMs} ms`);
  if (!smokeRes.ok) {
    console.error(`[smoke] FAILED.  response body (first 300 chars):`);
    console.error(smokeText.slice(0, 300));
    process.exit(1);
  }
  console.log(`[smoke] OK — fixture produces a valid prover response.`);

  const ctx = {
    proverUrl: opts.proverUrl,
    bodyJson,
    duration: opts.duration,
    maxRequests: opts.maxRequests,
  };

  const summaries = [];
  for (const C of opts.levels) {
    console.log(`\n[bench] ─── concurrency C=${C} for ${opts.duration}s ───`);
    const r = await runLevel(C, ctx);
    summaries.push(r);
    appendRows(opts.outfile, r.rows, { tag: opts.tag, C });
    console.log(
      `[bench] C=${String(C).padStart(3)}  ` +
      `throughput=${String(r.throughput_rps).padStart(6)} rps  ` +
      `mean=${String(r.mean).padStart(5)}ms  ` +
      `p50=${String(r.p50).padStart(5)}  ` +
      `p95=${String(r.p95).padStart(5)}  ` +
      `p99=${String(r.p99).padStart(5)}  ` +
      `status=${JSON.stringify(r.statuses)}  ` +
      `(n=${r.total}, succ=${r.successful})`,
    );

    if (C !== opts.levels[opts.levels.length - 1]) {
      console.log(`[bench] cooldown ${opts.cooldown}s...`);
      await new Promise((r) => setTimeout(r, opts.cooldown * 1000));
    }
  }

  console.log("\n[bench] ═══ prover hockey stick summary ═══");
  console.log("  C  throughput(rps)   mean(ms)   p50    p95    p99    err%");
  console.log("-".repeat(70));
  for (const s of summaries) {
    const errPct = ((s.total - s.successful) / Math.max(1, s.total) * 100).toFixed(1);
    console.log(
      String(s.C).padStart(4) +
      String(s.throughput_rps).padStart(12) +
      "     " +
      String(s.mean).padStart(8) +
      String(s.p50).padStart(7) +
      String(s.p95).padStart(7) +
      String(s.p99).padStart(7) +
      "    " + errPct.padStart(5) + "%",
    );
  }
  console.log(`\n[bench] CSV: ${opts.outfile}`);
}

main().catch((e) => { console.error("[bench] fatal:", e); process.exit(1); });
