// did-to-sui.js
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { fromB64 } from '@mysten/bcs';

// ====== Modify the following ======

// base64 private key (from sui.keystore, with prefix)
const base64PrivateKey = 'AV5C4U5UIz5/hykzmAgucI3uA5JNGo6dGGpKuMPCCN52';

// Package ID of your deployed module
const PACKAGE_ID = '0x7bedaa0d575e7a15173efb2196663165fff354d670ca7bff0a49c74633f0dcde';

// DID and VC content (example)
const did = 'did:ethr:sepolia:0x1234567890abcdef';
const vc = JSON.stringify({
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: did,
  credentialSubject: {
    id: 'did:example:abcd1234',
    name: 'Alice'
  },
  issuanceDate: '2025-08-15T00:00:00Z',
  proof: {
    type: 'Ed25519Signature2020',
    created: '2025-08-15T00:00:00Z',
    proofPurpose: 'assertionMethod',
    verificationMethod: did,
    jws: 'eyJhbGciOiJFZERTQSJ9...'
  }
});

// ====== Program body below, no modification needed ======

// Decode private key (skip first byte prefix)
const fullKey = fromB64(base64PrivateKey);
const secretKey = fullKey.slice(1);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const address = keypair.getPublicKey().toSuiAddress();

// Create Sui client
const client = new SuiClient({ url: 'https://fullnode.devnet.sui.io' });

console.log(`🔑 Using address: ${address}`);

// Query balance
const balances = await client.getAllBalances({ owner: address });
const suiBalance = balances.find((b) => b.coinType === '0x2::sui::SUI');

if (!suiBalance || parseInt(suiBalance.totalBalance) < 1_000_000) {
  console.error('❌ Insufficient SUI balance, please claim from faucet first: https://faucet.testnet.sui.io');
  process.exit(1);
}

// Query gas coin
const coins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
if (!coins.data || coins.data.length === 0) {
  console.error('❌ No available SUI Coin object, please confirm your address has available SUI.');
  process.exit(1);
}
const gasCoinId = coins.data[0].coinObjectId;
console.log(`✅ Using gas coin: ${gasCoinId}`);

// Build transaction
const tx = new TransactionBlock();
tx.moveCall({
  target: `${PACKAGE_ID}::store_did_vc::create_did_vc`,
  arguments: [
    tx.pure(did),
    tx.pure(vc)
  ]
});
const gasObject = coins.data[0]; // contains objectId, digest, version
tx.setGasPayment([
  {
    objectId: gasObject.coinObjectId,
    digest: gasObject.digest,
    version: gasObject.version
  }
]);
// Sign and send transaction
const result = await client.signAndExecuteTransactionBlock({
  signer: keypair,
  transactionBlock: tx,
  options: {
    showEffects: true,
    showObjectChanges: true
  }
});

console.log('✅ Transaction sent!');
console.log('Transaction Digest:', result.digest);
