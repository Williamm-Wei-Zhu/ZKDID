#!/usr/bin/env node
// search-access.mjs
// Search & verify medical_access AccessGrant records on the SUI blockchain
//
// Scans create_access_grant transactions and matches by patient_did, hospital_did,
// grantee_did, and/or record_id. All DID filters support cross-prefix DID matching
// (e.g. did:ethr:sepolia:0x... will also match did:zklogin:google:0x...).
//
// Business logic: patient_did grants grantee_did access to record_id at hospital_did
//
// Usage:
//   npm run search:access -- --patient "did:zklogin:google:0x..."
//   npm run search:access -- --hospital "did:zklogin:google:0x..."
//   npm run search:access -- --grantee "did:zklogin:google:0x..."
//   npm run search:access -- --record "record-123"
//   npm run search:access -- --patient "0xABC..." --hospital "0xDEF..." --grantee "0xGHI..." --record "rec-1"
//   npm run search:access -- --all
//   npm run search:access -- --patient "0xABC..." --verbose

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

// ============== Configuration ==============
const SUI_RPC_URL = process.env.SUI_RPC_URL || getFullnodeUrl('devnet')

// medical_access package ID (the only package for AccessGrant)
const MEDICAL_ACCESS_PACKAGE_ID = '0xea6c91e893af024db94d3b73b89124d164158b0aff19de1b49bb830ffc9398da'

const TYPE_ACCESS_GRANT = '::medical_access::AccessGrant'

// Known DID method prefixes used in this project
const DID_PREFIXES = [
  'did:zklogin:google:',
  'did:zklogin:twitch:',
  'did:zklogin:facebook:',
  'did:ethr:sepolia:',
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

/**
 * Extract the address part from a DID string.
 * e.g. "did:ethr:sepolia:0xABC" -> "0xabc"
 *      "did:zklogin:google:0xABC" -> "0xabc"
 *      "0xABC" -> "0xabc"
 */
function extractAddress(did) {
  if (!did) return null
  if (did.startsWith('0x') && !did.includes(':')) return did.toLowerCase()
  const parts = did.split(':')
  const last = parts[parts.length - 1]
  if (last && last.startsWith('0x')) return last.toLowerCase()
  return null
}

/**
 * Check if an on-chain DID matches the target DID.
 * Supports: exact match, case-insensitive, address-based cross-prefix match.
 */
function didMatches(onChainDid, targetDid) {
  if (!onChainDid || !targetDid) return false
  if (onChainDid === targetDid) return true
  if (onChainDid.toLowerCase() === targetDid.toLowerCase()) return true
  const onChainAddr = extractAddress(onChainDid)
  const targetAddr = extractAddress(targetDid)
  if (onChainAddr && targetAddr && onChainAddr === targetAddr) return true
  return false
}

/**
 * Check if an on-chain record_id matches the target.
 * Supports exact match and case-insensitive match.
 */
function recordMatches(onChainRecordId, targetRecordId) {
  if (!onChainRecordId || !targetRecordId) return false
  if (onChainRecordId === targetRecordId) return true
  if (onChainRecordId.toLowerCase() === targetRecordId.toLowerCase()) return true
  return false
}

function formatTimestamp(ts) {
  if (!ts) return 'N/A'
  const n = Number(ts)
  if (n === 0) return '0'
  // If it looks like a Unix ms timestamp (> year 2000)
  if (n > 946684800000) {
    try { return `${new Date(n).toISOString()} (${n})` } catch {}
  }
  // If it looks like a Unix seconds timestamp
  if (n > 946684800 && n < 9999999999) {
    try { return `${new Date(n * 1000).toISOString()} (${n})` } catch {}
  }
  return String(n)
}

function printDivider() {
  console.log('─'.repeat(70))
}

function printResult(label, value) {
  console.log(`  ${label.padEnd(18)}: ${value}`)
}

// ============== Core: Scan AccessGrant transactions ==============
async function scanAccessGrants(client, opts) {
  const { patientDid, hospitalDid, granteeDid, recordId, listAll, verbose } = opts

  // Header
  console.log(`\n🔍 Searching AccessGrant records on SUI blockchain`)
  console.log(`   Network: ${SUI_RPC_URL}`)
  console.log(`   Package: ${MEDICAL_ACCESS_PACKAGE_ID} (medical_access)`)
  if (patientDid)  console.log(`   Filter patient_did:  ${patientDid}`)
  if (hospitalDid) console.log(`   Filter hospital_did: ${hospitalDid}`)
  if (granteeDid)  console.log(`   Filter grantee_did:  ${granteeDid}`)
  if (recordId)    console.log(`   Filter record_id:    ${recordId}`)
  if (listAll)     console.log(`   Mode: list ALL AccessGrant records`)
  console.log(`   DID matching: cross-prefix (address-based)`)
  printDivider()

  const results = []
  const startTime = performance.now()

  // Scan the medical_access package
  let cursor = null
  const limit = 50
  const maxPages = 20

  for (let page = 0; page < maxPages; page++) {
    let resp
    try {
      resp = await client.queryTransactionBlocks({
        filter: {
          MoveFunction: {
            package: MEDICAL_ACCESS_PACKAGE_ID,
            module: 'medical_access',
            function: 'create_access_grant',
          },
        },
        cursor,
        limit,
        options: { showObjectChanges: true },
      })
    } catch (e) {
      if (verbose) console.log(`   ⚠️  Error querying create_access_grant: ${e.message}`)
      break
    }

    const txs = resp?.data || []
    if (verbose && page === 0) console.log(`   Found ${txs.length} tx(s) for medical_access::create_access_grant`)

    // Collect all object IDs to batch fetch
    const objectsToFetch = []
    for (const tx of txs) {
      const changes = tx.objectChanges || []
      for (const ch of changes) {
        if (ch.type !== 'created' || typeof ch.objectType !== 'string' || !ch.objectType.endsWith(TYPE_ACCESS_GRANT)) continue
        objectsToFetch.push(ch.objectId)
      }
    }

    if (objectsToFetch.length > 0) {
      // Batch fetch all objects in ONE RPC call using multiGetObjects
      try {
        const objs = await client.multiGetObjects({
          ids: objectsToFetch,
          options: { showContent: true, showOwner: true },
        })

        for (const obj of objs) {
          const fields = obj?.data?.content?.fields
          if (!fields) continue

          const onChainPatient  = decodeVecU8(fields.patient_did)
          const onChainHospital = decodeVecU8(fields.hospital_did)
          const onChainGrantee  = decodeVecU8(fields.grantee_did)
          const onChainRecord   = decodeVecU8(fields.record_id)
          const onChainTime     = fields.timestamp || fields.granted_at
          const onChainActive   = fields.is_active

          if (verbose) {
            console.log(`     AccessGrant: patient=${onChainPatient}, hospital=${onChainHospital}, grantee=${onChainGrantee}, record=${onChainRecord}, active=${onChainActive}`)
          }

          // Apply filters (all provided filters must match)
          if (!listAll) {
            if (patientDid && !didMatches(onChainPatient, patientDid)) continue
            if (hospitalDid && !didMatches(onChainHospital, hospitalDid)) continue
            if (granteeDid && !didMatches(onChainGrantee, granteeDid)) continue
            if (recordId && !recordMatches(onChainRecord, recordId)) continue
          }

          const owner = obj.data?.owner?.AddressOwner || obj.data?.owner?.ObjectOwner || 'unknown'
          results.push({
            objectId: obj.data?.objectId,
            patientDid: onChainPatient,
            hospitalDid: onChainHospital,
            granteeDid: onChainGrantee,
            recordId: onChainRecord,
            timestamp: onChainTime,
            isActive: onChainActive,
            owner,
          })
        }
      } catch (e) {
        if (verbose) console.log(`   ⚠️  multiGetObjects error: ${e.message}`)
      }
    }

    if (!resp.hasNextPage || !resp.nextCursor) break
    cursor = resp.nextCursor
  }

  const elapsed = (performance.now() - startTime).toFixed(0)

  // Output results
  if (results.length === 0) {
    console.log(`\n❌ No AccessGrant records found`)
    console.log(`   Searched in ${elapsed}ms`)
    if (patientDid)  console.log(`   patient_did:  ${patientDid}`)
    if (hospitalDid) console.log(`   hospital_did: ${hospitalDid}`)
    if (granteeDid)  console.log(`   grantee_did:  ${granteeDid}`)
    if (recordId)    console.log(`   record_id:    ${recordId}`)
    return false
  }

  console.log(`\n✅ Found ${results.length} AccessGrant record(s) in ${elapsed}ms\n`)

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    printDivider()
    console.log(`  📋 Record #${i + 1}`)
    printResult('Object ID', r.objectId)
    printResult('Patient DID', r.patientDid)
    printResult('Hospital DID', r.hospitalDid || 'N/A')
    printResult('Grantee DID', r.granteeDid)
    printResult('Record ID', r.recordId)
    printResult('Timestamp', formatTimestamp(r.timestamp))
    printResult('Active', r.isActive != null ? String(r.isActive) : 'N/A')
    printResult('Owner', r.owner)
    if (verbose) printResult('Package', MEDICAL_ACCESS_PACKAGE_ID)

    // Show match details
    const matchDetails = []
    if (patientDid && r.patientDid !== patientDid) matchDetails.push(`patient: cross-prefix`)
    if (hospitalDid && r.hospitalDid !== hospitalDid) matchDetails.push(`hospital: cross-prefix`)
    if (granteeDid && r.granteeDid !== granteeDid) matchDetails.push(`grantee: cross-prefix`)
    if (matchDetails.length > 0) printResult('Match type', matchDetails.join(', '))
  }
  printDivider()

  return true
}

// ============== CLI Argument Parser ==============
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    patientDid: null,
    hospitalDid: null,
    granteeDid: null,
    recordId: null,
    listAll: false,
    verbose: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--patient':
      case '--patient-did':
      case '-p':
        opts.patientDid = args[++i]
        break
      case '--hospital':
      case '--hospital-did':
      case '-H':
        opts.hospitalDid = args[++i]
        break
      case '--grantee':
      case '--grantee-did':
      case '-g':
        opts.granteeDid = args[++i]
        break
      case '--record':
      case '--record-id':
      case '-r':
        opts.recordId = args[++i]
        break
      case '--all':
      case '-a':
        opts.listAll = true
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
╔══════════════════════════════════════════════════════════════╗
║        🏥 Medical Access Record Search on SUI Blockchain    ║
╚══════════════════════════════════════════════════════════════╝

  Business logic: patient_did grants grantee_did access to record_id at hospital_did

Usage:
  npm run search:access -- [options]

Filters (combine any or all):
  --patient, -p <did>     Filter by patient DID
  --hospital, -H <did>    Filter by hospital/institution DID
  --grantee, -g <did>     Filter by grantee DID
  --record, -r <id>       Filter by record ID
  --all, -a               List ALL AccessGrant records (no filter)

  DID filters support flexible matching:
    - Exact DID:  "did:zklogin:google:0xABC..."
    - Any prefix: "did:ethr:sepolia:0xABC..." also matches "did:zklogin:google:0xABC..."
    - Raw address: "0xABC..." matches any DID containing that address

Options:
  --verbose, -v           Show detailed debug output
  --help, -h              Show this help message

Environment Variables:
  SUI_RPC_URL             Override the default RPC endpoint (default: devnet)
  SUI_PACKAGE_ID          Add an additional package ID to search

Examples:
  npm run search:access -- --patient "did:zklogin:google:0xc336..."
  npm run search:access -- --hospital "did:zklogin:google:0xad5d..."
  npm run search:access -- --grantee "did:ethr:sepolia:0xA220..."
  npm run search:access -- --record "000009"
  npm run search:access -- --patient "0xc336..." --hospital "0xad5d..." --grantee "0xA220..."
  npm run search:access -- --patient "0xc336..." --record "rec-1" --verbose
  npm run search:access -- --all
`)
}

// ============== Main ==============
async function main() {
  const opts = parseArgs()

  if (opts.help) {
    printUsage()
    process.exit(0)
  }

  if (!opts.patientDid && !opts.hospitalDid && !opts.granteeDid && !opts.recordId && !opts.listAll) {
    console.error('❌ At least one filter is required. Use --all to list everything.\n')
    printUsage()
    process.exit(1)
  }

  const client = new SuiClient({ url: SUI_RPC_URL })

  const found = await scanAccessGrants(client, opts)

  console.log('')
  process.exit(found ? 0 : 1)
}

main().catch(e => {
  console.error('💥 Fatal error:', e.message)
  process.exit(2)
})
