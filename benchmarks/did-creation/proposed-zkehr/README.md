# zkLogin-only End-to-End Identity-Establishment Baseline (zkEHR Evaluation)

This project implements the **zkLogin-only** baseline for the zkEHR paper. It
measures the full end-to-end latency of establishing a Sui-native identity
via Mysten Labs' zkLogin protocol:

> **OIDC login + salt + zkLogin proof + blockchain login/address creation**

## What this baseline measures

A patient (clinician) signs into Google, the system derives a Sui zkLogin
address from {JWT, salt}, asks Mysten's prover for a zero-knowledge proof
that binds the OIDC identity to the address, and submits a sponsored Sui
transaction to "establish" the identity on chain (creating a `DIDObject` in
the same `did_registry` Move package the private-key DID baseline deploys).

The 12 phases recorded per run (in order):

| Phase | Step | Column |
|---|---|---|
| A. Pre-OAuth | Generate ephemeral Ed25519 keypair | `ephemeral_keygen_ms` |
| | Fetch current Sui epoch (max_epoch = epoch + 8) | `epoch_fetch_ms` |
| | Generate randomness | `randomness_ms` |
| | Compute zkLogin nonce | `nonce_compute_ms` |
| B. OIDC | Drive Google OIDC implicit flow, capture JWT from URL fragment | `oidc_login_ms` |
| | Decode JWT (sub, aud, iss, nonce check) | `jwt_decode_ms` |
| C. Salt | Single-authority salt derivation (SHA-256 of secret + sub + aud) | `salt_fetch_ms` |
| D. Address + proof | Compute zkLogin Sui address (`jwtToAddress`) + addressSeed | `address_compute_ms` |
| | POST to Mysten devnet prover for Groth16 proof | `prover_request_ms` |
| E. On-chain | Build sponsored Move-call transaction | `tx_build_ms` |
| | Assemble zkLogin signature (proof + ephemeral signature) | `zklogin_sig_assemble_ms` |
| | Submit to devnet (WaitForEffectsCert) + extract object id | `tx_submit_ms`, `object_extract_ms` |

`total_ms` = end-to-end wall clock from first key generation to created
DIDObject id confirmed on chain.

## Architecture (three parties)

| Role | What it does | In this project |
|---|---|---|
| Patient Wallet (zkLogin user) | Generates ephemeral key, drives OIDC login, gets ZK proof, signs tx | `src/oidcLogin.ts`, `src/zkLoginAddress.ts`, `src/zkLoginTx.ts` |
| Sui Devnet Move package | Stores `DIDObject` on chain | `did_registry::did_registry` (deployed by the private-key baseline) |
| Gas Sponsor | Pays gas on behalf of unfunded zkLogin addresses | `SUI_PRIVATE_KEY` in `.env` |

Sponsored transactions let the zkLogin address itself never need SUI -- the
sponsor (our funded EC2 key) co-signs the tx and pays gas. This matches the
pattern most production zkLogin deployments use (a service or relying party
sponsors gas on behalf of users).

## Why "single-authority salt" and not multi-authority?

zkEHR's *innovation* is multi-authority salt derivation across N institutions.
This baseline is the boring *contrast*: salt comes from a single source
(SHA-256 of `secret || sub || aud`). Losing the salt secret would let an
attacker recompute every user's zkLogin address from {sub, aud} -- exactly
the centralization risk that motivates zkEHR's multi-party salt.

## Setup

Same DCV-based remote-execution pattern as the OIDC-only baseline. See
`../experiments/EC2-DCV-WORKFLOW.md` for full DCV setup.

```bash
# On EC2 (via SSH):
cd ~/zklogin-only-baseline
cp .env.example .env && $EDITOR .env       # set SUI_PRIVATE_KEY (gas sponsor)
npm install
npm run build
npx playwright install --with-deps chromium
```

The `.env.example` already has `SUI_PACKAGE_ID` set to the `did_registry`
package deployed by the private-key DID baseline -- no separate Move deploy
is needed.

## One-time interactive setup (DCV Viewer required)

1. Connect DCV Viewer to `<ec2-host>:8443` from your Mac.
2. In the DCV terminal:
   ```bash
   cd ~/zklogin-only-baseline
   ./run-in-dcv.sh prelogin       # sign into Google manually, press Enter
   ./run-in-dcv.sh prime-consent  # one OIDC round-trip; click Allow if asked
   ```
3. Disconnect DCV.

## Measured experiment (no DCV needed)

```bash
ssh -i aws.pem ubuntu@<ec2-host>
cd ~/zklogin-only-baseline
./run-in-dcv.sh establish    # 100 measured runs -> results/zklogin_establish_devnet.csv
```

## Output

| File | Content |
|---|---|
| `results/zklogin_establish_devnet.csv` | Per-run measurements (12 phase columns + total) |
| `data/sessions.json` | Sanity record of the (sub, aud, zklogin_address) tuple |

## Methodological notes (paper-ready)

- Timing primitive: `process.hrtime.bigint()` (nanosecond resolution).
- Warm-up: `WARMUP_RUNS` (default 10) runs are executed first and dropped
  from the CSV/statistics.
- Failed runs are recorded (success=false, error_message populated) and do
  not crash the experiment.
- Sui submission semantics match the private-key DID baseline:
  `requestType: WaitForEffectsCert`, `options: { showEffects: true }`,
  no `waitForTransaction` -- this is exactly what zkEHR's
  `zkdid/veramo-to-sui.js:1289` uses.
- The same Mysten prover endpoint (`https://prover-dev.mystenlabs.com/v1`)
  zkEHR uses is called here.
- The same `did_registry` Move package the private-key DID baseline deploys
  is used here -- so the on-chain operation is identical, only the signing
  scheme differs (regular Ed25519 vs. zkLogin signature).

## Intentionally excluded from this baseline

- Multi-authority salt derivation (zkEHR-specific)
- Keyless recovery (zkEHR-specific)
- zkDIDProof / zkEHR-specific access control
- Any zkEHR-specific identity binding logic

## Suggested paper paragraph

> The zkLogin-only baseline implements Mysten Labs' reference zkLogin
> identity establishment protocol against Sui Devnet. A patient's identity
> is anchored in a Google OIDC login; a single-authority salt service
> contributes the entropy needed to mask {iss, sub, aud} on-chain; the
> Mysten devnet prover service generates a Groth16 proof binding the JWT
> to a Sui zkLogin address; and a sponsored Sui transaction registers a
> `DIDObject` on chain. End-to-end establishment latency therefore
> incorporates OIDC silent-SSO RTT, salt derivation, prover-service RTT,
> Sui transaction submission with WaitForEffectsCert finality, and
> object-id extraction from certified effects. This baseline differs from
> the zkEHR proposal exclusively in (i) using a single salt authority
> rather than a threshold of institutional salt providers and (ii)
> omitting zkEHR-specific access-control hooks; all other infrastructure
> (the OIDC provider, the Mysten prover, the Sui Move package) is
> identical, ensuring that any latency difference between the two
> systems is attributable to those two design choices alone.
