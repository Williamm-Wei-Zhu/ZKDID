import { SuiClient } from '@mysten/sui/client';

const PACKAGE_ID = '0xa9127ce9e2403a6df3bfe83061b1b9606e7eb309ac25d5eeba3e3706487f376b';

async function main() {
  console.log('Checking Package:', PACKAGE_ID);
  const client = new SuiClient({ url: 'https://fullnode.devnet.sui.io' });
  
  try {
    const pkg = await client.getObject({ 
      id: PACKAGE_ID, 
      options: { showType: true, showContent: true } 
    });
    
    if (pkg.data) {
      console.log('✅ Package exists');
      console.log('Type:', pkg.data.type);
    } else if (pkg.error) {
      console.log('❌ Package does not exist:', pkg.error.code);
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  process.exit(0);
}

main();
