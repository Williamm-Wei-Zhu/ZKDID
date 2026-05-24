# ACTION-EHR-Inspired Patient-Centric Blockchain Access-Control Baseline

This project implements an **ACTION-EHR-inspired patient-centric blockchain
access-control baseline** for academic comparison with zkEHR. It measures
**end-to-end cross-institution access authorization and verification
latency** on Sui Devnet via a Move smart contract.

> **The ACTION-EHR-inspired baseline represents a patient-centric
> blockchain access-control model for cross-institutional EHR sharing. In
> this baseline, a patient creates an on-chain `AccessGrant` authorizing
> Hospital B to access selected EHR records held by Hospital A. During
> access verification, Hospital A queries the blockchain for the
> `AccessGrant` object and checks its status, grantee, data holder, record
> identifier, scope, and expiration before creating a local authorized EHR
> access session. This baseline abstracts the blockchain-managed
> access-control logic of patient-centric EHR sharing systems such as
> ACTION-EHR, while omitting zkLogin, zero-knowledge proofs,
> multi-authority salt derivation, and keyless DID recovery.**

> **This is NOT a full reproduction of ACTION-EHR.** It captures a
> comparable authorization path so the latency cost of conventional
> patient-centric blockchain access control can be measured against zkEHR.
> The baseline uses Sui Devnet for experimental consistency with the other
> baselines in this paper.

## Why this baseline matters for the paper

The paper evaluates zkEHR — a keyless and unlinkable decentralized
identity architecture for cross-institutional EHR sharing. To measure
zkEHR's latency overhead we compare against:

1. **OIDC-only** (no DIDs, no chain) — sibling project.
2. **Private-key DID/VC on Sui** (chain-resolved DID, off-chain VC) — sibling project.
3. **ACTION-EHR-inspired** (chain-stored access grant) — *this project*.

Each captures one well-known design point in the access-control literature.
This project's contribution is to isolate the **on-chain access-grant
verification** cost: a row of patient-centric blockchain EHR systems
(ACTION-EHR, MedRec, MedShare, …) where every cross-hospital access path
includes a chain query against an authorization object.

## Cross-institution scenario

Patient *P* holds a Sui keypair. Patient *P*'s clinical records live at
Hospital *A*. Patient *P* wants Hospital *B* (a specialist) to read EHR
record `ehr_record_001` held at Hospital *A*.

```
+---------+   create_access_grant(...)   +-----------------+
| Patient | ---------------------------> | AccessGrant     |
+---------+    (Sui Devnet, Move)        |  on Sui Devnet  |
                                         +-----------------+
+------------+   request(grant_id, …)    +---------+   getObject(grant_id)   +-----------------+
| Hospital B | ------------------------> | Hospital| ----------------------> | AccessGrant     |
+------------+                           |    A    | <---------------------- |   ↑ verifies     |
                                         +---------+   verifies + sessions   +-----------------+
```

## Three experiment modes

| Mode | CLI | What is measured |
|---|---|---|
| **1. Grant creation** | `npm run experiment:create-grant` | construct → tx build → submit → effects-cert → extract object id → persist |
| **2. Grant verification** | `npm run experiment:verify-grant` | request build → Sui `getObject` → parse → status / scope / expiration / record / grantee checks → session create |
| **3. End-to-end** | `npm run experiment:e2e` | mode 1 + mode 2 in a single timed run |

Each measured run records a row in
`results/action_ehr_*_devnet.csv` plus the metadata in `data/access_grants.json`
(reused by mode 2) and `data/access_requests.json` (audit trail).

## What is intentionally excluded

To keep this a fair conventional-blockchain baseline, the following are
**not** on the critical path:

- zkLogin / zkDIDProof / Groth16 proof generation or verification
- Multi-authority salt derivation
- Keyless DID recovery
- zkEHR-specific DID derivation
- OIDC login / Google JWT
- Verifiable credential selective disclosure / BBS+ proofs
- Any zkEHR-specific AccessGrant implementation

Hospital A and Hospital B identities are **pre-known constants** baked in
at config time — modeling the standard PKI-bootstrapped trust used in
production HIE deployments. Modeling per-call mutual TLS or institutional
JWT verification (as done in the OIDC-only sibling baseline) would be
additive on top of this baseline.

## Stack

- Node.js 20+
- TypeScript 5.6
- `@mysten/sui` 1.45 (Sui TypeScript SDK)
- `dotenv`
- Sui CLI 1.7+
- Sui Move (`edition = "2024"`)

## One-time setup on a fresh host

```bash
# 1. Install Sui CLI
#    https://docs.sui.io/guides/developer/getting-started/sui-install
#    (binaries available at https://github.com/MystenLabs/sui/releases)

# 2. Switch to devnet
sui client switch --env devnet
sui client active-env       # should print: devnet

# 3. Get Devnet SUI from the faucet (the deploy script also does this if low)
sui client faucet

# 4. Install dependencies + build the TS bundle
npm install
npm run build

# 5. Build & publish the AccessGrant Move package to Devnet
npm run deploy:devnet
# Copy the printed SUI_PACKAGE_ID into .env

# Manual fallback for the deploy step (matches what the script runs):
sui move build --path move/access_grant
sui client publish move/access_grant --gas-budget 100000000
```

## Configuration

Copy `.env.example` to `.env` and fill in:

- `SUI_PRIVATE_KEY` — bech32 `suiprivkey1...` exported by `sui keytool export`.
  This key signs every grant-creation tx and pays gas. **Do not commit.**
- `SUI_PACKAGE_ID` — the package id printed by `npm run deploy:devnet`.

All other env vars have safe defaults; see `.env.example` for documentation.

## Running the experiments

```bash
# Each can be run independently:
npm run experiment:create-grant   # Experiment 1 (creates real on-chain grants)
npm run experiment:verify-grant   # Experiment 2 (reuses grants from data/)
npm run experiment:e2e            # Experiment 3 (full end-to-end per run)
npm run experiment:all            # 1 → 2 → 3 in order
```

The default is `RUNS=100, WARMUP_RUNS=10`. Failed runs are recorded in the
CSV (`success=false`, `error_message=...`) and excluded from latency
percentiles. Override via `.env`.

## CSV output and how to interpret it

Three CSV files are produced under `results/`:

- **`action_ehr_grant_creation_devnet.csv`** — 100 rows × 14 columns.
  `total_ms` is dominated by `tx_submit_ms` (Sui `WaitForEffectsCert` round-trip).
- **`action_ehr_grant_verification_devnet.csv`** — 100 rows × 14 columns.
  `total_ms` is dominated by `blockchain_query_ms` (Sui `getObject`).
  All check columns (`status_check_ms`, `scope_check_ms`,
  `expiration_check_ms`) are sub-millisecond in-process work.
- **`action_ehr_end_to_end_devnet.csv`** — 100 rows × 19 columns. Sums the
  two phases per run; `total_ms` ≈ `tx_submit_ms` + `blockchain_query_ms`.

## Functional success criteria

- **Mode 1**: a row succeeds only when an AccessGrant object has been
  created on Sui Devnet AND its object id has been extracted from
  `objectChanges` AND the grant has been appended to
  `data/access_grants.json`.
- **Mode 2**: a row succeeds only when Hospital A (a) successfully fetched
  the AccessGrant via Sui `getObject`, (b) passed all status / scope /
  record / grantee / expiration checks, and (c) created the local
  authorized EHR access session.
- **Mode 3**: a row succeeds only when both phase-1 and phase-2 succeed
  end-to-end inside a single timed run.

## Why Sui Devnet (and not a local devnet)

For experimental consistency with the sibling baselines (`oidc-only-baseline`,
`private-key-did-vc-sui-devnet`, `oidc-only-cross-institution-access`,
`private-key-did-vc-cross-access`), all chain-touching baselines in this
paper use the *same* Sui Devnet endpoint over the *same* AWS region. The
code refuses to start with `SUI_NETWORK ≠ devnet` so a stray mainnet
config can never accidentally pay real gas. There is **no local-only
mode** — that would conflate this baseline with a different (no-RPC)
design point.
