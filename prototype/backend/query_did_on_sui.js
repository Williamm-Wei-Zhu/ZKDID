// query_did_on_sui.mjs
// Node 18+ / ESM

import { SuiClient } from '@mysten/sui.js/client';

// ====== Configuration ======
const SUI_RPC_URL =
  process.env.SUI_RPC_URL || 'https://fullnode.devnet.sui.io';

const objectId =
  '0x7bedaa0d575e7a15173efb2196663165fff354d670ca7bff0a49c74633f0dcde'; // Your DIDVC ObjectId

// ====== Main Logic ======
(async () => {
  try {
    const client = new SuiClient({ url: SUI_RPC_URL });

    const object = await client.getObject({
      id: objectId,
      options: {
        showContent: true,
      },
    });

    if (!object.data) {
      throw new Error('Object not found');
    }

    if (object.data.content?.dataType !== 'moveObject') {
      throw new Error('Not a Move object');
    }

    console.log('✅ DIDVC object content fields:');
    console.log(object.data.content.fields);

    // If vc is a JSON string, parse it as well
    if (object.data.content.fields?.vc) {
      console.log('\n📄 Parsed VC JSON:');
      console.log(JSON.parse(object.data.content.fields.vc));
    }
  } catch (e) {
    console.error('❌ Query failed:', e.message || e);
    process.exit(1);
  }
})();