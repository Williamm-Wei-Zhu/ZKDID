// Test Sui DevNet RPC connectivity
const urls = [
  'https://fullnode.devnet.sui.io',
  'https://sui-devnet-rpc.publicnode.com',
  'https://rpc-devnet.suiscan.xyz',
];

async function testRpc(url) {
  console.log(`\n🔍 Testing: ${url}`);
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_getLatestSuiSystemState',
        params: []
      })
    });
    const elapsed = Date.now() - start;
    console.log(`  Status code: ${resp.status} (${elapsed}ms)`);
    
    if (resp.ok) {
      const json = await resp.json();
      if (json.result?.epoch) {
        console.log(`  ✅ Current epoch: ${json.result.epoch}`);
        return { url, ok: true, epoch: json.result.epoch, ms: elapsed };
      } else if (json.error) {
        console.log(`  ❌ RPC error: ${json.error.message}`);
      }
    } else {
      console.log(`  ❌ HTTP error: ${resp.status}`);
    }
  } catch (e) {
    console.log(`  ❌ Connection failed: ${e.message}`);
  }
  return { url, ok: false };
}

async function main() {
  console.log('=== Sui DevNet RPC Connectivity Test ===');
  const results = [];
  for (const url of urls) {
    results.push(await testRpc(url));
  }
  
  const working = results.filter(r => r.ok);
  console.log('\n=== Results Summary ===');
  if (working.length > 0) {
    console.log(`✅ ${working.length} node(s) available:`);
    working.forEach(r => console.log(`   - ${r.url} (${r.ms}ms, epoch=${r.epoch})`));
  } else {
    console.log('❌ All nodes are unavailable! Sui DevNet may be under maintenance.');
  }
}

main().catch(console.error);
