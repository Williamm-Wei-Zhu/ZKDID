# zkDID / zkEHR — Prototype

The deployable system: patient DIDs, on-chain Verifiable Credentials, patient-controlled access
grants, and zkLogin authentication on the Sui blockchain.

## Architecture

```
+---------------------+       +---------------------+       +---------------------+
|     Frontend        |       |    Orchestrator     |       |      Backend        |
|  (React + zkLogin)  | <---> |    (bridge.mjs)     | <---> |  (veramo-to-sui.js) |
|  Port 1234          |       |  Epoch validation   |       |  DID/VC issuance    |
|  OAuth login        |       |  Session management |       |  Sui transactions   |
+---------------------+       +---------------------+       +---------------------+
         |                                                            |
         |  zkLogin Prover (MystenLabs): JWT -> ZK Proof              |
         v                                                            v
+---------------------+                                 +-------------------------+
|  OAuth Providers    |                                 |   Sui Blockchain        |
|  Google/Twitch/FB   |                                 |   (DevNet)              |
+---------------------+                                 |   store_did_vc /        |
                                                        |   medical_access        |
                                                        +-------------------------+
```

### Components

| Path | Role |
|---|---|
| `backend/` | DID creation, VC issuance, Sui Move transactions (Veramo + Sui SDK). Entry: `backend/veramo-to-sui.js` |
| `frontend/` | React + zkLogin web app (OAuth, ZK proof, timing). Entry: `frontend/src/App.tsx` |
| `orchestrator/` | `bridge.mjs` — spawns the frontend, validates Sui epochs, manages sessions |
| `salt-service/` | Per-institution salt service (Dockerized) |
| `mock-vc-issuer/` | Mock OIDC4VCI credential issuer used by the experiments |
| `salt-seeds.json` | Institution salt-seed config (template; values blank) |
| `deploy/` | EC2 / zkLogin prover deployment helper |

## Smart contracts

Two Move contracts are deployed on Sui DevNet:

- **`store_did_vc::DIDVC`** — stores DID + VC pairs on-chain (`backend/did_vc/`)
- **`medical_access::AccessGrant`** — patient-to-provider access grants (`backend/medical_access/`)

> Sui DevNet is periodically reset (all data + deployed packages wiped). After each reset,
> redeploy both contracts and update the package IDs in `backend/veramo-to-sui.js`.

## Prerequisites

- Node.js >= 18 (ESM), npm >= 9
- Sui CLI (for deploying Move contracts) — https://docs.sui.io/build/install
- OAuth credentials for Google, Twitch, and/or Facebook

## Installation

From the **repo root**:

```bash
npm install
(cd prototype/backend && npm install)
(cd prototype/frontend && npm install)
```

## Deploy the smart contracts

```bash
sui client switch --env devnet
sui client faucet                     # request test SUI if needed

# DID + VC storage contract
cd prototype/backend/did_vc && sui move build && sui client publish --gas-budget 100000000

# medical access-control contract
cd ../medical_access && sui move build && sui client publish --gas-budget 100000000
```

Update both Package IDs in `backend/veramo-to-sui.js` (constants `PACKAGE_ID` and
`MEDICAL_ACCESS_PACKAGE_ID`). Verify packages still exist with `node prototype/backend/check-pkg.mjs`.

## Configuration

```bash
# Frontend OAuth / zkLogin config
cp prototype/frontend/src/config.example.json prototype/frontend/src/config.json
# edit config.json with your client IDs, prover URL, salt seeds

# Salt service config
cp prototype/salt-service/config.json.example prototype/salt-service/config.json
```

Both `config.json` files are gitignored. Institution salt seeds are configured in
`prototype/salt-seeds.json`.

## Usage

From the **repo root**:

```bash
npm run dev            # frontend on http://localhost:1234 via the orchestrator
npm run search:did     # search DIDs on Sui
npm run search:access  # search AccessGrant records on-chain
```

DID management dashboard and utilities:

```bash
node prototype/backend/manage-dids.js     # web dashboard on http://localhost:3000
node prototype/backend/check-pkg.mjs      # verify deployed package exists
node prototype/backend/check-balance.mjs  # check zkLogin address balance
node prototype/backend/test-rpc.mjs       # test Sui DevNet RPC
node prototype/backend/diagnose-tx.mjs    # diagnose a transaction
node prototype/backend/epoch.js           # query current Sui epoch
```

## Scripts reference

| Command (from repo root) | Description |
|---|---|
| `npm run dev` | Full-stack dev server (frontend via orchestrator) |
| `npm run search:did` | Search DIDs on Sui |
| `npm run search:access` | Search AccessGrant records |
| `node prototype/backend/manage-dids.js` | DID management dashboard (port 3000) |
| `node prototype/backend/scripts/verify_vc.js` | Verify a single VC |
| `node prototype/backend/scripts/verify_vc_batch.js` | Batch-verify VCs |
| `node prototype/backend/scripts/verify_access_batch.js` | Batch-verify access grants |
| `node prototype/backend/scripts/fetch_did_vc.mjs` | Fetch a DID+VC pair on-chain |

## Network

| Parameter | Value |
|---|---|
| Network | Sui DevNet |
| RPC | `https://fullnode.devnet.sui.io` |
| zkLogin Prover | `https://prover-dev.mystenlabs.com/v1` |
