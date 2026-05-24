import { SuiClient } from '@mysten/sui.js/client';
import fs from 'fs';

const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.devnet.sui.io';
const DIGEST = process.env.SUI_TX_DIGEST; // Copy from your main script's output

if (!DIGEST) {
  console.error('Missing SUI_TX_DIGEST environment variable');
  process.exit(1);
}

const client = new SuiClient({ url: SUI_RPC_URL });
const tx = await client.getTransactionBlock({
  digest: DIGEST,
  options: { showEffects: true, showInput: true, showEvents: true },
});
const status = tx.effects?.status?.status;
console.log('status:', status);
console.log('sender:', tx.transaction?.data?.sender || tx.effects?.sender);
fs.writeFileSync('./.zklogin-ok', JSON.stringify({ digest: DIGEST, status }, null, 2));
console.log('ok file written.');
