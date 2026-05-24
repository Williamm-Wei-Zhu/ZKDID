# 30-run cross-region DID Registration Data Bundle

Captured 2026-04-25, all timing data for the 5.X / 5.Y paper sections.

## Test setup

- **Browser**: Chromium 131 / Playwright headless on AWS EC2 us-east-1 (`3.82.158.42`)
- **Salt-services** (4 institutions, real public network):
  - Institution 1 → `http://localhost:7001` (us-east-1, hairpin)
  - Institution 2 → `http://ec2-18-145-170-146.us-west-1.compute.amazonaws.com:7000`
  - Institution 3 → `http://ec2-54-219-178-124.us-west-1.compute.amazonaws.com:7000`
  - Institution 4 → `http://ec2-54-193-85-165.us-west-1.compute.amazonaws.com:7000`
- **Prover**: `https://prover-dev.mystenlabs.com/v1` (browser → Mysten direct)
- **Chain**: Sui DevNet
- **Per-run state**: `--cache=none --warm=false`, all caches wiped before batch
- **Sample size**: n = 30 (all successful, 30 distinct on-chain DIDs)

## Files in this bundle

| File | Purpose |
|---|---|
| `2026-04-25T15-15-23-421Z_op-did_N4_cache-none_runs30_breakdown.txt` | **Per-run + summary detail** (30 trials × 18 phases each) |
| `devstack-log-30run-slice.log` | Bridge stdout slice — Node-side per-phase timings (`6.x` lines) |
| `2026-04-25T14-02-08-647Z_..._runs5_breakdown.txt` | Baseline: 3 inst all-localhost (Table 5 row a) |
| `2026-04-25T15-00-21-641Z_..._runs3_breakdown.txt` | Earlier: 3 inst all-cross-region (Table 5 row b) |
| `2026-04-25T15-12-04-847Z_..._runs1_breakdown.txt` | Earlier: 4 inst smoke (n=1, cold-start case) |

CSV files live in `../results-from-ec2/` (synced via rsync from EC2).

## Headline results (this batch, n=30)

| Metric | mean | sd | CV(%) | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **wall_total_ms** | 5769 | 737 | 12.8 | 5782 | 5904 | 9253 | 5270 | 9253 |
| **wall_login_ms** | 3871 | 113 | 2.9 | 3896 | 3956 | 3977 | 3431 | 3977 |
| **wall_submit_ms** | 1894 | 750 | 39.6 | 1934 | 1992 | 5426 | 1372 | 5426 |
| salt_ms (4-inst parallel) | 187 | 5 | 2.7 | 187 | 192 | 195 | 182 | 195 |
| oauth_rtt_ms | 639 | 38 | 5.9 | 642 | 681 | 713 | 574 | 713 |
| prover_ms | 2615 | 95 | 3.6 | 2679 | 2733 | 2749 | 2455 | 2749 |
| backend.JWK_precheck | 91 | 12 | 13.2 | 90 | 96 | 133 | 75 | 133 |
| backend.build_sign | 43 | 4 | 9.3 | 43 | 48 | 50 | 36 | 50 |
| backend.submit_tx | 369 | 718 | 194.6 | 231 | 383 | 4038 | 151 | 4038 |
| gas_net_mist | 10836680 | 0 | 0.0 | — | — | — | — | — |

## Outliers

- **Run 12**: wall_submit = 5426 ms, wall_total = 9253 ms.
  Diagnosis: `backend.submit_tx_and_return = 4038 ms` (vs typical ~240 ms);
  Sui DevNet finality long tail. Drop for analysis or report as p99 only.
