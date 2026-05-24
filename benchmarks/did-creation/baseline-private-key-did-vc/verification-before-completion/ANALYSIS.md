# Private-key DID/VC on Sui Devnet -- Analysis Report

- Sources: `private_key_did_establishment_devnet.csv`, `private_key_did_auth_devnet.csv`, `private_key_did_vc.csv`
- Captured on EC2 us-east-1; Sui CLI 1.70 + @mysten/sui ^1.45.2
- Move package: did_registry::did_registry on Sui Devnet
- Clock: process.hrtime.bigint()

## Mode 1: First-time DID establishment (mandatory on-chain)

- Total measured runs: **100**
- Successes: **100** (100.0%)
- Failures: **0**

| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `keygen_ms` | 100 |   0.402 |  0.072 |  0.337 |  0.383 |  0.519 |  0.739 |  0.760 |
| `did_derivation_ms` | 100 |   0.043 |  0.032 |  0.019 |  0.029 |  0.096 |  0.140 |  0.244 |
| `did_document_create_ms` | 100 |   0.058 |  0.014 |  0.043 |  0.052 |  0.091 |  0.102 |  0.113 |
| `tx_build_ms` | 100 |   0.299 |  0.072 |  0.234 |  0.279 |  0.389 |  0.617 |  0.637 |
| `tx_submit_ms` | 100 | 316.668 | 72.264 | 246.967 | 310.546 | 389.874 | 465.509 | 915.300 |
| `tx_finality_ms` | 100 |   0.000 |  0.000 |  0.000 |  0.000 |  0.000 |  0.000 |  0.000 |
| `object_extract_ms` | 100 |   0.003 |  0.002 |  0.001 |  0.002 |  0.005 |  0.012 |  0.015 |
| `local_store_ms` | 100 |   1.918 |  0.365 |  1.356 |  1.877 |  2.624 |  3.422 |  3.568 |
| `total_ms` | 100 | 319.409 | 72.311 | 250.064 | 313.314 | 392.541 | 468.500 | 918.166 |

## Mode 2: DID challenge auth (on-chain DID resolve)

- Total measured runs: **100**
- Successes: **100** (100.0%)
- Failures: **0**

| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `challenge_create_ms` | 100 |   0.018 |  0.008 |  0.013 |  0.016 |  0.026 |  0.040 |  0.079 |
| `sign_challenge_ms` | 100 |   0.591 |  0.063 |  0.531 |  0.571 |  0.711 |  0.892 |  0.907 |
| `did_resolve_devnet_ms` | 100 |   9.869 | 17.209 |  5.360 |  6.379 |  8.040 | 98.369 | 99.475 |
| `did_object_parse_ms` | 100 |   0.001 |  0.004 |  0.000 |  0.000 |  0.001 |  0.002 |  0.040 |
| `signature_verify_ms` | 100 |   2.341 |  0.232 |  2.149 |  2.271 |  2.780 |  3.278 |  3.486 |
| `patient_mapping_ms` | 100 |   0.002 |  0.001 |  0.001 |  0.002 |  0.003 |  0.008 |  0.009 |
| `session_create_ms` | 100 |   0.007 |  0.001 |  0.005 |  0.007 |  0.010 |  0.013 |  0.013 |
| `total_ms` | 100 |  15.974 | 17.172 | 11.290 | 12.481 | 14.511 | 104.254 | 105.499 |

## Mode 3: VC issuance + verification

- Total measured runs: **100**
- Successes: **100** (100.0%)
- Failures: **0**

| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `vc_create_ms` | 100 |   0.005 |  0.001 |  0.004 |  0.005 |  0.007 |  0.007 |  0.013 |
| `vc_sign_ms` | 100 |   0.567 |  0.074 |  0.513 |  0.549 |  0.743 |  0.879 |  0.931 |
| `vc_verify_ms` | 100 |   2.283 |  0.213 |  2.113 |  2.237 |  2.612 |  3.437 |  3.446 |
| `total_ms` | 100 |   3.181 |  0.331 |  2.954 |  3.092 |  3.624 |  4.684 |  5.293 |

## Mode 1 -- step breakdown

| Step | Mean (ms) | % of total |
|---|--:|--:|
| `keygen_ms` | 0.402 | 0.1% |
| `did_derivation_ms` | 0.043 | 0.0% |
| `did_document_create_ms` | 0.058 | 0.0% |
| `tx_build_ms` | 0.299 | 0.1% |
| `tx_submit_ms` | 316.668 | 99.1% |
| `tx_finality_ms` | 0.000 | 0.0% |
| `object_extract_ms` | 0.003 | 0.0% |
| `local_store_ms` | 1.918 | 0.6% |
| **`total_ms`** | **319.409** | **100.0%** |

## Mode 2 -- step breakdown

| Step | Mean (ms) | % of total |
|---|--:|--:|
| `challenge_create_ms` | 0.018 | 0.1% |
| `sign_challenge_ms` | 0.591 | 3.7% |
| `did_resolve_devnet_ms` | 9.869 | 61.8% |
| `did_object_parse_ms` | 0.001 | 0.0% |
| `signature_verify_ms` | 2.341 | 14.7% |
| `patient_mapping_ms` | 0.002 | 0.0% |
| `session_create_ms` | 0.007 | 0.0% |
| **`total_ms`** | **15.974** | **100.0%** |

## Headline numbers (suggested for the paper)

- **Private-key DID first-time establishment latency** (Mode 1, n=100, includes mandatory Sui Devnet transaction submission + finality): mean = **319.4 ms**, p50 = **313.3 ms**, p95 = **392.5 ms**, p99 = **468.5 ms**, std = **72.3 ms**.
- **Private-key DID challenge-auth latency** (Mode 2, n=100, includes on-chain DID resolution): mean = **16.0 ms**, p50 = **12.5 ms**, p95 = **14.5 ms**, p99 = **104.3 ms**, std = **17.2 ms**.
- **VC issuance+verify latency** (Mode 3, n=100): mean = **3.181 ms**, p99 = **4.684 ms**.

These numbers represent the conventional decentralized-identity baseline against which zkEHR's keyless, blockchain-backed identity model is compared. Mode 1 includes mandatory on-chain DID registration (transaction submit + Sui Devnet finality), so the headline number reflects user-perceived latency for first-time DID establishment.
