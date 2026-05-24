#!/usr/bin/env node
// experiments/probe-prover.mjs
//
// Standalone probe: call Mysten's ZK prover N times from this Node process,
// using the EXACT same request body that veramo-to-sui.js builds, but with
// no Veramo / Sui-tx / Move overhead in the way.  Each iteration measures:
//
//   totalMs            wall time of fetch() round-trip
//   headerMs           start → response headers received
//   timeToFirstByteMs  start → first body byte
//   downloadMs         firstByte → end of body
//   bodyBytes          response body length
//
// Goal: cross-validate the in-process measurement we already see in
// veramo-to-sui.js — and prove that the ~2700 ms is owed to Mysten's
// server-side SNARK compute, not to any client-side artifact.
//
// Inputs: reads session fields from $REPO/zkdid/.zk-session.json
// Output: per-call timing line + summary stats at the end.
//
// Usage:
//   node experiments/probe-prover.mjs [N]   # default N=10

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getExtendedEphemeralPublicKey } from "@mysten/sui/zklogin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.resolve(__dirname, "../../prototype/backend/.zk-session.json");
const CONFIG_PATH  = path.resolve(__dirname, "../../prototype/frontend/src/config.json");

const N = Number(process.argv[2] || 10);

function toStdBase64(input) {
  if (input instanceof Uint8Array) return Buffer.from(input).toString("base64");
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return Buffer.from(input).toString("base64");
  throw new Error(`toStdBase64: unsupported type ${typeof input}`);
}

// Reuse veramo-to-sui.js's randomness handling: it accepts bytes16 base64
// directly. Here we just trust whatever the session file has.
function readSession() {
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
  const required = ["GOOGLE_ID_TOKEN", "EPHEMERAL_PRIVATE_KEY", "JWT_RANDOMNESS", "MAX_EPOCH", "USER_SALT"];
  for (const k of required) {
    if (!session[k]) throw new Error(`session missing field: ${k}`);
  }
  return session;
}

function readProverUrl() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!cfg.URL_ZK_PROVER) throw new Error("config.json missing URL_ZK_PROVER");
  return cfg.URL_ZK_PROVER;
}

function buildProverBody(session) {
  // Restore ephemeral keypair from base64 (veramo-to-sui.js parseEphemeralSecretKey shape)
  const sk = session.EPHEMERAL_PRIVATE_KEY;
  const { secretKey } = decodeSuiPrivateKey(sk);
  const eph = Ed25519Keypair.fromSecretKey(secretKey);

  // Extended pubkey in base64 (33 bytes)
  const ext = getExtendedEphemeralPublicKey(eph.getPublicKey());
  const extB64 = ext instanceof Uint8Array ? Buffer.from(ext).toString("base64") : String(ext);

  return {
    jwt: String(session.GOOGLE_ID_TOKEN),
    extendedEphemeralPublicKey: extB64,
    maxEpoch: String(session.MAX_EPOCH),
    jwtRandomness: String(session.JWT_RANDOMNESS),
    salt: String(session.USER_SALT),
    keyClaimName: "sub",
  };
}

async function callProverOnce(url, bodyJson) {
  const fetchStart = performance.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
  });
  const afterHeaders = performance.now();

  // Stream body regardless of status — we still want to time 4xx responses.
  let firstByteAt = null;
  let bodyBuffer = Buffer.alloc(0);
  if (resp.body?.getReader) {
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null) firstByteAt = performance.now();
      if (value) bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(value)]);
    }
  } else {
    const ab = await resp.arrayBuffer();
    bodyBuffer = Buffer.from(ab);
    firstByteAt = afterHeaders;
  }
  const fetchEnd = performance.now();

  return {
    totalMs:            Math.round(fetchEnd - fetchStart),
    headerMs:           Math.round(afterHeaders - fetchStart),
    timeToFirstByteMs:  Math.round((firstByteAt ?? afterHeaders) - fetchStart),
    downloadMs:         Math.round(fetchEnd - (firstByteAt ?? afterHeaders)),
    bodyBytes:          bodyBuffer.length,
    statusCode:         resp.status,
    bodySnippet:        resp.ok ? null : bodyBuffer.toString("utf-8").slice(0, 80),
  };
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function mean(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0; }

async function main() {
  const session  = readSession();
  const proverUrl = readProverUrl();
  const proverBody = buildProverBody(session);
  const bodyJson = JSON.stringify(proverBody);

  console.log(`[probe-prover] url    = ${proverUrl}`);
  console.log(`[probe-prover] body   = ${bodyJson.length} bytes`);
  console.log(`[probe-prover] runs   = ${N} (sequential)`);
  console.log(`[probe-prover] sub    = ${proverBody.jwt.split(".").length === 3 ? "(JWT shape OK)" : "(JWT shape WEIRD)"}`);
  console.log("");
  console.log(`run  total  header   TTFB  downl  bytes  http  note`);
  console.log(`---  -----  ------  -----  -----  -----  ----  --------`);

  const successTotals = [], successTtfbs = [];
  const failTotals    = [], failTtfbs    = [];
  for (let i = 0; i < N; i++) {
    try {
      const r = await callProverOnce(proverUrl, bodyJson);
      const ok = r.statusCode >= 200 && r.statusCode < 300;
      if (ok) { successTotals.push(r.totalMs); successTtfbs.push(r.timeToFirstByteMs); }
      else    { failTotals.push(r.totalMs);    failTtfbs.push(r.timeToFirstByteMs); }
      console.log(
        `${String(i + 1).padStart(3)}  ${String(r.totalMs).padStart(5)}  ${String(r.headerMs).padStart(6)}  ${String(r.timeToFirstByteMs).padStart(5)}  ${String(r.downloadMs).padStart(5)}  ${String(r.bodyBytes).padStart(5)}  ${r.statusCode}  ${ok ? "OK" : (r.bodySnippet || "ERR")}`
      );
    } catch (e) {
      console.log(`${String(i + 1).padStart(3)}  EXCEPTION: ${e.message.slice(0, 100)}`);
    }
  }

  console.log("");
  console.log(`Summary: ${successTotals.length} success, ${failTotals.length} fail (4xx)`);
  if (successTotals.length) {
    console.log(`  SUCCESS (real proof): mean=${mean(successTotals)}  p50=${pct(successTotals,50)}  p95=${pct(successTotals,95)}  min=${Math.min(...successTotals)}  max=${Math.max(...successTotals)}`);
    console.log(`     of which TTFBms : mean=${mean(successTtfbs)}  p50=${pct(successTtfbs,50)}`);
  }
  if (failTotals.length) {
    console.log(`  FAIL (server reject): mean=${mean(failTotals)}  p50=${pct(failTotals,50)}  p95=${pct(failTotals,95)}  min=${Math.min(...failTotals)}  max=${Math.max(...failTotals)}`);
    console.log(`     of which TTFBms : mean=${mean(failTtfbs)}  p50=${pct(failTtfbs,50)}`);
    console.log(`  ⓘ A fail-time of ~50-300ms means Mysten REJECTS before SNARK compute.`);
    console.log(`    The (compute-only) lower-bound = success.totalMs - fail.totalMs.`);
  }
}

main().catch((e) => { console.error("[probe-prover] fatal:", e); process.exit(1); });
