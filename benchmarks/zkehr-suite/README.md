# zkDID Performance Experiments

Automated batch runner for TSC-style performance measurements of the zkDID
Patient DID-creation + on-chain POST pipeline.

Drives the frontend via Playwright end-to-end (real Google OAuth, real Mysten
prover, real Sui DevNet), collects **per-phase** browser-side timings, backend
timings, gas/storage data, and wall-clock numbers, and writes them as one CSV
row per run.

## Prerequisites

1. The dev stack is running: `cd .. && npm run dev`
   - Bridge: `http://localhost:4317`
   - Frontend: `http://localhost:1234`
2. At least one EC2 salt-service instance is reachable (see top-level README).
3. `npm install` inside this directory (once).
4. Playwright's Chromium browser is installed (once):
   ```bash
   npm run setup
   ```

## First-run setup (one-time manual Google login)

Because Google cannot be scripted headlessly, we use a **persistent browser
profile** at `./.chrome-profile/`. On the very first run, a Chromium window
opens and you must:

1. Let the page load at `http://localhost:1234`
2. Click **Google** manually
3. Sign into your Google account normally
4. Let the redirect finish (you'll see the "Logged in as ..." toast)
5. Close the browser window OR wait for the script to continue

From then on, every subsequent run uses the same profile. Google sees an
existing session and silently redirects back — **no more clicking needed**.

## Usage

```bash
# 20 runs, 3 institutions, no cache (all salts fetched from EC2 at login)
node run.mjs --op=did --institutions=3 --cache=none --runs=20

# Same but all salts cached locally (tests local Poseidon path)
node run.mjs --op=did --institutions=3 --cache=all --runs=20

# 5-run smoke test
node run.mjs --runs=5
```

Running `node run.mjs --help` prints the full CLI reference.

## What gets measured (per run)

Each CSV row has ~40 columns. Here's the taxonomy:

### Identity & config
- `run_id`, `timestamp`, `tag`, `success`, `error_msg`
- `op`, `institutions`, `cache_mode`, `warm`

### Pre-OAuth browser timings (`beginZkLogin`)
- `epoch_fetch_ms` — `SuiClient.getLatestSuiSystemState()` RPC
- `eph_key_ms` — ephemeral Ed25519 keypair generation
- `randomness_ms` — 16-byte randomness
- `nonce_ms` — Poseidon-based zkLogin nonce
- `gen_params_total_ms` — sum of above

### OAuth round-trip
- `oauth_rtt_ms` — wall-clock from clicking Google to the JWT landing back

### Post-OAuth browser timings (`completeZkLogin`)
- `jwt_parse_ms` — base64url decode of the id_token
- `salt_ms` — per-institution salt derivation (local Poseidon and/or remote `/get-salt`)
- `nonce_verify_ms` — defensive re-compute + compare against JWT's nonce claim
- `prover_ms` — Mysten ZK prover request
- `save_account_ms` — sessionStorage write
- `bridge_post_ms` — POST to `/zklogin-session`
- `derive_all_ms` — convenience sum (salt + prover)

### Backend timings (from `/latest-timings` after each op)
- `backend_restore_ms` — key recovery + randomness + nonce verify + address seed
- `backend_jwk_precheck_ms` — Google JWKS `kid` check
- `backend_prover_request_ms` — 0 ms (frontend pre-supplies proof)
- `backend_faucet_ms` — auto-topup DevNet balance if <0.05 SUI
- `backend_build_sign_ms` — Move PTB construction + `tx.sign()`
- `backend_assemble_sig_ms` — `getZkLoginSignature(...)`
- `backend_submit_ms` — `executeTransactionBlock(...)`
- `backend_query_chain_ms` — `getTransactionBlock(digest, { showEffects })`
- `backend_total_ms` — sum of backend phases

### On-chain gas (from tx effects)
- `gas_computation_mist`, `gas_storage_mist`, `gas_rebate_mist`, `gas_nonrefundable_mist`, `gas_net_mist`

### On-chain object
- `object_id`, `object_bcs_bytes`, `objects_created`
- `tx_digest`, `tx_status`

### Playwright-measured wall-clock
- `wall_login_ms` — click Google → "Logged in" toast
- `wall_submit_ms` — click "Create DID" → "DID dispatched" toast
- `wall_total_ms` — click Google → everything done

### Reproducibility
- `node_version`, `git_commit`

## Experimental design recommendations (TSC-style)

| Variable to sweep | Command examples |
|---|---|
| Institution count (scalability) | `--institutions=1,3,5,10` (run one command per value) |
| Cache mode (ablation) | `--cache=none` vs `--cache=all` vs `--cache=mixed` |
| Op type | `--op=did` vs `--op=vc` vs `--op=access` |
| Cold vs warm | `--warm=false` for cold-start numbers |

Each condition should be run **≥ 100 times** for the TSC reviewer's
confidence-interval bar. Typical batch:

```bash
for INST in 1 3 5 10; do
  node run.mjs --op=did --institutions=$INST --cache=none --runs=100 --tag=N$INST_none
  node run.mjs --op=did --institutions=$INST --cache=all  --runs=100 --tag=N$INST_all
done
```

Eight CSV files, one per configuration. Each row is one observation — the
distributions let you compute means, tails, confidence intervals, and box
plots per condition.

## Post-processing

CSVs are flat wide-format, ready for pandas/R/Excel:

```python
import pandas as pd, glob
df = pd.concat([pd.read_csv(f) for f in glob.glob("results/*.csv")])
df.groupby(["op", "institutions", "cache_mode"])[["wall_total_ms", "salt_ms", "prover_ms"]].describe(percentiles=[.5, .95, .99])
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser opens but nothing happens on first run | Manually sign into Google once; profile is saved for subsequent runs |
| "timeout waiting for fresh backend timings" | Backend crashed mid-run — check the `npm run dev` terminal for errors |
| "Bridge not reachable at http://localhost:4317" | Start `npm run dev` in the repo root |
| Google "This browser may not be secure" | Rare with the UA override in `run.mjs`. If hit: sign in via `https://accounts.google.com` manually first |
| Every run fails with "nonce mismatch" | Delete `.chrome-profile/` and log in fresh; sessionStorage state from a prior run leaked |

## Clean-up

```bash
# Wipe Chrome profile (will need to re-login manually next time)
rm -rf .chrome-profile/

# Wipe all results
rm -rf results/

# Clear a stuck zkLogin session in the bridge
curl -X POST http://localhost:4317/session/clear
```
