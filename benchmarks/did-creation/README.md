# Benchmark — DID-creation (identity-establishment) latency

End-to-end latency to establish a patient identity (DID + on-chain credential), measured
apples-to-apples at the Node.js protocol layer for all variants on Sui DevNet.

| Variant | Directory |
|---|---|
| zkEHR (proposed) | `proposed-zkehr/` |
| OIDC-only | `baseline-oidc-only/` |
| zkLogin-only | `baseline-zklogin-only/` |
| Private-key DID/VC | `baseline-private-key-did-vc/` |

Final per-run CSVs live in each variant's `verification-before-completion/` (or `results/`)
directory. Aggregated into the paper figure by
[`analysis/did-creation/analyze_all.py`](../../analysis/did-creation/analyze_all.py).
See each variant's own README for the exact run command.
