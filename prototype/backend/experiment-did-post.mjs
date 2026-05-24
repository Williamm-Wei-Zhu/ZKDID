// experiment-did-post.mjs
// Runs 10 DID POST (/op/vc) iterations against the currently-live zkLogin
// session, forcing cold EC2-side caches between each one. No OAuth,
// no browser clicks, no human in the loop.
//
// Per iteration:
//   1. "lightweight reset" — delete .jwks-cache.json + pm2 restart all
//      (resets JWKS + Poseidon WASM). IMPORTANT: does NOT call /session/clear
//      because that would delete .zk-session.json and we'd lose the session.
//   2. POST /op/vc           — bridge blocks, runs backend, returns full
//      .backend-timings.json inline including phase timings + gas + storage.
//   3. Record row
//
// Output: stdout formatted tables + JSON dump.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = 'http://localhost:4317'
const ITERATIONS = 10

const BACKEND_DIR = __dirname
const JWKS_CACHE = path.resolve(BACKEND_DIR, '.jwks-cache.json')

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

function log(s) { console.log(`[did-exp] ${s}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function httpJson(method, p, body) {
  const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : undefined }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(BRIDGE + p, opts)
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  return { ok: r.ok, status: r.status, json, text }
}

/** Lightweight reset — forces JWKS + Poseidon cold but KEEPS the session file. */
async function lightweightColdReset() {
  try { fs.rmSync(JWKS_CACHE, { force: true }) } catch {}
  const r = spawnSync('pm2', ['restart', 'all'], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) throw new Error(`pm2 restart failed: ${r.stderr || r.stdout}`)
  await sleep(1500)  // let PM2 children finish starting so first request doesn't race
}

async function runVcOp() {
  const t0 = performance.now()
  const r = await httpJson('POST', '/op/vc')
  const wallMs = Math.round(performance.now() - t0)
  if (r.status !== 200 || !r.json?.ok) {
    throw new Error(`op/vc failed: HTTP ${r.status} ${r.json?.error || r.text.slice(0, 200)}`)
  }
  return { wallMs, timings: r.json.timings }
}

function fmt(n, w = 5) {
  if (n == null || Number.isNaN(n)) return '-'.padStart(w)
  return String(n).padStart(w)
}

async function main() {
  // Preflight: session must exist and be valid.
  const s = await httpJson('GET', '/session')
  if (!s.json?.hasSession || s.json?.expired) {
    throw new Error('no valid session on EC2; log in via browser first.')
  }
  log(`session ok — user=${s.json.jwtClaims?.email} remainingEpochs=${s.json.remainingEpochs}`)
  log(`running ${ITERATIONS} DID POST iterations with cold-cache reset between each`)
  log('')

  const rows = []
  for (let i = 1; i <= ITERATIONS; i++) {
    log(`── iteration ${i}/${ITERATIONS} ──`)

    log('  [reset] pm2 restart all + delete JWKS cache')
    await lightweightColdReset()

    log('  [op/vc] POST — blocks for full timings')
    let run
    try { run = await runVcOp() } catch (e) {
      log(`  ❌ ${e.message}`)
      rows.push({ iter: i, error: e.message })
      continue
    }

    const t = run.timings
    const timings = t.timings || {}
    const gas = t.gasReport || null
    const storage = Array.isArray(t.storageReport) ? t.storageReport : []

    log(`  ✅ wall=${run.wallMs}ms  step6.1b=${timings['6.1b_JWK_precheck']}ms  step6.5=${timings['6.5_build_and_sign_Move_tx']}ms  step6.6b=${timings['6.6b_submit_tx_and_return']}ms  step8=${timings['8_query_chain_and_update_DID_doc']}ms`)
    if (gas) log(`     gas net=${gas.netGasMist} MIST  storage=${storage[0]?.bcsBytes ?? '?'} bytes  digest=${String(t.digest || '').slice(0, 12)}…`)

    rows.push({
      iter: i,
      wallMs: run.wallMs,
      status: t.status,
      digest: t.digest,
      timings,
      gasReport: gas,
      storageReport: storage,
    })

    await sleep(400)  // let .backend-timings.json write settle before next pm2 restart
  }

  // ─── Table 1: phase timings ───
  console.log('\n' + '='.repeat(95))
  console.log('           BACKEND PHASE TIMINGS (ms) per DID POST iteration')
  console.log('='.repeat(95))
  const shortNames = {
    '2_load_or_populate_zkLogin_session': 's2',
    '3_generate_zkLogin_DID_and_ephemeral_key': 's3',
    '4_issue_zkLogin_JWT_VC': 's4',
    '5_generate_full_zkLogin_DID_doc': 's5',
    '6_save_VC_to_dids_json': 's6',
    '6.1-3_restore_key+randomness+nonce_verify+address_seed': 's6.1-3',
    '6.1b_JWK_precheck': 's6.1b',
    '6.4_request_Prover': 's6.4',
    '6.4b_request_Faucet': 's6.4b',
    '6.5_build_and_sign_Move_tx': 's6.5',
    '6.6a_assemble_zkLogin_signature': 's6.6a',
    '6.6b_submit_tx_and_return': 's6.6b',
    '8_query_chain_and_update_DID_doc': 's8',
  }
  const hdr = ['iter', 'wall', ...PHASE_KEYS.map(k => shortNames[k])]
  console.log(hdr.map(h => h.padStart(7).slice(0, 7)).join(' '))
  console.log('-'.repeat(hdr.length * 8))
  for (const r of rows) {
    if (r.error) { console.log(`${fmt(r.iter, 7)}  ERROR: ${r.error}`); continue }
    const row = [
      fmt(r.iter, 7),
      fmt(r.wallMs, 7),
      ...PHASE_KEYS.map(k => fmt(r.timings[k], 7)),
    ]
    console.log(row.join(' '))
  }

  // ─── Table 2: gas & storage ───
  console.log('\n' + '='.repeat(85))
  console.log('           GAS & STORAGE per DID POST iteration')
  console.log('='.repeat(85))
  console.log('iter  netGas_MIST       netGas_SUI       bcs_bytes  digest')
  console.log('-'.repeat(80))
  for (const r of rows) {
    if (r.error) continue
    const g = r.gasReport?.netGasMist ?? 0
    const sui = (g / 1e9).toFixed(9)
    const bytes = r.storageReport?.[0]?.bcsBytes ?? '?'
    const dig = r.digest ? r.digest.slice(0, 12) + '…' : '-'
    console.log(`${fmt(r.iter, 4)}  ${String(g).padStart(12)}  ${sui.padStart(13)}       ${String(bytes).padStart(6)}  ${dig}`)
  }

  // ─── Summary statistics ───
  console.log('\n' + '='.repeat(78))
  console.log('           SUMMARY (successful iterations)')
  console.log('='.repeat(78))
  const done = rows.filter(r => !r.error)
  function summarize(values) {
    const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b)
    if (!v.length) return null
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const p50 = v[Math.floor(v.length / 2)]
    return { n: v.length, min: v[0], p50, mean: Math.round(mean), max: v[v.length - 1] }
  }
  const metrics = [
    ['wall', done.map(r => r.wallMs)],
    ['s6.1b JWK precheck (cold)', done.map(r => r.timings['6.1b_JWK_precheck'])],
    ['s6.5 build & sign tx', done.map(r => r.timings['6.5_build_and_sign_Move_tx'])],
    ['s6.6b submit & return', done.map(r => r.timings['6.6b_submit_tx_and_return'])],
    ['s8 query chain & DID', done.map(r => r.timings['8_query_chain_and_update_DID_doc'])],
    ['netGas (MIST)', done.map(r => r.gasReport?.netGasMist)],
    ['storage (bytes)', done.map(r => r.storageReport?.[0]?.bcsBytes)],
  ]
  console.log('metric                                 n    min    p50   mean    max')
  console.log('-'.repeat(70))
  for (const [name, vals] of metrics) {
    const s = summarize(vals)
    if (!s) { console.log(`  ${name.padEnd(36)}  -`); continue }
    console.log(`  ${name.padEnd(36)}  ${fmt(s.n, 2)}  ${fmt(s.min, 6)}  ${fmt(s.p50, 6)}  ${fmt(s.mean, 6)}  ${fmt(s.max, 6)}`)
  }

  const outPath = path.resolve(__dirname, 'experiment-did-post.json')
  fs.writeFileSync(outPath, JSON.stringify({ rows, ranAt: new Date().toISOString() }, null, 2))
  console.log(`\nFull data: ${outPath}`)
}

main().catch(e => { console.error('[did-exp] fatal:', e); process.exit(1) })
