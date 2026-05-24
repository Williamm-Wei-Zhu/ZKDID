# Analysis — DID-creation latency

Aggregates the four DID-creation benchmarks into the paper's identity-establishment figure.

```bash
python3 analyze_all.py        # requires matplotlib
```

**Reads:** `benchmarks/did-creation/<variant>/verification-before-completion/*.csv`
(paths resolve from the repo root, computed from this script's location).
**Writes:** `figures/` and `paper-section/identity_establishment_latency.tex`.
