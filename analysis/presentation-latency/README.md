# Analysis — Credential-presentation latency

Builds the cold-start presentation-latency comparison figure (patient-side vs. hospital-side
cost per scheme, log x-axis, mean→p95 whiskers).

```bash
python3 make_figure.py        # requires matplotlib, numpy
```

**Reads:** `benchmarks/presentation-latency/<variant>/results/*.csv`
(paths resolve from the repo root, computed from this script's location).
**Writes:** `presentation-latency-comparison.{pdf,png,tex}`.
