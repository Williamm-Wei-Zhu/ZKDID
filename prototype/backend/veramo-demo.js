// veramo-demo.js
import { createAgent } from '@veramo/core'
import { DIDManager } from '@veramo/did-manager'
import { KeyManager } from '@veramo/key-manager'
import { KeyManagementSystem } from '@veramo/kms-local'
import { DIDResolverPlugin } from '@veramo/did-resolver'
import { Resolver } from 'did-resolver'
import { CredentialPlugin } from '@veramo/credential-w3c'
import { EthrDIDProvider } from '@veramo/did-provider-ethr'
import { getResolver as getEthrResolver } from 'ethr-did-resolver'
import { DIDStore } from '@veramo/data-store'
import fs from 'fs'
import { ethers } from 'ethers'

const INFURA_API_KEY = '82979dff41164aa19c58bcd232c8829c'
const ETH_PRIVATE_KEY = 'b17307472d81f76d656c3ffc211acb7b889073f4e2f1688425d7e8faa7c75657'
const SEPOLIA_RPC_URL = `https://sepolia.infura.io/v3/${INFURA_API_KEY}`
const REGISTRY_ADDRESS = '0x03d5003bf0e79C5F5223588F347ebA39AfbC3818'

// ✅ JSON file storage implementation
class JsonStore {
  constructor(path) {
    this.path = path
    if (!fs.existsSync(path)) {
      fs.writeFileSync(path, JSON.stringify({}))
    }
  }

  async get(key) {
    const data = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    return data[key]
  }

  async set(key, value) {
    const data = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    data[key] = value
    fs.writeFileSync(this.path, JSON.stringify(data, null, 2))
    return value
  }

  async delete(key) {
    const data = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    delete data[key]
    fs.writeFileSync(this.path, JSON.stringify(data, null, 2))
    return true
  }

  async query() {
    return Object.values(JSON.parse(fs.readFileSync(this.path, 'utf-8')))
  }

  async importKey(args) {
  const key = {
    kid: args.kid,
    alias: args.alias || args.kid,
    kms: 'local',
    type: 'Secp256k1',
    privateKeyHex: args.privateKeyHex,
    publicKeyHex: args.publicKeyHex,
    meta: {
      algorithms: ['ES256K', 'ES256K-R', 'eth_signTransaction', 'eth_signTypedData', 'eth_signMessage'],
      keyType: 'Secp256k1',
      kms: 'local'
    }
  }

    if (this.path.includes('privateKeys.json')) {
  await this.set(key.kid, { kid: key.kid, alias: key.alias, privateKeyHex: key.privateKeyHex })
} else {
  await this.set(key.kid, key)
}

    console.log('✅ Key import successful:', key.kid)
    return key
  }

  async listKeys() {
    const data = JSON.parse(fs.readFileSync(this.path, 'utf-8'))
    return Object.values(data)
  }

  async getKey(kidOrAlias) {
  let key = null;
  let data = JSON.parse(fs.readFileSync(this.path, 'utf-8'));

  if (typeof kidOrAlias === 'object') {
    // First look up by kid, then by alias
    if (kidOrAlias.kid && data[kidOrAlias.kid]) {
      key = data[kidOrAlias.kid];
    } else if (kidOrAlias.alias) {
      key = Object.values(data).find(k => k.alias === kidOrAlias.alias);
    }
  } else {
    // Look up directly by string
    key = data[kidOrAlias];
    if (!key) {
      key = Object.values(data).find(k => k.alias === kidOrAlias);
    }
  }

  if (!key) {
    return null;
  }

  // Supplement structure (unchanged)
  return {
    ...key,
    kms: 'local',
    type: 'Secp256k1',
    meta: {
      algorithms: [
        'ES256K',
        'ES256K-R',
        'eth_signTransaction',
        'eth_signTypedData',
        'eth_signMessage'
      ],
      keyType: 'Secp256k1',
      kms: 'local'
    }
  }
}

  getRepository() {
  return {
    find: async () => this.query(),

    // ✅ Support looking up key by kid or alias
    findOne: async (criteria) => {
      if (typeof criteria === 'object') {
        if (criteria.kid) {
          return this.getKey(criteria.kid)
        } else if (criteria.alias) {
          return this.getKey(criteria.alias)
        }
      }
      return null
    },

    save: async (entity) => {
      const key = await this.importKey(entity)
      return this.getKey(key.kid)
    },

    delete: async ({ kid }) => this.delete(kid)
  }
}
}

const keyStore = new JsonStore('./keys.json')
const privateKeyStore = new JsonStore('./privateKeys.json')
const didStore = new JsonStore('./dids.json')
const credentialStore = new JsonStore('./credentials.json')

// ✅ Custom DID Store
class JsonDIDStore extends DIDStore {
  constructor(store) {
    super()
    this.store = store
  }

  async importDID({ did, provider, alias, keys, services, controllerKeyId }) {
    const identifier = {
      did,
      provider,
      alias,
      controllerKeyId,
      keys: keys || [],
      services: services || []
    }
    await this.store.set(did, identifier)
    return identifier
  }

  async getDID({ did }) {
    return this.store.get(did)
  }

  async deleteDID({ did }) {
    return this.store.delete(did)
  }

  async listDIDs() {
    return this.store.query()
  }
}

// ✅ Initialize Veramo Agent
const agent = createAgent({
  plugins: [
    new KeyManager({
      store: keyStore,
      kms: {
        local: new KeyManagementSystem(privateKeyStore)
      }
    }),
    new DIDManager({
      store: new JsonDIDStore(didStore),
      defaultProvider: 'did:ethr',
      providers: {
        'did:ethr': new EthrDIDProvider({
          defaultKms: 'local',
          network: 'sepolia',
          rpcUrl: SEPOLIA_RPC_URL,
          registry: REGISTRY_ADDRESS,
        })
      }
    }),
    new CredentialPlugin(),
    new DIDResolverPlugin({
      resolver: new Resolver({
        ...getEthrResolver({
          networks: [{
            name: 'sepolia',
            chainId: 11155111,
            rpcUrl: SEPOLIA_RPC_URL,
            registry: REGISTRY_ADDRESS
          }]
        })
      })
    })
  ]
})

// ✅ Register on-chain (for ethr-did)
async function registerEthrDidOnChain(identity, wallet) {
  const abi = ['function changeOwner(address identity, address newOwner) external']
  const contract = new ethers.Contract(REGISTRY_ADDRESS, abi, wallet)
  console.log('📡 Registering DID on-chain...')
  const tx = await contract.changeOwner(identity, wallet.address, {
    gasLimit: 300000,
    gasPrice: ethers.parseUnits('20', 'gwei')
  })
  console.log('⏳ Waiting for transaction confirmation: ', tx.hash)
  await tx.wait()
  console.log('✅ Registration successful: ', tx.hash)
}

// ✅ Main flow
async function main() {
  const privateKeyWithPrefix = ETH_PRIVATE_KEY.startsWith('0x') ? ETH_PRIVATE_KEY : `0x${ETH_PRIVATE_KEY}`
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL)
  const wallet = new ethers.Wallet(privateKeyWithPrefix, provider)
  const address = wallet.address
  console.log(`💰 Wallet address: ${address}`)

  const pubKey = ethers.SigningKey.computePublicKey(privateKeyWithPrefix, false).slice(2)

  const keyData = {
    kid: 'main-key',
    kms: 'local',
    type: 'Secp256k1',
    privateKeyHex: ETH_PRIVATE_KEY.replace(/^0x/, ''),
    publicKeyHex: pubKey,
    meta: {
      algorithms: ['ES256K', 'ES256K-R', 'eth_signTransaction', 'eth_signTypedData', 'eth_signMessage'],
      keyType: 'Secp256k1',
      kms: 'local'
    }
  }

  const importedKey = await agent.keyManagerImport(keyData)
  console.log('🔑 Imported key:', importedKey)

  const key = await keyStore.getKey('main-key')
  console.log('🔍 Retrieved key:', key)

  const did = `did:ethr:sepolia:${address}`
  console.log('✅ Generated DID:', did)

  await registerEthrDidOnChain(address, wallet)

  await agent.didManagerImport({
  did,
  provider: 'did:ethr',
  alias: 'eth-did',
  controllerKeyId: 'main-key',
  keys: [keyData], // ✅ Use the originally fully defined keyData
})

  console.log('✅ DID imported into Veramo')

  await new Promise(resolve => setTimeout(resolve, 10000))

  const resolved = await agent.resolveDid({ didUrl: did })
  console.log('✅ DID resolved successfully:', JSON.stringify(resolved.didDocument, null, 2))

  const allKeys = await keyStore.listKeys()
  console.log('📋 All keys:', allKeys)

  console.log('=== keys.json ===')
console.log(await keyStore.listKeys())
console.log('=== privateKeys.json ===')
console.log(await privateKeyStore.listKeys())

console.log('=== keyStore.getKey("main-key") ===')
console.log(await keyStore.getKey('main-key'))
console.log('=== privateKeyStore.getKey("main-key") ===')
console.log(await privateKeyStore.getKey('main-key'))
console.log('=== keyStore.getKey({alias:"main-key"}) ===')
console.log(await keyStore.getKey({ alias: 'main-key' }))
console.log('=== privateKeyStore.getKey({alias:"main-key"}) ===')
console.log(await privateKeyStore.getKey({ alias: 'main-key' }))

  const vc = await agent.createVerifiableCredential({
    credential: {
      issuer: { id: did },
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: 'did:example:recipient',
        name: 'William Zhu'
      }
    },
    proofFormat: 'jwt',
    // save: true,
    keyRef: 'main-key'
  })

  console.log('🎉 VC created successfully:', vc)
}

main().catch(console.error)
