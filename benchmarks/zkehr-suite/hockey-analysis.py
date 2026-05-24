#!/usr/bin/env python3
# experiments/hockey-analysis.py
# Reads the concurrent-salt CSV and produces the TSC-ready hockey-stick
# summary table + Little's Law verification.

import csv, glob, statistics, sys
from collections import defaultdict

CSV = sys.argv[1] if len(sys.argv) > 1 else glob.glob("experiments/results-from-ec2/concurrent-salt-*T03-24-30*.csv")[0]
print(f"# Input: {CSV}")

# Bucket per-request rows by concurrency level
by_c = defaultdict(list)
per_port_count = defaultdict(lambda: defaultdict(int))  # C -> port -> count
with open(CSV) as f:
    for r in csv.DictReader(f):
        if r["success"] != "1":
            continue
        c = int(r["concurrency"])
        lat = float(r["latency_ms"])
        by_c[c].append(lat)
        per_port_count[c][int(r["port"])] += 1

def pct(sv, q):
    return sv[min(len(sv) - 1, int(q * len(sv)))]

DURATION_S = 30

print(f"\n{'C':>4} {'n':>7} {'throughput(rps)':>16} {'mean(ms)':>10} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>8} {'std':>8}")
print("-" * 90)
rows = []
for c in sorted(by_c.keys()):
    v = sorted(by_c[c])
    n = len(v)
    m = statistics.mean(v)
    s = statistics.pstdev(v) if n > 1 else 0
    throughput = n / DURATION_S
    rows.append(dict(C=c, n=n, throughput=throughput, mean=m, p50=pct(v,0.5), p95=pct(v,0.95), p99=pct(v,0.99), max=v[-1], std=s))
    print(f"{c:>4} {n:>7} {throughput:>16.1f} {m:>10.3f} {pct(v,0.5):>8.2f} {pct(v,0.95):>8.2f} {pct(v,0.99):>8.2f} {v[-1]:>8.2f} {s:>8.2f}")

# ----- Little's Law verification: N ≈ λ × T -----
# N = concurrency (offered load)
# λ = throughput in req/s
# T = mean latency in seconds
# These should all approximately equal for a steady-state system.
print(f"\n=== Little's Law sanity check (N ≈ throughput × latency_mean) ===")
print(f"{'C':>4} {'λ·T':>10} {'ratio (C/λT)':>14} {'interpret':>22}")
for r in rows:
    lt = r["throughput"] * (r["mean"] / 1000)
    ratio = r["C"] / lt if lt else float("inf")
    interp = "linear" if ratio < 1.1 and ratio > 0.9 else "queueing/saturated"
    print(f"{r['C']:>4} {lt:>10.2f} {ratio:>14.3f} {interp:>22}")

# ----- Scaling region analysis -----
print(f"\n=== Scaling region breakdown ===")
t1 = rows[0]["throughput"]
print(f"C=1 baseline throughput = {t1:.0f} rps")
for r in rows[1:]:
    speedup = r["throughput"] / t1
    efficiency = speedup / r["C"] * 100
    saturation_pct = r["throughput"] / max(r2["throughput"] for r2 in rows) * 100
    print(f"C={r['C']:>3}: speedup×{speedup:.2f}   efficiency={efficiency:>5.1f}%   of-peak={saturation_pct:>5.1f}%")

# ----- Per-port load balance (sanity: is the round-robin even?) -----
print(f"\n=== Port-level load balance (C=100, should be roughly even across 10 ports) ===")
counts = per_port_count[100]
total = sum(counts.values())
for p in sorted(counts.keys()):
    share = counts[p] / total * 100
    print(f"  :{p}  {counts[p]:>6} reqs  ({share:>5.2f}%)")

# ----- TSC-ready paragraph data -----
print(f"\n=== Paper paragraph data ===")
peak = max(rows, key=lambda r: r["throughput"])
print(f"peak throughput:        {peak['throughput']:.1f} rps at C={peak['C']}")
print(f"C=1 latency (p50):      {rows[0]['p50']:.2f} ms")
print(f"peak latency (p50):     {peak['p50']:.2f} ms")
print(f"latency blow-up ratio:  {peak['p50']/rows[0]['p50']:.1f}×")
