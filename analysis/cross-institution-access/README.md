# Analysis — Cross-institution access latency

Generates the cross-institution access-latency figure(s) for the paper. The measured
per-baseline means (n=100) are embedded in the scripts (see the docstring for provenance),
so these run with matplotlib alone.

```bash
python3 plot_cross_institution_latency.py            # main figure
python3 plot_cross_institution_latency_A_dot.py      # alternate layout A
python3 plot_cross_institution_latency_B_panels.py   # alternate layout B
python3 plot_cross_institution_latency_C_linear.py   # alternate layout C
```

**Writes:** `cross_institution_latency*.{pdf,png}`. Source data: the per-run CSVs under
`benchmarks/cross-institution-access/<variant>/results/`.
