// experiment-institution-count.mjs
// Measures "Fetch salt" wall-clock time vs number of institutions queried.
//
// For each N in [3, 5, 7, 9, 10]:
//   1. pm2 restart all   → forces Poseidon WASM cold on every salt-service
//   2. sleep briefly      → let PM2 children finish starting
//   3. fire N parallel POSTs to /get-salt at localhost:7001...localhost:7000+N
//   4. wall-clock = performance.now() delta around the Promise.all
//   5. per-institution computeMs = what each salt-service reports
//
// Output: stdout table + JSON dump for each run.
//
// Why run on EC2 (not from the Mac browser): eliminates the tunnel/hairpin
// variance and gives us the ground-truth "same-box parallel fan-out" cost.
// This is what the browser WOULD see if the browser were also on EC2 and
// pointed at localhost (which DCV Firefox effectively does for its own
// machine — so these numbers are what DCV Firefox would see too).

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = path.resolve(__dirname, '.zk-session.json')

const COUNTS = [3, 5, 7, 9, 10]
const SETTLE_MS_AFTER_PM2 = 1500 // give Poseidon processes time to listen again

function log(s) { console.log(`[exp] ${s}`) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function loadJwt() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
    if (!s.GOOGLE_ID_TOKEN) throw new Error('session has no GOOGLE_ID_TOKEN')
    return s.GOOGLE_ID_TOKEN
  } catch (e) {
    throw new Error(`cannot load session: ${e.message}`)
  }
}

async function resetPoseidon() {
  const r = spawnSync('pm2', ['restart', 'all'], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) throw new Error(`pm2 restart failed: ${r.stderr || r.stdout}`)
  await sleep(SETTLE_MS_AFTER_PM2)
}

async function fetchOneSalt(port, jwt) {
  const t0 = performance.now()
  try {
    const resp = await fetch(`http://localhost:${port}/get-salt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
    })
    const clientMs = Math.round(performance.now() - t0)
    const body = await resp.json().catch(() => ({}))
    return {
      port,
      ok: resp.ok,
      clientMs,
      serverComputeMs: typeof body?.computeMs === 'number' ? body.computeMs : null,
      err: resp.ok ? null : (body?.error || `HTTP ${resp.status}`),
    }
  } catch (e) {
    return { port, ok: false, clientMs: Math.round(performance.now() - t0), serverComputeMs: null, err: String(e?.message || e) }
  }
}

async function runOne(n, jwt) {
  log(`── N=${n} institutions ──`)

  log('  pm2 restart all (Poseidon cold)')
  await resetPoseidon()

  const ports = []
  for (let i = 0; i < n; i++) ports.push(7001 + i)

  log(`  firing ${n} parallel POSTs to ${ports[0]}…${ports[n - 1]}`)
  const t0 = performance.now()
  const results = await Promise.all(ports.map(p => fetchOneSalt(p, jwt)))
  const wallMs = Math.round(performance.now() - t0)

  const okCount = results.filter(r => r.ok).length
  const maxServerMs = Math.max(...results.map(r => r.serverComputeMs ?? 0))
  const minServerMs = Math.min(...results.map(r => r.serverComputeMs ?? Infinity).filter(Number.isFinite))
  const maxClientMs = Math.max(...results.map(r => r.clientMs))

  log(`  wall=${wallMs}ms  ok=${okCount}/${n}  maxServerMs=${maxServerMs}  maxClientMs=${maxClientMs}`)
  return {
    n,
    wallMs,
    maxClientMs,
    maxServerMs,
    minServerMs,
    okCount,
    perInstitution: results,
  }
}

async function main() {
  const jwt = loadJwt()
  log(`loaded session (jwt length=${jwt.length} chars)`)

  const rows = []
  for (const n of COUNTS) {
    rows.push(await runOne(n, jwt))
    // brief pause to let metadata settle before next pm2 restart
    await sleep(500)
  }

  // ─── Results ───
  console.log('\n========== RESULTS ==========')
  console.log('N   wall_ms   maxClient_ms   maxServer_ms   minServer_ms   ok/total   ratio(wall/maxServer)')
  console.log('-----------------------------------------------------------------------------------------------')
  for (const r of rows) {
    const ratio = r.maxServerMs > 0 ? (r.wallMs / r.maxServerMs).toFixed(2) : '-'
    console.log(
      `${String(r.n).padStart(2)}  ${String(r.wallMs).padStart(7)}  ${String(r.maxClientMs).padStart(12)}   ${String(r.maxServerMs).padStart(12)}   ${String(r.minServerMs).padStart(12)}   ${String(r.okCount + '/' + r.n).padStart(7)}    ${String(ratio).padStart(5)}`
    )
  }
  console.log('\nColumn notes:')
  console.log('  wall_ms       = total time for Promise.all (what the browser would see for Fetch salt)')
  console.log('  maxClient_ms  = slowest single-institution round-trip (client-side)')
  console.log('  maxServer_ms  = slowest server-reported computeMs (Poseidon init time; ~same across cold runs)')
  console.log('  ratio         = how much wall-clock exceeds the slowest server compute — values close to 1 mean')
  console.log('                  latency is pure server-side; higher values mean parallelism overhead is growing')

  // Per-institution detail
  console.log('\n========== PER-INSTITUTION ==========')
  for (const r of rows) {
    console.log(`N=${r.n}:`)
    for (const p of r.perInstitution) {
      console.log(`  :${p.port}  clientMs=${String(p.clientMs).padStart(4)}  serverMs=${p.serverComputeMs ?? '?'}  ${p.ok ? '✓' : 'FAIL: ' + p.err}`)
    }
  }

  // Save JSON for further analysis
  const outPath = path.resolve(__dirname, 'experiment-institution-count.json')
  fs.writeFileSync(outPath, JSON.stringify({ runs: rows, ranAt: new Date().toISOString() }, null, 2))
  console.log(`\nJSON dump: ${outPath}`)
}

main().catch(e => { console.error('[exp] fatal:', e); process.exit(1) })
