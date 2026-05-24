# OIDC-Only Baseline — Analysis Report

- Source: `oidc_only_results.csv` and `oidc_only_results_reuse.csv`
- Captured on EC2 us-east-1; clock: `process.hrtime.bigint()`
- Provider: Google OIDC (cached SSO via persistent Chromium profile)
- Flow: authorization-code + PKCE; ID token verified via Google JWKS

## Mode 1: Full OIDC login (silent SSO)

- Total measured runs: **100**
- Successes: **100**  (100.0%)
- Failures:  **0**

| Metric (ms) |    n |    mean |     std |     min |     p50 |     p95 |     p99 |     max |
|-------------|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| `oidc_login_ms` |  100 | 187.024 |  13.311 | 150.973 | 185.121 | 209.107 | 222.294 | 238.493 |
| `token_exchange_ms` |  100 |  52.087 |   8.797 |  37.860 |  49.572 |  67.088 |  73.969 |  88.380 |
| `jwks_fetch_or_cache_ms` |  100 |   0.049 |   0.020 |   0.036 |   0.043 |   0.068 |   0.154 |   0.185 |
| `jwt_verify_ms` |  100 |   0.278 |   0.103 |   0.217 |   0.269 |   0.336 |   0.404 |   1.235 |
| `claim_validation_ms` |  100 |   0.003 |   0.002 |   0.002 |   0.003 |   0.005 |   0.008 |   0.013 |
| `session_create_ms` |  100 |   0.010 |   0.002 |   0.008 |   0.010 |   0.014 |   0.016 |   0.021 |
| `total_ms` |  100 | 239.735 |  16.858 | 203.704 | 237.214 | 268.376 | 284.105 | 289.345 |

## Mode 2: Token / session reuse

- Total measured runs: **100**
- Successes: **100**  (100.0%)
- Failures:  **0**

| Metric (ms) |    n |    mean |     std |     min |     p50 |     p95 |     p99 |     max |
|-------------|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|
| `oidc_login_ms` |  100 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |
| `token_exchange_ms` |  100 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |   0.000 |
| `jwks_fetch_or_cache_ms` |  100 |   0.025 |   0.017 |   0.018 |   0.021 |   0.037 |   0.109 |   0.121 |
| `jwt_verify_ms` |  100 |   0.178 |   0.023 |   0.152 |   0.171 |   0.233 |   0.250 |   0.254 |
| `claim_validation_ms` |  100 |   0.001 |   0.001 |   0.001 |   0.001 |   0.003 |   0.006 |   0.012 |
| `session_create_ms` |  100 |   0.005 |   0.002 |   0.004 |   0.004 |   0.006 |   0.008 |   0.027 |
| `total_ms` |  100 |   0.213 |   0.034 |   0.181 |   0.202 |   0.284 |   0.345 |   0.354 |

## Mode 1 vs Mode 2 — head-to-head comparison

| Metric (ms) | Mode 1 (full login)  mean ± std | Mode 1 p50 / p95 / p99 | Mode 2 (reuse) mean ± std | Mode 2 p50 / p95 / p99 |
|---|---|---|---|---|
| `oidc_login_ms` | 187.024 ± 13.311 | 185.121 / 209.107 / 222.294 | 0.000 ± 0.000 | 0.000 / 0.000 / 0.000 |
| `token_exchange_ms` | 52.087 ± 8.797 | 49.572 / 67.088 / 73.969 | 0.000 ± 0.000 | 0.000 / 0.000 / 0.000 |
| `jwks_fetch_or_cache_ms` | 0.049 ± 0.020 | 0.043 / 0.068 / 0.154 | 0.025 ± 0.017 | 0.021 / 0.037 / 0.109 |
| `jwt_verify_ms` | 0.278 ± 0.103 | 0.269 / 0.336 / 0.404 | 0.178 ± 0.023 | 0.171 / 0.233 / 0.250 |
| `claim_validation_ms` | 0.003 ± 0.002 | 0.003 / 0.005 / 0.008 | 0.001 ± 0.001 | 0.001 / 0.003 / 0.006 |
| `session_create_ms` | 0.010 ± 0.002 | 0.010 / 0.014 / 0.016 | 0.005 ± 0.002 | 0.004 / 0.006 / 0.008 |
| `total_ms` | 239.735 ± 16.858 | 237.214 / 268.376 / 284.105 | 0.213 ± 0.034 | 0.202 / 0.284 / 0.345 |

## Mode 1 wall-clock breakdown — what dominates the latency?

| Step | Mean (ms) | % of total |
|---|---:|---:|
| Browser navigation + Google silent-SSO redirect (`oidc_login_ms`) | 187.024 | 78.0% |
| POST /token (authorization-code -> ID token) (`token_exchange_ms`) | 52.087 | 21.7% |
| JWKS fetch or cache hit (`jwks_fetch_or_cache_ms`) | 0.049 | 0.0% |
| RSA signature verification (`jwt_verify_ms`) | 0.278 | 0.1% |
| iss/aud/exp/nonce/sub validation (`claim_validation_ms`) | 0.003 | 0.0% |
| Local EHR session object construction (`session_create_ms`) | 0.010 | 0.0% |
| **Total (`total_ms`)** | **239.735** | **100.0%** |

## Headline numbers (suggested for the paper)

- **OIDC silent-SSO identity-establishment latency** (Mode 1, n=100): mean = **239.7 ms**, p50 = **237.2 ms**, p95 = **268.4 ms**, p99 = **284.1 ms**, std = **16.9 ms**.
- **OIDC token-reuse identity-establishment latency** (Mode 2, n=100): mean = **0.213 ms**, p50 = **0.202 ms**, p95 = **0.284 ms**, p99 = **0.345 ms**, std = **0.034 ms**.

These are the *lower-bound federated baselines* against which the zkEHR pipeline (DID + VC + blockchain + zkLogin + multi-authority salt) is compared. Any zkEHR overhead is the marginal cost of the privacy and decentralization properties the OIDC-only baseline does not provide.
