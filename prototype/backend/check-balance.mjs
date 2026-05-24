// Check zkLogin address balance
import { SuiClient } from '@mysten/sui/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read dids.json to get zkLogin addresses
const didsPath = path.resolve(__dirname, './dids.json');
const sessionPath = path.resolve(__dirname, './zklogin-sessions.json');

async function main() {
  const client = new SuiClient({ url: 'https://fullnode.devnet.sui.io' });
  
  // Try to get addresses from dids.json
  let addresses = [];
  
  if (fs.existsSync(didsPath)) {
    const dids = JSON.parse(fs.readFileSync(didsPath, 'utf-8'));
    for (const [did, data] of Object.entries(dids)) {
      if (did.startsWith('did:zklogin:')) {
        // Extract address from DID
        const parts = did.split(':');
        if (parts.length >= 4) {
          addresses.push({ did, address: parts[3] });
        }
      }
    }
  }
  
  // Get from session
  if (fs.existsSync(sessionPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    for (const [key, data] of Object.entries(sessions)) {
      if (data.userAddress) {
        addresses.push({ session: key, address: data.userAddress });
      }
    }
  }
  
  // Deduplicate
  const uniqueAddresses = [...new Set(addresses.map(a => a.address))];
  
  console.log('=== Checking zkLogin Address Balance ===\n');
  
  for (const addr of uniqueAddresses) {
    console.log(`📍 Address: ${addr}`);
    try {
      const balance = await client.getBalance({ owner: addr });
      const suiBalance = Number(balance.totalBalance) / 1e9;
      console.log(`   💰 Balance: ${suiBalance.toFixed(4)} SUI`);
      
      if (suiBalance < 0.01) {
        console.log(`   ⚠️  Insufficient balance! Need at least 0.01 SUI to pay for gas`);
        console.log(`   💡 Please visit https://faucet.devnet.sui.io/ to claim test tokens`);
        console.log(`   💡 Or run: curl -X POST https://faucet.devnet.sui.io/v2/gas -H "Content-Type: application/json" -d '{"FixedAmountRequest":{"recipient":"${addr}"}}'`);
      }
    } catch (e) {
      console.log(`   ❌ Query failed: ${e.message}`);
    }
    console.log('');
  }
  
  if (uniqueAddresses.length === 0) {
    console.log('❌ No zkLogin addresses found');
  }
}

main().catch(console.error);
