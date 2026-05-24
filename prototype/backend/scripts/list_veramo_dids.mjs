import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..')
const DIDS = path.join(ROOT, 'dids.json')
if (!fs.existsSync(DIDS)) {
  console.error('Cannot find dids.json:', DIDS)
  process.exit(1)
}
const data = JSON.parse(fs.readFileSync(DIDS, 'utf-8'))

for (const [did, info] of Object.entries(data)) {
  console.log('DID:', did)
  const latest = info.latestZkLoginSession || null
  console.log('  latestZkLoginSession.userAddress:', latest?.userAddress ?? '(none)')
  console.log('  latestZkLoginSession.maxEpoch:', latest?.maxEpoch ?? '(none)')
  console.log('  latestIdToken:', info.latestIdToken ? '[present]' : '[none]')
  const vcs = Array.isArray(info.verifiableCredentials) ? info.verifiableCredentials : []
  console.log('  verifiableCredentials count:', vcs.length)
  vcs.slice(0, 5).forEach((vc, i) => {
    const s = typeof vc === 'string' ? vc.slice(0, 200) : JSON.stringify(vc).slice(0, 200)
    console.log(`    VC[${i}]:`, s.replace(/\n/g,' '))
  })
  console.log('')
}