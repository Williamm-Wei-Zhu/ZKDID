#!/usr/bin/env python3
"""Analysis of the OIDC-only baseline CSVs.

Produces:
  1. Per-mode summary: count, success/failure, mean, std, p50, p95, p99, min, max
     for every latency metric.
  2. Two-mode comparison table suitable for the paper.
  3. Saves a markdown report next to the CSVs.

Run:  python3 verification-before-completion/analyze.py
"""

import csv
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FULL_CSV  = ROOT / "oidc_only_results.csv"
REUSE_CSV = ROOT / "oidc_only_results_reuse.csv"
OUT_MD    = ROOT / "ANALYSIS.md"

METRIC_COLS = [
    "oidc_login_ms",
    "token_exchange_ms",
    "jwks_fetch_or_cache_ms",
    "jwt_verify_ms",
    "claim_validation_ms",
    "session_create_ms",
    "total_ms",
]

def load(path: Path):
    rows = []
    with path.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            r["success"] = r["success"].lower() == "true"
            for k in METRIC_COLS:
                r[k] = float(r[k])
            rows.append(r)
    return rows

def percentile(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    rank = (p / 100.0) * (len(sorted_vals) - 1)
    lo, hi = int(math.floor(rank)), int(math.ceil(rank))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (rank - lo)

def stats(vals):
    if not vals:
        return None
    s = sorted(vals)
    mean = statistics.fmean(s)
    std  = statistics.stdev(s) if len(s) >= 2 else 0.0
    return {
        "n":    len(s),
        "mean": mean,
        "std":  std,
        "min":  s[0],
        "p50":  percentile(s, 50),
        "p95":  percentile(s, 95),
        "p99":  percentile(s, 99),
        "max":  s[-1],
    }

def fmt(x, w=8, decimals=3):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—".rjust(w)
    return f"{x:>{w}.{decimals}f}"

def per_mode_summary(rows, label):
    lines = [f"## {label}", ""]
    n_total   = len(rows)
    successes = [r for r in rows if r["success"]]
    failures  = [r for r in rows if not r["success"]]
    lines.append(f"- Total measured runs: **{n_total}**")
    lines.append(f"- Successes: **{len(successes)}**  ({100.0*len(successes)/n_total:.1f}%)")
    lines.append(f"- Failures:  **{len(failures)}**")
    if failures:
        lines.append("")
        lines.append("First few error messages:")
        for f in failures[:3]:
            lines.append(f"  - run_id={f['run_id']}  err=`{f['error_message']}`")
    lines.append("")
    lines.append(
        "| Metric (ms) |    n |    mean |     std |     min |     p50 |     p95 |     p99 |     max |"
    )
    lines.append(
        "|-------------|-----:|--------:|--------:|--------:|--------:|--------:|--------:|--------:|"
    )
    for col in METRIC_COLS:
        s = stats([r[col] for r in successes])
        if s is None:
            lines.append(f"| {col} | 0 | — | — | — | — | — | — | — |")
            continue
        lines.append(
            f"| `{col}` | {s['n']:>4} | "
            f"{s['mean']:>7.3f} | {s['std']:>7.3f} | "
            f"{s['min']:>7.3f} | {s['p50']:>7.3f} | "
            f"{s['p95']:>7.3f} | {s['p99']:>7.3f} | {s['max']:>7.3f} |"
        )
    lines.append("")
    return "\n".join(lines), successes, failures

def comparison_table(full_ok, reuse_ok):
    lines = ["## Mode 1 vs Mode 2 — head-to-head comparison",
             "",
             "| Metric (ms) | Mode 1 (full login)  mean ± std | Mode 1 p50 / p95 / p99 | Mode 2 (reuse) mean ± std | Mode 2 p50 / p95 / p99 |",
             "|---|---|---|---|---|"]
    for col in METRIC_COLS:
        f = stats([r[col] for r in full_ok])
        u = stats([r[col] for r in reuse_ok])
        if f is None or u is None:
            continue
        lines.append(
            f"| `{col}` | "
            f"{f['mean']:.3f} ± {f['std']:.3f} | "
            f"{f['p50']:.3f} / {f['p95']:.3f} / {f['p99']:.3f} | "
            f"{u['mean']:.3f} ± {u['std']:.3f} | "
            f"{u['p50']:.3f} / {u['p95']:.3f} / {u['p99']:.3f} |"
        )
    lines.append("")
    return "\n".join(lines)

def main():
    full  = load(FULL_CSV)
    reuse = load(REUSE_CSV)

    parts = []
    parts.append("# OIDC-Only Baseline — Analysis Report")
    parts.append("")
    parts.append(f"- Source: `{FULL_CSV.name}` and `{REUSE_CSV.name}`")
    parts.append(f"- Captured on EC2 us-east-1; clock: `process.hrtime.bigint()`")
    parts.append(f"- Provider: Google OIDC (cached SSO via persistent Chromium profile)")
    parts.append(f"- Flow: authorization-code + PKCE; ID token verified via Google JWKS")
    parts.append("")

    s1, full_ok, full_fail   = per_mode_summary(full,  "Mode 1: Full OIDC login (silent SSO)")
    s2, reuse_ok, reuse_fail = per_mode_summary(reuse, "Mode 2: Token / session reuse")
    parts += [s1, s2, comparison_table(full_ok, reuse_ok)]

    # Per-step breakdown of where Mode 1 spends its time, since this is the
    # number reviewers most care about.
    parts.append("## Mode 1 wall-clock breakdown — what dominates the latency?")
    parts.append("")
    if full_ok:
        means = {col: statistics.fmean([r[col] for r in full_ok]) for col in METRIC_COLS}
        total_mean = means["total_ms"]
        breakdown_cols = [
            ("oidc_login_ms",          "Browser navigation + Google silent-SSO redirect"),
            ("token_exchange_ms",      "POST /token (authorization-code -> ID token)"),
            ("jwks_fetch_or_cache_ms", "JWKS fetch or cache hit"),
            ("jwt_verify_ms",          "RSA signature verification"),
            ("claim_validation_ms",    "iss/aud/exp/nonce/sub validation"),
            ("session_create_ms",      "Local EHR session object construction"),
        ]
        parts.append("| Step | Mean (ms) | % of total |")
        parts.append("|---|---:|---:|")
        for col, desc in breakdown_cols:
            v = means[col]
            pct = 100.0 * v / total_mean if total_mean > 0 else 0.0
            parts.append(f"| {desc} (`{col}`) | {v:.3f} | {pct:.1f}% |")
        parts.append(f"| **Total (`total_ms`)** | **{total_mean:.3f}** | **100.0%** |")
        parts.append("")

    # Headline numbers for the paper abstract.
    parts.append("## Headline numbers (suggested for the paper)")
    parts.append("")
    if full_ok:
        f = stats([r["total_ms"] for r in full_ok])
        parts.append(
            f"- **OIDC silent-SSO identity-establishment latency** (Mode 1, n={f['n']}): "
            f"mean = **{f['mean']:.1f} ms**, p50 = **{f['p50']:.1f} ms**, "
            f"p95 = **{f['p95']:.1f} ms**, p99 = **{f['p99']:.1f} ms**, "
            f"std = **{f['std']:.1f} ms**."
        )
    if reuse_ok:
        u = stats([r["total_ms"] for r in reuse_ok])
        parts.append(
            f"- **OIDC token-reuse identity-establishment latency** (Mode 2, n={u['n']}): "
            f"mean = **{u['mean']:.3f} ms**, p50 = **{u['p50']:.3f} ms**, "
            f"p95 = **{u['p95']:.3f} ms**, p99 = **{u['p99']:.3f} ms**, "
            f"std = **{u['std']:.3f} ms**."
        )
    parts.append("")
    parts.append(
        "These are the *lower-bound federated baselines* against which the zkEHR "
        "pipeline (DID + VC + blockchain + zkLogin + multi-authority salt) is "
        "compared. Any zkEHR overhead is the marginal cost of the privacy and "
        "decentralization properties the OIDC-only baseline does not provide."
    )
    parts.append("")

    OUT_MD.write_text("\n".join(parts))
    print(f"Wrote {OUT_MD}")
    # Also dump to stdout so the user sees the headline numbers immediately.
    print()
    print("\n".join(parts))

if __name__ == "__main__":
    main()
