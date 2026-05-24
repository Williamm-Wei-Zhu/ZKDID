You are helping me implement an experimental baseline for an academic paper targeting IEEE Transactions on Services Computing.

The baseline is called: Private-key DID/VC on Sui Devnet.

Context:
I am evaluating zkEHR, a keyless and unlinkable decentralized identity architecture for EHR sharing. I need a Private-key DID/VC baseline to measure the latency of a conventional decentralized identity model where the patient controls a DID using a long-term private key.

This baseline MUST use Sui Devnet.
This baseline MUST deploy and use a Sui Move smart contract for on-chain DID registration.
This baseline MUST register a DID object on-chain for every first-time DID establishment run.

This baseline must not use:
- OIDC
- Google login
- JWT
- zkLogin
- zkDIDProof
- zero-knowledge proof generation
- multi-authority salt
- keyless recovery
- zkEHR-specific DID derivation
- zkEHR-specific AccessGrant logic

The purpose is to isolate the cost of conventional private-key-based decentralized identity with on-chain DID registration.

Main goal:
Implement a complete, runnable Node.js / TypeScript experimental project that measures:

1. First-time DID establishment latency with mandatory Sui Devnet on-chain DID object registration.
2. DID challenge authentication latency using the registered DID object.
3. Optional VC issuance and verification latency.

System roles:
The baseline should model three parties:

1. Patient Wallet / User App
   - Generates a long-term Ed25519 key pair.
   - Derives a DID from the public key.
   - Constructs a DID document.
   - Registers the DID object on Sui Devnet through a Move contract.
   - Signs authentication challenges.
   - Stores the private key locally for the experiment.

2. DID Registry / Sui Devnet Move Contract
   - A Sui Move module deployed to Sui Devnet.
   - Stores a minimal DID object on-chain.
   - Every DID establishment run must call this Move contract to create a DID object.

3. EHR Service / Relying Party
   - Generates a random challenge.
   - Resolves the DID object from Sui Devnet.
   - Extracts the public key from the on-chain DID object.
   - Verifies the patient's digital signature.
   - Maps the DID to a local mock patient ID.
   - Creates a local authenticated EHR session.

Important fairness requirement:
The first-time DID establishment experiment MUST include Sui Devnet transaction submission and finality.
Do not provide a local-only DID establishment result as the main result.
Do not make on-chain registration optional.
The baseline must represent blockchain-backed private-key DID establishment.

Technology stack:
- Node.js 20+
- TypeScript
- Sui TypeScript SDK
- Sui CLI for Move deployment
- Ed25519 key pair support from Sui SDK or @noble/ed25519
- dotenv
- csv output
- optional Express/Fastify mock EHR service
- robust error handling

Project structure:
Please create a clean project like this:

private-key-did-vc-sui-devnet/
  package.json
  tsconfig.json
  .env.example
  README.md
  move/
    did_registry/
      Move.toml
      sources/
        did_registry.move
  scripts/
    deploy_devnet.sh
  src/
    config.ts
    types.ts
    timer.ts
    stats.ts
    csv.ts
    keypair.ts
    did.ts
    didDocument.ts
    suiClient.ts
    didRegistry.ts
    ehrService.ts
    challengeAuth.ts
    vc.ts
    storage.ts
    experimentDidEstablishment.ts
    experimentChallengeAuth.ts
    experimentVc.ts
    index.ts
  results/
    .gitkeep
  data/
    .gitkeep

Configuration:
Create a .env.example file with:

SUI_NETWORK=devnet
SUI_RPC_URL=https://fullnode.devnet.sui.io:443
SUI_PRIVATE_KEY=your_sui_private_key_for_paying_gas
SUI_PACKAGE_ID=your_deployed_did_registry_package_id
RUNS=100
WARMUP_RUNS=10
OUTPUT_DIR=results
DID_METHOD=did:sui
STORE_KEYS_IN=data/wallets.json
STORE_DIDS_IN=data/dids.json
ENABLE_VC_EXPERIMENT=false

Important:
There must be no ENABLE_ONCHAIN_DID_REGISTRATION flag.
On-chain registration is mandatory.

Move smart contract requirement:
Create a minimal Sui Move module for DID registration.

The Move module must define:

public struct DIDObject has key, store {
    id: UID,
    did: vector<u8>,
    public_key: vector<u8>,
    controller: address,
    metadata: vector<u8>,
    created_at: u64,
    active: bool,
}

The module must expose at least the following public entry functions:

1. create_did_object(
      did: vector<u8>,
      public_key: vector<u8>,
      metadata: vector<u8>,
      clock: &Clock,
      ctx: &mut TxContext
   )

This function must:
- create a new DIDObject
- set controller to tx_context::sender(ctx)
- set created_at using clock::timestamp_ms(clock)
- set active=true
- transfer the DIDObject to the transaction sender

2. update_did_metadata(
      did_object: &mut DIDObject,
      metadata: vector<u8>,
      ctx: &mut TxContext
   )

This function must:
- require tx_context::sender(ctx) == did_object.controller
- update metadata

3. deactivate_did(
      did_object: &mut DIDObject,
      ctx: &mut TxContext
   )

This function must:
- require tx_context::sender(ctx) == did_object.controller
- set active=false

The Move code should import:
- sui::object::{Self, UID}
- sui::tx_context::{Self, TxContext}
- sui::transfer
- sui::clock::{Self, Clock}

If some imports differ in current Sui Move, adjust accordingly and make the module compile on Sui Devnet.

Deployment requirement:
Provide scripts/deploy_devnet.sh that:
1. Switches Sui CLI to devnet or explains how to do so.
2. Builds the Move package.
3. Publishes the Move package to Sui Devnet.
4. Prints the published package ID.
5. Explains that the package ID must be copied into .env as SUI_PACKAGE_ID.

README.md must include exact commands:
- sui client switch --env devnet
- sui client active-env
- sui client faucet
- sui move build --path move/did_registry
- sui client publish move/did_registry --gas-budget 100000000

Experiment mode 1:
First-time DID establishment with mandatory Sui Devnet registration.

Workflow:
For each measured run:

1. Start timer.
2. Generate a long-term Ed25519 key pair for the patient.
3. Derive a DID from the public key.
   Example:
   did:sui:<hex_or_base64url_hash_of_public_key>
4. Construct a DID document containing:
   - id
   - controller
   - verificationMethod
   - authentication
   - publicKeyMultibase or publicKeyHex
   - optional service endpoint
5. Build a Sui Devnet transaction that calls:
   <SUI_PACKAGE_ID>::did_registry::create_did_object(
      did,
      public_key,
      metadata,
      clock
   )
6. Submit the transaction to Sui Devnet.
7. Wait for transaction finality.
8. Extract and record the created DIDObject ID from the transaction effects/object changes.
9. Store local experimental metadata:
   - DID
   - public key
   - private key reference or encoded private key
   - DID document
   - Sui DIDObject ID
   - transaction digest
10. Stop timer.
11. Record latency.

Metrics to record:
- run_id
- mode=did-establishment-devnet
- start_time_iso
- keygen_ms
- did_derivation_ms
- did_document_create_ms
- tx_build_ms
- tx_submit_ms
- tx_finality_ms
- object_extract_ms
- local_store_ms
- total_ms
- sui_tx_digest
- sui_object_id
- success
- error_message

Functional endpoint:
The run succeeds only when the DID object has been created on Sui Devnet and the DIDObject ID has been extracted and stored.

Experiment mode 2:
DID challenge authentication / session creation using Sui Devnet DID resolution.

Workflow:
For each measured run:

1. Load an existing DID, private key, and Sui DIDObject ID generated by the establishment experiment.
2. EHR Service generates a fresh random challenge.
3. Patient Wallet signs the challenge with the DID private key.
4. Patient sends DID, challenge, signature, and DIDObject ID to EHR Service.
5. EHR Service resolves the DID object from Sui Devnet using DIDObject ID.
6. EHR Service extracts:
   - DID
   - public key
   - controller
   - active status
7. EHR Service checks:
   - active == true
   - on-chain DID equals presented DID
8. EHR Service verifies the signature against the on-chain public key.
9. EHR Service maps the DID to a mock patient ID.
10. EHR Service creates a mock authenticated EHR session.
11. Stop timer.
12. Record latency.

Metrics to record:
- run_id
- mode=challenge-auth-devnet
- start_time_iso
- challenge_create_ms
- sign_challenge_ms
- did_resolve_devnet_ms
- did_object_parse_ms
- signature_verify_ms
- patient_mapping_ms
- session_create_ms
- total_ms
- sui_object_id
- success
- error_message

Functional endpoint:
The run succeeds when the EHR Service resolves the DID object from Sui Devnet, verifies that it is active, verifies the patient's signature, and creates a local authenticated EHR session.

Experiment mode 3:
Optional VC issuance and verification.

This mode should be implemented but disabled by default.

Workflow:
1. Create an issuer key pair representing a hospital authority.
2. Create a simple VC payload:
   - issuer
   - subject DID
   - patient role or eligibility claim
   - issuance time
   - expiration time
3. Sign the VC with issuer private key.
4. Store the VC in the patient wallet.
5. EHR Service verifies:
   - issuer signature
   - subject DID
   - expiration
6. Record latency.

Metrics:
- run_id
- mode=vc
- start_time_iso
- vc_create_ms
- vc_sign_ms
- vc_verify_ms
- total_ms
- success
- error_message

Note:
The VC experiment should not be included in the main identity-establishment latency unless explicitly enabled. It is more suitable for access authorization experiments.

Statistics:
After each experiment, print statistics for total_ms:
- count
- success_count
- failure_count
- mean
- p50
- p95
- p99
- standard deviation

Also compute statistics for important sub-metrics:
For DID establishment:
- keygen_ms
- did_derivation_ms
- did_document_create_ms
- tx_submit_ms
- tx_finality_ms

For challenge authentication:
- sign_challenge_ms
- did_resolve_devnet_ms
- signature_verify_ms
- session_create_ms

Command-line interface:
Implement commands:

npm run build
npm run deploy:devnet
npm run experiment:establish
npm run experiment:auth
npm run experiment:vc
npm run experiment:all

Implementation details:
1. Use performance.now() or process.hrtime.bigint() for precise timing.
2. Use warm-up runs before measured runs.
3. Failed runs should be recorded in CSV and should not crash the whole experiment.
4. Use clear TypeScript types for all records.
5. Use deterministic CSV column order.
6. Save results to:
   results/private_key_did_establishment_devnet.csv
   results/private_key_did_auth_devnet.csv
   results/private_key_did_vc.csv
7. Do not hard-code secrets.
8. Do not print private keys to the console.
9. Store experimental keys only in the data directory and clearly mark this as unsafe for production.
10. Include comments explaining that this is an academic baseline implementation, not production wallet code.
11. The code must check that SUI_NETWORK is devnet. If it is not devnet, exit with a clear error.
12. The code must check that SUI_RPC_URL points to devnet. If not, warn or exit.
13. The establishment experiment must fail fast if SUI_PACKAGE_ID is missing.

Sui transaction requirements:
Use the Sui TypeScript SDK to:
- create a Transaction
- call the Move function create_did_object
- pass the Sui Clock object 0x6 as a shared object if required by the SDK
- sign and execute the transaction with the gas payer key
- request objectChanges and effects in the response
- extract created DIDObject ID from objectChanges

If the current SDK API differs, adapt to the current SDK but document the version used.

README.md should explain:
1. What the Private-key DID/VC on Sui Devnet baseline measures.
2. Why it is used as a conventional DID/VC baseline.
3. Why on-chain Sui Devnet registration is mandatory in this experiment.
4. How it differs from zkEHR.
5. How to install Sui CLI.
6. How to switch to Sui Devnet.
7. How to request Devnet SUI from faucet.
8. How to deploy the Move DID registry module.
9. How to configure SUI_PACKAGE_ID.
10. How to run DID establishment experiments.
11. How to run DID challenge authentication experiments.
12. How to optionally run VC issuance/verification experiments.
13. How to interpret CSV results.
14. What is intentionally excluded:
    - OIDC
    - Google login
    - JWT
    - zkLogin
    - zkDIDProof
    - ZK proof generation
    - multi-authority salt
    - keyless recovery
    - zkEHR-specific access control
15. That experimental private keys are stored locally only for repeatability and must never be used in production.

Please include this academic paragraph in README.md:

"The Private-key DID/VC baseline represents a conventional decentralized identity model in which a patient controls a DID through a long-term private key. For a fair comparison with zkEHR's blockchain-backed identity model, this baseline registers each DID as an on-chain object on Sui Devnet through a Move smart contract. The baseline measures the cost of first-time DID establishment, including key generation, DID document construction, Sui transaction submission, and transaction finality, as well as the cost of subsequent DID-based authentication through challenge signing, on-chain DID resolution, signature verification, and local EHR session creation. Unlike zkEHR, this baseline does not provide keyless identity recovery, OIDC-derived identity binding, multi-authority salt derivation, or zero-knowledge identity hiding."

Output:
Please generate all source files.
Make the project runnable.
Include robust error handling.
Do not include any zkEHR-specific code.
Use Sui Devnet only.
On-chain DID registration through the Move contract is mandatory.