# Analysis — Scalability (DID recovery vs. #institutions)

Plots how cost scales with the number of institutions, using the DID-recovery sweeps
(N = 3, 5, 7, 9, 11) from the zkEHR microbenchmark suite.

```bash
python3 plot_salt_scalability.py        # requires matplotlib
```

**Reads:** `benchmarks/zkehr-suite/results-from-ec2/*recovery_N*_runs30.csv`
(path resolves from the repo root, computed from this script's location).
**Writes:** `salt-scalability.{pdf,png}`.
