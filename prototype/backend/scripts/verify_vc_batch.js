// verify-vc.js
// Node.js 18+ / ESM
// ✅ Parallel query for two DIDObjects (with timing)
// ✅ Manual signature verification of two VCs using on-chain public keys (with timing)

import { SuiClient } from '@mysten/sui/client'
import * as jose from 'jose'
import { performance } from 'perf_hooks'

// ============== SUI Devnet Configuration ==============
const SUI_DEVNET_RPC = process.env.SUI_RPC_URL || 'https://fullnode.devnet.sui.io'
const PACKAGE_ID =
  process.env.SUI_PACKAGE_ID ||
  '0xe17c8152a5d63c36b1a630b464ce4bbcf35216acd863abe797215cec4ff1b394'

// ============== Two DIDs ==============
const DID_1 = 'did:ethr:sepolia:0xb543920fEBe4cf02CA031Ce6a77e2ea5Ad69bDd8'
const DID_2 = 'did:ethr:sepolia:0xA220c646F653b2b07771c94382921b34e52b7489'

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

// ============== Reverse Lookup DIDObject from On-Chain ==============
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
const VC_1 = {
  credentialSubject: { name: 'Wei Zhu', id: 'did:example:Wei Zhu' },
  issuer: { id: DID_1 },
  type: ['VerifiableCredential'],
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  issuanceDate: '2025-10-06T03:08:13.000Z',
  proof: {
    type: 'JwtProof2020',
    jwt:
      'eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSJdLCJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl0sImNyZWRlbnRpYWxTdWJqZWN0Ijp7Im5hbWUiOiJXZWkgWmh1In19LCJzdWIiOiJkaWQ6ZXhhbXBsZTpXZWkgWmh1IiwibmJmIjoxNzU5NzIwMDkzLCJpc3MiOiJkaWQ6ZXRocjpzZXBvbGlhOjB4YjU0MzkyMGZFQmU0Y2YwMkNBMDMxQ2U2YTc3ZTJlYTVBZDY5YkRkOCJ9.SWUTmpiZd54rJhh7ZnRyTSNEWoJxg3zGnYgHXWnj2SF_cmSjlYJqOnhJZx45POgNzfjqrRECvq3QjlJrsnMaZg',
  },
}

const VC_2 = {
  credentialSubject: { name: 'Wei Zhu', id: 'did:example:Wei Zhu' },
  issuer: { id: DID_2 },
  type: ['VerifiableCredential'],
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  issuanceDate: '2025-10-06T04:17:50.000Z',
  proof: {
    type: 'JwtProof2020',
    jwt:
      'eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSJdLCJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl0sImNyZWRlbnRpYWxTdWJqZWN0Ijp7Im5hbWUiOiJXZWkgWmh1In19LCJzdWIiOiJkaWQ6ZXhhbXBsZTpXZWkgWmh1IiwibmJmIjoxNzU5NzI0MjcwLCJpc3MiOiJkaWQ6ZXRocjpzZXBvbGlhOjB4QTIyMGM2NDZGNjUzYjJiMDc3NzFjOTQzODI5MjFiMzRlNTJiNzQ4OSJ9.wS7N4OK2VS1bf-ZFyDPoUqrGT9TO3IvoXJokcpOeboodhwCbNQWYlr2BgYqcsGGuCKnwcd0OYlJYAmaIeVwGdw',
  },
}

// ============== Signature Verification Function ==============
async function verifyVC(vc, publicKey) {
  const pubBytes = Buffer.from(publicKey, 'base64')
  const jwk = {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(pubBytes.slice(1, 33)).toString('base64url'),
    y: Buffer.from(pubBytes.slice(33, 65)).toString('base64url'),
  }
  const key = await jose.importJWK(jwk, 'ES256K')
  return jose.jwtVerify(vc.proof.jwt, key)
}

// ============== Main Function ==============
async function main() {
  try {
    // 1️⃣ Parallel query for two DID public keys
    const t0 = performance.now()
    const [didInfo1, didInfo2] = await Promise.all([
      resolveDidOnSuiByBusinessDid(DID_1),
      resolveDidOnSuiByBusinessDid(DID_2),
    ])
    const t1 = performance.now()
    console.log(`⏱️ Total time for parallel query of two DID public keys: ${(t1 - t0).toFixed(2)} ms`)

    // 2️⃣ Verify VC signatures separately
    console.log('🔎 Verifying VC_1 signature ...')
    const t2 = performance.now()
    const { payload: payload1 } = await verifyVC(VC_1, didInfo1.publicKey)
    const t3 = performance.now()
    console.log('✅ VC_1 signature verification passed', payload1)
    console.log(`⏱️ VC_1 verification time: ${(t3 - t2).toFixed(2)} ms`)

    console.log('🔎 Verifying VC_2 signature ...')
    const t4 = performance.now()
    const { payload: payload2 } = await verifyVC(VC_2, didInfo2.publicKey)
    const t5 = performance.now()
    console.log('✅ VC_2 signature verification passed', payload2)
    console.log(`⏱️ VC_2 verification time: ${(t5 - t4).toFixed(2)} ms`)
  } catch (e) {
    console.error('❌ Verification error:', e)
  }
}

main()