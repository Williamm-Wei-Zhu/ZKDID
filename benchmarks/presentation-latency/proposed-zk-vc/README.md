# ZK-based VC — End-to-End Off-Chain Identity/Credential Presentation Latency

> **Variant of the zkEHR comparative-presentation-latency series.** This
> measures the **ZK-VC presentation** data point — the patient generates a
> Groth16 proof over their VC claims and presents it alongside a DID
> challenge signature, achieving selective disclosure without revealing the
> raw VC.
>
> **Flow measured here (timed in a single per-run total):**
>   1. Patient obtains VC from issuer (issuer EdDSA-Poseidon-signs canonical claims)
>   2. Patient stores VC (in-memory)
>   3. Hospital issues challenge (random field element + 32-byte commitment)
>   4. Patient signs challenge with DID private key (Ed25519)
>   5. **Patient generates ZK proof over VC claims (Groth16 / bn128)**
>   6. Patient presents (ZK-VC proof + DID signature) envelope
>   7. Hospital resolves DID on Sui Devnet, verifies DID signature **and ZK-VC proof**
>   8. Hospital creates local patient session
>
> Headline command: `npm run experiment:presentation` (CSV →
> `results/zk_vc_presentation_latency.csv`).
>
> Forked from `private-key-did-vc-sui-devnet/` on 2026-05-02. Adds
> `src/experimentZkVcPresentationLatency.ts` (the ZK-VC pipeline) and
> integrates `snarkjs` + `circomlibjs`. Reuses the **already-compiled**
> Groth16 artifacts from the sibling `zkdid-circuit/` project — copy
> `build/zkdid.generated_js/zkdid.generated.wasm`, `build/zkdid_final.zkey`,
> and `build/verification_key.json` into `./build/` before running the
> experiment. Trusted setup is intentionally **not** in the per-presentation
> latency budget.

---

This project implements a **private-key, blockchain-backed DID/VC baseline**
for the zkEHR paper. It measures the latency of the conventional decentralized
identity model in which the patient holds a long-term Ed25519 private key,
registers a DID object on Sui Devnet through a Move smart contract, and
authenticates to an EHR service via DID resolution + signature verification.

## What this baseline measures

> **The Private-key DID/VC baseline represents a conventional decentralized
> identity model in which a patient controls a DID through a long-term private
> key. For a fair comparison with zkEHR's blockchain-backed identity model,
> this baseline registers each DID as an on-chain object on Sui Devnet
> through a Move smart contract. The baseline measures the cost of first-time
> DID establishment, including key generation, DID document construction, Sui
> transaction submission, and transaction finality, as well as the cost of
> subsequent DID-based authentication through challenge signing, on-chain DID
> resolution, signature verification, and local EHR session creation. Unlike
> zkEHR, this baseline does not provide keyless identity recovery,
> OIDC-derived identity binding, multi-authority salt derivation, or
> zero-knowledge identity hiding.**

### Three modes

| Mode | Command | What is measured |
|---|---|---|
| **1. DID establishment** | `experiment:establish` | keygen → DID derivation → DID document → tx build → tx submit → tx finality → object id extract → local persist |
| **2. Challenge auth** | `experiment:auth` | challenge nonce → patient signs → EHR resolves DIDObject from devnet → parses fields → verifies signature → maps DID → creates local session |
| **3. VC issuance + verify** (off by default) | `experiment:vc` | build VC → sign → verify (issuer signature, expiration, subject) |

### Three parties (matches the paper)

| Role | What it does | In this project |
|---|---|---|
| Patient Wallet / User App | Generates Ed25519 keypair, derives DID, signs challenges | [`src/keypair.ts`](src/keypair.ts), [`src/did.ts`](src/did.ts), [`src/challengeAuth.ts`](src/challengeAuth.ts) |
| **DID Registry on Sui Devnet** (Move smart contract) | Stores `DIDObject { did, public_key, controller, metadata, created_at, active }` | [`move/did_registry/sources/did_registry.move`](move/did_registry/sources/did_registry.move) |
| EHR Service / Relying Party | Issues challenge, resolves DID from devnet, verifies sig, creates session | [`src/ehrService.ts`](src/ehrService.ts), [`src/experimentChallengeAuth.ts`](src/experimentChallengeAuth.ts) |

## Why on-chain Sui Devnet registration is mandatory

To make the baseline a faithful comparison against zkEHR (which also goes
on-chain), every Mode 1 run **must** include transaction submission and
finality. There is no `ENABLE_ONCHAIN_DID_REGISTRATION` flag — the experiment
fails fast if the Move package is not deployed.

## Intentionally excluded from this baseline

- OIDC and Google login
- JWT
- zkLogin / zkDIDProof
- Zero-knowledge proof generation
- Multi-authority salt derivation
- Keyless identity recovery
- zkEHR-specific DID derivation
- zkEHR-specific AccessGrant / EHR access-control logic

## Setup

Requires Node.js 20+ and the Sui CLI.

### 1. Install Sui CLI

If `sui --version` works on your machine, skip this. Otherwise (Linux):

```bash
# Quickstart — see https://docs.sui.io/guides/developer/getting-started/sui-install
curl -fL https://sui-releases.s3.us-east-1.amazonaws.com/<version>.tar.gz | tar -xz
```

### 2. Switch the CLI to Devnet

```bash
sui client switch --env devnet
sui client active-env        # should print: devnet
sui client active-address    # your gas-payer address
```

### 3. Fund the address from the Devnet faucet

```bash
sui client faucet
sui client gas               # confirm at least ~0.1 SUI
```

### 4. Configure `.env`

```bash
cp .env.example .env
# Set SUI_PRIVATE_KEY to the bech32 export of your gas-paying key:
sui keytool list             # find your active key name
sui keytool export <name>    # bech32 starts with `suiprivkey1...`
# Paste the bech32 into .env as SUI_PRIVATE_KEY=
```

### 5. Install dependencies and build

```bash
npm install
npm run build
```

### 6. Deploy the Move DID registry

```bash
npm run deploy:devnet
# -> prints SUI_PACKAGE_ID=0x...
# Paste the line into .env:
echo 'SUI_PACKAGE_ID=0x...' >> .env
```

The deploy script also runs the equivalent of:

```bash
sui move build --path move/did_registry
sui client publish move/did_registry --gas-budget 100000000
```

## Running the experiments

```bash
npm run experiment:establish   # Mode 1 — must run first; populates data/dids.json
npm run experiment:auth        # Mode 2 — uses DIDs from Mode 1
npm run experiment:vc          # Mode 3 — only runs when ENABLE_VC_EXPERIMENT=true
npm run experiment:all         # Mode 1 + Mode 2 (and Mode 3 if enabled)
```

Each mode writes one CSV:

| Mode | Output |
|---|---|
| 1 | `results/private_key_did_establishment_devnet.csv` |
| 2 | `results/private_key_did_auth_devnet.csv` |
| 3 | `results/private_key_did_vc.csv` |

## Interpreting the CSVs

All rows record per-step latencies in milliseconds. **Failed runs are recorded
with `success=false` and a populated `error_message`** so they can be
analyzed alongside successful runs without crashing the experiment.

### Mode 1 columns

| Column | Meaning |
|---|---|
| `keygen_ms` | Ed25519 key-pair generation |
| `did_derivation_ms` | SHA-256 + base64url derivation of the DID string |
| `did_document_create_ms` | Build + serialize the W3C DID document |
| `tx_build_ms` | Construct the Move call transaction (no I/O) |
| `tx_submit_ms` | `signAndExecuteTransaction` round-trip to the RPC |
| `tx_finality_ms` | `waitForTransaction` until effects are observable |
| `object_extract_ms` | Find the created DIDObject in `objectChanges` |
| `local_store_ms` | Persist wallet + DID metadata to `data/` |
| `total_ms` | End-to-end |
| `sui_tx_digest` / `sui_object_id` | Provenance |

### Mode 2 columns

| Column | Meaning |
|---|---|
| `challenge_create_ms` | Generate a 32-byte server nonce |
| `sign_challenge_ms` | Patient signs the nonce with Ed25519 |
| `did_resolve_devnet_ms` | RPC `getObject` + parse content |
| `did_object_parse_ms` | Active-status + DID-string consistency check |
| `signature_verify_ms` | Ed25519 verify against on-chain public key |
| `patient_mapping_ms` | DID → patient_id index lookup |
| `session_create_ms` | Local EHR session object creation |

## Console summary

After each mode the program prints `count / success / failure / mean / p50 /
p95 / p99 / std / min / max` for `total_ms` plus the most informative
sub-metrics.

## Methodological notes for the paper

- Timing primitive: `process.hrtime.bigint()` (nanosecond resolution).
- Warm-up: `WARMUP_RUNS` runs are executed before measurement; only
  warm-ups SUCCEED into the JSON store but the CSV/statistics drop them.
- Failed runs counted in `count` and `failure_count`, excluded from latency
  percentiles.
- Mode 1 includes mandatory devnet transaction finality. The reported
  `total_ms` therefore reflects user-perceived latency for first-time DID
  establishment, including blockchain inclusion.
- Mode 2 includes a real `getObject` RPC round-trip per run, so the latency
  reflects the cost a hospital EHR backend would actually pay each time a
  patient authenticates.
- Sui SDK version: `@mysten/sui ^1.45.2` — same major version used in the
  zkEHR experiments folder, ensuring SDK-side timings are comparable.

## Safety / academic caveats

- Experimental private keys are stored unencrypted in `data/wallets.json` so
  the auth experiment can replay an established DID. **NEVER ship this to
  production.**
- The faucet-funded gas-payer key is the same key that signs every
  `create_did_object` transaction in this baseline. Real systems would use
  per-patient keys + a separate gas sponsor; the conflation here is purely a
  measurement convenience and does not change the protocol-level latency.
- The Move module is intentionally minimal. A production DID registry would
  add resolution indexing, key rotation events, and access-control hooks.
