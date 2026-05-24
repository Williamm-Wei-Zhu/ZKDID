#!/usr/bin/env python3
# experiments/paired-analysis.py
# Compares cold_page vs warm_page batches (same op/N/cache, only `warm` flag differs).
# Computes per-metric descriptive stats + non-parametric significance test (Mann-Whitney U).

import csv, glob, statistics, sys
from collections import defaultdict

def load_rows(paths, success_only=True):
    rows = []
    for p in paths:
        with open(p) as f:
            for r in csv.DictReader(f):
                if success_only and r.get("success") != "1":
                    continue
                rows.append(r)
    return rows

def num(s):
    try: return float(s)
    except: return None

def stats(vals):
    vals = [v for v in vals if v is not None]
    if not vals: return None
    sv = sorted(vals)
    pct = lambda q: sv[min(len(sv)-1, int(q*len(sv)))]
    m = statistics.mean(vals)
    return {
        "n": len(vals),
        "mean": m,
        "p50": pct(0.5),
        "p95": pct(0.95),
        "p99": pct(0.99),
        "min": sv[0],
        "max": sv[-1],
        "std": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
    }

def mann_whitney_u(xs, ys):
    """Return (U, z, p two-tailed approx). Handles ties via average rank."""
    n1, n2 = len(xs), len(ys)
    combined = sorted([(v, 0) for v in xs] + [(v, 1) for v in ys])
    ranks = [0]*(n1+n2)
    i = 0
    while i < len(combined):
        j = i
        while j+1 < len(combined) and combined[j+1][0] == combined[i][0]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j+1):
            ranks[k] = avg_rank
        i = j + 1
    r1 = sum(r for r, c in zip(ranks, [c for _,c in combined]) if c == 0)
    u1 = r1 - n1*(n1+1)/2
    u2 = n1*n2 - u1
    U = min(u1, u2)
    # Normal approximation
    mu = n1*n2/2
    sigma = (n1*n2*(n1+n2+1)/12) ** 0.5
    z = (U - mu) / sigma if sigma else 0
    # two-tailed p via error function approx
    import math
    p = math.erfc(abs(z)/math.sqrt(2))
    return U, z, p

# Metrics to compare
METRICS = [
    ("epoch_fetch_ms",       "Sui epoch RPC"),
    ("eph_key_ms",           "Ephemeral key gen"),
    ("gen_params_total_ms",  "Gen params total"),
    ("oauth_rtt_ms",         "OAuth round-trip"),
    ("jwt_parse_ms",         "JWT parse"),
    ("salt_ms",              "Salt derivation"),
    ("nonce_verify_ms",      "Nonce verify"),
    ("prover_ms",            "ZK prover (Mysten)"),
    ("save_account_ms",      "Save account"),
    ("bridge_post_ms",       "Bridge POST"),
    ("derive_all_ms",        "Derive all (salt+prover)"),
    ("backend_submit_ms",    "Backend submit"),
    ("backend_query_chain_ms","Query chain"),
    ("wall_login_ms",        "Wall: click→login toast"),
    ("wall_submit_ms",       "Wall: click→DID toast"),
    ("wall_total_ms",        "Wall: total"),
]

def main():
    cold_files = glob.glob("experiments/results-from-ec2/2026-04-23T02-24-39*.csv")
    warm_files = glob.glob("experiments/results-from-ec2/2026-04-23T02-29-04*.csv")
    cold = load_rows(cold_files)
    warm = load_rows(warm_files)
    print(f"cold rows: {len(cold)}  (tag=cold_page_N3, --warm=false)")
    print(f"warm rows: {len(warm)}  (tag=warm_page_N3, --warm=true)")
    if len(cold) != 30 or len(warm) != 30:
        print(f"WARN: expected 30+30 successful runs")

    print()
    print(f"{'Metric':<28} {'cold_mean':>10} {'cold_p50':>10} {'warm_mean':>10} {'warm_p50':>10} {'Δmean':>8} {'Δ%':>7} {'U':>6} {'p':>8}")
    print("─" * 110)

    for key, label in METRICS:
        xs = [num(r.get(key,"")) for r in cold]
        ys = [num(r.get(key,"")) for r in warm]
        sx = stats(xs); sy = stats(ys)
        if sx is None or sy is None: continue

        cold_v = [v for v in xs if v is not None]
        warm_v = [v for v in ys if v is not None]
        U, z, p = mann_whitney_u(cold_v, warm_v)
        diff = sx["mean"] - sy["mean"]
        diff_pct = (diff / sy["mean"] * 100) if sy["mean"] else 0
        sig = ""
        if p < 0.001: sig = "***"
        elif p < 0.01: sig = "**"
        elif p < 0.05: sig = "*"
        print(f"{label:<28} {sx['mean']:>10.1f} {sx['p50']:>10.1f} {sy['mean']:>10.1f} {sy['p50']:>10.1f} "
              f"{diff:>8.1f} {diff_pct:>6.1f}% {U:>6.0f} {p:>8.4f} {sig}")

    print()
    print("Legend: * p<0.05, ** p<0.01, *** p<0.001 (Mann-Whitney U, two-tailed)")
    print("Δmean = cold.mean - warm.mean; Δ% = relative to warm baseline")

if __name__ == "__main__":
    main()
