// experiment-access.mjs
// Measures per-phase timings for 10 EHR Access Grant operations,
// varying only the recordId (record-0001 … record-0010).
//
// Each iteration:
//   1. POST /op/access with { hospitalDid, granteeDid, recordId }
//   2. bridge runs the backend, returns the full .backend-timings.json inline
//   3. we record every phase timing + gas/storage + total wall-clock
//
// What is NOT forced between iterations:
//   - we do NOT pm2 restart or clear caches between runs. That's intentional:
//     the user wants to see the NORMAL per-op cost, with realistic warm-cache
//     behavior. JWKS/Poseidon cold spikes would be noise for this question.
//
// Output: stdout table + JSON dump.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = 'http://localhost:4317'

const HOSPITAL_DID = 'did:zklogin:google:0x6f4e223d691075755161e79aad78b027ef4554900c751fa8cc8e0e4e47bd7202'
const GRANTEE_DID  = 'did:zklogin:google:0x2c5f9b8ba577dd12508a43a9509491a698f0f926bcb037bb6629b39e21d17173'
const RECORD_IDS = Array.from({ length: 10 }, (_, i) => `record-${String(i + 1).padStart(4, '0')}`)

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

function log(s) { console.log(`[access-exp] ${s}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runOneAccess(recordId) {
  const body = JSON.stringify({ hospitalDid: HOSPITAL_DID, granteeDid: GRANTEE_DID, recordId })
  const t0 = performance.now()
  const resp = await fetch(`${BRIDGE}/op/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const wallMs = Math.round(performance.now() - t0)
  const text = await resp.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { wallMs, status: resp.status, json }
}

function fmt(n, w = 5) {
  if (n == null || Number.isNaN(n)) return '-'.padStart(w)
  return String(n).padStart(w)
}

async function main() {
  log(`hospital: ${HOSPITAL_DID}`)
  log(`grantee:  ${GRANTEE_DID}`)
  log(`record ids: ${RECORD_IDS[0]} ... ${RECORD_IDS.at(-1)}`)

  // Sanity: session must be valid; otherwise every /op/access returns 409.
  const s = await (await fetch(`${BRIDGE}/session`)).json().catch(() => null)
  if (!s?.hasSession || s?.expired) throw new Error('no valid session on EC2; log in via browser first')
  log(`session ok (provider=${s.provider}, remainingEpochs=${s.remainingEpochs})`)

  const rows = []
  for (let i = 0; i < RECORD_IDS.length; i++) {
    const recordId = RECORD_IDS[i]
    log(`── iteration ${i + 1}/${RECORD_IDS.length}  recordId=${recordId} ──`)

    const { wallMs, status, json } = await runOneAccess(recordId)
    if (status !== 200 || !json?.ok) {
      log(`  ❌ HTTP ${status}: ${json?.error || json?.raw || 'unknown'}`)
      rows.push({ iter: i + 1, recordId, error: json?.error || `HTTP ${status}`, wallMs })
      // sleep a bit then keep going
      await sleep(500)
      continue
    }

    const t = json.timings || {}
    const timings = t.timings || {}
    const gas = t.gasReport || null
    const storage = Array.isArray(t.storageReport) ? t.storageReport : []

    log(`  ok  wall=${wallMs}ms  status=${t.status}  digest=${String(t.digest || '').slice(0, 10)}…`)
    log(`      step6.5=${timings['6.5_build_and_sign_Move_tx']}ms  step6.6b=${timings['6.6b_submit_tx_and_return']}ms  step8=${timings['8_query_chain_and_update_DID_doc']}ms`)
    if (gas) log(`      netGas=${gas.netGasMist} MIST  bcsBytes=${storage[0]?.bcsBytes ?? '?'}`)

    rows.push({
      iter: i + 1,
      recordId,
      wallMs,
      status: t.status,
      digest: t.digest,
      timings,
      gasReport: gas,
      storageReport: storage,
    })

    // Small spacing between iterations so `.backend-timings.json` writes settle
    // and PM2 / systemd aren't in any weird flush state.
    await sleep(400)
  }

  // ────── Results table ──────
  console.log('\n================ TIMING TABLE (ms) ================')
  const headers = [
    'iter', 'recordId',
    'wall',
    's2', 's3', 's4', 's5', 's6',
    's61-3', 's6.1b', 's6.4', 's6.4b',
    's6.5', 's6.6a', 's6.6b',
    's8',
  ]
  console.log(headers.map(h => h.padStart(h === 'recordId' ? 11 : h === 'iter' ? 4 : 6)).join(' '))
  console.log('-'.repeat(headers.length * 7 + 12))
  for (const r of rows) {
    if (r.error) {
      console.log(`${fmt(r.iter, 4)} ${r.recordId.padStart(11)}  ERROR: ${r.error}`)
      continue
    }
    const t = r.timings
    const vals = [
      fmt(r.iter, 4),
      r.recordId.padStart(11),
      fmt(r.wallMs, 6),
      fmt(t['2_load_or_populate_zkLogin_session']),
      fmt(t['3_generate_zkLogin_DID_and_ephemeral_key']),
      fmt(t['4_issue_zkLogin_JWT_VC']),
      fmt(t['5_generate_full_zkLogin_DID_doc']),
      fmt(t['6_save_VC_to_dids_json']),
      fmt(t['6.1-3_restore_key+randomness+nonce_verify+address_seed'], 6),
      fmt(t['6.1b_JWK_precheck']),
      fmt(t['6.4_request_Prover']),
      fmt(t['6.4b_request_Faucet']),
      fmt(t['6.5_build_and_sign_Move_tx']),
      fmt(t['6.6a_assemble_zkLogin_signature']),
      fmt(t['6.6b_submit_tx_and_return']),
      fmt(t['8_query_chain_and_update_DID_doc']),
    ]
    console.log(vals.join(' '))
  }

  // ────── Gas & storage table ──────
  console.log('\n================ GAS & STORAGE TABLE ================')
  console.log('iter  recordId       net_gas_MIST       net_gas_SUI       storage_bytes   digest')
  console.log('-'.repeat(98))
  for (const r of rows) {
    if (r.error) continue
    const gasMist = r.gasReport?.netGasMist ?? 0
    const gasSui = (gasMist / 1e9).toFixed(9)
    const bytes = r.storageReport?.[0]?.bcsBytes ?? '?'
    const dig = r.digest ? r.digest.slice(0, 10) + '…' : '-'
    console.log(
      `${fmt(r.iter, 4)}  ${r.recordId.padStart(11)}  ${fmt(gasMist, 14)}  ${gasSui.padStart(17)}   ${String(bytes).padStart(13)}   ${dig}`
    )
  }

  // ────── Summary stats ──────
  const done = rows.filter(r => !r.error)
  if (done.length) {
    const keysToStat = ['wallMs', '6.5_build_and_sign_Move_tx', '6.6b_submit_tx_and_return', '8_query_chain_and_update_DID_doc']
    console.log('\n================ SUMMARY STATS (successful runs) ================')
    console.log('metric                                       n    min    p50   mean    max')
    console.log('-'.repeat(78))
    for (const k of keysToStat) {
      const vals = done.map(r => k === 'wallMs' ? r.wallMs : r.timings[k]).filter(x => typeof x === 'number')
      vals.sort((a, b) => a - b)
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const p50 = vals[Math.floor(vals.length / 2)]
      console.log(
        `  ${k.padEnd(44)}  ${fmt(vals.length, 2)}  ${fmt(vals[0])}  ${fmt(p50)}  ${fmt(Math.round(mean))}  ${fmt(vals.at(-1))}`
      )
    }

    const gases = done.map(r => r.gasReport?.netGasMist).filter(Boolean)
    gases.sort((a, b) => a - b)
    const bytes = done.map(r => r.storageReport?.[0]?.bcsBytes).filter(Boolean)
    bytes.sort((a, b) => a - b)
    console.log(`  netGasMist (gas cost)                         ${fmt(gases.length, 2)}  ${fmt(gases[0], 8)}  ${fmt(gases[Math.floor(gases.length / 2)], 8)}  ${fmt(Math.round(gases.reduce((a, b) => a + b, 0) / gases.length), 8)}  ${fmt(gases.at(-1), 8)}`)
    console.log(`  storage bytes                                 ${fmt(bytes.length, 2)}  ${fmt(bytes[0])}  ${fmt(bytes[Math.floor(bytes.length / 2)])}  ${fmt(Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length))}  ${fmt(bytes.at(-1))}`)
  }

  const outPath = path.resolve(__dirname, 'experiment-access.json')
  fs.writeFileSync(outPath, JSON.stringify({ rows, ranAt: new Date().toISOString() }, null, 2))
  console.log(`\nFull data: ${outPath}`)
}

main().catch(e => { console.error('[access-exp] fatal:', e); process.exit(1) })
