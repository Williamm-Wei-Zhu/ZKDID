// prototype/orchestrator/bridge.mjs — spawn frontend WITHOUT npm or shell
// Supports ehr_access smart contract access grant/revoke/check operations.
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

// Node 18+ has global fetch

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 👉 adjust these to your dirs
const FRONTEND_DIR = path.resolve(__dirname, '../frontend')
const BACKEND_DIR  = path.resolve(__dirname, '../backend')
const SESSION_FILE = path.resolve(BACKEND_DIR, '.zk-session.json')
const SALT_SEEDS_FILE = path.resolve(__dirname, '../salt-seeds.json')

/* ---------------------- small utils ---------------------- */
function readJSON(p, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return fallback
  }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
}
function resolveLocalBin(pkgName, binRelPath) {
  const p = path.join(FRONTEND_DIR, 'node_modules', pkgName, binRelPath)
  if (!fs.existsSync(p)) throw new Error(`Cannot find ${pkgName} bin at ${p}`)
  return p
}

/* ---------------------- Sui epoch helpers ---------------------- */
// Robustly read frontend config to derive SUI RPC URL
function getSuiRpcUrl() {
  const tryPaths = [
    path.join(FRONTEND_DIR, 'src', 'config.json'),
    path.join(FRONTEND_DIR, 'config.json'),
  ]
  let cfg = {}
  for (const p of tryPaths) {
    if (fs.existsSync(p)) { cfg = readJSON(p, {}) || {}; break }
  }
  if (cfg?.SUI_RPC_URL) return cfg.SUI_RPC_URL

  const net = (cfg?.network || 'devnet').toLowerCase()
  if (net.includes('dev')) return 'https://fullnode.devnet.sui.io'
  if (net.includes('test')) return 'https://fullnode.testnet.sui.io'
  if (net.includes('main')) return 'https://fullnode.mainnet.sui.io'
  return 'https://fullnode.devnet.sui.io'
}

// Get current epoch via multiple methods (suix/sui/checkpoint)
async function getCurrentEpoch() {
  const rpc = getSuiRpcUrl()

  async function rpcCall(method, params = []) {
    const body = { jsonrpc: '2.0', id: 1, method, params }
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(`RPC ${method} ${resp.status}`)
    const data = await resp.json()
    if (data.error) throw new Error(`RPC ${method} error: ${JSON.stringify(data.error)}`)
    return data.result
  }

  // A. suix_*
  try {
    const r = await rpcCall('suix_getLatestSuiSystemState')
    const epoch = r?.epoch ?? r?.systemStateSummary?.epoch
    if (epoch !== undefined) return Number(epoch)
  } catch (_) {}

  // B. Legacy/compatible sui_*
  try {
    const r = await rpcCall('sui_getLatestSuiSystemState')
    const epoch = r?.epoch ?? r?.systemStateSummary?.epoch
    if (epoch !== undefined) return Number(epoch)
  } catch (_) {}

  // C. Fallback: epoch from latest checkpoint
  try {
    const latestSeq = await rpcCall('sui_getLatestCheckpointSequenceNumber')
    const ckpt = await rpcCall('sui_getCheckpoint', [ String(latestSeq) ])
    if (ckpt?.epoch !== undefined) return Number(ckpt.epoch)
  } catch (_) {}

  throw new Error('could not resolve epoch via RPC (suix/sui/checkpoint all failed)')
}

// Check if session is still valid (compare absolute MAX_EPOCH with current epoch)
async function isSessionStillValid(session) {
  const nowEpoch = await getCurrentEpoch()
  const maxEpochNum = Number(session?.MAX_EPOCH)
  if (!Number.isFinite(maxEpochNum)) return false
  // Valid rule: current epoch <= MAX_EPOCH
  return nowEpoch <= maxEpochNum
}

/* ---------------------- JWKS cache ---------------------- */
// On-disk cache of provider JWKS kid lists. Honors the provider Cache-Control
// max-age (Google uses ~6h), with a 1h fallback TTL. Makes the JWK pre-check
// effectively free on warm runs.
const JWKS_CACHE_PATH = path.resolve(__dirname, '.jwks-cache.json')
const JWKS_CACHE_FALLBACK_TTL_MS = 60 * 60 * 1000 // 1 hour

function readJwksCache() {
  try {
    const raw = fs.readFileSync(JWKS_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch { return {} }
}
function writeJwksCache(cache) {
  try { fs.writeFileSync(JWKS_CACHE_PATH, JSON.stringify(cache, null, 2)) }
  catch (e) { console.warn('[bridge] JWKS cache write failed (non-fatal):', e?.message) }
}
async function fetchAndCacheJwks(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!resp.ok) throw new Error(`JWKS fetch failed: HTTP ${resp.status}`)
  const cc = resp.headers.get('cache-control') || ''
  const m = /max-age\s*=\s*(\d+)/i.exec(cc)
  const ttlMs = m ? Number(m[1]) * 1000 : JWKS_CACHE_FALLBACK_TTL_MS
  const jwks = await resp.json()
  const kids = Array.isArray(jwks?.keys) ? jwks.keys.map(k => k?.kid).filter(Boolean) : []
  const entry = { fetchedAt: Date.now(), expiresAt: Date.now() + ttlMs, kids, ttlMs }
  const cache = readJwksCache()
  cache[url] = entry
  writeJwksCache(cache)
  return entry
}
async function getJwksKids(url, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const entry = readJwksCache()[url]
    if (entry && Number.isFinite(entry.expiresAt) && entry.expiresAt > Date.now() && Array.isArray(entry.kids)) {
      return { kids: entry.kids, fromCache: true, ageMs: Date.now() - (entry.fetchedAt || 0) }
    }
  }
  const entry = await fetchAndCacheJwks(url)
  return { kids: entry.kids, fromCache: false, ageMs: 0 }
}

/* ---------------------- JWK pre-check ---------------------- */
// Extract kid from JWT header, check if it is still valid in provider JWKS
// Returns: { valid: true/false, kid, error?, fromCache?, ageMs? }
async function checkJwkValidity(idToken) {
  try {
    // Parse JWT header to get kid
    const headerB64 = idToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString())
    const kid = header?.kid
    if (!kid) return { valid: false, kid: null, error: 'Missing kid in JWT header' }

    // Parse JWT payload to get iss (to determine provider)
    const payloadB64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString())
    const iss = String(payload?.iss || '').toLowerCase()

    // Select JWKS endpoint based on provider
    let jwksUrl = null
    if (iss.includes('accounts.google')) {
      jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs'
    } else if (iss.includes('twitch') || iss.includes('id.twitch.tv')) {
      jwksUrl = 'https://id.twitch.tv/oauth2/keys'
    }
    // Skip JWK pre-check for Facebook and other providers, allow through
    if (!jwksUrl) return { valid: true, kid, skipped: true }

    // Cached path first; if kid is not in cached set, force-refresh before
    // reporting "rotated" to avoid false positives on stale-but-unexpired caches.
    let { kids: validKids, fromCache, ageMs } = await getJwksKids(jwksUrl)
    if (!validKids.includes(kid) && fromCache) {
      ;({ kids: validKids, fromCache, ageMs } = await getJwksKids(jwksUrl, { forceRefresh: true }))
    }

    if (validKids.includes(kid)) {
      return { valid: true, kid, fromCache, ageMs }
    } else {
      return { valid: false, kid, validKids, error: `kid="${kid}" not found in current JWKS (valid: ${validKids.join(', ')})` }
    }
  } catch (e) {
    // Network error — cannot confirm, allow through and let backend check again
    return { valid: true, kid: null, skipped: true, error: `JWK check network error: ${e?.message}` }
  }
}

/* ---------------------- spawn helpers ---------------------- */
let childFrontend = null
let childBackend  = null

// Collect backend CLI args passed via `npm run dev -- <args>` (did | vc | access and --key=1/2/3 etc.)
const BACKEND_CLI_ARGS = (() => {
  const raw = process.argv.slice(2)
  if (!raw.length) return []
  // Allow first arg to be did/vc/access or key-related params; pass through without deep validation
  return raw
})()
if (BACKEND_CLI_ARGS.length) {
  console.log('[bridge] captured backend CLI args:', BACKEND_CLI_ARGS.join(' '))
} else {
  console.log('[bridge] no extra backend CLI args passed (default veramo script behavior)')
}

function spawnFrontend() {
  const pkgPath = path.join(FRONTEND_DIR, 'package.json')
  const pkg = readJSON(pkgPath, {})
  const devCmd = (pkg.scripts && pkg.scripts.dev) || ''
  console.log('[bridge] frontend scripts.dev =', devCmd)

  const nodeBin = process.execPath
  let entry
  let args = []

  if (/^\s*vite(\s|$)/.test(devCmd)) {
    entry = resolveLocalBin('vite', 'bin/vite.js')
    args = [entry, 'dev']
  } else if (/^\s*next(\s+dev)?/.test(devCmd)) {
    entry = resolveLocalBin('next', 'dist/bin/next')
    args = [entry, 'dev']
  } else if (/react-scripts\s+start/.test(devCmd)) {
    entry = resolveLocalBin('react-scripts', 'bin/react-scripts.js')
    args = [entry, 'start']
  } else {
    // fallback to vite
    try {
      entry = resolveLocalBin('vite', 'bin/vite.js')
      args = [entry, 'dev']
      console.warn('[bridge] Unknown dev command; falling back to vite dev')
    } catch {
      console.error('[bridge] Unknown dev command and vite not found. Please edit spawnFrontend().')
      process.exit(1)
    }
  }

  console.log('[bridge] spawning frontend:', { nodeBin, args, cwd: FRONTEND_DIR })
  const child = spawn(nodeBin, args, {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    shell: false,
  })
  child.on('error', (e) => console.error('[bridge] frontend spawn error:', e))
  child.on('exit', (code) => console.log(`[bridge] frontend exit code=${code}`))
  childFrontend = child
  return child
}

function spawnBackend(envVars, extraArgs = []) {
  if (childBackend && !childBackend.killed) {
    console.log('[bridge] backend already running, skip spawn')
    return childBackend
  }
  const nodeBin = process.execPath
  const entry = path.resolve(BACKEND_DIR, 'veramo-to-sui.js')
  // extraArgs come from dynamic /op/* routes; CLI args come from `npm run dev -- <op>`.
  const args = [entry, ...extraArgs, ...BACKEND_CLI_ARGS]
  console.log('[bridge] spawning backend:', { nodeBin, args, cwd: BACKEND_DIR, op: envVars?.OP || '(from argv)' })
  const child = spawn(nodeBin, args, {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...envVars },
    stdio: 'inherit',
    shell: false,
  })
  child.on('error', (e) => console.error('[bridge] backend spawn error:', e))
  child.on('exit', (code) => {
    console.log(`[bridge] backend exit code=${code}`)
    childBackend = null
  })
  childBackend = child
  return child
}

/* ---------------- helpers for /op/* and /session routes ---------------- */

function loadSavedSession() {
  return readJSON(SESSION_FILE, null)
}

// Returns { ok, session?, reason? }. Combines file-exists + completeness + epoch validity.
async function ensureValidSession() {
  const s = loadSavedSession()
  if (!s) return { ok: false, reason: 'no saved session; login via browser first' }
  const missing = ['GOOGLE_ID_TOKEN','EPHEMERAL_PRIVATE_KEY','JWT_RANDOMNESS','MAX_EPOCH'].filter(k => !s[k])
  if (missing.length) return { ok: false, reason: `session incomplete: missing ${missing.join(',')}` }
  let valid = false
  try { valid = await isSessionStillValid(s) } catch {}
  if (!valid) return { ok: false, reason: 'session expired (epoch check); login again in browser' }
  return { ok: true, session: s }
}

function spawnBackendForOp(session, op, params = {}) {
  const env = {
    GOOGLE_ID_TOKEN: session.GOOGLE_ID_TOKEN,
    EPHEMERAL_PRIVATE_KEY: session.EPHEMERAL_PRIVATE_KEY,
    JWT_RANDOMNESS: session.JWT_RANDOMNESS,
    MAX_EPOCH: String(session.MAX_EPOCH),
    USER_SALT: session.USER_SALT || '',
    OP: op,
  }
  const extra = []
  if (op === 'access') {
    if (params.hospitalDid) extra.push(`--hospital-did=${params.hospitalDid}`)
    if (params.granteeDid)  extra.push(`--grantee-did=${params.granteeDid}`)
    if (params.recordId)    extra.push(`--record-id=${params.recordId}`)
  }
  return spawnBackend(env, extra)
}

// Run the backend synchronously for an op, wait for the child to exit, then
// read the freshly written .backend-timings.json and return its contents.
// If the child process fails to spawn or exits non-zero, returns
// { ok:false, error } so the caller can surface a useful HTTP error.
//
// Wired from /op/* handlers so the POST response carries the timings payload
// directly — the browser can attribute wall-clock latency to phases instead
// of polling /latest-timings after a fire-and-forget dispatch.
async function runBackendForOpAndWait(session, op, params = {}) {
  const TIMINGS_PATH = path.resolve(BACKEND_DIR, '.backend-timings.json')

  // Remove any stale timings file from a prior run so we can't accidentally
  // return pre-existing data if the new child fails to write one.
  try { if (fs.existsSync(TIMINGS_PATH)) fs.rmSync(TIMINGS_PATH, { force: true }) } catch {}

  const child = spawnBackendForOp(session, op, params)
  if (!child) return { ok: false, error: 'failed to spawn backend' }

  // Wait for exit OR timeout (60s max — one op should never exceed ~10s).
  const exitInfo = await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const t = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      finish({ code: -1, reason: 'timeout' })
    }, 60_000)
    child.once('exit', (code) => { clearTimeout(t); finish({ code }) })
    child.once('error', (e) => { clearTimeout(t); finish({ code: -1, reason: String(e?.message || e) }) })
  })

  // Give the OS a beat in case fs.writeFileSync was the last thing before
  // process exit on a slow filesystem — normally the file is already there.
  const timings = readJSON(TIMINGS_PATH, null)

  if (exitInfo.code !== 0) {
    return {
      ok: false,
      error: `backend exit code=${exitInfo.code}${exitInfo.reason ? ` (${exitInfo.reason})` : ''}`,
      timings, // return partial timings if the child wrote anything before dying
    }
  }
  if (!timings) {
    return { ok: false, error: 'backend exited ok but produced no timings file' }
  }
  return { ok: true, timings }
}

// Decode base64url → UTF-8 for safe JWT inspection.
function decodeJwtPayloadBridge(jwt) {
  try {
    const b64 = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
  } catch { return null }
}

// Build the safe public view of the current session (no raw JWT, no eph key).
async function getSessionSummary() {
  const s = loadSavedSession()
  if (!s) return { hasSession: false }
  const payload = decodeJwtPayloadBridge(s.GOOGLE_ID_TOKEN) || {}
  let currentEpoch = null
  try { currentEpoch = await getCurrentEpoch() } catch {}
  const maxEpoch = Number(s.MAX_EPOCH)
  const remaining = (currentEpoch != null && Number.isFinite(maxEpoch)) ? maxEpoch - currentEpoch : null
  const iss = String(payload?.iss || '').toLowerCase()
  let provider = 'unknown'
  if (iss.includes('accounts.google')) provider = 'google'
  else if (iss.includes('twitch') || iss.includes('id.twitch.tv')) provider = 'twitch'
  else if (iss.includes('facebook')) provider = 'facebook'
  return {
    hasSession: true,
    provider,
    savedAt: s.savedAt || null,
    maxEpoch,
    currentEpoch,
    remainingEpochs: remaining,
    expired: (remaining != null && remaining < 0),
    jwtClaims: payload ? {
      iss: payload.iss,
      sub: payload.sub,
      aud: Array.isArray(payload.aud) ? payload.aud[0] : payload.aud,
      iat: payload.iat,
      exp: payload.exp,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    } : null,
    hasZkProofs: !!(s.ZK_PROOFS && typeof s.ZK_PROOFS === 'object' && Object.keys(s.ZK_PROOFS).length > 0),
    userSaltPresent: !!s.USER_SALT,
  }
}

/* ---------------------- HTTP bridge server ---------------------- */
const PORT = 4317
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

  // Simple health check
  if (req.method === 'GET' && req.url === '/') {
    res.end('ok')
    return
  }

  // Get current epoch (for frontend debugging)
  if (req.method === 'GET' && req.url === '/epoch') {
    try {
      const epoch = await getCurrentEpoch()
      res.end(JSON.stringify({ epoch }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // POST /browser-timings — accept finalized browser-side TimingRecord from
  // the frontend (called by auth.ts::postBrowserTimingsToBridge after a login).
  // Stored to .browser-timings.json keyed by userAddr; experiment harnesses
  // (e.g., experiment-path-a.mjs) read the latest entry to capture what
  // Gen params / Fetch salt / ZK prover / Derive all / etc. took in the browser.
  if (req.method === 'POST' && req.url === '/browser-timings') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { userAddr, timing } = JSON.parse(body || '{}')
        if (typeof userAddr !== 'string' || !userAddr || !timing || typeof timing !== 'object') {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: 'expected { userAddr: string, timing: object }' }))
        }
        const p = path.resolve(BACKEND_DIR, '.browser-timings.json')
        const existing = readJSON(p, {}) || {}
        existing[userAddr] = { timing, receivedAt: Date.now() }
        existing.__latest = { userAddr, timing, receivedAt: Date.now() }
        writeJSON(p, existing)
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e?.message || e) }))
      }
    })
    return
  }

  // GET /browser-timings/latest — returns the most recent browser-timings
  // entry (any user). Used by the experiment harness to read the record
  // produced by the iteration we just observed complete.
  if (req.method === 'GET' && req.url === '/browser-timings/latest') {
    const p = path.resolve(BACKEND_DIR, '.browser-timings.json')
    const all = readJSON(p, null)
    if (!all?.__latest) {
      res.statusCode = 404
      return res.end(JSON.stringify({ error: 'no browser timings yet' }))
    }
    return res.end(JSON.stringify(all.__latest))
  }

  // Latest backend timings (written by veramo-to-sui.js after each run).
  // Consumed by DIDPage.tsx to render the "Timing (on-chain op)" card.
  if (req.method === 'GET' && req.url === '/latest-timings') {
    const timingsPath = path.resolve(BACKEND_DIR, '.backend-timings.json')
    const payload = readJSON(timingsPath, null)
    if (!payload) {
      res.statusCode = 404
      return res.end(JSON.stringify({ error: 'no backend timings yet' }))
    }
    return res.end(JSON.stringify(payload))
  }

  // Frontend session upload
  if (req.method === 'POST' && req.url === '/zklogin-session') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const { GOOGLE_ID_TOKEN, EPHEMERAL_PRIVATE_KEY, JWT_RANDOMNESS, MAX_EPOCH, USER_SALT, ZK_PROOFS } = payload
        if (!GOOGLE_ID_TOKEN || !EPHEMERAL_PRIVATE_KEY || !JWT_RANDOMNESS || !MAX_EPOCH) {
          res.statusCode = 400
          return res.end('missing fields')
        }

        // Save session (including zkProofs already obtained by frontend)
        writeJSON(SESSION_FILE, {
          GOOGLE_ID_TOKEN,
          EPHEMERAL_PRIVATE_KEY,
          JWT_RANDOMNESS,
          MAX_EPOCH,
          USER_SALT: USER_SALT || '',
          ZK_PROOFS: ZK_PROOFS || null,
          savedAt: new Date().toISOString(),
        })
        console.log('[bridge] session received & saved to', SESSION_FILE)

        // Check if still within valid period
        let stillValid = false
        try {
          stillValid = await isSessionStillValid({ MAX_EPOCH })
        } catch (e) {
          console.warn('[bridge] getCurrentEpoch failed:', String(e?.message || e))
        }

        if (stillValid) {
          console.log('[bridge] session still valid by epoch -> starting backend directly')
          spawnBackend({ GOOGLE_ID_TOKEN, EPHEMERAL_PRIVATE_KEY, JWT_RANDOMNESS, MAX_EPOCH, USER_SALT: USER_SALT || '' })
        } else {
          console.warn('[bridge] session expired by epoch; please login again in browser')
        }

        res.end(JSON.stringify({ ok: true, stillValid }))
      } catch (e) {
        res.statusCode = 500
        res.end(String(e?.message || e))
      }
    })
    return
  }

  // Manual trigger: if a valid session exists, start backend directly (no browser re-login needed)
  if (req.method === 'POST' && req.url === '/run-with-last-session') {
    try {
      const last = readJSON(SESSION_FILE, null)
      if (!last) {
        res.statusCode = 404
        return res.end('no saved session')
      }
      let stillValid = false
      try {
        stillValid = await isSessionStillValid(last)
      } catch (e) {
        console.warn('[bridge] getCurrentEpoch failed:', String(e?.message || e))
      }
      if (!stillValid) {
        res.statusCode = 409
        return res.end('saved session expired')
      }
      spawnBackend({
        GOOGLE_ID_TOKEN: last.GOOGLE_ID_TOKEN,
        EPHEMERAL_PRIVATE_KEY: last.EPHEMERAL_PRIVATE_KEY,
        JWT_RANDOMNESS: last.JWT_RANDOMNESS,
        MAX_EPOCH: last.MAX_EPOCH,
        USER_SALT: last.USER_SALT || '',
      })
      res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.statusCode = 500
      res.end(String(e?.message || e))
    }
    return
  }

  // ---------------- NEW: frontend-triggered ops ----------------

  // GET /session — safe summary of the current saved session (no JWT, no keys)
  if (req.method === 'GET' && req.url === '/session') {
    try {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(await getSessionSummary()))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // POST /session/clear — a "reset the user-visible state" operation:
  //   - session files (.zk-session.json, .zklogin-ok)
  //   - JWKS cache (so "OAuth JWT" stat shows real network time on the next op)
  //   - salt-service Poseidon in-memory state (so "Fetch salt" stat shows real
  //     compute time on the next login) via pm2 restart
  //   - any currently running backend child process
  //
  // Intentionally NOT cleared (reasons listed):
  //   - .sui-balance-cache.json / .sui-gas-cache.json — internal perf caches.
  //     Step 6.5 depends on them to stay at ~5-20 ms instead of ~1300 ms. No
  //     user-visible stat wants these reset.
  //   - .backend-timings.json — this is the display record powering OAuth JWT
  //     + the whole backend timing card. If we deleted it, the card would go
  //     blank after every clear until a new op writes it back. Keeping the
  //     file means the stats stay visible (showing the last op's numbers)
  //     and naturally update when the next op completes.
  if (req.method === 'POST' && req.url && req.url.startsWith('/session/clear')) {
    try {
      const cleared = []
      const toRemove = [
        SESSION_FILE,
        path.resolve(BACKEND_DIR, '.zklogin-ok'),
        path.resolve(BACKEND_DIR, '.jwks-cache.json'),
      ]
      for (const p of toRemove) {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true })
          cleared.push(path.basename(p))
        }
      }
      // Terminate any running backend so it can't finish writing stale state back.
      if (childBackend && !childBackend.killed) {
        childBackend.kill('SIGTERM')
      }
      // Restart salt-service PM2 instances so Poseidon WASM is re-initialized
      // on the next /get-salt call. We use `restart` (kill + respawn) rather
      // than `reload` because `reload` on fork-mode processes is an in-place
      // SIGUSR2 signal that salt-service doesn't handle, so the in-memory
      // Poseidon module would survive. Synchronous so the HTTP response
      // reflects post-restart state; blocks the event loop ~1-2s but only on
      // explicit user action. If pm2 isn't installed (local dev), log & skip.
      // pm2 restart is opt-in: only run when ?restart-services=true.
      // Default-off so batch experiments don't disrupt salt-service availability
      // between runs. The cold-start study enables it explicitly.
      const qs = (req.url.split('?')[1] || '')
      const restartServices = /(^|&)restart-services=true(&|$)/.test(qs)
      if (restartServices) {
        try {
          const r = spawnSync('pm2', ['restart', 'all'], { encoding: 'utf-8', timeout: 15000 })
          if (r.error) {
            console.warn('[bridge] pm2 spawn error:', r.error.message)
          } else if (r.status === 0) {
            cleared.push('pm2:restart-all')
            console.log('[bridge] pm2 restart completed (all salt-service processes re-spawned)')
          } else {
            console.warn('[bridge] pm2 restart exit=' + r.status + ' stderr:', (r.stderr || '').slice(0, 300))
          }
        } catch (e) {
          console.warn('[bridge] pm2 spawn threw:', e?.message)
        }
      }
      console.log('[bridge] /session/clear -> cleared:', cleared.join(', ') || '(nothing)')
      res.end(JSON.stringify({ ok: true, cleared }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // POST /op/did — create DID-only against current session
  if (req.method === 'POST' && req.url === '/op/did') {
    try {
      const check = await ensureValidSession()
      if (!check.ok) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: check.reason }))
      }
      // Block on the backend so the POST response carries per-phase timings.
      const r = await runBackendForOpAndWait(check.session, 'did')
      if (!r.ok) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: r.error, timings: r.timings || null }))
      }
      res.end(JSON.stringify({ ok: true, op: 'did', spawned: true, timings: r.timings }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // POST /op/access — create AccessGrant record on chain
  if (req.method === 'POST' && req.url === '/op/access') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const { hospitalDid, granteeDid, recordId } = payload
        if (!hospitalDid || !granteeDid || !recordId) {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: 'hospitalDid, granteeDid and recordId are all required' }))
        }
        const check = await ensureValidSession()
        if (!check.ok) {
          res.statusCode = 409
          return res.end(JSON.stringify({ error: check.reason }))
        }
        const r = await runBackendForOpAndWait(check.session, 'access', { hospitalDid, granteeDid, recordId })
        if (!r.ok) {
          res.statusCode = 500
          return res.end(JSON.stringify({ error: r.error, timings: r.timings || null }))
        }
        res.end(JSON.stringify({ ok: true, op: 'access', spawned: true, args: { hospitalDid, granteeDid, recordId }, timings: r.timings }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e?.message || e) }))
      }
    })
    return
  }

  // POST /op/vc — (bonus; mirror of /op/did but keeps VC on chain)
  if (req.method === 'POST' && req.url === '/op/vc') {
    try {
      const check = await ensureValidSession()
      if (!check.ok) {
        res.statusCode = 409
        return res.end(JSON.stringify({ error: check.reason }))
      }
      const r = await runBackendForOpAndWait(check.session, 'vc')
      if (!r.ok) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: r.error, timings: r.timings || null }))
      }
      res.end(JSON.stringify({ ok: true, op: 'vc', spawned: true, timings: r.timings }))
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // ---------------- prover proxy (experimental) ----------------
  // POST /proxy-prover — forward the body verbatim to the Mysten ZK prover.
  // Used to attribute the ~2500 ms browser-side prover latency: when the
  // frontend points at this endpoint instead of prover-dev.mystenlabs.com
  // directly, we eliminate (a) the cross-WAN CORS preflight and (b) Mysten's
  // TLS handshake from the browser's path. See §5.8 of the paper.
  if (req.method === 'POST' && req.url === '/proxy-prover') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const upstream = (() => {
        // Read prover URL from frontend config.json so this path tracks any
        // future change (e.g. Mysten moving from /v1 to /v2). Fallback to
        // the well-known DevNet URL.
        try {
          const cfgPath = path.join(FRONTEND_DIR, 'src', 'config.json')
          const cfg = readJSON(cfgPath, {}) || {}
          if (typeof cfg.URL_ZK_PROVER === 'string' && cfg.URL_ZK_PROVER.startsWith('http')) return cfg.URL_ZK_PROVER
        } catch {}
        return 'https://prover-dev.mystenlabs.com/v1'
      })()
      const t0 = Date.now()
      try {
        const r = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const text = await r.text()
        const elapsed = Date.now() - t0
        // Surface server-perspective timing back to the client in a header so
        // we can subtract it from the browser-perspective measurement to
        // isolate browser-only overhead.
        res.setHeader('X-Proxy-Upstream-Ms', String(elapsed))
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = r.status
        res.end(text)
      } catch (e) {
        res.statusCode = 502
        res.end(JSON.stringify({ error: String(e?.message || e), upstream }))
      }
    })
    return
  }

  // ---------------- existing routes ----------------

  // salt-seeds persistence: read
  if (req.method === 'GET' && req.url === '/salt-seeds') {
    const data = readJSON(SALT_SEEDS_FILE, { saltSeeds: {}, selectedInstitutions: [] })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
    return
  }

  // salt-seeds persistence: write
  if (req.method === 'POST' && req.url === '/salt-seeds') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}')
        writeJSON(SALT_SEEDS_FILE, payload)
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.statusCode = 500
        res.end(String(e?.message || e))
      }
    })
    return
  }

  res.statusCode = 404
  res.end('not found')
})

/* ---------------------- bootstrap ---------------------- */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[bridge] Port ${PORT} is in use, attempting to release...`)
    import('node:child_process').then(({ execSync }) => {
      try {
        const pids = execSync(`lsof -ti :${PORT}`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
        for (const pid of pids) {
          if (String(pid) !== String(process.pid)) {
            try { process.kill(Number(pid), 'SIGKILL') } catch {}
          }
        }
        console.log(`[bridge] Released port ${PORT}, retrying in 1 second...`)
        setTimeout(() => server.listen(PORT), 1000)
      } catch {
        console.error(`[bridge] Cannot release port ${PORT}, please run manually: kill -9 $(lsof -ti :${PORT})`)
        process.exit(1)
      }
    })
  } else {
    console.error('[bridge] server error:', err)
    process.exit(1)
  }
})

server.listen(PORT, () => {
  console.log(`[bridge] ready: http://localhost:${PORT}/zklogin-session`)
  console.log(`[bridge] node=${process.execPath} platform=${process.platform}`)
})

// Start frontend
spawnFrontend()

// On startup, try to reuse existing session: check epoch validity + JWK validity.
// If both pass, auto-start backend (no browser re-login needed).
;(async () => {
  const last = readJSON(SESSION_FILE, null)
  if (!last) {
    console.log('[bridge] no saved session found, waiting for browser login')
    return
  }
  if (!last.GOOGLE_ID_TOKEN || !last.EPHEMERAL_PRIVATE_KEY || !last.JWT_RANDOMNESS || !last.MAX_EPOCH) {
    console.log('[bridge] saved session is incomplete, waiting for browser login')
    return
  }

  // 1) Epoch check
  let epochValid = false
  try {
    epochValid = await isSessionStillValid(last)
  } catch (e) {
    console.warn('[bridge] epoch check at startup failed:', String(e?.message || e))
    return
  }
  if (!epochValid) {
    console.log('[bridge] saved session expired by epoch, waiting for browser login')
    return
  }

  // 2) JWK pre-check — verify JWT's kid is still in provider's JWKS
  const jwkResult = await checkJwkValidity(last.GOOGLE_ID_TOKEN)
  if (jwkResult.skipped) {
    console.log(`[bridge] JWK pre-check skipped (${jwkResult.error || 'provider not supported'}), still attempting auto-start backend`)
  } else if (jwkResult.valid) {
    const src = jwkResult.fromCache ? `cache, age ${Math.round((jwkResult.ageMs || 0)/1000)}s` : 'fresh fetch'
    console.log(`[bridge] ✅ JWK pre-check passed: kid="${jwkResult.kid}" is still valid (${src})`)
  } else {
    console.log(`[bridge] ❌ JWK has rotated: ${jwkResult.error}`)
    console.log('[bridge] 👉 Please re-login in browser to obtain new JWT and zkProofs')
    return
  }

  // 3) Both checks passed — auto-start backend, reuse existing session
  console.log('[bridge] ✅ Existing session is still valid (epoch + JWK), auto-starting backend...')
  spawnBackend({
    GOOGLE_ID_TOKEN: last.GOOGLE_ID_TOKEN,
    EPHEMERAL_PRIVATE_KEY: last.EPHEMERAL_PRIVATE_KEY,
    JWT_RANDOMNESS: last.JWT_RANDOMNESS,
    MAX_EPOCH: last.MAX_EPOCH,
    USER_SALT: last.USER_SALT || '',
  })
})()

/* ---------------------- graceful shutdown ---------------------- */
function shutdown(sig) {
  console.log(`[bridge] received ${sig}, shutting down...`)
  server.close(() => console.log('[bridge] http server closed'))
  if (childFrontend && !childFrontend.killed) childFrontend.kill('SIGTERM')
  if (childBackend  && !childBackend.killed)  childBackend.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
