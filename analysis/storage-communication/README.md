# Analysis — Storage & communication cost

Generates the storage, gas, and communication-cost comparison figures and the combined
resource-and-cost table. Measured values are embedded in the script, so it runs with
matplotlib alone.

```bash
python3 make_figure.py        # requires matplotlib
```

**Writes:** `storage-comparison.{pdf,png}`, `gas-comparison.{pdf,png}`,
`communication-comparison.{pdf,png}`, and `resource-and-cost.{pdf,tex}`.
