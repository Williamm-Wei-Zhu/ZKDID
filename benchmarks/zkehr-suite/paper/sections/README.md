# Paper Section Bundle (Overleaf-ready)

Two sections covering the n=30 cross-region DID registration measurement,
formatted for direct upload to Overleaf or `\input{}` into a larger paper.

## Files

```
sections/
├── 5_1_timing_distribution.tex            ← Section 5.1
├── 5_2_phase_and_module_analysis.tex      ← Section 5.2 (merged + compressed)
└── README.md                              ← this file

figures/
├── make_figures.py                        ← regenerates all figures from CSV
├── fig_wall_total_cdf.pdf  (and .png)     ← used in 5.1
├── fig_phase_composition.pdf  (and .png)  ← used in 5.2
└── fig_salt_comparison.pdf  (and .png)    ← used in 5.2
```

## How to use in Overleaf

1. **Create a project** (or open existing).
2. **Upload** the `sections/` and `figures/` folders, preserving paths.
3. In your main `.tex`, add to the preamble:
   ```latex
   \usepackage{graphicx}
   \usepackage{booktabs}
   \usepackage{xcolor}
   ```
4. In the body, where you want these sections:
   ```latex
   \input{sections/5_1_timing_distribution}
   \input{sections/5_2_phase_and_module_analysis}
   ```
   The figures reference paths `figures/...`, matching the folder layout.
5. **Optional adjustment**: the sections currently start with `\section{...}`.
   If they should be subsections of a larger "Performance Evaluation"
   chapter, replace `\section` with `\subsection` (and adjust nested
   `\subsection`/`\paragraph` levels accordingly).

## Regenerating figures

```bash
cd experiments/paper/figures
python3 make_figures.py
```

Reads CSVs from `experiments/results-from-ec2/` and the bridge log slice
from `experiments/paper/devstack-log-30run-slice.log`. Writes PDF + PNG.

## Source data

| File | Purpose |
|---|---|
| `2026-04-25T15-15-23-421Z_..._N4_runs30.csv` | headline n=30 measurement |
| `2026-04-25T14-02-08-647Z_..._N3_runs5.csv`  | localhost baseline (Fig.\,salt) |
| `2026-04-25T15-00-21-641Z_..._N3_runs3.csv`  | all cross-region (Fig.\,salt) |
| `devstack-log-30run-slice.log`                | Node-side per-phase timings |
