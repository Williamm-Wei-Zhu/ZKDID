#!/usr/bin/env node
// search-did.mjs
// Search & verify a DID exists on the SUI blockchain
// Supports 3 search strategies:
//   1. By DID string   — scans transactions from both contracts
//   2. By owner address — lists all DID-related objects owned by a SUI address
//   3. By object ID     — direct lookup of a specific SUI object
//
// Usage:
//   npm run search:did -- --did "did:ethr:sepolia:0x..."
//   npm run search:did -- --owner "0xABC123..."
//   npm run search:did -- --object "0xDEF456..."
//   npm run search:did -- --did "did:ethr:sepolia:0x..." --verbose

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

// ============== Configuration ==============
const SUI_RPC_URL = process.env.SUI_RPC_URL || getFullnodeUrl('devnet')

// store_did_vc package ID (the only package for DID+VC)
const DIDVC_PACKAGE_ID = '0x79b189632bb607c249390f4aec6137a3000073039f7e2ce92432f8719eefe3a7'

// Known type suffix
const TYPE_DIDVC = '::store_did_vc::DIDVC'

// Known DID method prefixes used in this project
const DID_PREFIXES = [
  'did:zklogin:google:',   // main format used by veramo-to-sui.js
  'did:zklogin:twitch:',
  'did:zklogin:facebook:',
  'did:ethr:sepolia:',     // legacy Veramo format
]

// ============== Utility Functions ==============
function decodeVecU8(v) {
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

function getObjectTypeName(type) {
  if (type.includes('::store_did_vc::DIDVC')) return 'DIDVC'
  if (type.includes('::medical_access::DIDObject')) return 'DIDObject'
  if (type.includes('::medical_access::AccessGrant')) return 'AccessGrant'
  return type.split('::').pop() || type
}

function extractDidFromFields(fields, objectType) {
  if (!fields) return null

  // DIDVC contract stores "did" as vector<u8>
  if (objectType.includes('store_did_vc')) {
    return decodeVecU8(fields.did)
  }
  // medical_access stores "did" as vector<u8>
  if (objectType.includes('medical_access') && fields.did) {
    return decodeVecU8(fields.did)
  }
  // Some versions may use "did_str" as String
  if (fields.did_str) return fields.did_str

  return null
}

/**
 * Extract the address part from a DID string.
 * e.g. "did:ethr:sepolia:0xABC" -> "0xabc"
 *      "did:zklogin:google:0xABC" -> "0xabc"
 *      "0xABC" -> "0xabc"
 */
function extractAddress(did) {
  if (!did) return null
  // If it's already a raw address
  if (did.startsWith('0x') && !did.includes(':')) return did.toLowerCase()
  // Extract from DID URI — the address is the last segment after ':'
  const parts = did.split(':')
  const last = parts[parts.length - 1]
  if (last && last.startsWith('0x')) return last.toLowerCase()
  return null
}

/**
 * Generate all possible DID variants for a given DID or address.
 * This allows searching "did:ethr:sepolia:0xABC" to also find "did:zklogin:google:0xABC".
 */
function generateDidVariants(inputDid) {
  const addr = extractAddress(inputDid)
  if (!addr) return [inputDid] // fallback: exact match only

  const variants = [inputDid] // always include the original
  for (const prefix of DID_PREFIXES) {
    const variant = prefix + addr
    if (variant !== inputDid) variants.push(variant)
    // Also try with original case address
    const originalAddr = inputDid.split(':').pop()
    if (originalAddr && originalAddr.startsWith('0x')) {
      const variantOrigCase = prefix + originalAddr
      if (!variants.includes(variantOrigCase)) variants.push(variantOrigCase)
    }
  }
  return variants
}

/**
 * Check if a on-chain DID matches the target DID.
 * Supports: exact match, address-based cross-prefix match, case-insensitive.
 */
function didMatches(onChainDid, targetDid) {
  if (!onChainDid || !targetDid) return false
  // Exact match
  if (onChainDid === targetDid) return true
  // Case-insensitive exact match
  if (onChainDid.toLowerCase() === targetDid.toLowerCase()) return true
  // Address-based match (cross DID method prefix)
  const onChainAddr = extractAddress(onChainDid)
  const targetAddr = extractAddress(targetDid)
  if (onChainAddr && targetAddr && onChainAddr === targetAddr) return true
  return false
}

function printDivider() {
  console.log('─'.repeat(60))
}

function printResult(label, value) {
  console.log(`  ${label.padEnd(16)}: ${value}`)
}

// ============== Strategy 1: Search by DID String ==============
async function searchByDid(client, didString, verbose) {
  const addr = extractAddress(didString)
  const variants = generateDidVariants(didString)

  console.log(`\n🔍 Searching for DID: ${didString}`)
  if (addr) console.log(`   Address extracted: ${addr}`)
  console.log(`   Will match any DID containing this address (cross-prefix)`)
  console.log(`   Network: ${SUI_RPC_URL}`)
  console.log(`   Package: ${DIDVC_PACKAGE_ID} (store_did_vc)`)
  if (verbose) {
    console.log(`   DID variants to match:`)
    for (const v of variants) console.log(`     - ${v}`)
  }
  printDivider()

  const startTime = performance.now()

  // Scan only the store_did_vc package
  const results = await scanTransactionsForDid(client, DIDVC_PACKAGE_ID, 'store_did_vc', 'create_did_vc', TYPE_DIDVC, didString, verbose)

  const elapsed = (performance.now() - startTime).toFixed(0)

  if (results.length === 0) {
    console.log(`\n❌ DID NOT FOUND on chain`)
    console.log(`   Searched in ${elapsed}ms`)
    console.log(`   DID: ${didString}`)
    if (addr) console.log(`   Also tried matching address: ${addr} across all DID method prefixes`)
    return false
  }

  console.log(`\n✅ DID EXISTS — found ${results.length} on-chain object(s)`)
  console.log(`   Search completed in ${elapsed}ms\n`)

  for (const r of results) {
    printDivider()
    printResult('Object ID', r.objectId)
    printResult('Type', r.typeName)
    printResult('DID (on-chain)', r.did)
    printResult('Matched query', didString)
    if (r.did !== didString) printResult('Match type', 'cross-prefix (address match)')
    if (r.publicKey) printResult('Public Key', r.publicKey)
    if (r.vc) printResult('VC', r.vc.length > 100 ? r.vc.substring(0, 100) + '...' : r.vc)
    if (r.owner) printResult('Owner', r.owner)
  }
  printDivider()

  return true
}

async function scanTransactionsForDid(client, packageId, moduleName, functionName, typeSuffix, targetDid, verbose) {
  const results = []
  let cursor = null
  const limit = 50
  const maxPages = 20

  for (let page = 0; page < maxPages; page++) {
    let resp
    try {
      resp = await client.queryTransactionBlocks({
        filter: {
          MoveFunction: {
            package: packageId,
            module: moduleName,
            function: functionName,
          },
        },
        cursor,
        limit,
        options: { showObjectChanges: true },
      })
    } catch (e) {
      if (verbose) console.log(`   ⚠️  Error querying ${moduleName}::${functionName} on ${packageId}: ${e.message}`)
      break
    }

    const txs = resp?.data || []
    if (verbose && page === 0) console.log(`   Found ${txs.length} tx(s) for ${moduleName}::${functionName}`)

    // Collect all object IDs that need fetching
    const objectsToFetch = []
    for (const tx of txs) {
      const changes = tx.objectChanges || []
      for (const ch of changes) {
        if (ch.type === 'created' && typeof ch.objectType === 'string' && ch.objectType.endsWith(typeSuffix)) {
          objectsToFetch.push({ objectId: ch.objectId, objectType: ch.objectType })
        }
      }
    }

    if (objectsToFetch.length === 0) {
      if (!resp.hasNextPage || !resp.nextCursor) break
      cursor = resp.nextCursor
      continue
    }

    // Batch fetch all objects in ONE RPC call using multiGetObjects
    try {
      const objs = await client.multiGetObjects({
        ids: objectsToFetch.map(o => o.objectId),
        options: { showContent: true, showOwner: true },
      })

      for (let i = 0; i < objs.length; i++) {
        const obj = objs[i]
        const { objectId, objectType } = objectsToFetch[i]
        const fields = obj?.data?.content?.fields
        if (!fields) continue

        const didStr = extractDidFromFields(fields, objectType)
        if (verbose && didStr) console.log(`     Found DID on-chain: ${didStr}`)
        if (didMatches(didStr, targetDid)) {
          const owner = obj.data?.owner?.AddressOwner || obj.data?.owner?.ObjectOwner || 'unknown'
          results.push({
            objectId,
            typeName: getObjectTypeName(objectType),
            did: didStr,
            publicKey: fields.public_key ? `(base64, ${String(fields.public_key).length} chars)` : null,
            vc: fields.vc ? decodeVecU8(fields.vc) : null,
            owner,
          })
        }
      }
    } catch (e) {
      if (verbose) console.log(`   ⚠️  multiGetObjects error: ${e.message}`)
    }

    if (!resp.hasNextPage || !resp.nextCursor) break
    cursor = resp.nextCursor
  }

  return results
}

// ============== Strategy 2: Search by Owner Address ==============
async function searchByOwner(client, ownerAddress, verbose) {
  console.log(`\n🔍 Searching all DID objects owned by: ${ownerAddress}`)
  console.log(`   Network: ${SUI_RPC_URL}`)
  printDivider()

  const startTime = performance.now()
  const results = []

  let cursor = null
  let hasMore = true

  while (hasMore) {
    const resp = await client.getOwnedObjects({
      owner: ownerAddress,
      cursor,
      options: { showContent: true, showType: true },
    })

    const objs = resp.data || []
    for (const o of objs) {
      const objectId = o.data?.objectId
      const type = o.data?.content?.type || o.data?.type
      if (!objectId || !type) continue

      // Only match store_did_vc::DIDVC objects
      if (!type.includes('store_did_vc::DIDVC')) continue

      // Need to fetch full content if not already included
      let fields = o.data?.content?.fields
      if (!fields) {
        try {
          const detail = await client.getObject({ id: objectId, options: { showContent: true } })
          fields = detail.data?.content?.fields
        } catch { continue }
      }
      if (!fields) continue

      results.push({
        objectId,
        typeName: 'DIDVC',
        did: decodeVecU8(fields.did),
        vc: decodeVecU8(fields.vc),
      })
    }

    hasMore = resp.hasNextPage && resp.nextCursor
    cursor = resp.nextCursor
  }

  const elapsed = (performance.now() - startTime).toFixed(0)

  if (results.length === 0) {
    console.log(`\n❌ No DID-related objects found for this address`)
    console.log(`   Searched in ${elapsed}ms`)
    return false
  }

  console.log(`\n✅ Found ${results.length} DID-related object(s) in ${elapsed}ms\n`)

  for (const r of results) {
    printDivider()
    printResult('Object ID', r.objectId)
    printResult('Type', r.typeName)
    if (r.did) printResult('DID', r.did)
    if (r.publicKey) printResult('Public Key', r.publicKey)
    if (r.vc) printResult('VC', r.vc.length > 120 ? r.vc.substring(0, 120) + '...' : r.vc)
    if (r.patientDid) printResult('Patient DID', r.patientDid)
    if (r.granteeDid) printResult('Grantee DID', r.granteeDid)
    if (r.recordId) printResult('Record ID', r.recordId)
    if (r.grantedAt) printResult('Granted At', r.grantedAt)
  }
  printDivider()

  return true
}

// ============== Strategy 3: Search by Object ID ==============
async function searchByObjectId(client, objectId, verbose) {
  console.log(`\n🔍 Looking up SUI object: ${objectId}`)
  console.log(`   Network: ${SUI_RPC_URL}`)
  printDivider()

  const startTime = performance.now()

  try {
    const obj = await client.getObject({
      id: objectId,
      options: { showContent: true, showOwner: true, showType: true },
    })

    const elapsed = (performance.now() - startTime).toFixed(0)

    if (!obj.data) {
      console.log(`\n❌ Object not found (may have been deleted or never existed)`)
      return false
    }

    const type = obj.data.content?.type || obj.data.type || 'unknown'
    const fields = obj.data.content?.fields || {}
    const owner = obj.data.owner?.AddressOwner || obj.data.owner?.ObjectOwner || JSON.stringify(obj.data.owner)

    const isDIDRelated = type.includes('store_did_vc') || type.includes('medical_access')

    console.log(`\n✅ Object EXISTS on chain — fetched in ${elapsed}ms\n`)
    printDivider()
    printResult('Object ID', obj.data.objectId)
    printResult('Type', type)
    printResult('Owner', owner)
    printResult('DID Related', isDIDRelated ? 'Yes' : 'No')

    if (isDIDRelated) {
      if (fields.did) printResult('DID', decodeVecU8(fields.did))
      if (fields.did_str) printResult('DID', fields.did_str)
      if (fields.public_key) printResult('Public Key', `(${Buffer.from(fields.public_key, 'base64').length} bytes)`)
      if (fields.vc) {
        const vc = decodeVecU8(fields.vc)
        printResult('VC', vc.length > 120 ? vc.substring(0, 120) + '...' : vc)
      }
      if (fields.patient_did) printResult('Patient DID', decodeVecU8(fields.patient_did))
      if (fields.grantee_did) printResult('Grantee DID', decodeVecU8(fields.grantee_did))
      if (fields.record_id) printResult('Record ID', decodeVecU8(fields.record_id))
      if (fields.granted_at) printResult('Granted At', fields.granted_at)
    }

    if (verbose) {
      console.log('\n  Raw fields:')
      console.log(JSON.stringify(fields, null, 2))
    }

    printDivider()
    return true

  } catch (e) {
    console.log(`\n❌ Lookup failed: ${e.message}`)
    return false
  }
}

// ============== CLI Argument Parser ==============
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { did: null, owner: null, object: null, verbose: false, help: false }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--did':
      case '-d':
        opts.did = args[++i]
        break
      case '--owner':
      case '-o':
        opts.owner = args[++i]
        break
      case '--object':
      case '--id':
        opts.object = args[++i]
        break
      case '--verbose':
      case '-v':
        opts.verbose = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
    }
  }

  return opts
}

function printUsage() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              🔍 DID Search on SUI Blockchain            ║
╚══════════════════════════════════════════════════════════╝

Usage:
  npm run search:did -- [options]

Search Modes:
  --did, -d <string>      Search by DID string or raw address
  --owner, -o <address>   List all DID objects owned by a SUI address
  --object, --id <id>     Direct lookup by SUI Object ID

  The --did flag supports flexible matching:
    - Exact DID:  "did:zklogin:google:0xABC..."
    - Any prefix: "did:ethr:sepolia:0xABC..." will also find "did:zklogin:google:0xABC..."
    - Raw address: "0xABC..." matches any DID containing that address

Options:
  --verbose, -v           Show detailed debug output
  --help, -h              Show this help message

Environment Variables:
  SUI_RPC_URL             Override the default RPC endpoint (default: devnet)
  SUI_PACKAGE_ID          Add an additional package ID to search

Examples:
  npm run search:did -- --did "did:zklogin:google:0xc33643f49..."
  npm run search:did -- --did "did:ethr:sepolia:0xc33643f49..."
  npm run search:did -- --did "0xc33643f49..."
  npm run search:did -- --owner "0x1234abcd..."
  npm run search:did -- --object "0xdeadbeef..."
  npm run search:did -- --did "did:zklogin:google:0x..." --verbose
`)
}

// ============== Main ==============
async function main() {
  const opts = parseArgs()

  if (opts.help || (!opts.did && !opts.owner && !opts.object)) {
    printUsage()
    process.exit(opts.help ? 0 : 1)
  }

  const client = new SuiClient({ url: SUI_RPC_URL })

  let found = false

  if (opts.did) {
    found = await searchByDid(client, opts.did, opts.verbose)
  } else if (opts.owner) {
    found = await searchByOwner(client, opts.owner, opts.verbose)
  } else if (opts.object) {
    found = await searchByObjectId(client, opts.object, opts.verbose)
  }

  console.log('')
  process.exit(found ? 0 : 1)
}

main().catch(e => {
  console.error('💥 Fatal error:', e.message)
  process.exit(2)
})
