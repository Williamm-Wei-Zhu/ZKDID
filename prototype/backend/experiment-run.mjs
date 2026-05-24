// experiment-run.mjs
// Runs 10 iterations of the "select 3 institutions → trigger VC op → clear" flow
// and emits a CSV + summary statistics. Reuses one real Google session for all
// iterations (Path C — forces cold caches between iterations without needing
// programmatic Google sign-in).
//
// What it measures PER iteration:
//   - fetch_salt_ms: wall-clock of POSTing to 3 institutions' /get-salt in parallel
//   - all 13 keys from .backend-timings.json (step 6.1b, 6.5, 6.6b, 8, etc.)
//   - op_wall_ms: total wall-clock the bridge took on /op/vc
//
// What it does to force cold state BETWEEN iterations:
//   - delete .jwks-cache.json (OAuth JWT cold)
//   - pm2 restart all (Poseidon cold for salt services)
//   - KEEPS .sui-gas-cache.json and .sui-balance-cache.json so step 6.5 reflects
//     realistic warm-gas behavior (deleting these just measures one-off RPC cost)
//
// Usage (on EC2):
//   node experiment-run.mjs
// Output:
//   stdout: human-readable progress + summary
//   ./experiment-results.csv: per-row CSV for further analysis

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ITERATIONS = 10
const BRIDGE = 'http://localhost:4317'
const SALT_INSTITUTION_PORTS = [7001, 7002, 7003]
const BACKEND_DIR = __dirname
const JWKS_CACHE = path.resolve(BACKEND_DIR, '.jwks-cache.json')
const SESSION_FILE = path.resolve(BACKEND_DIR, '.zk-session.json')
const CSV_OUT = path.resolve(__dirname, 'experiment-results.csv')

// All backend timing keys we care about, in the order they appear in a run.
const PHASE_KEYS = [
  '2_load_or_populate_zkLogin_session',
  '3_generate_zkLogin_DID_and_ephemeral_key',
  '4_issue_zkLogin_JWT_VC',
  '5_generate_full_zkLogin_DID_doc',
  '6_save_VC_to_dids_json',
  '6.1-3_restore_key+randomness+nonce_verify+address_seed',
  '6.1b_JWK_precheck',
  '6.4_request_Prover',
  '6.4b_request_Faucet',
  '6.5_build_and_sign_Move_tx',
  '6.6a_assemble_zkLogin_signature',
  '6.6b_submit_tx_and_return',
  '8_query_chain_and_update_DID_doc',
]

function log(s) { console.log(`[exp] ${s}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function jsonFetch(url, opts = {}) {
  const resp = await fetch(url, opts)
  const text = await resp.text()
  let j = null; try { j = JSON.parse(text) } catch {}
  return { ok: resp.ok, status: resp.status, json: j, text }
}

/** Read the session's JWT so we can POST it to /get-salt. */
function loadSessionJwt() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
    return s.GOOGLE_ID_TOKEN || null
  } catch { return null }
}

/** Force cold state between iterations. Preserves gas/balance caches. */
async function forceCold() {
  // Delete JWKS cache so OAuth JWT (step 6.1b) shows a real cold fetch.
  try { fs.rmSync(JWKS_CACHE, { force: true }) } catch {}

  // PM2 restart all — brings Poseidon cold in every salt-service process.
  // Uses restart (not reload) because salt-service is fork-mode; reload is a
  // SIGUSR2 no-op on non-cluster processes.
  const r = spawnSync('pm2', ['restart', 'all'], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) throw new Error(`pm2 restart failed: ${r.stderr || r.stdout}`)

  // Wait a moment for PM2 children to fully listen on their ports again.
  await sleep(1500)
}

/** Time the 3-institution parallel salt fetch as the browser would see it. */
async function timeSaltFetch(jwt) {
  const t0 = performance.now()
  const results = await Promise.all(
    SALT_INSTITUTION_PORTS.map((port) =>
      jsonFetch(`http://localhost:${port}/get-salt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt }),
      }).catch((e) => ({ ok: false, error: String(e?.message || e) }))
    )
  )
  const wallMs = Math.round(performance.now() - t0)
  // Per-institution server-reported times (from the body's computeMs field).
  const perInstServer = results.map((r, i) => ({
    port: SALT_INSTITUTION_PORTS[i],
    ok: r.ok,
    serverMs: r.ok && r.json?.computeMs != null ? r.json.computeMs : null,
  }))
  return { wallMs, perInstServer, allOk: results.every(r => r.ok) }
}

/** Fire /op/vc, block until bridge returns with timings payload. */
async function runVcOp() {
  const t0 = performance.now()
  const r = await jsonFetch(`${BRIDGE}/op/vc`, { method: 'POST' })
  const wallMs = Math.round(performance.now() - t0)
  if (!r.ok) throw new Error(`op/vc returned ${r.status}: ${r.text.slice(0, 200)}`)
  if (!r.json?.ok) throw new Error(`op/vc ok=false: ${JSON.stringify(r.json)}`)
  return { wallMs, timings: r.json.timings?.timings || {}, status: r.json.timings?.status }
}

async function preflight() {
  // Session check — won't bother running the experiment if we can't even do one op.
  const s = await jsonFetch(`${BRIDGE}/session`)
  if (!s.ok || !s.json?.hasSession || s.json?.expired) {
    throw new Error('no valid session on EC2. Log in via browser first, then re-run.')
  }
  const jwt = loadSessionJwt()
  if (!jwt) throw new Error('.zk-session.json missing GOOGLE_ID_TOKEN')
  log(`session ok (provider=${s.json.provider}, remainingEpochs=${s.json.remainingEpochs})`)
  return jwt
}

function summarizeColumn(values) {
  const nums = values.filter(v => typeof v === 'number' && !Number.isNaN(v))
  if (!nums.length) return { n: 0 }
  nums.sort((a, b) => a - b)
  const sum = nums.reduce((a, b) => a + b, 0)
  const mean = sum / nums.length
  const variance = nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length
  const stddev = Math.sqrt(variance)
  const pct = (p) => nums[Math.min(nums.length - 1, Math.floor((p / 100) * nums.length))]
  return {
    n: nums.length, min: nums[0], max: nums[nums.length - 1],
    mean: Math.round(mean * 10) / 10,
    stddev: Math.round(stddev * 10) / 10,
    p50: pct(50), p95: pct(95),
  }
}

async function main() {
  log(`starting: ${ITERATIONS} iterations`)
  const jwt = await preflight()

  const rows = []
  const columnsNumeric = ['fetch_salt_wall_ms', 'op_wall_ms', ...PHASE_KEYS.map(k => `phase_${k}`)]

  for (let i = 1; i <= ITERATIONS; i++) {
    log(`── iteration ${i}/${ITERATIONS} ──`)

    // STEP 1: force cold state
    log('  forceCold() — delete JWKS cache, pm2 restart all')
    await forceCold()

    // STEP 2: time salt fetch (3 institutions in parallel)
    log('  timing salt fetch (3 institutions)')
    const salt = await timeSaltFetch(jwt)
    log(`    wall=${salt.wallMs}ms  perInstServerMs=${salt.perInstServer.map(p => p.serverMs).join(',')}  allOk=${salt.allOk}`)

    // STEP 3: run /op/vc, block for result + timings payload
    log('  POST /op/vc (blocking, returns per-phase timings)')
    let op
    try { op = await runVcOp() } catch (e) {
      log(`    ⚠️ op failed: ${e.message}`)
      rows.push({ iter: i, error: e.message })
      continue
    }
    log(`    wall=${op.wallMs}ms  status=${op.status}  step6.1b=${op.timings['6.1b_JWK_precheck']}ms  step6.5=${op.timings['6.5_build_and_sign_Move_tx']}ms  step8=${op.timings['8_query_chain_and_update_DID_doc']}ms`)

    // STEP 4: record row
    const row = {
      iter: i,
      fetch_salt_wall_ms: salt.wallMs,
      salt_inst_server_ms: salt.perInstServer.map(p => p.serverMs).join('|'),
      op_wall_ms: op.wallMs,
      op_status: op.status,
    }
    for (const k of PHASE_KEYS) row[`phase_${k}`] = op.timings[k] ?? null
    rows.push(row)

    // STEP 5: small pause so the .backend-timings.json write is fully flushed
    // before the next iteration's forceCold (shouldn't matter, safety cushion).
    await sleep(500)
  }

  // --- Emit CSV ---
  const headers = ['iter', 'fetch_salt_wall_ms', 'salt_inst_server_ms', 'op_wall_ms', 'op_status',
    ...PHASE_KEYS.map(k => `phase_${k}`)]
  const csvLines = [headers.join(',')]
  for (const r of rows) {
    if (r.error) {
      csvLines.push([r.iter, 'ERROR', r.error].join(','))
      continue
    }
    csvLines.push(headers.map(h => {
      const v = r[h]
      if (v == null) return ''
      const s = String(v)
      return s.includes(',') ? `"${s}"` : s
    }).join(','))
  }
  fs.writeFileSync(CSV_OUT, csvLines.join('\n') + '\n')
  log(`CSV written: ${CSV_OUT}`)

  // --- Summary ---
  console.log('\n========== SUMMARY (ms) ==========')
  console.log('column                                          n  min  p50  mean±sd    p95  max')
  console.log('-------------------------------------------------------------------------------------')
  for (const col of columnsNumeric) {
    const values = rows.filter(r => !r.error).map(r => r[col])
    const s = summarizeColumn(values)
    if (s.n === 0) { console.log(`  ${col.padEnd(46)}  -  (no data)`); continue }
    console.log(
      `  ${col.padEnd(46)}  ${String(s.n).padStart(2)}  ${String(s.min).padStart(4)}  ${String(s.p50).padStart(4)}  ` +
      `${String(s.mean).padStart(5)}±${String(s.stddev).padEnd(4)}  ${String(s.p95).padStart(4)}  ${String(s.max).padStart(4)}`
    )
  }
  console.log('========================================')
}

main().catch(e => { console.error('[exp] fatal:', e); process.exit(1) })
