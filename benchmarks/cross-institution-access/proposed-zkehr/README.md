# zkEHR (proposed) — cross-institution access benchmark

Measures the proposed zkEHR scheme's cross-institution grant + access latency on Sui DevNet,
in both no-session and session-reuse regimes. A patient (zkLogin) grants access at hospital A;
hospital B exercises that access.

## Layout

- `src/` — TypeScript experiment driver (`index.ts` dispatches subcommands; `hospitalA.ts` /
  `hospitalB.ts` model the two institutions; `*CrossAccess.ts` run the measured flows).
- `results/` — output CSVs:
  - `zkehr_cross_institution_access_results.csv` (session-reuse)
  - `zkehr_cross_institution_access_no_session_results.csv` (no-session)
  - plus run logs and `hospital_dids.json` fixtures.

## Run

Requires Sui DevNet access and OIDC credentials (see the repo-root README "Secrets" section).

```bash
npm install
npm run playwright:install
npm run build
npm run experiment:setup-hospital-dids   # one-time fixture setup
npm run experiment:cross-access           # measured cross-institution access runs
```

Aggregated into the paper figure by
[`analysis/cross-institution-access/`](../../../analysis/cross-institution-access/).
