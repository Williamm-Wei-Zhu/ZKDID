// list_all_vc.mjs
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

const PACKAGE_ID = '0x601c8d5158684d1199f50a430d22dc59dc9d0c674d26b223235c8854390dc486'
const TARGET_TYPE = `${PACKAGE_ID}::store_did_vc::DIDVC`
const SUI_URL = process.env.SUI_RPC_URL || getFullnodeUrl('devnet')

// ---------- Utility Functions ----------
function decodeVectorU8(v) {
  if (!v) return null
  if (Array.isArray(v)) return Buffer.from(v).toString('utf8')
  if (typeof v === 'string') {
    try { return Buffer.from(v, 'base64').toString('utf8') } catch {}
    return v
  }
  return JSON.stringify(v)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { owner: null, did: null, name: null }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--did') {
      opts.did = args[i + 1]
      i++
    } else if (args[i] === '--name') {
      opts.name = args[i + 1]
      i++
    } else if (!opts.owner) {
      opts.owner = args[i]
    }
  }

  if (!opts.owner) {
    console.error('Usage:')
    console.error('  node list_all_vc.mjs <ownerAddress> [--did <DID>] [--name "<Name>"]')
    process.exit(1)
  }

  return opts
}

// ---------- Main Function ----------
async function main() {
  const { owner, did: didFilter, name: nameFilter } = parseArgs()
  const client = new SuiClient({ url: SUI_URL })

  console.log('🔗 Using Sui RPC:', SUI_URL)
  console.log('🔍 Listing all objects under address:', owner)
  if (didFilter) console.log('🔎 Filtering by DID:', didFilter)
  if (nameFilter) console.log('🔎 Filtering by Name:', nameFilter)

  // 1️⃣ First list all objectIds under this address
  const resp = await client.getOwnedObjects({ owner })
  const objs = resp.data || []
  console.log(`📦 Total object count: ${objs.length}\n`)

  if (objs.length === 0) {
    console.log('ℹ️ No objects found')
    return
  }

  let found = 0
  for (const o of objs) {
    const objectId = o.data?.objectId
    if (!objectId) continue

    // 2️⃣ Call getObject to get detailed information
    const detail = await client.getObject({ id: objectId, options: { showContent: true } })
    const type = detail.data?.content?.type
    if (!type || !type.startsWith(TARGET_TYPE)) continue

    const fields = detail.data?.content?.fields || {}
    const didStr = decodeVectorU8(fields.did)
    const vcStr = decodeVectorU8(fields.vc)

    // Try to parse VC JSON
    let vcObj = null
    try {
      vcObj = JSON.parse(vcStr)
    } catch {}

    // 3️⃣ Apply filter conditions
    if (didFilter && didStr !== didFilter) continue

    if (nameFilter) {
      const vcName = vcObj?.credentialSubject?.name
      if (vcName !== nameFilter) continue
    }

    // 4️⃣ Print matching records
    found++
    console.log('────────────────────────────')
    console.log(`🟡 Object ID: ${objectId}`)
    console.log(`   Type     : ${type}`)
    console.log(`   DID      : ${didStr}`)
    console.log('   VC       :', vcStr)
  }

  if (found === 0) {
    console.log('⚠️ No DIDVC objects matching the criteria were found')
  } else {
    console.log(`\n✅ Found ${found} matching records in total`)
  }
}

main()