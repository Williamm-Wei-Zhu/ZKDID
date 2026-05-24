#!/usr/bin/env python3
# experiments/analyze.py — quick descriptive stats over all result CSVs.
# Uses only Python stdlib (csv, statistics) so no pandas needed.
#
# Usage: python3 analyze.py results-from-ec2/*.csv

import csv, sys, statistics, glob, os
from collections import defaultdict

# --- which columns we care about for statistics ---
METRICS = {
    "wall_login_ms":          "Login (click→toast)",
    "wall_submit_ms":         "Submit (click→digest)",
    "wall_total_ms":          "Total wall-clock",
    "epoch_fetch_ms":         "Sui epoch RPC",
    "eph_key_ms":             "Eph key gen",
    "gen_params_total_ms":    "Gen params (total)",
    "salt_ms":                "Salt derivation",
    "prover_ms":              "ZK prover (frontend)",
    "bridge_post_ms":         "POST to bridge",
    "derive_all_ms":          "Derive all (salt+prover)",
    "backend_jwk_precheck_ms":"JWK precheck (backend)",
    "backend_build_sign_ms":  "Build+sign tx",
    "backend_submit_ms":      "Submit tx to Sui",
    "backend_query_chain_ms": "Query tx effects",
    "backend_total_ms":       "Backend total",
    "gas_net_mist":           "Gas net (MIST)",
    "gas_computation_mist":   "Gas: computation",
    "gas_storage_mist":       "Gas: storage",
    "gas_rebate_mist":        "Gas: rebate",
    "object_bcs_bytes":       "Obj storage bytes",
}

def load_rows(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            r = csv.DictReader(f)
            for row in r:
                # parse success
                if row.get("success","") != "1":
                    continue
                rows.append(row)
    return rows

def to_num(s):
    try: return float(s)
    except: return None

def stats_on(values):
    vals = [v for v in values if v is not None]
    if not vals: return None
    sv = sorted(vals)
    def pct(q):
        idx = min(len(sv)-1, int(q*len(sv)))
        return sv[idx]
    return {
        "n": len(vals),
        "mean": statistics.mean(vals),
        "p50": pct(0.5),
        "p95": pct(0.95),
        "p99": pct(0.99),
        "min": sv[0],
        "max": sv[-1],
        "std": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
    }

def fmt(v, unit="ms"):
    if v is None: return "   -  "
    if unit == "MIST":
        return f"{v/1_000_000:.2f}M"
    if unit == "B":
        return f"{int(v)}"
    if v >= 10000:   return f"{v:.0f}"
    if v >= 100:     return f"{v:.0f}"
    if v >= 10:      return f"{v:.1f}"
    return f"{v:.2f}"

def print_stats_table(label, rows, metric_keys=None):
    if metric_keys is None: metric_keys = list(METRICS.keys())
    print(f"\n─── {label} (n={len(rows)}) " + "─"*(60-len(label)))
    print(f"{'Metric':<30} {'mean':>8} {'p50':>8} {'p95':>8} {'p99':>8} {'std':>8}")
    print("─"*80)
    for key in metric_keys:
        if key not in METRICS: continue
        name = METRICS[key]
        s = stats_on([to_num(r.get(key,"")) for r in rows])
        if s is None or s["n"] == 0: continue
        unit = "MIST" if "mist" in key else ("B" if "bytes" in key else "ms")
        print(f"{name:<30} {fmt(s['mean'],unit):>8} {fmt(s['p50'],unit):>8} {fmt(s['p95'],unit):>8} {fmt(s['p99'],unit):>8} {fmt(s['std'],unit):>8}")

def group(rows, keyfn):
    buckets = defaultdict(list)
    for r in rows:
        buckets[keyfn(r)].append(r)
    return buckets

def main(paths):
    rows = load_rows(paths)
    print(f"Loaded {len(rows)} successful rows from {len(paths)} files.")

    # ------- group inventory -------
    cfg_buckets = group(rows, lambda r: (r["op"], r["institutions"], r["cache_mode"]))
    print(f"\nConfigurations present:")
    for (op,n,cache), rs in sorted(cfg_buckets.items(), key=lambda x: (x[0][0], int(x[0][1]), x[0][2])):
        print(f"  op={op:<6} N={n:<2} cache={cache:<4} → {len(rs)} runs")

    # ------- scalability: N=1, 3, 5, 10 cache=none (op=did) -------
    print("\n" + "="*80)
    print("SCALABILITY (op=did, cache=none, varying N institutions)")
    print("="*80)
    scale_keys = ["salt_ms", "prover_ms", "derive_all_ms", "backend_submit_ms", "wall_total_ms", "gas_net_mist"]
    for N in ["1","3","5","10"]:
        key = ("did", N, "none")
        rs = cfg_buckets.get(key, [])
        if rs:
            print_stats_table(f"N={N} cache=none", rs, scale_keys)

    # ------- ablation: cache=all vs cache=none at N=3 (op=did) -------
    print("\n" + "="*80)
    print("ABLATION (op=did, N=3, cache=all vs cache=none)")
    print("="*80)
    ablation_keys = ["salt_ms", "prover_ms", "derive_all_ms", "backend_submit_ms", "wall_total_ms"]
    for cache in ["all","none"]:
        rs = cfg_buckets.get(("did","3",cache), [])
        if rs:
            print_stats_table(f"N=3 cache={cache}", rs, ablation_keys)

    # ------- op type: did vs vc at N=3, cache=all -------
    print("\n" + "="*80)
    print("OP COMPARISON (N=3, cache=all, did vs vc)")
    print("="*80)
    op_keys = ["salt_ms", "prover_ms", "backend_build_sign_ms", "backend_submit_ms", "wall_total_ms", "gas_net_mist", "object_bcs_bytes"]
    for op in ["did","vc","access"]:
        rs = cfg_buckets.get((op,"3","all"), [])
        if rs:
            print_stats_table(f"op={op} N=3 cache=all", rs, op_keys)

    # ------- data quality flags -------
    print("\n" + "="*80)
    print("DATA QUALITY CHECKS")
    print("="*80)
    # 1. backend_prover_request_ms should be 0 (frontend pre-supplied proof)
    backend_prover = [to_num(r.get("backend_prover_request_ms","")) for r in rows]
    n_nonzero = sum(1 for v in backend_prover if v and v > 0)
    print(f"  Backend prover_request_ms = 0 for {len(rows)-n_nonzero}/{len(rows)} runs (frontend reuse working)")
    # 2. gas_net = computation + storage - rebate  (per row)
    gas_ok = 0
    for r in rows:
        c = to_num(r.get("gas_computation_mist",""))
        s = to_num(r.get("gas_storage_mist",""))
        rb= to_num(r.get("gas_rebate_mist",""))
        nr= to_num(r.get("gas_nonrefundable_mist",""))
        n = to_num(r.get("gas_net_mist",""))
        if None in (c,s,rb,n): continue
        # allow ± nonrefundable as tolerance (bridge rollup formula varies)
        expected = c + s - rb
        if abs(expected - n) <= (nr or 0) + 1:
            gas_ok += 1
    print(f"  Gas net check:            {gas_ok}/{len(rows)} rows match `computation + storage - rebate ± nonref`")
    # 3. wall_total ≈ wall_login + wall_submit
    wall_ok = 0
    for r in rows:
        l = to_num(r.get("wall_login_ms",""))
        s = to_num(r.get("wall_submit_ms",""))
        t = to_num(r.get("wall_total_ms",""))
        if None in (l,s,t): continue
        if abs(l+s - t) <= 1000:  # allow 1s overhead slack
            wall_ok += 1
    print(f"  Wall-clock sum check:     {wall_ok}/{len(rows)} rows match `wall_login + wall_submit ≈ wall_total`")
    # 4. tx_status distribution
    statuses = defaultdict(int)
    for r in rows: statuses[r.get("tx_status","(empty)")] += 1
    print(f"  On-chain tx_status:       {dict(statuses)}")
    # 5. Git commit presence
    commits = set(r.get("git_commit","") for r in rows)
    print(f"  git_commit variants:      {commits if len(commits)<=3 else f'{len(commits)} distinct'}")

if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob("results-from-ec2/*.csv"))
    if not paths:
        print("no CSV files found", file=sys.stderr)
        sys.exit(1)
    main(paths)
