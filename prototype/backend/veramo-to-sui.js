// veramo-to-sui.js
// Node 18+ / ESM
// 0823 minimal version (with timing stats): no Ethereum on-chain. Local did:ethr VC issuance + persistent zkLogin session + Sui on-chain.
// 1019 version: ehr_access smart contract deployed to DevNet, supporting access grant/revoke/check operations.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

// ────────────────────────────────────────────────────────────────────
// Veramo and the Ethereum DID provider were removed in the
// dependency-pruning refactor (see paper §VI Discussion).
//
// Why: of all the Veramo plugins that used to be instantiated here
// (KeyManager, KMS, DIDManager, DIDResolverPlugin, CredentialPlugin,
//  EthrDIDProvider, getEthrResolver), only four call sites in the
// hot path actually used the resulting `agent` object — and each of
// those calls was a ~1:1 wrapper around our own `JsonStore` class
// or our own `createJwtVcEd25519()` helper. Removing the wrappers
// shaves roughly 350-400 ms of cold-start work per /op/* invocation
// (NPM module imports + Veramo agent + plugin chain construction).
//
// What remains: direct calls to `keyStore.importKey()` /
// `didStore.set()` / `keyStore.get()` / `createJwtVcEd25519()`.
// Functional behavior on disk and on chain is identical.
//
// `ethers` was already removed earlier (no Ethereum address derivation
// any more).
// ────────────────────────────────────────────────────────────────────

// —— Sui
import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import {
  getZkLoginSignature,
  genAddressSeed,
  jwtToAddress,
  generateNonce,
  getExtendedEphemeralPublicKey,
} from '@mysten/sui/zklogin'

// =============== Timing Utility ===============
const T = {
  _t: new Map(),
  start(label) {
    this._t.set(label, performance.now())
  },
  end(label) {
    const t0 = this._t.get(label)
    const ms = t0 != null ? Math.round(performance.now() - t0) : -1
    this._t.set(label, ms)
    return ms
  },
  get(label) { return this._t.get(label) },
  dump(prefix = '⏱️ Timing Summary') {
    console.log(`\n${prefix}`)
    for (const [k, v] of this._t.entries()) {
      if (typeof v === 'number') console.log(`- ${k}: ${v} ms`)
    }
    console.log('')
  },
  // Serialize all finished timers (values that are already resolved to ms)
  // plus the supplied metadata so the frontend can display them.
  // Called at the end of the main flow and in the pre-failure summary path.
  saveToFile(filePath, meta = {}) {
    try {
      const timings = {}
      for (const [k, v] of this._t.entries()) {
        if (typeof v === 'number') timings[k] = v
      }
      const payload = { ...meta, timestampMs: Date.now(), timings }
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
    } catch (e) {
      console.warn('⚠️ Failed to save timings JSON (non-fatal):', e?.message)
    }
  },
}
console.log('🧩 process.argv =', process.argv);
// ================= Load zkLogin config.json =================
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_PATH = path.resolve(__dirname, '../frontend/src/config.json')

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ zkLogin config file not found:', CONFIG_PATH)
  process.exit(1)
}

let zkConfig
try {
  zkConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
} catch (e) {
  console.error('❌ Failed to read or parse config.json:', e.message)
  process.exit(1)
}

const PROVER_URL = zkConfig.URL_ZK_PROVER
const SUI_RPC_URL = zkConfig.network || 'https://fullnode.devnet.sui.io'
// Fallback RPC endpoint list (DevNet has multiple public nodes)
const SUI_RPC_FALLBACK_URLS = [
  'https://fullnode.devnet.sui.io',
  'https://devnet.suiet.app',
  'https://sui-devnet-endpoint.blockvision.org',
]
// Prefer USER_SALT from frontend (merged from institution seeds), otherwise fall back to config/env defaults
const ZKLOGIN_SALT = (
  process.env.USER_SALT
    ? process.env.USER_SALT
    : (zkConfig.salt ?? process.env.ZKLOGIN_SALT ?? '1234567890')
).toString()

// Twitch config (experimental; do not put secret in frontend files in production)
const TWITCH_CLIENT_ID = zkConfig.CLIENT_ID_TWITCH || ''
const TWITCH_CLIENT_SECRET = zkConfig.CLIENT_SECRET_TWITCH || ''

if (!PROVER_URL) {
  console.error('❌ config.json is missing URL_ZK_PROVER')
  process.exit(1)
}
console.log('📝 Loaded zkLogin config:', {
  PROVER_URL,
  SUI_RPC_URL,
  ZKLOGIN_SALT,
  ZKLOGIN_SALT_SOURCE: process.env.USER_SALT ? 'frontend institution seed merge' : 'config/env default',
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET: TWITCH_CLIENT_SECRET
    ? TWITCH_CLIENT_SECRET.slice(0, 6) + '...' + TWITCH_CLIENT_SECRET.slice(-4)
    : '(none)',
})

// ================= Environment Variables =================
const {
  GOOGLE_ID_TOKEN,
  EPHEMERAL_PRIVATE_KEY,
  JWT_RANDOMNESS,
  MAX_EPOCH,

  // INFURA_API_KEY removed — only consumed by the Sepolia EthrDIDProvider, which
  // is no longer instantiated.
  // ETH_PRIVATE_KEY_1/2/3 env vars are no longer read here — zkLogin sessions
  // are now keyed by user slot number (see selectUserSlot). Left blank
  // intentionally; delete from .env if you no longer need them elsewhere.

  SAVE_VC_TO_DIDS = 'true',
  INCLUDE_ID_TOKEN_IN_VC = 'false',
  SAVE_ID_TOKEN_TO_DIDS = 'true',
  ID_TOKEN_HISTORY_LIMIT = '5',
  PROVIDER,
} = process.env

// NOTE: hardcoded ETH private keys were removed — zkLogin does not need them.
// Session ownership is now tracked by a user slot (1|2|3) instead of an ETH address.

// Dynamic provider detection (when PROVIDER is not explicitly set)
function detectProviderFromIdTokenPayload(payload) {
  const iss = String(payload?.iss || '').toLowerCase()
  if (iss.includes('accounts.google')) return 'google'
  if (iss.includes('twitch') || iss.includes('id.twitch.tv')) return 'twitch'
  if (iss.includes('facebook')) return 'facebook'
  return PROVIDER && ['google', 'twitch', 'facebook'].includes(PROVIDER) ? PROVIDER : 'google'
}

// Select which user slot to use for zkLogin session storage and Veramo key naming.
// Supports --key=2 / --key-index=3 / positional arg 1|2|3 (same CLI as before).
// Replaces selectEthPrivateKey(): only the slot number is needed now — we no
// longer load any ETH private key.
function selectUserSlot() {
  const argv = process.argv.slice(2)
  let idx = 1
  for (const a of argv) {
    if (/^--key-index=\d+$/.test(a)) { idx = Number(a.split('=')[1]); break }
    if (/^--key=\d+$/.test(a)) { idx = Number(a.split('=')[1]); break }
    if (/^[123]$/.test(a)) { idx = Number(a); break }
  }
  if (![1,2,3].includes(idx)) idx = 1
  return { keyIndex: idx }
}

// SEPOLIA_RPC_URL and ZkloginDIDProvider removed in the dependency-pruning
// refactor. They were only ever consumed by the Veramo agent's EthrDIDProvider
// + DIDResolverPlugin and DIDManager registrations, which no longer exist.

// Extended JsonStore with Ed25519 support - moved above
class JsonStore {
  constructor(p) { this.path = p; if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({})) }
  async get(key) { return JSON.parse(fs.readFileSync(this.path, 'utf-8'))[key] }
  async set(key, value) { const d = JSON.parse(fs.readFileSync(this.path, 'utf-8')); d[key]=value; fs.writeFileSync(this.path, JSON.stringify(d,null,2)); return value }
  async delete(key) { const d = JSON.parse(fs.readFileSync(this.path, 'utf-8')); delete d[key]; fs.writeFileSync(this.path, JSON.stringify(d,null,2)); return true }
  async query() { return Object.values(JSON.parse(fs.readFileSync(this.path, 'utf-8'))) }
  async importKey(args) {
    // Fix: set correct algorithm based on key type
    const isEd25519 = args.type === 'Ed25519' || args.meta?.keyType === 'Ed25519'
    const key = {
      kid: args.kid, 
      alias: args.alias || args.kid, 
      kms: 'local', 
      type: isEd25519 ? 'Ed25519' : 'Secp256k1',
      privateKeyHex: args.privateKeyHex, 
      publicKeyHex: args.publicKeyHex,
      meta: isEd25519 ? 
        { algorithms: ['EdDSA'], keyType: 'Ed25519', kms: 'local' } :
        { algorithms: ['ES256K','ES256K-R','eth_signTransaction','eth_signTypedData','eth_signMessage','eth_rawSign'], keyType: 'Secp256k1', kms:'local' },
    }
    if (this.path.includes('privateKeys.json')) await this.set(key.kid, { kid:key.kid, alias:key.alias, privateKeyHex:key.privateKeyHex })
    else await this.set(key.kid, key)
    return key
  }
  async getKey(kidOrAlias) {
    const d = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    let key = d[kidOrAlias] || Object.values(d).find(k => k.alias === kidOrAlias)
    if (!key && typeof kidOrAlias === 'object') {
      if (kidOrAlias.kid && d[kidOrAlias.kid]) key = d[kidOrAlias.kid]
      else if (kidOrAlias.alias) key = Object.values(d).find(k => k.alias === kidOrAlias.alias)
    }
    if (!key) return null
    
    // Fix: preserve original key type and algorithm
    const isEd25519 = key.type === 'Ed25519' || key.meta?.keyType === 'Ed25519'
    return { 
      ...key, 
      kms:'local', 
      type: isEd25519 ? 'Ed25519' : 'Secp256k1',
      meta: isEd25519 ?
        { algorithms: ['EdDSA'], keyType: 'Ed25519', kms: 'local' } :
        { algorithms:['ES256K','ES256K-R','eth_signTransaction','eth_signTypedData','eth_signMessage','eth_rawSign'], keyType:'Secp256k1', kms:'local' }
    }
  }
  getRepository() {
    return {
      find: async () => this.query(),
      findOne: async (c) => (typeof c==='object' ? (c.kid ? this.getKey(c.kid) : (c.alias ? this.getKey(c.alias) : null)) : null),
      save: async (e) => { const k = await this.importKey(e); return this.getKey(k.kid) },
      delete: async ({kid}) => this.delete(kid),
    }
  }
}

// Persistent KV stores backing key/DID/private-key state. These are the same
// JsonStore instances Veramo's KeyManager/DIDManager used to wrap; we now call
// them directly (see notes at the top of the Veramo-removal block).
const keyStore = new JsonStore('./keys.json')
const privateKeyStore = new JsonStore('./privateKeys.json')
const didStore = new JsonStore('./dids.json')

// Local Ed25519 JWT VC generation function (fallback when Veramo fails)
function b64url(objOrBuf) {
  const buf = Buffer.isBuffer(objOrBuf)
    ? objOrBuf
    : Buffer.from(typeof objOrBuf === 'string' ? objOrBuf : JSON.stringify(objOrBuf))
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}
async function signEd25519Detached(privateKeyHex, data) {
  const { sign } = await import('@noble/ed25519')
  const sig = await sign(data, Buffer.from(privateKeyHex, 'hex'))
  return b64url(Buffer.from(sig))
}
async function createJwtVcEd25519({ issuerDid, subjectDid, keyId, privateKeyHex, vcData }) {
  const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT' }
  const now = new Date().toISOString()
  const payload = {
    iss: issuerDid,
    sub: subjectDid,
    iat: Math.floor(Date.now()/1000),
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      credentialSubject: vcData,
      issuanceDate: now,
      issuer: issuerDid,
    },
  }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const signature = await signEd25519Detached(privateKeyHex, Buffer.from(signingInput))
  return `${signingInput}.${signature}`
}

// ================== VC / JWT Persistence (to dids.json) ==================
async function appendVCToDidStore(did, vc) {
  const existing = (await didStore.get(did)) || {}
  const vcs = Array.isArray(existing.verifiableCredentials) ? existing.verifiableCredentials : []
  vcs.push(vc)
  await didStore.set(did, { ...existing, verifiableCredentials: vcs })
}

async function saveIdTokenToDidStore(did, idToken, limit = 5) {
  const existing = (await didStore.get(did)) || {}
  const history = Array.isArray(existing.idTokensHistory) ? existing.idTokensHistory : []
  history.push({ at: new Date().toISOString(), idToken })
  const trimmed = history.slice(-Number(limit || 5))
  await didStore.set(did, { ...existing, latestIdToken: idToken, idTokensHistory: trimmed })
}

// ================= Utility Functions =================
function decodeJwt(jwt) {
  const [, payloadB64] = jwt.split('.')
  const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  return JSON.parse(json)
}
function decodeB64orB64Url(s) {
  const b64 = String(s).trim().replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 2 ? '==' : b64.length % 4 === 3 ? '=' : ''
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'))
}
function toStdBase64(u8) { return Buffer.from(u8).toString('base64') }
function toHex(u8) { return Buffer.from(u8).toString('hex') }
// hex to bytes
function hexToBytes(hex) {
  const h = hex.replace(/^0x/, '').trim()
  if (h.length % 2 !== 0) throw new Error('public key hex length is not even')
  return Uint8Array.from(h.match(/.{2}/g).map(b => parseInt(b, 16)))
}
function b64urlFromBytes(u8) { return Buffer.from(u8).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') }

function parseEphemeralSecretKey(input) {
  const s = String(input || '').trim()
  if (!s) throw new Error('EPHEMERAL_PRIVATE_KEY is empty')
  if (s.startsWith('suiprivkey1')) {
    const { secretKey } = decodeSuiPrivateKey(s)
    if (secretKey?.length !== 32) throw new Error(`bech32 decoded length is not 32 bytes (got ${secretKey?.length || 0})`)
    return secretKey
  }
  try {
    const b = decodeB64orB64Url(s)
    if (b.length === 32) return b
    if (b.length === 64) return b.slice(0, 32)
  } catch {}
  if (/^(0x)?[0-9a-fA-F]+$/.test(s)) {
    const hex = s.startsWith('0x') ? s.slice(2) : s
    const buf = Buffer.from(hex, 'hex')
    if (buf.length === 32) return new Uint8Array(buf)
    if (buf.length === 64) return new Uint8Array(buf.slice(0, 32))
  }
  throw new Error('EPHEMERAL_PRIVATE_KEY has invalid format: must be suiprivkey(bech32) or 32/64-byte base64/base64url/hex')
}

function beBigIntFromBytes(u8) { return BigInt('0x' + Buffer.from(u8).toString('hex')) }
function bigIntToBytesBE(bn, len) {
  let hex = bn.toString('16')
  if (hex.length > len * 2) hex = hex.slice(-len * 2)
  hex = hex.padStart(len * 2, '0')
  return new Uint8Array(Buffer.from(hex, 'hex'))
}
async function generateNoncePoseidonLocal(extended33, maxEpoch, randomness16) {
  const mod = await import('circomlibjs')
  const poseidon = await mod.buildPoseidon()
  const extBig = beBigIntFromBytes(extended33)
  const limbHi = extBig >> 128n
  const limbLo = extBig & ((1n << 128n) - 1n)
  const h  = poseidon([limbHi, limbLo, BigInt(maxEpoch), beBigIntFromBytes(randomness16)])
  const h32 = bigIntToBytesBE(h, 32)
  return b64urlFromBytes(h32.slice(-20))
}
function getExtendedEphemeralPublicKeyCompat(publicKey) {
  const raw = publicKey.toRawBytes() // 32B
  const extended = new Uint8Array(1 + raw.length)
  extended[0] = 0x00 // Ed25519 scheme flag
  extended.set(raw, 1)
  return extended // 33B
}
function debugNonceSHA256({ ephPublicKey, maxEpoch, randomnessBytes, jwtNonce }) {
  const rawPub = ephPublicKey.toRawBytes()
  const extended33 = getExtendedEphemeralPublicKeyCompat(ephPublicKey)
  const epochLE8 = Buffer.alloc(8); epochLE8.writeBigUInt64LE(BigInt(maxEpoch))
  const data = Buffer.concat([Buffer.from(extended33), epochLE8, Buffer.from(randomnessBytes)])
  const sha = crypto.createHash('sha256').update(data).digest()
  console.log('\n======= 🔬 Nonce Calculation Debug (SHA-256 comparison) START =======')
  console.log('JWT.nonce      =', jwtNonce)
  console.log('raw pub (32B)  =', toHex(rawPub))
  console.log('ext (33B)      =', toHex(extended33))
  console.log('epoch(LE8) hex =', epochLE8.toString('hex'))
  console.log('rand(16B) hex  =', toHex(randomnessBytes))
  console.log('sha256 b64url  =', b64urlFromBytes(sha))
  console.log('======= 🔬 Nonce Calculation Debug (SHA-256 comparison) END =======\n')
}

// ============== JWKS Cache (step 6.1b optimization) ==============
// Caches the provider's JWKS `kid` list on disk so we don't do a fresh HTTPS
// round-trip on every backend run. The previous implementation fetched
// https://www.googleapis.com/oauth2/v3/certs every time, costing ~100-200 ms.
// Google sends `Cache-Control: max-age=...` (typically 6h) on that endpoint;
// we honor it, falling back to a 1h TTL if absent.
//
// Correctness note: if the current JWT's `kid` is *not* in the cached list,
// we force a fresh fetch before declaring "JWK rotated". This prevents false
// positives when the provider mints a new key and our cache is stale-but-not-expired.
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
  catch (e) { console.warn('⚠️ JWKS cache write failed (non-fatal):', e?.message) }
}
async function fetchAndCacheJwks(url) {
  const resp = await fetch(url)
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
// Returns { kids, fromCache, ageMs } — caller may force a refresh on cache miss.
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

// ============== Balance / Faucet Cache (step 6.4b optimization) ==============
// Caches the "last known sufficient balance" per zkLogin userAddress so the
// step-6.4b pre-flight can be skipped on warm runs. Balance only decreases in a
// single dev session, so a short TTL is safe; we also invalidate proactively
// from the tx submit loop when it reports InsufficientGas (reactive fallback).
const BALANCE_CACHE_PATH = path.resolve(__dirname, '.sui-balance-cache.json')
const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 min
const GAS_FLOOR_MIST = 50_000_000n // 0.05 SUI — matches the historical threshold

function readBalanceCache() {
  try {
    const raw = fs.readFileSync(BALANCE_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch { return {} }
}
function writeBalanceCache(cache) {
  try { fs.writeFileSync(BALANCE_CACHE_PATH, JSON.stringify(cache, null, 2)) }
  catch (e) { console.warn('⚠️ Balance cache write failed (non-fatal):', e?.message) }
}
function isBalanceCachedSufficient(userAddress) {
  const entry = readBalanceCache()[userAddress]
  if (!entry || !Number.isFinite(entry.expiresAt)) return null
  if (entry.expiresAt <= Date.now()) return null
  return entry // { balanceMist, checkedAt, expiresAt }
}
function markBalanceSufficient(userAddress, balanceMist) {
  const cache = readBalanceCache()
  cache[userAddress] = {
    balanceMist: String(balanceMist),
    checkedAt: Date.now(),
    expiresAt: Date.now() + BALANCE_CACHE_TTL_MS,
  }
  writeBalanceCache(cache)
}
function invalidateBalanceCache(userAddress) {
  const cache = readBalanceCache()
  if (userAddress in cache) {
    delete cache[userAddress]
    writeBalanceCache(cache)
  }
}

// Shared faucet-request helper — used both by the pre-flight top-up and by the
// reactive tx-loop fallback. Replaces the old hardcoded 3s sleep with a
// getBalance poll (same ~3s max budget, but exits early when tokens land).
async function requestDevnetFaucet(userAddress, suiClient) {
  console.log(`💧 Requesting gas from DevNet faucet for ${userAddress.slice(0, 10)}…`)
  let ok = false
  try {
    const resp = await fetch('https://faucet.devnet.sui.io/v2/gas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient: userAddress } }),
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      console.warn(`⚠️ Faucet request failed: ${resp.status} ${String(txt).slice(0, 200)}`)
      return false
    }
    ok = true
  } catch (e) {
    console.warn('⚠️ Faucet request network error:', e?.message)
    return false
  }

  // Poll for the balance to reach the gas floor (up to 6 × 500ms = 3s).
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const bal = await suiClient.getBalance({ owner: userAddress, coinType: '0x2::sui::SUI' })
      if (BigInt(bal.totalBalance) >= GAS_FLOOR_MIST) {
        console.log(`✅ Faucet drop landed (${bal.totalBalance} MIST) after ${(i + 1) * 500}ms`)
        markBalanceSufficient(userAddress, bal.totalBalance)
        return true
      }
    } catch { /* keep polling */ }
  }
  console.warn('⚠️ Faucet responded OK but balance did not reach gas floor within 3s — proceeding anyway')
  return ok
}

// ============== Gas Metadata Cache (step 6.5 optimization) ==============
// Eliminates the two RPCs that step 6.5 otherwise needs (getReferenceGasPrice +
// getCoins). Stored together in .sui-gas-cache.json with structure:
//   {
//     referenceGasPrice: { price, cachedAt, expiresAt },
//     coinRefs: { [userAddress]: { objectId, version, digest, estimatedBalanceMist, updatedAt } }
//   }
//
// Correctness:
//   - Gas price: changes at most once per epoch (~30 min on DevNet). 5-min TTL
//     is conservative; if we ever use a stale price and the node rejects it,
//     the submit-loop error path will surface the failure and we invalidate.
//   - Coin ref: (objectId, version, digest) of the coin consumed most recently.
//     Refreshed from effects.gasObject.reference after each successful tx,
//     along with a computed post-consumption balance. If the cache becomes
//     stale (e.g., the coin was spent by another process), the submit loop
//     raises InsufficientGas / object-version errors, we invalidate and the
//     next run re-fetches via getCoins.
const GAS_CACHE_PATH = path.resolve(__dirname, '.sui-gas-cache.json')
const GAS_PRICE_TTL_MS = 5 * 60 * 1000 // 5 min

function readGasCache() {
  try {
    const raw = fs.readFileSync(GAS_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch { return {} }
}
function writeGasCache(cache) {
  try { fs.writeFileSync(GAS_CACHE_PATH, JSON.stringify(cache, null, 2)) }
  catch (e) { console.warn('⚠️ Gas cache write failed (non-fatal):', e?.message) }
}
function getCachedGasPrice() {
  const entry = readGasCache().referenceGasPrice
  if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) return null
  return entry.price
}
function setCachedGasPrice(price) {
  const cache = readGasCache()
  cache.referenceGasPrice = {
    price: String(price),
    cachedAt: Date.now(),
    expiresAt: Date.now() + GAS_PRICE_TTL_MS,
  }
  writeGasCache(cache)
}
function invalidateCachedGasPrice() {
  const cache = readGasCache()
  if (cache.referenceGasPrice) {
    delete cache.referenceGasPrice
    writeGasCache(cache)
  }
}
function getCachedCoinRef(userAddress) {
  const entry = (readGasCache().coinRefs || {})[userAddress]
  if (!entry || !entry.objectId) return null
  // If we have an estimate and it's below the gas floor, treat as stale.
  if (typeof entry.estimatedBalanceMist === 'string') {
    try {
      if (BigInt(entry.estimatedBalanceMist) < GAS_FLOOR_MIST) return null
    } catch { return null }
  }
  return entry
}
function setCachedCoinRef(userAddress, { objectId, version, digest, estimatedBalanceMist }) {
  const cache = readGasCache()
  if (!cache.coinRefs) cache.coinRefs = {}
  cache.coinRefs[userAddress] = {
    objectId, version, digest,
    estimatedBalanceMist: String(estimatedBalanceMist ?? '0'),
    updatedAt: Date.now(),
  }
  writeGasCache(cache)
}
function invalidateCachedCoinRef(userAddress) {
  const cache = readGasCache()
  if (cache.coinRefs && cache.coinRefs[userAddress]) {
    delete cache.coinRefs[userAddress]
    writeGasCache(cache)
  }
}

// ============== zkLogin Session Persistence to dids.json ==============
async function loadLatestZkSession(did) {
  const existing = (await didStore.get(did)) || {}
  const arr = Array.isArray(existing.zkLoginSessions) ? existing.zkLoginSessions : []
  arr.sort((a, b) => (a.created || '').localeCompare(b.created || ''))
  return arr[arr.length - 1] || null
}
async function saveZkSession(did, session) {
  const existing = (await didStore.get(did)) || {}
  const arr = Array.isArray(existing.zkLoginSessions) ? existing.zkLoginSessions : []
  const entry = {
    created: new Date().toISOString(),
    idToken: String(session.idToken),
    ephemeralPrivateKey: String(session.ephemeralPrivateKey),
    randomness: String(session.randomness),
    maxEpoch: Number(session.maxEpoch),
    sub: session.sub ? String(session.sub) : undefined,
    aud: session.aud ? String(session.aud) : undefined,
    userAddress: session.userAddress ? String(session.userAddress) : undefined,
  }
  arr.push(entry)
  await didStore.set(did, { ...existing, zkLoginSessions: arr, latestZkLoginSession: entry })
}

// ----------------- Fine-grained RPC endpoint probe (header / ttfb / download) ---------------
async function probeRpcTiming(url, rpcMethod, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', method: rpcMethod, params, id: 1 })
  const fetchStart = performance.now()
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch((e) => { throw new Error(`probeRpcTiming fetch failed: ${e?.message || e}`) })
  const afterFetchHeaders = performance.now()

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '<unable to read response body>')
    throw new Error(`probeRpcTiming returned error: ${resp.status} ${txt}`)
  }

  // Read body stream to measure Time-to-First-Byte and total download time
  let firstByteAt = null
  let bodyBuffer = Buffer.alloc(0)
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstByteAt === null) firstByteAt = performance.now()
      if (value) bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(value)])
    }
  } else {
    const ab = await resp.arrayBuffer()
    bodyBuffer = Buffer.from(ab)
    firstByteAt = afterFetchHeaders
  }
  const fetchEnd = performance.now()

  const totalMs = Math.round(fetchEnd - fetchStart)
  const headerMs = Math.round(afterFetchHeaders - fetchStart)
  const timeToFirstByteMs = Math.round((firstByteAt || afterFetchHeaders) - fetchStart)
  const downloadMs = Math.round(fetchEnd - (firstByteAt || afterFetchHeaders))

  const bodyText = bodyBuffer.length ? bodyBuffer.toString('utf-8') : ''
  let parsed = null
  try { parsed = JSON.parse(bodyText) } catch (e) { parsed = { raw: bodyText } }

  console.log(`🔎 RPC probe ${rpcMethod} timing (ms):`, { totalMs, headerMs, timeToFirstByteMs, downloadMs, bodyBytes: bodyBuffer.length })
  return { parsed, timings: { totalMs, headerMs, timeToFirstByteMs, downloadMs } }
}

async function getActiveZkSessionOrNull(did, suiRpcUrl) {
  // Do a lightweight probe first to get RPC timing info (for comparison with Prover header/ttfb)
  try {
    const probe = await probeRpcTiming(suiRpcUrl, 'sui_getLatestSuiSystemState', [])
    // Try to parse epoch from probe JSON response (if successful, no need to use SuiClient)
    const result = probe.parsed?.result || probe.parsed
    const epochVal = result?.epoch ?? (result && result.epoch) ?? null
    if (epochVal != null) {
      const currentEpoch = Number(epochVal)
      const latest = await loadLatestZkSession(did)
      if (!latest) return null
      if (Number(latest.maxEpoch) >= currentEpoch) return latest
      return null
    }
    // If probe doesn't contain expected fields, fall back to SuiClient (compatibility)
  } catch (e) {
    console.warn('⚠️ probeRpcTiming failed (ignoring, will try SuiClient):', e?.message || e)
  }

  // Fallback: use SuiClient to query epoch (still recording timing)
  try {
    const cli = new SuiClient({ url: suiRpcUrl })
    const t0 = performance.now()
    const state = await cli.getLatestSuiSystemState()
    const t1 = performance.now()
    console.log('🔎 SuiClient.getLatestSuiSystemState totalMs:', Math.round(t1 - t0), 'ms')
    const currentEpoch = Number(state.epoch)
    const latest = await loadLatestZkSession(did)
    if (!latest) return null
    if (Number(latest.maxEpoch) >= currentEpoch) return latest
    return null
  } catch (e) {
    console.warn('⚠️ Cannot access Sui RPC (getLatestSuiSystemState failed), suiRpcUrl=', suiRpcUrl, ', error:', e?.message || e)
    return null
  }
}

// —— Randomness normalization
function normalizeRandomnessForZklogin(input) {
  const s0 = String(input ?? '')
  const s = s0.trim()
  if (!s) throw new Error('JWT_RANDOMNESS is empty')
  try {
    const bytes = decodeB64orB64Url(s)
    if (bytes.length === 16) {
      const u8 = new Uint8Array(bytes)
      return { kind: 'bytes16', bytes: u8, base64: toStdBase64(u8) }
    }
    if (bytes.length > 0) throw new Error(`JWT_RANDOMNESS looks like base64 but is not 16 bytes (${bytes.length})`)
  } catch {}
  const csv = s.replace(/\s+/g, '')
  if (/^\d+(?:,\d+){15}$/.test(csv)) {
    const arr = csv.split(',').map(x => Number(x))
    if (!arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Decimal byte string contains values outside 0..255')
    const u8 = Uint8Array.from(arr)
    return { kind: 'bytes16', bytes: u8, base64: toStdBase64(u8) }
  }
  if (/^(?:0x)?[0-9a-fA-F]{1,2}(?:,(?:0x)?[0-9a-fA-F]{1,2}){15}$/.test(csv)) {
    const arr = csv.split(',').map(x => parseInt(x.replace(/^0x/i, ''), 16))
    if (!arr.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('Hex byte string contains values outside 0..255')
    const u8 = Uint8Array.from(arr)
    return { kind: 'bytes16', bytes: u8, base64: toStdBase64(u8) }
  }
  if (/^\d+$/.test(s)) return { kind: 'decimal', str: s }
  if (/^(0x)?[0-9a-fA-F]+$/.test(s)) return { kind: 'hex', str: s.startsWith('0x') ? s : '0x' + s }
  throw new Error('Unrecognized JWT_RANDOMNESS format: expected base64(16B) / decimal integer string / 0xhex / 16B CSV')
}
function toBytes16FromDecimalOrHex(str) {
  let bn = BigInt(str)
  const mask = (1n << 128n) - 1n
  bn = bn & mask
  const out = Buffer.alloc(16)
  for (let i = 15; i >= 0; i--) { out[i] = Number(bn & 0xffn); bn >>= 8n }
  return new Uint8Array(out)
}

// ================= zkLogin DID Generation and Formatting =================
function generateZkLoginDID(userAddress, provider = 'google') {
  return `did:zklogin:${provider}:${userAddress}`
}

async function createZkLoginDIDDocument(session, userAddress, ephPublicKey, proof) {
  const providerFromPayload = detectProviderFromIdTokenPayload(decodeJwt(session.idToken))
  const didId = generateZkLoginDID(userAddress, providerFromPayload)
  
  // Fix: properly handle ephemeral public key conversion
  let ephPublicKeyBytes
  if (ephPublicKey && typeof ephPublicKey.toRawBytes === 'function') {
    ephPublicKeyBytes = ephPublicKey.toRawBytes()
  } else if (Buffer.isBuffer(ephPublicKey)) {
    ephPublicKeyBytes = ephPublicKey
  } else if (ephPublicKey instanceof Uint8Array) {
    ephPublicKeyBytes = ephPublicKey
  } else {
    throw new Error('Unrecognized ephemeral public key format')
  }
  
  const publicKeyMultibase = 'z' + Buffer.from(ephPublicKeyBytes).toString('base64url')
  
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://zklogin.example.org/did/v1"
    ],
    "id": didId,
    "verificationMethod": [
      {
        "id": "#zklogin-proof",
        "type": "ZkLoginOIDCProof2025",
        "controller": didId,
        "oidcProvider": "https://accounts.google.com",
        "salt": `0x${BigInt(ZKLOGIN_SALT).toString(16)}`,
        "maxEpoch": String(session.maxEpoch),
        "publicKeyMultibase": publicKeyMultibase,
        "zkProof": {
          "type": "Groth16",
          "curve": "BLS12-381",
          "proof": proof ? JSON.stringify(proof) : null,
          "inputs": {
            "identityHash": session.sub ? `0x${Buffer.from(session.sub).toString('hex')}` : null,
            "address": userAddress
          }
        }
      }
    ],
    "authentication": [
      "#zklogin-proof"
    ],
    "service": [
      {
        "id": "#resolver",
        "type": "ZkLoginResolver",
        "serviceEndpoint": "https://zklogin.example.org/resolver"
      }
    ]
  }
}

// Modify Veramo DID store to include zkLogin DID document
async function saveZkLoginDIDDocument(session, userAddress, ephPublicKey, proof = null) {
  const zkDidDoc = await createZkLoginDIDDocument(session, userAddress, ephPublicKey, proof)
  const zkDid = zkDidDoc.id
  
  const existing = (await didStore.get(zkDid)) || {}
  await didStore.set(zkDid, {
    ...existing,
    zkLoginDIDDocument: zkDidDoc,
    created: new Date().toISOString(),
    userAddress,
    ephemeralPublicKey: ephPublicKey.toRawBytes(),
    session: {
      idToken: session.idToken,
      sub: session.sub,
      aud: session.aud,
      maxEpoch: session.maxEpoch
    }
  })
  
  console.log(`✅ zkLogin DID document saved: ${zkDid}`)
  return zkDidDoc
}

// ================= Core: Send zkLogin Transaction (with step 6.x timing) =================
async function sendOnSuiWithZkLogin({ did, vc, session, publicKeyHex }) {
  // (Legacy function kept for reference; main flow now uses sendOnSuiWithZkLoginSplit)
  const label = (s) => `6.${s}`
  const suiClient = new SuiClient({ url: SUI_RPC_URL })
  // ...existing code (no changes needed)...
  return { result, userAddress }
}

// ================= Main Flow (legacy combined; renamed to legacyMainCombined) =================
async function legacyMainCombined() {
  // Legacy main function content unchanged (call legacyMainCombined() manually if needed)
  // ...existing code...
  T.dump('⏱️ Full Process Timing Details')
}
// (Note: remove/comment out any old main() call here. New split CLI main() is below)

// ================= CLI Operation Parser =================
function parseCli() {
  const argv = process.argv.slice(2)
  let op = null
  const params = {}
  for (const a of argv) {
    if (a.startsWith('--op=')) { op = a.split('=')[1] }
    else if (['did','vc','access'].includes(a) && !op) { op = a }
    else if (a.startsWith('--grantee-did=')) params.granteeDid = a.split('=')[1]
    else if (a.startsWith('--hospital-did=')) params.hospitalDid = a.split('=')[1]
    else if (a.startsWith('--record-id=')) params.recordId = a.split('=')[1]
    else if (a.startsWith('--vc-file=')) params.vcFile = a.split('=')[1]
  }
  // If neither --op= nor a positional op was provided, fall back to the OP
  // environment variable (set by the bridge when triggered via /op/<name>).
  if (!op && process.env.OP && ['did','vc','access'].includes(process.env.OP)) {
    op = process.env.OP
  }
  if (!op) op = 'vc'
  if (!['did','vc','access'].includes(op)) {
    console.error('❌ --op must be one of: did | vc | access')
    process.exit(1)
  }
  return { op, params }
}

// ================= Construct and Send Transaction (split by operation) =================
async function sendOnSuiWithZkLoginSplit({ op, did, vc, session, publicKeyHex, hospitalDid, granteeDid, recordId, preloadedZkProofs }) {
  const label = (s) => `6.${s}`
  const suiClient = new SuiClient({ url: SUI_RPC_URL })

  // 6.1~6.3: Common preparation
  T.start(label('1-3_restore_key+randomness+nonce_verify+address_seed'))
  const ephSecret = parseEphemeralSecretKey(session.ephemeralPrivateKey)
  const eph = Ed25519Keypair.fromSecretKey(ephSecret)
  const maxEpoch = Number(session.maxEpoch)
  if (!Number.isFinite(maxEpoch)) throw new Error(`MAX_EPOCH is invalid (current: ${session.maxEpoch}).`)
  const rnd = normalizeRandomnessForZklogin(session.randomness)
  const randomnessBytes16 = (rnd.kind === 'bytes16') ? rnd.bytes : toBytes16FromDecimalOrHex(rnd.str)
  const randomnessB64ForProver = (rnd.kind === 'bytes16') ? rnd.base64 : toStdBase64(randomnessBytes16)
  const payload = decodeJwt(session.idToken)
  const jwtNonce = payload?.nonce
  if (!jwtNonce) throw new Error('Missing nonce in id_token')

  const extAny = getExtendedEphemeralPublicKey(eph.getPublicKey())
  const extended33 = extAny instanceof Uint8Array ? extAny : Buffer.from(String(extAny), 'base64')
  const randomnessForSdk = rnd.kind === 'bytes16' ? randomnessBytes16 : rnd.str
  const sdkNonce = generateNonce(eph.getPublicKey(), maxEpoch, randomnessForSdk)
  if (sdkNonce !== jwtNonce) {
    debugNonceSHA256({ ephPublicKey: eph.getPublicKey(), maxEpoch, randomnessBytes: randomnessBytes16, jwtNonce })
    throw new Error('Nonce mismatch: please verify session key/randomness/maxEpoch/id_token.')
  }
  const { sub, aud } = payload
  const audStr = Array.isArray(aud) ? aud[0] : aud
  const saltBigInt = BigInt(ZKLOGIN_SALT)
  const userAddress = jwtToAddress(session.idToken, saltBigInt)
  const addressSeed = genAddressSeed(saltBigInt, 'sub', String(sub), String(audStr)).toString()
  T.end(label('1-3_restore_key+randomness+nonce_verify+address_seed'))

  // Kick off on-chain precondition prefetch IN PARALLEL with the rest of the flow
  // (JWK precheck, prover, faucet). These two RPCs are what `tx.sign({ client })`
  // does implicitly; by hoisting them out we let step 6.5 become pure-local work.
  // Cache-first: skip RPC entirely for whichever of (price, coin) is already
  // cached, so warm runs hit zero network in this section.
  const gasMetadataPromise = (async () => {
    try {
      const cachedPrice = getCachedGasPrice()
      const cachedCoin = getCachedCoinRef(userAddress)

      const pricePromise = cachedPrice != null
        ? Promise.resolve({ fromCache: true, value: cachedPrice })
        : suiClient.getReferenceGasPrice().then(v => ({ fromCache: false, value: v }))

      const coinPromise = cachedCoin != null
        ? Promise.resolve({
            fromCache: true,
            value: { data: [{
              coinObjectId: cachedCoin.objectId,
              version: cachedCoin.version,
              digest: cachedCoin.digest,
              balance: cachedCoin.estimatedBalanceMist,
            }] },
          })
        : suiClient.getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' })
            .then(v => ({ fromCache: false, value: v }))

      const [priceR, coinR] = await Promise.all([pricePromise, coinPromise])

      // Populate gas-price cache from a fresh fetch (coin cache is populated
      // post-tx from effects.gasObject, never from getCoins directly, because
      // we want exact post-consumption versions).
      if (!priceR.fromCache && priceR.value != null) {
        try { setCachedGasPrice(String(priceR.value)) } catch {}
      }

      console.log(`🔧 Gas prefetch: price=${priceR.fromCache ? 'CACHE' : 'RPC'}, coin=${coinR.fromCache ? 'CACHE' : 'RPC'}`)
      return { price: priceR.value, coins: coinR.value }
    } catch (e) {
      console.warn('⚠️ Gas metadata prefetch failed (will fall back to SDK-managed path at sign time):', e?.message)
      return null
    }
  })()
  let faucetJustFired = false // set by step 6.4b when it actually invokes the faucet

  // 6.1b: JWK pre-check — verify JWT header kid is still in provider's JWKS.
  // Uses an on-disk cache (see JWKS Cache section above) so this is ~0 ms on
  // cache hits and only spends a network round-trip when the cache is cold or
  // the kid isn't found (stale-cache double-check).
  T.start(label('1b_JWK_precheck'))
  try {
    const jwtHeader = JSON.parse(Buffer.from(session.idToken.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString())
    const kid = jwtHeader?.kid
    const iss = payload?.iss || 'https://accounts.google.com'
    if (kid) {
      // Pick JWKS endpoint by issuer. (Twitch supported; Facebook uses a
      // different verification path and is intentionally skipped here.)
      let jwksUrl = null
      if (iss.includes('accounts.google')) jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs'
      else if (iss.includes('twitch') || iss.includes('id.twitch.tv')) jwksUrl = 'https://id.twitch.tv/oauth2/keys'

      if (jwksUrl) {
        // First pass: prefer cached kids.
        let { kids: validKids, fromCache, ageMs } = await getJwksKids(jwksUrl)

        // If the kid isn't in the cached set, the cache may just be stale
        // (provider rotated but our entry hasn't expired yet). Force a fresh
        // fetch before declaring "rotated" to avoid false positives.
        if (!validKids.includes(kid) && fromCache) {
          console.log(`🔁 kid="${kid}" not in cached JWKS (age ${Math.round(ageMs/1000)}s) — refreshing…`)
          ;({ kids: validKids } = await getJwksKids(jwksUrl, { forceRefresh: true }))
        }

        if (!validKids.includes(kid)) {
          console.error(`❌ JWK expired: JWT kid="${kid}" not found in current JWKS`)
          console.error(`   Currently valid kids: ${validKids.join(', ')}`)
          console.error('👉 Please re-login in browser to get a new JWT and zkProofs')
          T.end(label('1b_JWK_precheck'))
          throw new Error(`JWK rotated: kid "${kid}" is expired, please re-login`)
        }
        const src = fromCache ? `cache, age ${Math.round(ageMs/1000)}s` : 'fresh fetch'
        console.log(`✅ JWK pre-check passed: kid="${kid}" is valid (${src})`)
      }
    }
  } catch (e) {
    if (e.message.includes('JWK rotated')) throw e
    console.warn('⚠️ JWK pre-check skipped:', e?.message)
  }
  T.end(label('1b_JWK_precheck'))

  // 6.4: Prover (skip if frontend already provided zkProofs)
  T.start(label('4_request_Prover'))
  let proof = {}

  if (preloadedZkProofs && typeof preloadedZkProofs === 'object' && Object.keys(preloadedZkProofs).length > 0) {
    proof = preloadedZkProofs
    console.log('✅ Using zkProofs from frontend, skipping Prover request')
  } else {
    const proverBody = {
      jwt: String(session.idToken),
      extendedEphemeralPublicKey: toStdBase64(extended33),
      maxEpoch: String(maxEpoch),
      jwtRandomness: String(randomnessB64ForProver),
      salt: String(ZKLOGIN_SALT),
      keyClaimName: 'sub',
    }

    console.log('🔗 Requesting Prover URL:', PROVER_URL)
    console.log('📦 Prover request body size:', JSON.stringify(proverBody).length, 'bytes')

    let resp
    let retryCount = 0
    const maxRetries = 2

    while (retryCount <= maxRetries) {
      try {
        const fetchStart = performance.now()
        resp = await fetch(`${PROVER_URL}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(proverBody),
          timeout: 30000
        })
        const afterFetchHeaders = performance.now()

        if (!resp.ok) {
          const txt = await resp.text().catch(() => '')
          throw new Error(`Prover returned error: ${resp.status} ${txt}`)
        }

        let firstByteAt = null
        let bodyBuffer = Buffer.alloc(0)
        if (resp.body?.getReader) {
          const reader = resp.body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (firstByteAt === null) firstByteAt = performance.now()
            if (value) bodyBuffer = Buffer.concat([bodyBuffer, Buffer.from(value)])
          }
        } else {
          const ab = await resp.arrayBuffer()
          bodyBuffer = Buffer.from(ab)
          firstByteAt = afterFetchHeaders
        }
        const fetchEnd = performance.now()

        const totalMs = Math.round(fetchEnd - fetchStart)
        const headerMs = Math.round(afterFetchHeaders - fetchStart)
        const timeToFirstByteMs = Math.round((firstByteAt || afterFetchHeaders) - fetchStart)
        const downloadMs = Math.round(fetchEnd - (firstByteAt || afterFetchHeaders))

        try {
          proof = bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf-8')) : {}
        } catch (parseErr) {
          console.error('🔥 Failed to parse Prover response:', parseErr.message)
          console.log('🔥 Raw response:', bodyBuffer.toString('utf-8').slice(0, 500))
          throw parseErr
        }

        console.log('🔎 Prover timing (ms):', { totalMs, headerMs, timeToFirstByteMs, downloadMs, bodyBytes: bodyBuffer.length })
        break

      } catch (fetchErr) {
        retryCount++
        console.error(`🔥 Prover request failed (attempt ${retryCount}/${maxRetries + 1}):`, fetchErr.message)

        if (retryCount > maxRetries) {
          throw new Error(`Prover request failed after ${maxRetries} retries: ${fetchErr.message}`)
        }

        console.log(`⏳ Waiting ${retryCount * 2}s before retry...`)
        await new Promise(resolve => setTimeout(resolve, retryCount * 2000))
      }
    }
  }

  T.end(label('4_request_Prover'))

  // 6.4b: Auto-request gas from DevNet faucet (cached pre-flight + reactive fallback).
  // On warm runs (< 5 min since a sufficient-balance observation) we skip the
  // network call entirely. On cold runs we do one balance RPC and top up if
  // needed. If balance drains between here and tx submit, the submit loop's
  // reactive fallback (see "InsufficientGas" branch below) will top up and retry.
  T.start(label('4b_request_Faucet'))
  try {
    const cached = isBalanceCachedSufficient(userAddress)
    if (cached) {
      const ageS = Math.round((Date.now() - cached.checkedAt) / 1000)
      console.log(`💰 Balance cache hit (${cached.balanceMist} MIST, age ${ageS}s) — skipping faucet pre-check`)
    } else {
      const bal = await suiClient.getBalance({ owner: userAddress, coinType: '0x2::sui::SUI' })
      const balMist = BigInt(bal.totalBalance)
      if (balMist < GAS_FLOOR_MIST) {
        console.log(`💰 Insufficient balance (${balMist} MIST < ${GAS_FLOOR_MIST}) — requesting faucet top-up…`)
        await requestDevnetFaucet(userAddress, suiClient)
        // requestDevnetFaucet marks the cache itself on a successful drop.
        // Signal step 6.5 that its pre-fetched coins are stale (new faucet drop
        // produced new objects). Re-fetch at sign time instead of using stale prefetch.
        faucetJustFired = true
      } else {
        console.log(`💰 Balance sufficient (${balMist} MIST) — caching for ${BALANCE_CACHE_TTL_MS / 1000}s`)
        markBalanceSufficient(userAddress, balMist)
      }
    }
  } catch (e) {
    console.warn('⚠️ Faucet pre-check failed (non-fatal, submit loop has reactive fallback):', e?.message)
  }
  T.end(label('4b_request_Faucet'))

  // 6.5: Construct transaction by operation
  //
  // This step is intentionally PURE LOCAL WORK — no RPCs, no network.
  // The two on-chain preconditions we need (current gas price + a spendable
  // coin to pay for gas) were already prefetched in parallel with steps 1b/4/4b
  // above (see `gasMetadataPromise`). We just await them here; on the warm path
  // they resolved long ago and this await is instant.
T.start(label('5_build_and_sign_Move_tx'))
const PACKAGE_ID = '0xa9127ce9e2403a6df3bfe83061b1b9606e7eb309ac25d5eeba3e3706487f376b'
const MEDICAL_ACCESS_PACKAGE_ID = '0xb6348cf0ac7b9b35adfae31f7516fa4c703dce8c88a619bda49b3f634c4cc10d'

// Resolve the prefetched gas metadata. If the faucet just fired, the pre-fetched
// coin list predates the top-up — force a fresh getCoins so we pick up the new drop.
let referenceGasPrice = null
let gasCoinsData = null
try {
  const prefetch = await gasMetadataPromise
  if (prefetch) {
    referenceGasPrice = prefetch.price
    gasCoinsData = prefetch.coins?.data || []
  }
  if (faucetJustFired) {
    console.log('🔁 Faucet just fired in 6.4b — re-fetching gas coins to include the new drop, and invalidating coin cache')
    invalidateCachedCoinRef(userAddress)
    const fresh = await suiClient.getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' })
    gasCoinsData = fresh?.data || []
  }
} catch (e) {
  console.warn('⚠️ Gas metadata resolve failed:', e?.message)
}

const tx = new Transaction()
tx.setSender(userAddress)
const enc = new TextEncoder()

console.log(`🔧 Building tx: op=${op}, packageId=${op === 'access' ? MEDICAL_ACCESS_PACKAGE_ID : PACKAGE_ID}`)
console.log(`🔧 userAddress=${userAddress}`)

// Default gas budget, adjusted for transaction complexity (increased to 50M MIST = 0.05 SUI)
const DEFAULT_GAS_BUDGET = 50000000;

// Set transaction gas budget
tx.setGasBudget(DEFAULT_GAS_BUDGET);

// Explicit gas price + gas payment (hoisted out of tx.sign's implicit RPCs).
// When both are provided, tx.sign({ signer }) needs no client and does zero network.
if (referenceGasPrice != null) tx.setGasPrice(Number(referenceGasPrice))
const chosenGasCoin = Array.isArray(gasCoinsData)
  ? (gasCoinsData.find(c => BigInt(c.balance || '0') >= BigInt(DEFAULT_GAS_BUDGET)) || gasCoinsData[0])
  : null
if (chosenGasCoin) {
  tx.setGasPayment([{ objectId: chosenGasCoin.coinObjectId, version: chosenGasCoin.version, digest: chosenGasCoin.digest }])
}
const canSignLocally = referenceGasPrice != null && !!chosenGasCoin
console.log(`🔧 Gas metadata: price=${referenceGasPrice ?? '(none)'}, coin=${chosenGasCoin?.coinObjectId?.slice(0, 10) ?? '(none)'}…, local-sign=${canSignLocally}`)

// VC operation - uses store_did_vc::create_did_vc
if (op === 'vc') {
  if (!vc) throw new Error('vc operation requires a vc object')
  const didBytes = enc.encode(did)
  const vcBytes = enc.encode(JSON.stringify(vc))
  console.log(`🔧 VC op: did_len=${didBytes.length}, vc_len=${vcBytes.length}`)

  try {
    tx.moveCall({
      target: `${PACKAGE_ID}::store_did_vc::create_did_vc`,
      arguments: [
        tx.pure.vector('u8', Array.from(didBytes)), // did
        tx.pure.vector('u8', Array.from(vcBytes)),  // vc
      ],
    })
  } catch (buildError) {
    console.error('🔧 Failed to build moveCall:', buildError)
    throw buildError
  }
} else if (op === 'did') {
  // DID operation - store DID only (empty vc field)
  const didBytes = enc.encode(did)
  const emptyVcBytes = enc.encode('{}') // empty VC
  console.log(`🔧 DID op: did_len=${didBytes.length}`)

  try {
    tx.moveCall({
      target: `${PACKAGE_ID}::store_did_vc::create_did_vc`,
      arguments: [
        tx.pure.vector('u8', Array.from(didBytes)), // did
        tx.pure.vector('u8', Array.from(emptyVcBytes)), // empty vc
      ],
    })
  } catch (buildError) {
    console.error('🔧 Failed to build moveCall:', buildError)
    throw buildError
  }
} else if (op === 'access') {
    // patient_did grants grantee_did access to record_id at hospital_did
    if (!hospitalDid) throw new Error('access operation requires --hospital-did')
    if (!granteeDid) throw new Error('access operation requires --grantee-did')
    if (!recordId) throw new Error('access operation requires --record-id')
    const patientBytes = enc.encode(did)
    const hospitalBytes = enc.encode(hospitalDid)
    const granteeBytes = enc.encode(granteeDid)
    const recordBytes = enc.encode(recordId)
    const timestamp = BigInt(Date.now())
    console.log(`🔧 Access op: patient_len=${patientBytes.length}, hospital_len=${hospitalBytes.length}, grantee_len=${granteeBytes.length}, record_len=${recordBytes.length}, timestamp=${timestamp}`)
    tx.moveCall({
      target: `${MEDICAL_ACCESS_PACKAGE_ID}::medical_access::create_access_grant`,
      arguments: [
        tx.pure.vector('u8', Array.from(patientBytes)),    // patient_did
        tx.pure.vector('u8', Array.from(hospitalBytes)),   // hospital_did
        tx.pure.vector('u8', Array.from(granteeBytes)),    // grantee_did
        tx.pure.vector('u8', Array.from(recordBytes)),     // record_id
        tx.pure.u64(timestamp),                            // granted_at
      ],
    })
  }

  console.log(`🔧 Signing transaction${canSignLocally ? ' (pure local)' : ' (SDK-managed, will RPC)'}…`)
  const { bytes, signature: userSignature } = canSignLocally
    ? await tx.sign({ signer: eph })                       // no client → no RPC, pure BCS + Ed25519
    : await tx.sign({ client: suiClient, signer: eph })    // fallback: SDK resolves gas via RPCs
  console.log(`🔧 Transaction signed, byte_length=${bytes.length}`)
  T.end(label('5_build_and_sign_Move_tx'))

  // 6.6: Sign + Submit
  T.start(label('6a_assemble_zkLogin_signature'))
  const zkLoginSignature = getZkLoginSignature({ inputs: { ...proof, addressSeed }, maxEpoch, userSignature })
  T.end(label('6a_assemble_zkLogin_signature'))

  T.start(label('6b_submit_tx_and_return'))
  const execStart = performance.now()

  // Build deduplicated RPC list: primary RPC first, then unique fallback RPCs
  const allRpcUrls = [SUI_RPC_URL, ...SUI_RPC_FALLBACK_URLS.filter(u => u !== SUI_RPC_URL)]
  let result
  let txRetries = 0
  const maxTxRetries = Math.max(allRpcUrls.length * 3, 9)
  let rpcIndex = 0
  let knownDigest = null  // After 504, tx may have succeeded; remember digest for later query
  let faucetRetryUsed = false // Reactive fallback: one faucet top-up per run if tx fails for gas reasons

  while (txRetries <= maxTxRetries) {
    const currentRpcUrl = allRpcUrls[rpcIndex % allRpcUrls.length]

    // ── If there was a previous 504, check on a new node whether the tx already succeeded ──
    if (knownDigest) {
      try {
        console.log(`🔍 Checking if tx ${knownDigest.slice(0,16)}... is already on-chain (RPC: ${currentRpcUrl})`)
        const checkClient = new SuiClient({ url: currentRpcUrl })
        const existing = await Promise.race([
          checkClient.getTransactionBlock({ digest: knownDigest, options: { showEffects: true } }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('digest query timeout')), 8000)),
        ])
        if (existing?.digest) {
          console.log(`✅ Transaction confirmed on-chain! digest=${existing.digest}`)
          result = existing
          break
        }
      } catch (checkErr) {
        console.log(`⚠️ Digest query failed: ${checkErr?.message?.slice(0,80)} — continuing retry`)
      }
    }

    try {
      const currentClient = new SuiClient({ url: currentRpcUrl })
      console.log(`🔄 Attempting to submit tx (RPC: ${currentRpcUrl})...`)

      // Use AbortSignal with 20s timeout to prevent long hangs
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 20000)

      // Use fetch directly for JSON-RPC to precisely control timeout
      const rpcResp = await fetch(currentRpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sui_executeTransactionBlock',
          params: [
            typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('base64'),
            [zkLoginSignature],
            { showEffects: true },  // Minimal options for faster response
            null,
          ],
        }),
      })
      clearTimeout(timeoutId)

      if (!rpcResp.ok) {
        throw new Error(`Unexpected status code: ${rpcResp.status}`)
      }
      const rpcJson = await rpcResp.json()
      if (rpcJson.error) {
        throw new Error(rpcJson.error.message || JSON.stringify(rpcJson.error))
      }
      result = rpcJson.result
      // Remember digest for subsequent lookup
      if (result?.digest) knownDigest = result.digest
      console.log('🔎 executeTransactionBlock totalMs:', Math.round(performance.now() - execStart), 'ms')
      break // success
    } catch (txErr) {
      txRetries++
      const errMsg = txErr.message || String(txErr)
      const isTimeout = txErr.name === 'AbortError' || errMsg.includes('abort')
      console.error(`❌ Submit tx failed (attempt ${txRetries}/${maxTxRetries + 1}, RPC: ${currentRpcUrl}):`,
        isTimeout ? 'Request timeout (20s)' : errMsg)

      // 504/timeout = tx may have already been submitted, response just timed out
      if (errMsg.includes('504') || isTimeout) {
        console.log('⚠️ Timeout/504 — tx may have been submitted, will check digest before next retry')
      }

      // "JWK not found" means node JWK cache not synced, can retry with different node
      const isJwkNotFound = errMsg.includes('JWK not found')
      if (isJwkNotFound) {
        console.log('⚠️ This node JWK cache not synced, trying other RPC nodes...')
      }

      // Stale-coin detection: if the cached gas coin ref has a version/digest
      // that's no longer current (e.g., coin consumed by another process), Sui
      // surfaces errors mentioning version / object-existence. Invalidate the
      // coin cache eagerly so the NEXT run will re-fetch via getCoins; this
      // particular run still fails (the tx bytes baked in the stale ref).
      const isStaleCoin = /VersionError|ObjectVersionUnavailable|InputObjectDoesntExist|ObjectDeleted|InvalidObjectByValue/i.test(errMsg)
      if (isStaleCoin) {
        console.log('🔧 Tx failed due to stale gas coin reference — invalidating coin cache (next run will re-fetch)')
        invalidateCachedCoinRef(userAddress)
      }

      // Gas-price mismatch (e.g., epoch rollover bumped the price while our
      // cached value was still considered fresh by TTL): invalidate so the next
      // run re-queries getReferenceGasPrice.
      const isGasPriceStale = errMsg.includes('GasPriceTooLow') || errMsg.includes('GasPriceUnderRGP')
      if (isGasPriceStale) {
        console.log('🔧 Tx failed due to gas price mismatch — invalidating gas price cache')
        invalidateCachedGasPrice()
      }

      // Reactive faucet fallback (option 3 in 6.4b plan): if the tx fails because
      // of gas, invalidate the balance cache, top up once, and retry on the SAME
      // RPC (node isn't the problem). Limited to one top-up per run.
      const isGasShortage = errMsg.includes('InsufficientGas') || errMsg.includes('InsufficientCoinBalance')
      if (isGasShortage && !faucetRetryUsed) {
        faucetRetryUsed = true
        console.log('💧 Tx failed due to gas shortage — invalidating balance + coin caches and requesting faucet…')
        invalidateBalanceCache(userAddress)
        invalidateCachedCoinRef(userAddress) // coin ref may be stale or depleted
        const ok = await requestDevnetFaucet(userAddress, suiClient)
        if (ok) {
          // Same RPC, no extra backoff (we just spent ~3s polling the faucet).
          continue
        }
        // If the faucet itself failed, fall through to the normal non-retryable path.
      }

      // Only clear business logic errors that cannot be fixed by switching nodes are non-retryable
      const isNotRetryable = !isJwkNotFound && (
                             errMsg.includes('Invalid user signature') ||
                             errMsg.includes('InvalidSignature') ||
                             errMsg.includes('InsufficientGas') ||
                             errMsg.includes('InsufficientCoinBalance') ||
                             errMsg.includes('MoveAbort') ||
                             errMsg.includes('address_seed'))

      if (isNotRetryable || txRetries > maxTxRetries) {
        T.end(label('6b_submit_tx_and_return'))
        throw new Error(`Submit tx failed: ${errMsg}`)
      }

      // Switch to next RPC
      rpcIndex++
      console.log(`🔀 Switching to fallback RPC: ${allRpcUrls[rpcIndex % allRpcUrls.length]}`)

      // Exponential backoff wait (max 8 seconds)
      const waitSec = Math.min(Math.pow(2, txRetries), 8)
      console.log(`⏳ Waiting ${waitSec}s before retry...`)
      await new Promise(resolve => setTimeout(resolve, waitSec * 1000))
    }
  }
  
  T.end(label('6b_submit_tx_and_return'))

  // Post-tx: refresh the coin cache so the NEXT run can skip getCoins.
  // We read the new (version, digest) from effects.gasObject.reference and
  // compute the post-consumption balance from effects.gasUsed. If anything
  // is missing we silently skip — the next run will re-fetch via getCoins.
  try {
    const gasObj = result?.effects?.gasObject
    const newRef = gasObj?.reference
    if (newRef?.objectId && chosenGasCoin) {
      const gasUsed = result?.effects?.gasUsed || {}
      let newBalance = null
      try {
        const spent =
          BigInt(gasUsed.computationCost || '0') +
          BigInt(gasUsed.storageCost || '0') -
          BigInt(gasUsed.storageRebate || '0')
        const prev = BigInt(chosenGasCoin.balance || '0')
        const next = prev > spent ? (prev - spent) : 0n
        newBalance = next.toString()
      } catch { /* fall through with null */ }
      setCachedCoinRef(userAddress, {
        objectId: newRef.objectId,
        version: newRef.version,
        digest: newRef.digest,
        estimatedBalanceMist: newBalance ?? chosenGasCoin.balance ?? '0',
      })
      console.log(`🔧 Gas coin cache updated: id=${newRef.objectId.slice(0, 10)}… v=${newRef.version} balance~${newBalance ?? '?'}`)
    }
  } catch (cacheErr) {
    console.warn('⚠️ Gas coin cache update failed (non-fatal):', cacheErr?.message)
  }

  // Extract gas breakdown + storage (per-object byte size) from tx effects.
  // All four gas components come straight from effects.gasUsed (MIST).
  // For each object created by the tx we do one extra getObject RPC to fetch
  // the exact BCS byte length — without this we could only infer size from
  // storageCost, which over/under-estimates tiny/large objects because of the
  // per-object metadata overhead (~80 bytes) that dominates small DIDs.
  let gasReport = null
  let storageReport = []
  try {
    const gasUsed = result?.effects?.gasUsed || {}
    const comp = Number(gasUsed.computationCost || 0)
    const stor = Number(gasUsed.storageCost || 0)
    const rebate = Number(gasUsed.storageRebate || 0)
    const nonRef = Number(gasUsed.nonRefundableStorageFee || 0)
    gasReport = {
      computationCostMist: comp,
      storageCostMist: stor,
      storageRebateMist: rebate,
      nonRefundableStorageFeeMist: nonRef,
      netGasMist: comp + stor - rebate,
    }

    const created = Array.isArray(result?.effects?.created) ? result.effects.created : []
    for (const obj of created) {
      const objectId = obj?.reference?.objectId
      if (!objectId) continue
      const ownerRaw = obj?.owner
      const owner = typeof ownerRaw === 'object' && ownerRaw
        ? Object.keys(ownerRaw)[0]
        : String(ownerRaw ?? 'unknown')

      // Retry getObject with small backoff — the object was JUST created, RPC
      // nodes may return {error:"notExists"} for ~50-500ms before propagation.
      // Note: the SDK returns {error:...} rather than throwing, so we check the
      // `error` field AND the absence of `data.bcs` to decide whether to retry.
      let bcsBytes = null
      const bcsSchedule = [100, 200, 400, 800]
      for (let a = 0; a < bcsSchedule.length; a++) {
        try {
          const detail = await suiClient.getObject({
            id: objectId,
            options: { showBcs: true, showContent: false },
          })
          const bcsB64 = detail?.data?.bcs?.bcsBytes
          if (typeof bcsB64 === 'string') {
            bcsBytes = Buffer.from(bcsB64, 'base64').length
            break
          }
          // error:"notExists" case — try again after backoff
        } catch (e) {
          console.warn(`⚠️ getObject(${objectId.slice(0, 10)}…) attempt ${a + 1} threw: ${e?.message}`)
        }
        if (a < bcsSchedule.length - 1) await new Promise(r => setTimeout(r, bcsSchedule[a]))
      }
      storageReport.push({ objectId, owner, bcsBytes })
    }
    console.log(`💾 Gas: net=${gasReport.netGasMist} MIST (comp=${comp}, storage=${stor}, rebate=-${rebate})`)
    for (const s of storageReport) {
      console.log(`   + created object ${s.objectId.slice(0, 10)}… (${s.owner}) — ${s.bcsBytes ?? '?'} bytes`)
    }
  } catch (e) {
    console.warn('⚠️ Gas/storage extraction failed (non-fatal):', e?.message)
  }

  return { result, userAddress, gasReport, storageReport }
}

// ================= Main Flow (split by operation, new version) =================
async function main() {
  const { op, params } = parseCli()
  console.log('🧾 Current operation --op =', op)

  // Try to load frontend-acquired zkProofs from .zk-session.json
  let preloadedZkProofs = null
  try {
    const sessionFile = path.resolve(__dirname, '.zk-session.json')
    if (fs.existsSync(sessionFile)) {
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
      if (sessionData.ZK_PROOFS && typeof sessionData.ZK_PROOFS === 'object') {
        preloadedZkProofs = sessionData.ZK_PROOFS
        console.log('📦 Loaded frontend zkProofs from .zk-session.json')
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to load zkProofs from .zk-session.json:', e?.message)
  }

  // Pick user slot (1|2|3) from CLI args — used for session lookup + Veramo key naming.
  const { keyIndex } = selectUserSlot()
  console.log(`🔑 Using user slot ${keyIndex}`)

  // Step 1 (derive ETH address) removed — the Ethereum address was only used
  // as a lookup key in dids.json and contributed nothing to zkLogin signing or
  // the Sui transaction. Sessions are now keyed directly by user slot.
  //
  // Migration: previously-stored sessions under `did:ethr:sepolia:0x...` will be
  // orphaned (still present in dids.json but unreachable). Re-login in the
  // browser once per slot to repopulate under the new key format.

  // 2) Load or populate zkLogin session
  T.start('2_load_or_populate_zkLogin_session')
  const sessionKey = `zklogin-user-${keyIndex}`
  let sessionWasCreatedNow = false

  // If frontend passed a new USER_SALT (via env), the user just logged in,
  // must use new session data from env, cannot reuse old session from dids.json.
  const freshEnvSession = !!(process.env.USER_SALT && process.env.GOOGLE_ID_TOKEN)
  if (freshEnvSession) {
    console.log('🔄 Detected frontend USER_SALT + GOOGLE_ID_TOKEN, skipping old session reuse, using new session')
  }
  let activeSession = freshEnvSession ? null : await getActiveZkSessionOrNull(sessionKey, SUI_RPC_URL)

  if (!activeSession) {
    // Check for missing or expired env variables (e.g. MAX_EPOCH too small)
    const missing = ['GOOGLE_ID_TOKEN','EPHEMERAL_PRIVATE_KEY','JWT_RANDOMNESS','MAX_EPOCH'].filter(k => !process.env[k])
    if (missing.length) {
      T.end('2_load_or_populate_zkLogin_session')
      console.error('❌ No valid session and missing:', missing.join(', '))
      console.error('👉 Please re-login on the frontend to refresh the session.')
      process.exit(2)
    }
    const payload = decodeJwt(String(GOOGLE_ID_TOKEN))
    const sub = payload?.sub
    const aud = Array.isArray(payload?.aud) ? payload.aud[0] : payload?.aud
    const userAddress = jwtToAddress(String(GOOGLE_ID_TOKEN), BigInt(ZKLOGIN_SALT))
    await saveZkSession(sessionKey, {
      idToken: String(GOOGLE_ID_TOKEN),
      ephemeralPrivateKey: String(EPHEMERAL_PRIVATE_KEY),
      randomness: String(JWT_RANDOMNESS),
      maxEpoch: Number(MAX_EPOCH),
      sub, aud, userAddress,
    })
    activeSession = await loadLatestZkSession(sessionKey)
    sessionWasCreatedNow = true
  } else {
    // Output remaining epochs
    try {
      const cli = new SuiClient({ url: SUI_RPC_URL })
      const state = await cli.getLatestSuiSystemState()
      const remaining = Number(activeSession.maxEpoch) - Number(state.epoch)
      console.log(`⏳ Session remaining epochs: ${remaining} (current=${state.epoch}, max=${activeSession.maxEpoch})`)
      if (remaining < 0) {
        console.warn('⚠️ Session expired, please re-login in browser to generate a new zkLogin session.')
        T.end('2_load_or_populate_zkLogin_session')
        process.exit(3)
      }
    } catch {}
  }
  T.end('2_load_or_populate_zkLogin_session')

  // 3) Generate zkLogin DID (using zkLogin address + provider)
  T.start('3_generate_zkLogin_DID_and_ephemeral_key')
  const ephSecret = parseEphemeralSecretKey(activeSession.ephemeralPrivateKey)
  const ephKeyPair = Ed25519Keypair.fromSecretKey(ephSecret)
  const userAddress = activeSession.userAddress

  // Parse provider from id_token (or use provided PROVIDER)
  let rawPayload
  try { rawPayload = decodeJwt(activeSession.idToken) } catch {}
  const provider = detectProviderFromIdTokenPayload(rawPayload)
  console.log(`🔍 Detected provider: ${provider}`)

  const zkDid = generateZkLoginDID(userAddress, provider)

  // Public/private key hex
  const ephPublicKeyHex = Buffer.from(ephKeyPair.getPublicKey().toRawBytes()).toString('hex')
  const ephPrivateKeyHex = Buffer.from(ephSecret).toString('hex')
  const zkKid = `zklogin-key-${keyIndex}`

  // Detect whether ephemeral key is reused or new
  let ephemeralKeyStatus = 'new'
  const existingKeyEntry = await keyStore.get(zkKid)
  if (existingKeyEntry && existingKeyEntry.publicKeyHex === ephPublicKeyHex) {
    ephemeralKeyStatus = 'reuse-existing'
  } else if (!sessionWasCreatedNow) {
    // Session not newly created but keyStore has no matching pubkey -> possibly never imported
    ephemeralKeyStatus = 'session-reuse-but-import-new'
  }
  console.log(`🔍 Ephemeral key status: ${ephemeralKeyStatus} (kid=${zkKid}, pub=${ephPublicKeyHex.slice(0,16)}...)`)
  console.log(`🔍 Session source: ${sessionWasCreatedNow ? 'newly created' : 'reusing existing session'} (maxEpoch=${activeSession.maxEpoch})`)

  // ✅ Force write to privateKeys.json to ensure KMS can read it
  await privateKeyStore.set(zkKid, {
    kid: zkKid,
    alias: zkKid,
    privateKeyHex: ephPrivateKeyHex
  })
  console.log(`🗝️ Written to privateKeys.json: ${zkKid}`)

  // Direct key registration — replaces agent.keyManagerImport. JsonStore.importKey
  // handles the type-aware {kid, alias, meta, ...} record shape and writes a
  // privateKeyHex-only entry to privateKeys.json plus the full record to keys.json.
  try {
    await keyStore.importKey({
      kid: zkKid,
      kms: 'local',
      type: 'Ed25519',
      privateKeyHex: ephPrivateKeyHex,
      publicKeyHex: ephPublicKeyHex,
      meta: { algorithms: ['Ed25519','EdDSA'], keyType: 'Ed25519', kms: 'local' },
    })
    await privateKeyStore.importKey({
      kid: zkKid,
      privateKeyHex: ephPrivateKeyHex,
    })
    console.log(`✅ Ed25519 key imported (direct): ${zkKid}`)
  } catch (e) {
    console.log(`⚠️ Key import failed or already exists: ${e.message}`)
  }

  // Direct DID registration — replaces agent.didManagerImport. The on-disk
  // record shape mirrors what Veramo's DIDManager.import wrote previously.
  try {
    const identifier = {
      did: zkDid,
      provider: 'did:zklogin',
      alias: `zklogin-did-${provider}-${keyIndex}`,
      controllerKeyId: zkKid,
      keys: [{
        kid: zkKid,
        kms: 'local',
        type: 'Ed25519',
        publicKeyHex: ephPublicKeyHex,
        privateKeyHex: ephPrivateKeyHex, // optional
        meta: { algorithms: ['Ed25519','EdDSA'], keyType: 'Ed25519', kms: 'local' },
      }],
      services: [],
    }
    await didStore.set(zkDid, identifier)
    console.log(`✅ zkLogin DID imported (${provider}): ${zkDid}`)
  } catch (e) {
    console.log(`⚠️ DID import failed or already exists (${provider}): ${e.message}`)
  }

  const step3Ms = T.end('3_generate_zkLogin_DID_and_ephemeral_key')
  console.log(`✅ zkLogin DID：${zkDid}`)
  console.log(`👤 zkLogin Address：${userAddress}`)
  console.log(`⏱️ 3_generate_zkLogin_DID_and_ephemeral_key: ${step3Ms} ms (ephemeral_key_status=${ephemeralKeyStatus}, provider=${provider})`)

  // 4) Issue VC
  let vc // Important: outer scope declaration for save/on-chain reuse
  if (op === 'vc') {
    T.start('4_issue_zkLogin_JWT_VC')
    const putIdTokenIntoVC = (INCLUDE_ID_TOKEN_IN_VC === 'true')
    // Direct VC issuance — what used to be the "fallback" path in earlier
    // revisions is now the primary path. Veramo's createVerifiableCredential
    // was failing on every run with `unknown credential format` and we always
    // fell through to this code anyway, so the previous try/catch was pure
    // overhead. We additionally do a direct keyStore lookup for diagnostic
    // logging (replaces agent.keyManagerGet).
    try {
      const kmKey = await keyStore.get(zkKid).catch(() => null)
      if (kmKey) console.log('🔍 keyStore.get:', { kid: kmKey.kid, type: kmKey.type, algos: kmKey.meta?.algorithms })

      vc = await createJwtVcEd25519({
        issuerDid: zkDid,
        subjectDid: zkDid,
        keyId: zkKid,
        privateKeyHex: ephPrivateKeyHex,
        vcData: {
          id: zkDid,
          zkLoginAddress: userAddress,
          name: 'Wei Zhu',
          ...(putIdTokenIntoVC ? { idToken: String(activeSession.idToken) } : {}),
        },
      })
      console.log('✅ VC issued (Ed25519 JWT, direct)')
    } catch (e) {
      console.error('🔥 VC issuance failed:', e.message)
      process.exit(1)
    }
    if (SAVE_VC_TO_DIDS === 'true' && vc) await appendVCToDidStore(zkDid, vc)
    T.end('4_issue_zkLogin_JWT_VC')
  }

  // 5) Generate complete zkLogin DID document before on-chain submission
  T.start('5_generate_full_zkLogin_DID_doc')
  const zkDidDoc = await saveZkLoginDIDDocument(activeSession, userAddress, ephKeyPair.getPublicKey())
  T.end('5_generate_full_zkLogin_DID_doc')

  // 6) Save to local store
  if (op === 'vc') {
    T.start('6_save_VC_to_dids_json')
    if (vc && SAVE_VC_TO_DIDS === 'true') await appendVCToDidStore(zkDid, vc)
    if (SAVE_ID_TOKEN_TO_DIDS === 'true') await saveIdTokenToDidStore(zkDid, String(activeSession.idToken), Number(ID_TOKEN_HISTORY_LIMIT))
    T.end('6_save_VC_to_dids_json')
  }

  // 7) Submit on-chain (passing zkLogin DID)
  let submitResult
  // Captured from sendOnSuiWithZkLoginSplit — forwarded to the final timings
  // payload so the frontend's Gas & Storage card can display them.
  let gasReport = null
  let storageReport = []
  try {
    const r = await sendOnSuiWithZkLoginSplit({
      op,
      did: zkDid,
      vc,
      session: {
        idToken: activeSession.idToken,
        ephemeralPrivateKey: activeSession.ephemeralPrivateKey,
        randomness: activeSession.randomness,
        maxEpoch: Number(activeSession.maxEpoch),
      },
      publicKeyHex: ephPublicKeyHex,
      hospitalDid: params.hospitalDid,
      granteeDid: params.granteeDid,
      recordId: params.recordId,
      preloadedZkProofs,
    })
    submitResult = r.result
    gasReport = r.gasReport || null
    storageReport = r.storageReport || []
  } catch (e) {
    console.error('❌ Submit tx failed:', e?.message || e)
    T.dump('⏱️ (pre-failure) Step Timing Summary')
    T.saveToFile(path.resolve(__dirname, '.backend-timings.json'), {
      op, userAddress, zkDid, status: 'failed', error: String(e?.message || e),
    })
    return
  }
  
  console.log(`✅ Operation (${op}) submitted to Sui`)
  console.log('👤 zkLogin Address:', userAddress)
  console.log('🆔 zkLogin DID:', zkDid)
  console.log('Transaction Digest:', submitResult?.digest)

  // 8) Query on-chain and update DID document (with zkProof).
  //
  // The tx was submitted in step 6.6b and the RPC responded with a digest —
  // but the transaction may not yet be visible to other (or even the same)
  // RPC nodes due to consensus propagation lag. Naively calling
  // getTransactionBlock often returns "Could not find the referenced
  // transaction" within ~10-50ms of submit. We retry with exponential backoff
  // up to ~5 seconds so step 8 honestly reflects the cost of confirmation.
  //
  // This fixes two problems at once:
  //   (1) the metric now shows real on-chain latency instead of a 10 ms
  //       fast-fail, and
  //   (2) the DID document actually gets updated on success, where before it
  //       was silently skipped whenever propagation hadn't caught up.
  T.start('8_query_chain_and_update_DID_doc')
  const digest = submitResult?.digest
  if (digest) {
    const suiClient = new SuiClient({ url: SUI_RPC_URL })
    let txDetail = null
    let lastErr = null
    // Backoff: 150ms, 300ms, 600ms, 1200ms, 1500ms (capped) — up to ~3.75s total.
    const schedule = [150, 300, 600, 1200, 1500]
    for (let attempt = 0; attempt < schedule.length; attempt++) {
      try {
        txDetail = await suiClient.getTransactionBlock({
          digest,
          options: { showEffects: true, showInput: true, showEvents: true },
        })
        if (txDetail?.effects) break
      } catch (e) {
        lastErr = e
        const msg = String(e?.message || e)
        const notReadyYet = /not find|not found|TransactionDigest/i.test(msg)
        if (!notReadyYet) {
          // A non-propagation error (network, 500, etc.) — log and retry anyway,
          // but cap total wait.
          console.warn(`⚠️ getTransactionBlock attempt ${attempt + 1}: ${msg.slice(0, 120)}`)
        }
      }
      if (attempt < schedule.length - 1) {
        await new Promise(r => setTimeout(r, schedule[attempt]))
      }
    }

    if (txDetail?.effects) {
      const status = txDetail.effects?.status?.status || 'unknown'
      console.log(`🔎 On-chain status (after ${schedule.slice(0, schedule.length).join('+')}ms max): ${status}`)
      if (status === 'success') {
        const updatedDidDoc = await createZkLoginDIDDocument(
          activeSession,
          userAddress,
          ephKeyPair.getPublicKey(),
          { digest, status, timestamp: new Date().toISOString() }
        )
        await didStore.set(zkDid, {
          ...(await didStore.get(zkDid) || {}),
          zkLoginDIDDocument: updatedDidDoc,
          onChainProof: { digest, status }
        })
        fs.writeFileSync('./.zklogin-ok', JSON.stringify({
          digest, status, op, zkDid, userAddress,
          time: new Date().toISOString()
        }, null, 2))
        console.log('✅ Transaction successful, zkLogin DID document updated')
      } else {
        console.warn(`⚠️ Tx executed but status != success: ${status}`)
      }
    } else {
      // Never became visible — don't throw (submit succeeded, tx exists in
      // mempool). Log loudly so this isn't silent.
      console.error(`❌ Could not confirm tx on-chain after ${schedule.reduce((a, b) => a + b, 0)}ms of retries. Last error: ${String(lastErr?.message || lastErr)}`)
      console.error(`   DID doc NOT updated. Manual check: sui client tx-block ${digest}`)
    }
  }
  T.end('8_query_chain_and_update_DID_doc')

  T.dump('⏱️ Full Process Timing Details')
  T.saveToFile(path.resolve(__dirname, '.backend-timings.json'), {
    op, userAddress, zkDid, status: 'success', digest: submitResult?.digest || null,
    gasReport, storageReport,
  })
}

main().catch(e => { console.error(e); process.exit(1) })