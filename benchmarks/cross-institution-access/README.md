# Benchmark — Cross-institution access latency

Latency for a patient at one institution to grant access, and for a provider at another
institution to exercise that access, measured on Sui DevNet (100 runs per baseline, EC2
us-east-1). Both no-session and session-reuse regimes are covered for zkLogin/zkEHR.

| Variant | Directory |
|---|---|
| zkEHR (proposed) | `proposed-zkehr/` |
| OIDC-only | `baseline-oidc-only/` |
| zkLogin-only | `baseline-zklogin-only/` |
| Private-key DID/VC | `baseline-private-key-did-vc/` |
| ACTION-EHR-inspired | `baseline-action-ehr/` |

Per-run CSVs live in each variant's `results/`. The paper figure is produced by
[`analysis/cross-institution-access/plot_cross_institution_latency.py`](../../analysis/cross-institution-access/plot_cross_institution_latency.py)
(plus the `_A_dot` / `_B_panels` / `_C_linear` layout variants).
See each variant's own README for the exact run command.
