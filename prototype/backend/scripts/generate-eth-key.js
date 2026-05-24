// generate-eth-key.js
import { Wallet } from 'ethers'

// Randomly generate a new wallet
const wallet = Wallet.createRandom()

console.log('✅ New Ethereum wallet generated:')
console.log('Private Key:', wallet.privateKey)
console.log('Address:', wallet.address)
console.log('Mnemonic (optional):', wallet.mnemonic?.phrase || '(none)')