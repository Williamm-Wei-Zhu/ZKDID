// salt-service/server.mjs
// Institution-specific salt derivation service for zkDID Patient.
// Deterministically derives a 128-bit salt from (institution_seed, jwt.sub)
// using Poseidon hashing, matching the browser-side algorithm in
// zklogin/polymedia-zklogin-demo/web/src/App.tsx (deriveSaltFromSelectedSeeds).
//
// Deploy one instance per institution. Config via env vars (override file).
//
//   env                      file key           default
//   -------------------------------------------------------------------------
//   PORT                     port               7000
//   INSTITUTION_NAME         institution        "Institution 1"
//   INSTITUTION_SEED         seed               (required; no default)
//   CORS_ORIGIN              corsOrigin         "*"
//   VERIFY_JWT               verifyJwt          false
//   RATE_LIMIT_WINDOW_MS     rateLimit.windowMs 60000
//   RATE_LIMIT_MAX           rateLimit.max      60

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { buildPoseidon } from 'circomlibjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_PATH = path.join(__dirname, 'config.json')
const VERSION = '1.0.0'
const TWO_POW_128 = 1n << 128n

/* ---------------- config ---------------- */
function loadConfig() {
  let file = {}
  if (fs.existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) }
    catch (e) { console.warn('[salt] could not parse config.json:', e.message) }
  }
  const cfg = {
    institution: process.env.INSTITUTION_NAME || file.institution || 'Institution 1',
    seed: process.env.INSTITUTION_SEED || file.seed || null,
    port: Number(process.env.PORT || file.port || 7000),
    corsOrigin: process.env.CORS_ORIGIN || file.corsOrigin || '*',
    verifyJwt: (process.env.VERIFY_JWT ?? String(file.verifyJwt ?? 'false')).toLowerCase() === 'true',
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || file.rateLimit?.windowMs || 60_000),
      max: Number(process.env.RATE_LIMIT_MAX || file.rateLimit?.max || 60),
    },
  }
  if (!cfg.seed) {
    console.error('[salt] FATAL: no seed configured. Set INSTITUTION_SEED env or populate config.json.')
    process.exit(2)
  }
  try { BigInt(cfg.seed) } catch {
    console.error('[salt] FATAL: INSTITUTION_SEED must be a decimal integer string.')
    process.exit(2)
  }
  return cfg
}
const cfg = loadConfig()

/* ---------------- poseidon ---------------- */
let poseidon = null
async function getPoseidon() {
  if (!poseidon) poseidon = await buildPoseidon()
  return poseidon
}

function deriveSalt(seedBig, subBig) {
  const p = poseidon
  const out = p.F.toObject(p([seedBig, subBig]))
  // Reduce to 128 bits so the resulting salt matches Sui zkLogin's expectation.
  return out % TWO_POW_128
}

/* ---------------- jwt helpers ---------------- */
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8')
}
function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.')
  if (parts.length !== 3) throw new Error('JWT must have 3 dot-separated parts')
  try {
    return JSON.parse(b64urlDecode(parts[1]))
  } catch (e) {
    throw new Error('JWT payload is not valid JSON: ' + e.message)
  }
}

async function optionallyVerifyJwt(jwt) {
  if (!cfg.verifyJwt) return
  // Lightweight JWK-rotation check (signature verification proper would need node-jose
  // or similar — deliberately not pulling it in for a research-grade service).
  const header = JSON.parse(b64urlDecode(jwt.split('.')[0]))
  const payload = decodeJwtPayload(jwt)
  const iss = String(payload?.iss || '').toLowerCase()
  let jwksUrl = null
  if (iss.includes('accounts.google')) jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs'
  else if (iss.includes('twitch') || iss.includes('id.twitch.tv')) jwksUrl = 'https://id.twitch.tv/oauth2/keys'
  if (!jwksUrl) return
  const resp = await fetch(jwksUrl, { signal: AbortSignal.timeout(8000) })
  if (!resp.ok) return
  const jwks = await resp.json()
  const kids = (jwks.keys || []).map(k => k.kid)
  if (!kids.includes(header.kid)) {
    const err = new Error(`JWT kid "${header.kid}" not in provider JWKS (rotated?)`)
    err.status = 401
    throw err
  }
}

/* ---------------- rate limit (in-memory sliding window) ---------------- */
const hits = new Map() // ip -> [timestamps...]
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < cfg.rateLimit.windowMs)
  if (arr.length >= cfg.rateLimit.max) {
    res.status(429).json({ error: 'rate limit exceeded', retryAfterMs: cfg.rateLimit.windowMs })
    return
  }
  arr.push(now)
  hits.set(ip, arr)
  next()
}

/* ---------------- app ---------------- */
const app = express()
app.use(express.json({ limit: '32kb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin)
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

app.get('/healthz', (req, res) => {
  res.json({ ok: true, institution: cfg.institution, version: VERSION })
})

app.get('/institution', (req, res) => {
  // Intentionally does NOT return the seed.
  res.json({ name: cfg.institution, verifyJwt: cfg.verifyJwt })
})

// GET /seed — returns the institution's fixed 128-bit seed.
// This is the same value used internally by /get-salt to derive user salts.
// Clients call this to cache the seed locally so they can re-derive salts
// offline (same algorithm as /get-salt).
//
// Security note: the seed is the long-lived institution secret. Exposing it
// via an unauthenticated endpoint is acceptable for a research demo where
// the same seed is baked into a publicly-readable docker image, but a
// production deployment should gate this endpoint (mTLS, bearer token, etc.)
// via a reverse proxy.
app.get('/seed', rateLimit, (req, res) => {
  res.json({ seed: String(cfg.seed), institution: cfg.institution })
})

app.post('/get-salt', rateLimit, async (req, res) => {
  // Start server-side compute timer. `performance` is a Node 18+ global.
  const t0 = performance.now()
  try {
    const jwt = req.body?.jwt
    if (typeof jwt !== 'string' || !jwt) return res.status(400).json({ error: 'missing or invalid jwt' })
    await optionallyVerifyJwt(jwt)
    const payload = decodeJwtPayload(jwt)
    const sub = payload?.sub
    if (typeof sub !== 'string' || !/^\d+$/.test(sub)) {
      // Non-numeric subs (e.g. some providers) get hashed via keccak — to keep
      // v1 simple and match the browser's current behavior, we require numeric sub.
      return res.status(400).json({ error: 'jwt.sub must be a numeric string' })
    }
    await getPoseidon()
    const salt = deriveSalt(BigInt(cfg.seed), BigInt(sub))
    const computeMs = Math.round(performance.now() - t0)
    // Also emit as a standard Server-Timing header (clients can read it via
    // Resource Timing API). Body field is the primary channel for this app.
    res.set('Server-Timing', `compute;dur=${computeMs}`)
    res.set('Access-Control-Expose-Headers', 'Server-Timing')
    res.json({
      salt: salt.toString(),
      institution: cfg.institution,
      computeMs,
    })
  } catch (e) {
    const code = e?.status || 500
    res.status(code).json({ error: String(e?.message || e) })
  }
})

app.use((req, res) => res.status(404).json({ error: 'not found' }))

/* ---------------- start ---------------- */
app.listen(cfg.port, () => {
  console.log(`[salt] ${cfg.institution} listening on http://0.0.0.0:${cfg.port}`)
  console.log(`[salt]   verifyJwt=${cfg.verifyJwt} corsOrigin=${cfg.corsOrigin} rateLimit=${cfg.rateLimit.max}/${cfg.rateLimit.windowMs}ms`)
})
