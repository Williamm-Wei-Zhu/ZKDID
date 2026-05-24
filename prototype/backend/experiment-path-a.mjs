// experiment-path-a.mjs
// Path A: You click "Authenticate Google" in DCV Firefox for each iteration,
// the script orchestrates everything else. Produces a 10-row dataset with
// both browser-side and EC2-side timings for every phase.
//
// Per iteration:
//   [script]   POST /session/clear             (forces session + caches cold)
//   [script]   POST /salt-seeds                (select 3 institutions)
//   [YOU]      click "Authenticate Google" in DCV Firefox
//              → frontend runs beginZkLogin → OAuth redirect → completeZkLogin
//              → calls postSessionToBridge + postBrowserTimingsToBridge
//   [script]   poll /session until hasSession=true  (~up to 60s)
//   [script]   GET /browser-timings/latest    (the browser-side TimingRecord)
//   [script]   POST /op/vc                     (triggers backend, blocks for timings)
//   [script]   record row with all fields
//
// Output: stdout progress + a CSV + JSON dump.
//
// IMPORTANT: you must be ready to click in DCV Firefox at localhost:1234/
// when prompted. The script prints a "🖱️ CLICK NOW" message at the start
// of each iteration's human-waiting phase.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = 'http://localhost:4317'
const ITERATIONS = 10
const WAIT_POLL_MS = 1000
// A cold-Poseidon iteration (post /session/clear → pm2 restart) can push the
// browser's salt phase to ~1s and the ZK prover to ~3s, plus Google OAuth +
// redirect + bundle reload + the user's click delay. 180s gives comfortable
// headroom even when the user is briefly distracted between iterations.
const WAIT_MAX_S = 180

const INSTITUTIONS = ['Institution 1', 'Institution 2', 'Institution 3']

const BACKEND_PHASE_KEYS = [
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

const BROWSER_PHASE_KEYS = [
  'genParamsMs', 'epochFetchMs', 'ephKeyMs', 'randomnessMs', 'nonceMs',
  'jwtParseMs', 'saltMs', 'nonceVerifyMs', 'proverMs',
  'saveAccountMs', 'bridgePostMs', 'deriveAllMs',
]

function log(s) { console.log(`[path-a] ${s}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function req(method, path_, body) {
  const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : undefined }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(BRIDGE + path_, opts)
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = null }
  return { ok: r.ok, status: r.status, json, text }
}

async function getSession() {
  const r = await req('GET', '/session')
  return r.ok ? r.json : null
}

async function clearSession() {
  const r = await req('POST', '/session/clear')
  return r.ok ? r.json : null
}

async function setSaltSeeds() {
  // Use the existing POST /salt-seeds endpoint to persist which institutions
  // the frontend should query. The frontend reads these on login via
  // getSaltSeeds() and dispatches salt fetches per the selectedInstitutions list.
  const r = await req('POST', '/salt-seeds', {
    selectedInstitutions: INSTITUTIONS,
    // saltSeeds map omitted → frontend will use DEFAULT_SALT_SEEDS (empty strings),
    // forcing the remote-fetch path (what the user's experiment wants).
    saltSeeds: INSTITUTIONS.reduce((m, n) => ({ ...m, [n]: '' }), {}),
  })
  return r.ok
}

async function waitForFreshSession(minReceivedAtMs) {
  const deadline = Date.now() + WAIT_MAX_S * 1000
  let lastLogSec = -1
  while (Date.now() < deadline) {
    const s = await getSession()
    if (s?.hasSession && !s.expired) {
      // Also wait for browser-timings to be uploaded so we don't capture stale ones.
      const bt = await req('GET', '/browser-timings/latest')
      if (bt.ok && bt.json?.receivedAt && bt.json.receivedAt > minReceivedAtMs) {
        return { session: s, browserTiming: bt.json.timing, browserReceivedAt: bt.json.receivedAt }
      }
    }
    const sec = Math.floor((deadline - Date.now()) / 1000)
    if (sec !== lastLogSec && sec % 10 === 0) {
      log(`  waiting… (${WAIT_MAX_S - sec}s elapsed, ${sec}s remaining)`)
      lastLogSec = sec
    }
    await sleep(WAIT_POLL_MS)
  }
  return null
}

async function runVc() {
  const t0 = performance.now()
  const r = await req('POST', '/op/vc')
  const wallMs = Math.round(performance.now() - t0)
  return { wallMs, status: r.status, json: r.json }
}

async function main() {
  log(`starting: ${ITERATIONS} iterations with live Google OAuth per iteration`)
  log(`institutions: ${INSTITUTIONS.join(', ')}`)
  log('')

  const rows = []

  for (let i = 1; i <= ITERATIONS; i++) {
    console.log('━'.repeat(70))
    log(`ITERATION ${i}/${ITERATIONS}`)
    console.log('━'.repeat(70))

    // Step 0: clear session + caches (pm2 restart resets Poseidon)
    log('  [0] POST /session/clear (resets JWKS + pm2 salt-services)')
    const cleared = await clearSession()
    if (!cleared?.ok) { log('  ❌ clearSession failed'); break }
    log(`      cleared: ${(cleared.cleared || []).join(', ')}`)

    // Step 1: select 3 institutions
    log('  [1] POST /salt-seeds (select 3 institutions)')
    const ok = await setSaltSeeds()
    if (!ok) { log('  ❌ setSaltSeeds failed'); break }
    log(`      selected: ${INSTITUTIONS.join(', ')}`)

    // Step 2: HUMAN clicks Authenticate Google
    const tRequestStart = Date.now()
    console.log('')
    console.log(`  🖱️  ━━━━━━ CLICK NOW (iteration ${i}/${ITERATIONS}) ━━━━━━`)
    console.log('      1. Switch to DCV Firefox at http://localhost:1234/')
    console.log('      2. Click "Sign in with Google"')
    console.log('      3. Wait for the DID page to load (session populates automatically)')
    console.log('')

    const res = await waitForFreshSession(tRequestStart)
    if (!res) {
      log(`  ❌ timeout waiting for login (${WAIT_MAX_S}s)`)
      rows.push({ iter: i, error: 'login timeout' })
      continue
    }
    log(`  ✅ login detected — browser timings received`)

    // Step 3: trigger /op/vc for backend phase timings + gas + storage
    log('  [3] POST /op/vc (backend timings)')
    const vc = await runVc()
    if (vc.status !== 200 || !vc.json?.ok) {
      log(`  ❌ op/vc failed: ${vc.json?.error || vc.status}`)
      rows.push({ iter: i, error: `op/vc failed: ${vc.json?.error || vc.status}`, browserTiming: res.browserTiming })
      continue
    }
    const backend = vc.json.timings
    log(`      op/vc wall=${vc.wallMs}ms  step6.5=${backend.timings['6.5_build_and_sign_Move_tx']}ms  step6.6b=${backend.timings['6.6b_submit_tx_and_return']}ms  step8=${backend.timings['8_query_chain_and_update_DID_doc']}ms`)

    rows.push({
      iter: i,
      browserTiming: res.browserTiming,
      opVcWallMs: vc.wallMs,
      opStatus: backend.status,
      digest: backend.digest,
      backendPhases: backend.timings,
      gasReport: backend.gasReport,
      storageReport: backend.storageReport,
    })

    // Small pause between iterations to give user time to switch focus
    if (i < ITERATIONS) {
      log('  (pausing 3s before next iteration — stay on DCV Firefox)')
      await sleep(3000)
    }
  }

  // ─── Summary ───
  console.log('\n' + '='.repeat(70))
  console.log('           RESULTS — BROWSER-SIDE TIMINGS (ms)')
  console.log('='.repeat(70))
  const bh = ['iter', ...BROWSER_PHASE_KEYS]
  console.log(bh.map(h => h.padStart(14).slice(0, 14)).join(' '))
  console.log('-'.repeat(14 * bh.length + bh.length - 1))
  for (const r of rows) {
    if (r.error) { console.log(`${String(r.iter).padStart(14)} ERROR: ${r.error}`); continue }
    const bt = r.browserTiming || {}
    const vals = [String(r.iter), ...BROWSER_PHASE_KEYS.map(k => (typeof bt[k] === 'number' ? String(bt[k]) : '-'))]
    console.log(vals.map(v => v.padStart(14).slice(0, 14)).join(' '))
  }

  console.log('\n' + '='.repeat(70))
  console.log('           RESULTS — EC2-SIDE BACKEND PHASES (ms)')
  console.log('='.repeat(70))
  // Compact column names
  const shortNames = {
    '2_load_or_populate_zkLogin_session': 's2_load',
    '3_generate_zkLogin_DID_and_ephemeral_key': 's3_genDID',
    '4_issue_zkLogin_JWT_VC': 's4_VC',
    '5_generate_full_zkLogin_DID_doc': 's5_doc',
    '6_save_VC_to_dids_json': 's6_save',
    '6.1-3_restore_key+randomness+nonce_verify+address_seed': 's6.1-3',
    '6.1b_JWK_precheck': 's6.1b',
    '6.4_request_Prover': 's6.4',
    '6.4b_request_Faucet': 's6.4b',
    '6.5_build_and_sign_Move_tx': 's6.5',
    '6.6a_assemble_zkLogin_signature': 's6.6a',
    '6.6b_submit_tx_and_return': 's6.6b',
    '8_query_chain_and_update_DID_doc': 's8',
  }
  const ebh = ['iter', 'wall', ...BACKEND_PHASE_KEYS.map(k => shortNames[k] || k)]
  console.log(ebh.map(h => h.padStart(8).slice(0, 8)).join(' '))
  console.log('-'.repeat(8 * ebh.length + ebh.length - 1))
  for (const r of rows) {
    if (r.error) continue
    const p = r.backendPhases || {}
    const vals = [String(r.iter), String(r.opVcWallMs), ...BACKEND_PHASE_KEYS.map(k => typeof p[k] === 'number' ? String(p[k]) : '-')]
    console.log(vals.map(v => v.padStart(8).slice(0, 8)).join(' '))
  }

  console.log('\n' + '='.repeat(70))
  console.log('           RESULTS — GAS & STORAGE')
  console.log('='.repeat(70))
  console.log('iter   netGas_MIST    netGas_SUI     storage_bytes  digest')
  console.log('-'.repeat(72))
  for (const r of rows) {
    if (r.error) continue
    const g = r.gasReport?.netGasMist ?? 0
    const sui = (g / 1e9).toFixed(9)
    const bytes = r.storageReport?.[0]?.bcsBytes ?? '?'
    const dig = r.digest ? r.digest.slice(0, 10) + '…' : '-'
    console.log(`${String(r.iter).padStart(4)}  ${String(g).padStart(12)}  ${sui.padStart(13)}   ${String(bytes).padStart(13)}  ${dig}`)
  }

  // Save CSV + JSON dumps
  const csvPath = path.resolve(__dirname, 'experiment-path-a.csv')
  const allHeaders = ['iter', 'error',
    ...BROWSER_PHASE_KEYS.map(k => 'browser.' + k),
    'opVcWallMs',
    ...BACKEND_PHASE_KEYS.map(k => 'backend.' + k),
    'netGasMist', 'storageBcsBytes', 'digest',
  ]
  const lines = [allHeaders.join(',')]
  for (const r of rows) {
    const row = {}
    row.iter = r.iter; row.error = r.error || ''
    for (const k of BROWSER_PHASE_KEYS) row['browser.' + k] = r.browserTiming?.[k] ?? ''
    row.opVcWallMs = r.opVcWallMs ?? ''
    for (const k of BACKEND_PHASE_KEYS) row['backend.' + k] = r.backendPhases?.[k] ?? ''
    row.netGasMist = r.gasReport?.netGasMist ?? ''
    row.storageBcsBytes = r.storageReport?.[0]?.bcsBytes ?? ''
    row.digest = r.digest ?? ''
    lines.push(allHeaders.map(h => String(row[h] ?? '')).join(','))
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n')
  fs.writeFileSync(path.resolve(__dirname, 'experiment-path-a.json'), JSON.stringify({ rows, ranAt: new Date().toISOString() }, null, 2))
  console.log(`\nCSV: ${csvPath}`)
  console.log(`JSON: ${path.resolve(__dirname, 'experiment-path-a.json')}`)
}

main().catch(e => { console.error('[path-a] fatal:', e); process.exit(1) })
