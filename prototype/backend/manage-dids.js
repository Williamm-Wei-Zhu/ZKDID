// Simple DID & VC Management Dashboard (ESM friendly if "type":"module" set; else rename to .mjs)
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ---------- Config ----------
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_PATH = path.resolve(__dirname, './dids.json')
const PORT = Number(process.env.PORT || 3000)

// ---------- Data Access ----------
function ensureStore() {
  if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify({}, null, 2))
}
function readStore() {
  ensureStore()
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8')
    return JSON.parse(raw || '{}') || {}
  } catch {
    return {}
  }
}
let writeQueue = Promise.resolve()
function writeStore(obj) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DATA_PATH, JSON.stringify(obj, null, 2)))
  return writeQueue
}

// ---------- Helpers ----------
function send(res, status, body, headers = {}) {
  const h = { 'content-type': 'application/json; charset=utf-8', ...headers }
  res.writeHead(status, h)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
function notFound(res) { send(res, 404, { error: 'not found' }) }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => {
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
    })
  })
}

// ---------- API Router ----------
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const { pathname, searchParams } = url
  const store = readStore()

  // CORS (optional)
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    return res.end()
  }
  const setCORS = (res) => {
    res.setHeader('access-control-allow-origin', '*')
  }

  // /api/dids
  if (pathname === '/api/dids' && req.method === 'GET') {
    setCORS(res)
    const list = Object.entries(store).map(([did, v]) => ({
      did,
      verifiableCredentialCount: Array.isArray(v.verifiableCredentials) ? v.verifiableCredentials.length : 0,
      idTokensHistory: (v.idTokensHistory || []).length,
      latestIdToken: v.latestIdToken ? true : false,
      zkLoginSessions: Array.isArray(v.zkLoginSessions) ? v.zkLoginSessions.length : 0,
      hasLatestZkLoginSession: v.latestZkLoginSession ? true : false,
    }))
    return send(res, 200, { list, updatedAt: new Date().toISOString() })
  }

  // /api/dids/:encodedDid
  if (pathname.startsWith('/api/dids/')) {
    const parts = pathname.split('/').filter(Boolean) // ['api','dids',...]
    if (parts.length >= 3) {
      const didEncoded = parts.slice(2).join('/') // allow slashes encoded
      const did = decodeURIComponent(didEncoded)

      // GET detail
      if (req.method === 'GET') {
        setCORS(res)
        if (!store[did]) return notFound(res)
        return send(res, 200, { did, data: store[did] })
      }

      // DELETE did
      if (req.method === 'DELETE' && parts.length === 3) {
        setCORS(res)
        if (!store[did]) return notFound(res)
        delete store[did]
        await writeStore(store)
        return send(res, 200, { ok: true, deleted: did })
      }

      // Credentials sub-routes
      if (parts.length >= 4 && parts[3] === 'credentials') {
        // POST /api/dids/:did/credentials  { vc: {...} }
        if (req.method === 'POST' && parts.length === 4) {
          setCORS(res)
            if (!store[did]) return notFound(res)
          const body = await parseBody(req).catch(e => ({ __parseError: e.message }))
          if (body.__parseError) return send(res, 400, { error: 'invalid json', detail: body.__parseError })
          if (!body || typeof body !== 'object' || !body.vc) return send(res, 400, { error: 'missing vc' })
          const vcs = Array.isArray(store[did].verifiableCredentials) ? store[did].verifiableCredentials : []
          vcs.push(body.vc)
          store[did].verifiableCredentials = vcs
          await writeStore(store)
          return send(res, 200, { ok: true, count: vcs.length })
        }
        // DELETE /api/dids/:did/credentials/:index
        if (req.method === 'DELETE' && parts.length === 5) {
          setCORS(res)
          if (!store[did]) return notFound(res)
          const idx = Number(parts[4])
          const vcs = Array.isArray(store[did].verifiableCredentials) ? store[did].verifiableCredentials : []
          if (!Number.isInteger(idx) || idx < 0 || idx >= vcs.length) return send(res, 400, { error: 'invalid index' })
          const removed = vcs.splice(idx, 1)
          store[did].verifiableCredentials = vcs
          await writeStore(store)
          return send(res, 200, { ok: true, removedIndex: idx, remaining: vcs.length, removed })
        }
      }

      // zkLoginSessions trim: POST /api/dids/:did/trim-sessions?keep=1
      if (parts.length === 4 && parts[3] === 'trim-sessions' && req.method === 'POST') {
        setCORS(res)
        if (!store[did]) return notFound(res)
        const keep = Math.max(0, Number(searchParams.get('keep') || 1))
        const arr = Array.isArray(store[did].zkLoginSessions) ? store[did].zkLoginSessions : []
        const trimmed = arr.slice(-keep)
        store[did].zkLoginSessions = trimmed
        store[did].latestZkLoginSession = trimmed[trimmed.length - 1] || null
        await writeStore(store)
        return send(res, 200, { ok: true, kept: trimmed.length })
      }
    }
  }

  // Export raw file
  if (pathname === '/api/export/raw' && req.method === 'GET') {
    setCORS(res)
    const raw = fs.readFileSync(DATA_PATH, 'utf-8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="dids.json"',
    })
    return res.end(raw)
  }

  return notFound(res)
}

// ---------- HTML (Single Page) ----------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DID & VC Management</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
html,body{margin:0;font-family:system-ui,Arial,sans-serif;background:#0f1218;color:#d8dce3;}
header{padding:10px 16px;background:#1b222d;display:flex;align-items:center;gap:12px;}
h1{font-size:18px;margin:0;}
#container{display:flex;height:calc(100vh - 60px);}
#list{width:320px;border-right:1px solid #2a323f;overflow:auto;}
#detail{flex:1;overflow:auto;padding:16px;}
.did-item{padding:8px 12px;border-bottom:1px solid #1f2732;cursor:pointer;display:flex;flex-direction:column;gap:4px;}
.did-item:hover{background:#1d2531;}
.did-item.active{background:#243140;}
.badge{display:inline-block;background:#39475a;padding:1px 6px;border-radius:10px;font-size:11px;margin-right:4px;}
button{background:#365880;color:#fff;border:0;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px;}
button.danger{background:#a84332;}
button.secondary{background:#2e3d4f;}
pre{background:#141a22;padding:12px;overflow:auto;border:1px solid #253040;border-radius:4px;font-size:12px;line-height:1.4;}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 16px;}
input[type=file]{color:#d8dce3;}
table{border-collapse:collapse;width:100%;font-size:12px;}
td,th{border:1px solid #2a3644;padding:4px 6px;text-align:left;vertical-align:top;}
.tag{background:#314257;border-radius:3px;padding:2px 6px;font-size:11px;margin-right:4px;display:inline-block;}
small{opacity:.75;}
.search{width:100%;box-sizing:border-box;padding:6px 8px;margin:8px 0;border:1px solid #2a3644;background:#141a22;color:#eee;border-radius:4px;}
footer{padding:6px 14px;font-size:11px;background:#1b222d;color:#7d8794;}
</style>
</head>
<body>
<header>
  <h1>DID & VC Management</h1>
  <button onclick="refreshList()">Refresh List</button>
  <button onclick="exportRaw()">Export dids.json</button>
  <span id="status" style="font-size:12px;opacity:.7;"></span>
</header>
<div id="container">
  <div id="list">
    <input id="search" class="search" placeholder="Search DID..." oninput="filterList()" />
    <div id="didList"></div>
  </div>
  <div id="detail">
    <h2 id="detailTitle" style="margin-top:0;">Select a DID</h2>
    <div class="actions" id="detailActions" style="display:none;">
      <button onclick="deleteCurrent()" class="danger">Delete this DID</button>
      <button onclick="trimSessions()" class="secondary">Keep latest zkLogin session (1)</button>
      <label class="secondary" style="padding:6px 8px;cursor:pointer;">
        <input type="file" accept="application/json" style="display:none" onchange="uploadVC(event)" />
        Add VC (JSON)
      </label>
    </div>
    <div id="detailBody"></div>
  </div>
</div>
<footer>
  Live reading: dids.json | If an external process writes to it, click “Refresh List” to sync
</footer>
<script>
let DID_CACHE = []
let CURRENT_DID = null

async function refreshList() {
  setStatus('Loading...')
  try {
    const r = await fetch('/api/dids')
    const j = await r.json()
    DID_CACHE = j.list || []
    renderList()
    setStatus('Total ' + DID_CACHE.length + ' entries, updated at ' + new Date().toLocaleTimeString())
    if (CURRENT_DID) {
      // validate still exists
      if (!DID_CACHE.some(x => x.did === CURRENT_DID)) {
        CURRENT_DID = null
        document.getElementById('detailTitle').textContent = 'Select a DID'
        document.getElementById('detailBody').innerHTML = ''
        document.getElementById('detailActions').style.display = 'none'
      }
    }
  } catch (e) {
    console.error(e)
    setStatus('Loading failed:' + e.message)
  }
}
function renderList() {
  const cont = document.getElementById('didList')
  const kw = document.getElementById('search').value.trim().toLowerCase()
  cont.innerHTML = ''
  DID_CACHE.filter(item => !kw || item.did.toLowerCase().includes(kw)).forEach(item => {
    const div = document.createElement('div')
    div.className = 'did-item' + (item.did === CURRENT_DID ? ' active':'')
    div.onclick = () => selectDid(item.did)
    div.innerHTML = '<div style="font-size:12px;word-break:break-all;">' + item.did + '</div>' +
      '<div style="font-size:11px;opacity:.8;">' +
      '<span class="badge">VC:' + item.verifiableCredentialCount + '</span>' +
      '<span class="badge">idTok:' + item.idTokensHistory + '</span>' +
      '<span class="badge">zkSess:' + item.zkLoginSessions + '</span>' +
      (item.hasLatestZkLoginSession ? '<span class="badge">latestSess</span>' : '') +
      (item.latestIdToken ? '<span class="badge">latestIdToken</span>' : '') +
      '</div>'
    cont.appendChild(div)
  })
}
function filterList() { renderList() }
async function selectDid(did) {
  CURRENT_DID = did
  renderList()
  setStatus('Loading details...')
  try {
    const r = await fetch('/api/dids/' + encodeURIComponent(did))
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    renderDetail(j.data)
    setStatus('Loaded: ' + did)
  } catch (e) {
    setStatus('Loading failed:' + e.message)
  }
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
}
function renderDetail(data) {
  document.getElementById('detailTitle').textContent = data.did || CURRENT_DID
  document.getElementById('detailActions').style.display = 'flex'
  const vcArr = Array.isArray(data.verifiableCredentials) ? data.verifiableCredentials : []
  const sessions = Array.isArray(data.zkLoginSessions) ? data.zkLoginSessions : []
  let html = ''
  html += '<h3>Basic Structure</h3><pre>' + escapeHtml(JSON.stringify({ ...data, verifiableCredentials: undefined, zkLoginSessions: undefined }, null, 2)) + '</pre>'
  html += '<h3>Verifiable Credentials (' + vcArr.length + ')</h3>'
  if (!vcArr.length) html += '<p><i>No VC</i></p>'
  else {
    html += '<table><thead><tr><th>#</th><th>issuer</th><th>subject</th><th>issuanceDate</th><th>type</th><th>Actions</th></tr></thead><tbody>'
    vcArr.forEach((vc, i) => {
      html += '<tr>' +
        '<td>'+i+'</td>' +
        '<td>'+escapeHtml(vc.issuer?.id || '')+'</td>' +
        '<td>'+escapeHtml(vc.credentialSubject?.id || '')+'</td>' +
        '<td>'+escapeHtml(vc.issuanceDate || '')+'</td>' +
        '<td>'+escapeHtml((vc.type || []).join(','))+'</td>' +
        '<td><button onclick="viewVC('+i+')">View</button> <button class="danger" onclick="deleteVC('+i+')">Delete</button></td>' +
        '</tr>'
    })
    html += '</tbody></table>'
  }
  html += '<h3>Latest id_token</h3>'
  html += data.latestIdToken ? '<pre>'+escapeHtml(data.latestIdToken)+'</pre>' : '<p><i>None</i></p>'
  html += '<h3>idTokensHistory ('+(data.idTokensHistory?data.idTokensHistory.length:0)+')</h3>'
  if (Array.isArray(data.idTokensHistory) && data.idTokensHistory.length) {
    html += '<pre>'+escapeHtml(JSON.stringify(data.idTokensHistory, null, 2))+'</pre>'
  } else html += '<p><i>None</i></p>'
  html += '<h3>zkLoginSessions ('+sessions.length+')</h3>'
  if (sessions.length) {
    html += '<pre>'+escapeHtml(JSON.stringify(sessions, null, 2))+'</pre>'
  } else html += '<p><i>None</i></p>'
  document.getElementById('detailBody').innerHTML = html
}
function setStatus(s) {
  document.getElementById('status').textContent = s
}
async function deleteCurrent() {
  if (!CURRENT_DID) return
  if (!confirm('Are you sure you want to delete DID? '+CURRENT_DID)) return
  setStatus('Deleting...')
  const r = await fetch('/api/dids/' + encodeURIComponent(CURRENT_DID), { method:'DELETE' })
  if (r.ok) {
    CURRENT_DID = null
    refreshList()
    document.getElementById('detailBody').innerHTML = ''
    document.getElementById('detailTitle').textContent = 'Select a DID'
    document.getElementById('detailActions').style.display = 'none'
    setStatus('Deleted')
  } else setStatus('Delete failed')
}
async function deleteVC(idx) {
  if (!CURRENT_DID) return
  if (!confirm('Delete VC #' + idx + '?')) return
  setStatus('Deleting VC...')
  const r = await fetch('/api/dids/' + encodeURIComponent(CURRENT_DID) + '/credentials/' + idx, { method:'DELETE' })
  if (r.ok) {
    await selectDid(CURRENT_DID)
    refreshList()
    setStatus('VC deleted')
  } else setStatus('Delete failed')
}
function viewVC(idx) {
  if (!CURRENT_DID) return
  const data = document.querySelector('#detailBody')
  const preList = data.querySelectorAll('table tbody tr')
  if (!preList[idx]) return
  // re-fetch to get full object
  fetch('/api/dids/' + encodeURIComponent(CURRENT_DID))
    .then(r => r.json())
    .then(j => {
      const vc = (j.data.verifiableCredentials || [])[idx]
      if (!vc) return alert('Not found')
      const win = window.open('', '_blank', 'width=640,height=600')
      win.document.write('<pre style="white-space:pre-wrap;font-family:monospace;">'+
        escapeHtml(JSON.stringify(vc, null, 2))+'</pre>')
    })
}
async function uploadVC(e) {
  if (!CURRENT_DID) return alert('Select a DID first')
  const file = e.target.files && e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    setStatus('Uploading VC...')
    const r = await fetch('/api/dids/' + encodeURIComponent(CURRENT_DID) + '/credentials', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ vc: parsed })
    })
    if (!r.ok) throw new Error('HTTP '+r.status)
    await selectDid(CURRENT_DID)
    refreshList()
    setStatus('VC added')
  } catch (err) {
    alert('Upload failed: ' + err.message)
  } finally {
    e.target.value = ''
  }
}
async function trimSessions() {
  if (!CURRENT_DID) return
  if (!confirm('Keep only the latest 1 zkLogin session?')) return
  setStatus('Trimming sessions...')
  const r = await fetch('/api/dids/' + encodeURIComponent(CURRENT_DID) + '/trim-sessions?keep=1', { method:'POST' })
  if (r.ok) {
    await selectDid(CURRENT_DID)
    setStatus('Trimmed')
  } else setStatus('Trim failed')
}
async function exportRaw() {
  window.open('/api/export/raw', '_blank')
}
refreshList()
</script>
</body>
</html>`

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    try {
      await handleApi(req, res)
    } catch (e) {
      console.error('API error', e)
      send(res, 500, { error: 'internal', detail: e.message })
    }
    return
  }
  // Root UI
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(HTML)
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`🚀 DID management dashboard started: http://localhost:${PORT}`)
  console.log(`📄 Data file: ${DATA_PATH}`)
})