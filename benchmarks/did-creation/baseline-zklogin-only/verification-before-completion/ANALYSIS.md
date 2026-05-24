# zkLogin-only End-to-End Identity-Establishment -- Analysis Report

- Source: `zklogin_establish_devnet.csv`
- Captured on EC2 us-east-1; Sui CLI 1.70 + @mysten/sui ^1.45.2
- OIDC: Google (silent SSO via persistent profile)
- Prover: https://prover-dev.mystenlabs.com/v1
- Move package: did_registry::did_registry on Sui Devnet
- Submission: WaitForEffectsCert (matches zkEHR's submission semantics)
- Sponsored tx: zkLogin user pays no gas; gas sponsor co-signs

## Run summary
- Total measured runs: **100**
- Successes: **100** (100.0%)
- Failures: **0**

## Per-step timings

| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `ephemeral_keygen_ms` | 100 |   0.386 |  0.060 |  0.334 |  0.371 |  0.495 |  0.665 |  0.733 |
| `epoch_fetch_ms` | 100 |   8.769 |  5.977 |  5.865 |  7.256 | 24.470 | 36.454 | 38.052 |
| `randomness_ms` | 100 |   0.027 |  0.008 |  0.022 |  0.024 |  0.048 |  0.057 |  0.058 |
| `nonce_compute_ms` | 100 |   0.559 |  0.057 |  0.520 |  0.550 |  0.714 |  0.813 |  0.817 |
| `oidc_login_ms` | 100 | 187.446 | 16.335 | 152.785 | 184.876 | 217.027 | 227.331 | 236.441 |
| `jwt_decode_ms` | 100 |   0.230 |  0.054 |  0.163 |  0.213 |  0.356 |  0.408 |  0.503 |
| `salt_fetch_ms` | 100 |   0.072 |  0.127 |  0.038 |  0.049 |  0.087 |  0.493 |  1.220 |
| `address_compute_ms` | 100 |   5.761 |  1.216 |  4.564 |  5.580 |  7.515 |  9.035 | 13.725 |
| `prover_request_ms` | 100 | 2885.966 | 304.371 | 2464.406 | 2972.698 | 3287.218 | 3369.232 | 3445.869 |
| `tx_build_ms` | 100 | 121.307 | 29.138 | 86.390 | 112.166 | 168.067 | 227.433 | 261.846 |
| `zklogin_sig_assemble_ms` | 100 |   0.000 |  0.000 |  0.000 |  0.000 |  0.001 |  0.001 |  0.001 |
| `tx_submit_ms` | 100 | 203.369 | 40.826 | 140.123 | 201.063 | 252.037 | 389.932 | 426.524 |
| `object_extract_ms` | 100 |   0.003 |  0.006 |  0.002 |  0.002 |  0.008 |  0.045 |  0.047 |
| `total_ms` | 100 | 3415.641 | 295.404 | 2976.493 | 3507.060 | 3826.339 | 3926.928 | 3929.341 |

## Phase breakdown

| Phase / step | Mean (ms) | % of total |
|---|--:|--:|
| **Phase A: pre-OAuth setup** | **9.741** | **0.3%** |
|   `ephemeral_keygen_ms` | 0.386 | 0.01% |
|   `epoch_fetch_ms` | 8.769 | 0.26% |
|   `randomness_ms` | 0.027 | 0.00% |
|   `nonce_compute_ms` | 0.559 | 0.02% |
| **Phase B: OIDC login** | **187.676** | **5.5%** |
|   `oidc_login_ms` | 187.446 | 5.49% |
|   `jwt_decode_ms` | 0.230 | 0.01% |
| **Phase C: salt** | **0.072** | **0.0%** |
|   `salt_fetch_ms` | 0.072 | 0.00% |
| **Phase D: zkLogin proof + address** | **2891.727** | **84.7%** |
|   `address_compute_ms` | 5.761 | 0.17% |
|   `prover_request_ms` | 2885.966 | 84.49% |
| **Phase E: on-chain registration** | **324.680** | **9.5%** |
|   `tx_build_ms` | 121.307 | 3.55% |
|   `zklogin_sig_assemble_ms` | 0.000 | 0.00% |
|   `tx_submit_ms` | 203.369 | 5.95% |
|   `object_extract_ms` | 0.003 | 0.00% |
| **Total** | **3415.641** | **100.0%** |

## Headline numbers (suggested for the paper)

- **zkLogin end-to-end identity-establishment latency** (n=100, includes Google OIDC silent-SSO, single-authority salt, Mysten Labs devnet prover, sponsored Sui transaction with WaitForEffectsCert): mean = **3415.6 ms**, p50 = **3507.1 ms**, p95 = **3826.3 ms**, p99 = **3926.9 ms**, std = **295.4 ms**.
- Mysten zkLogin prover dominates at **2886 ± 304 ms** (84% of total). OIDC silent-SSO is **187 ms** (5%). Sui WaitForEffectsCert tx submit is **203 ms** (6%).

These numbers represent the conventional zkLogin baseline against which zkEHR's keyless, multi-authority-salt identity establishment is compared. The zkLogin proof step is the immovable cost of any zk-anchored OIDC binding; zkEHR cannot avoid it but may amortize it.
