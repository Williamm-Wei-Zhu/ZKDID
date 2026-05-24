// Check smart contract and transactions
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const PACKAGE_ID = '0x7bedaa0d575e7a15173efb2196663165fff354d670ca7bff0a49c74633f0dcde';
const USER_ADDR = '0x2f2a11fd02b6989fec0223a7f80b068bb4942ef9484fb503a4e9bf86681457e8';

async function main() {
  const client = new SuiClient({ url: 'https://fullnode.devnet.sui.io' });
  
  console.log('=== Diagnosing Sui Transaction Issues ===\n');
  
  // 1. Check if Package exists
  console.log('1. Checking if Package exists...');
  try {
    const pkg = await client.getObject({ 
      id: PACKAGE_ID, 
      options: { showContent: true, showType: true, showOwner: true } 
    });
    if (pkg.data) {
      console.log('   ✅ Package exists');
      console.log('   Type:', pkg.data.type);
    } else if (pkg.error) {
      console.log('   ❌ Package does not exist:', pkg.error.code);
      console.log('   💡 DevNet may have been reset, need to redeploy the contract!');
      return;
    }
  } catch (e) {
    console.log('   ❌ Query failed:', e.message);
  }

  // 2. Check user balance
  console.log('\n2. Checking user balance...');
  try {
    const balance = await client.getBalance({ owner: USER_ADDR });
    const sui = Number(balance.totalBalance) / 1e9;
    console.log('   Balance:', sui.toFixed(4), 'SUI');
    if (sui < 0.01) {
      console.log('   ⚠️ Insufficient balance');
    } else {
      console.log('   ✅ Sufficient balance');
    }
  } catch (e) {
    console.log('   ❌ Query failed:', e.message);
  }

  // 3. Attempt dry run transaction
  console.log('\n3. Attempting Dry Run transaction...');
  try {
    const tx = new Transaction();
    tx.setSender(USER_ADDR);
    tx.setGasBudget(10000000);
    
    const enc = new TextEncoder();
    const testDid = enc.encode('did:test:abc');
    const testVc = enc.encode('{"test":"vc"}');
    
    tx.moveCall({
      target: `${PACKAGE_ID}::store_did_vc::create_did_vc`,
      arguments: [
        tx.pure.vector('u8', Array.from(testDid)),  // did
        tx.pure.vector('u8', Array.from(testVc)),   // vc
      ],
    });
    
    const dryRun = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });
    
    console.log('   Dry Run status:', dryRun.effects?.status?.status);
    if (dryRun.effects?.status?.status === 'success') {
      console.log('   ✅ Transaction structure is correct');
      console.log('   Gas used:', dryRun.effects?.gasUsed);
    } else {
      console.log('   ❌ Transaction failed:', dryRun.effects?.status?.error);
    }
  } catch (e) {
    console.log('   ❌ Dry Run failed:', e.message);
    if (e.message.includes('not found') || e.message.includes('ObjectNotFound')) {
      console.log('\n   💡 Smart contract may not exist! DevNet resets periodically, need to redeploy the contract.');
    }
  }
  
  console.log('\n=== Diagnosis complete ===');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
