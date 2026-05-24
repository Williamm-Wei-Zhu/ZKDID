// Node 18+ / ESM
import { SuiClient } from '@mysten/sui.js/client';

// Usage: SUI_RPC_URL=<rpc> node epoch.js [--plus 0]
const args = process.argv.slice(2);
const ix = args.indexOf('--plus');
const plus = ix >= 0 ? Number(args[ix + 1] ?? 0) : 0;

const SUI_RPC_URL =
  process.env.SUI_RPC_URL ||
  'https://fullnode.testnet.sui.io'; // can also use mainnet/devnet

(async () => {
  try {
    const client = new SuiClient({ url: SUI_RPC_URL });
    const s = await client.getLatestSuiSystemState(); // SDK calls suix_getLatestSuiSystemState
    const epochAbs = BigInt(s.epoch);
    const recommended = epochAbs + BigInt(plus || 0);

    console.log('SUI_RPC_URL:', SUI_RPC_URL);
    console.log('current_epoch(abs):', epochAbs.toString());
    console.log('epoch_duration_ms:', s.epochDurationMs);
    console.log('epoch_start_timestamp_ms:', s.epochStartTimestampMs);
    if (plus) console.log(`\n>> With --plus ${plus}:`);
    console.log('MAX_EPOCH (recommended):', recommended.toString());
    console.log(`\nexport MAX_EPOCH=${recommended.toString()}`);
  } catch (e) {
    console.error('Failed to fetch epoch:', e?.message || e);
    process.exit(1);
  }
})();