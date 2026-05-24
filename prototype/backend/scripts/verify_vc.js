// verify-vc.js
// Node.js 18+ / ESM
// ✅ Query DIDObject from SUI chain (with timing)
// ✅ Manual VC signature verification using on-chain public key (with timing)

import { SuiClient } from '@mysten/sui/client'
import * as jose from 'jose'
import { performance } from 'perf_hooks'

// ============== SUI Devnet Configuration ==============
const SUI_DEVNET_RPC = process.env.SUI_RPC_URL || 'https://fullnode.devnet.sui.io'
const PACKAGE_ID =
  process.env.SUI_PACKAGE_ID ||
  '0xe17c8152a5d63c36b1a630b464ce4bbcf35216acd863abe797215cec4ff1b394'

// ============== Your Business DID ==============
const BUSINESS_DID = 'did:ethr:sepolia:0xb543920fEBe4cf02CA031Ce6a77e2ea5Ad69bDd8'

// ============== Utility Functions ==============
function decodeVecU8ToUtf8(v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    if (v.startsWith('0x') || v.startsWith('0X')) {
      return Buffer.from(v.slice(2), 'hex').toString('utf8')
    }
    try { return Buffer.from(v, 'base64').toString('utf8') } catch {}
    return v
  }
  if (Array.isArray(v)) return Buffer.from(v).toString('utf8')
  return String(v)
}

function vecU8ToBase64(v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    if (v.startsWith('0x') || v.startsWith('0X')) {
      return Buffer.from(v.slice(2), 'hex').toString('base64')
    }
    try {
      Buffer.from(v, 'base64')
      return v
    } catch {
      return Buffer.from(v, 'utf8').toString('base64')
    }
  }
  if (Array.isArray(v)) return Buffer.from(v).toString('base64')
  return Buffer.from(String(v), 'utf8').toString('base64')
}

// ============== Reverse Lookup DIDObject via Transactions ==============
async function resolveDidOnSuiByBusinessDid(businessDid) {
  const client = new SuiClient({ url: SUI_DEVNET_RPC })
  console.log(`🔍 Reverse looking up DIDObject via business DID (transaction query): ${businessDid}`)

  let cursor = null
  const limit = 50
  const typeSuffix = '::medical_access::DIDObject'
  const maxPages = 20

  for (let page = 0; page < maxPages; page++) {
    const resp = await client.queryTransactionBlocks({
      filter: {
        MoveFunction: {
          package: PACKAGE_ID,
          module: 'medical_access',
          function: 'create_did_object',
        },
      },
      cursor,
      limit,
      options: { showObjectChanges: true },
    })

    const txs = resp?.data || []
    for (const tx of txs) {
      const changes = tx.objectChanges || []
      for (const ch of changes) {
        if (ch.type === 'created' && typeof ch.objectType === 'string' && ch.objectType.endsWith(typeSuffix)) {
          const objectId = ch.objectId
          if (!objectId) continue
          try {
            const obj = await client.getObject({ id: objectId, options: { showContent: true } })
            const fields = obj?.data?.content?.fields
            if (!fields) continue

            const didStr = decodeVecU8ToUtf8(fields.did)
            if (didStr === businessDid) {
              const pubkeyB64 = vecU8ToBase64(fields.public_key)
              console.log(`✅ Found matching DIDObject: ${obj.data.objectId}`)
              console.log(`✅ On-chain DID: ${didStr}`)
              console.log(`✅ On-chain PublicKey(Base64): ${pubkeyB64}`)
              return { objectId: obj.data.objectId, did: didStr, publicKey: pubkeyB64 }
            }
          } catch {}
        }
      }
    }

    if (!resp.hasNextPage || !resp.nextCursor) break
    cursor = resp.nextCursor
  }

  throw new Error(`❌ No matching DIDObject found for DID=${businessDid}`)
}

// ============== Sample VC Data ==============
const vc = {
  credentialSubject: { name: 'Wei Zhu', id: 'did:example:Wei Zhu' },
  issuer: { id: BUSINESS_DID },
  type: ['VerifiableCredential'],
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  issuanceDate: '2025-10-06T03:08:13.000Z',
  proof: {
    type: 'JwtProof2020',
    jwt:
      'eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSJdLCJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl0sImNyZWRlbnRpYWxTdWJqZWN0Ijp7Im5hbWUiOiJXZWkgWmh1In19LCJzdWIiOiJkaWQ6ZXhhbXBsZTpXZWkgWmh1IiwibmJmIjoxNzU5NzIwMDkzLCJpc3MiOiJkaWQ6ZXRocjpzZXBvbGlhOjB4YjU0MzkyMGZFQmU0Y2YwMkNBMDMxQ2U2YTc3ZTJlYTVBZDY5YkRkOCJ9.SWUTmpiZd54rJhh7ZnRyTSNEWoJxg3zGnYgHXWnj2SF_cmSjlYJqOnhJZx45POgNzfjqrRECvq3QjlJrsnMaZg',
  },
}

// ============== Main Function (with timing) ==============
async function main() {
  try {
    // 1️⃣ Measure time to find DID public key from SUI
    const t0 = performance.now()
    const { publicKey } = await resolveDidOnSuiByBusinessDid(BUSINESS_DID)
    const t1 = performance.now()
    console.log(`⏱️ Time to find DID public key from SUI: ${(t1 - t0).toFixed(2)} ms`)

    // 2️⃣ Measure signature verification time
    console.log('🔎 Manually verifying VC using on-chain public key ...')
    const t2 = performance.now()

    const pubBytes = Buffer.from(publicKey, 'base64')
    const jwk = {
      kty: 'EC',
      crv: 'secp256k1',
      x: Buffer.from(pubBytes.slice(1, 33)).toString('base64url'),
      y: Buffer.from(pubBytes.slice(33, 65)).toString('base64url'),
    }
    const key = await jose.importJWK(jwk, 'ES256K')
    const { payload } = await jose.jwtVerify(vc.proof.jwt, key)

    const t3 = performance.now()
    console.log('✅ Manual signature verification using on-chain public key passed', payload)
    console.log(`⏱️ Verification time: ${(t3 - t2).toFixed(2)} ms`)
  } catch (e) {
    console.error('❌ Verification error:', e.message)
  }
}

main()