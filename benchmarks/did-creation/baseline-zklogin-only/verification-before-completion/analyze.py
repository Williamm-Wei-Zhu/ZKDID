#!/usr/bin/env python3
"""Analysis of the zkLogin-only baseline CSV.

Run after pulling the CSV into this folder:
  python3 verification-before-completion/analyze.py
"""
import csv, math, statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EST = ROOT / "zklogin_establish_devnet.csv"
OUT_MD = ROOT / "ANALYSIS.md"

METRICS = [
    "ephemeral_keygen_ms", "epoch_fetch_ms", "randomness_ms", "nonce_compute_ms",
    "oidc_login_ms", "jwt_decode_ms",
    "salt_fetch_ms",
    "address_compute_ms", "prover_request_ms",
    "tx_build_ms", "zklogin_sig_assemble_ms", "tx_submit_ms", "object_extract_ms",
    "total_ms",
]

PHASE_A = ["ephemeral_keygen_ms", "epoch_fetch_ms", "randomness_ms", "nonce_compute_ms"]
PHASE_B = ["oidc_login_ms", "jwt_decode_ms"]
PHASE_C = ["salt_fetch_ms"]
PHASE_D = ["address_compute_ms", "prover_request_ms"]
PHASE_E = ["tx_build_ms", "zklogin_sig_assemble_ms", "tx_submit_ms", "object_extract_ms"]

def load(path: Path):
    if not path.exists(): return []
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            r["success"] = r["success"].lower() == "true"
            for k in METRICS:
                if k in r and r[k] != "":
                    r[k] = float(r[k])
            rows.append(r)
    return rows

def percentile(s, p):
    if not s: return float("nan")
    if len(s) == 1: return s[0]
    rank = (p / 100) * (len(s) - 1)
    lo, hi = int(math.floor(rank)), int(math.ceil(rank))
    if lo == hi: return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (rank - lo)

def stats(vals):
    if not vals: return None
    s = sorted(vals)
    mean = statistics.fmean(s)
    std = statistics.stdev(s) if len(s) >= 2 else 0.0
    return dict(n=len(s), mean=mean, std=std, min=s[0],
                p50=percentile(s, 50), p95=percentile(s, 95),
                p99=percentile(s, 99), max=s[-1])

def main():
    rows = load(EST)
    if not rows:
        print(f"No data in {EST}"); return

    parts = [
        "# zkLogin-only End-to-End Identity-Establishment -- Analysis Report",
        "",
        f"- Source: `{EST.name}`",
        f"- Captured on EC2 us-east-1; Sui CLI 1.70 + @mysten/sui ^1.45.2",
        f"- OIDC: Google (silent SSO via persistent profile)",
        f"- Prover: https://prover-dev.mystenlabs.com/v1",
        f"- Move package: did_registry::did_registry on Sui Devnet",
        f"- Submission: WaitForEffectsCert (matches zkEHR's submission semantics)",
        f"- Sponsored tx: zkLogin user pays no gas; gas sponsor co-signs",
        "",
    ]
    n = len(rows)
    ok = [r for r in rows if r["success"]]
    fail = [r for r in rows if not r["success"]]
    parts.append(f"## Run summary")
    parts.append(f"- Total measured runs: **{n}**")
    parts.append(f"- Successes: **{len(ok)}** ({100.0*len(ok)/n:.1f}%)")
    parts.append(f"- Failures: **{len(fail)}**")
    if fail:
        parts.append("")
        parts.append("First few error messages:")
        for f in fail[:3]:
            parts.append(f"  - run_id={f['run_id']}  err=`{f['error_message'][:200]}`")
    parts.append("")

    parts.append("## Per-step timings")
    parts.append("")
    parts.append("| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |")
    parts.append("|---|--:|--:|--:|--:|--:|--:|--:|--:|")
    for m in METRICS:
        s = stats([r[m] for r in ok if isinstance(r.get(m), float)])
        if s is None:
            parts.append(f"| `{m}` | 0 | - | - | - | - | - | - | - |")
            continue
        parts.append(
            f"| `{m}` | {s['n']:>3} | "
            f"{s['mean']:>7.3f} | {s['std']:>6.3f} | "
            f"{s['min']:>6.3f} | {s['p50']:>6.3f} | "
            f"{s['p95']:>6.3f} | {s['p99']:>6.3f} | {s['max']:>6.3f} |"
        )
    parts.append("")

    if ok:
        means = {m: statistics.fmean([r[m] for r in ok if isinstance(r.get(m), float)]) for m in METRICS}
        total = means["total_ms"]
        def section(label, keys):
            sub = sum(means[k] for k in keys)
            return f"| **{label}** | **{sub:.3f}** | **{100.0*sub/total:.1f}%** |", sub
        parts.append("## Phase breakdown")
        parts.append("")
        parts.append("| Phase / step | Mean (ms) | % of total |")
        parts.append("|---|--:|--:|")
        # Phase A
        line, _ = section("Phase A: pre-OAuth setup", PHASE_A)
        parts.append(line)
        for k in PHASE_A:
            parts.append(f"|   `{k}` | {means[k]:.3f} | {100.0*means[k]/total:.2f}% |")
        # Phase B
        line, _ = section("Phase B: OIDC login", PHASE_B)
        parts.append(line)
        for k in PHASE_B:
            parts.append(f"|   `{k}` | {means[k]:.3f} | {100.0*means[k]/total:.2f}% |")
        # Phase C
        line, _ = section("Phase C: salt", PHASE_C)
        parts.append(line)
        for k in PHASE_C:
            parts.append(f"|   `{k}` | {means[k]:.3f} | {100.0*means[k]/total:.2f}% |")
        # Phase D
        line, _ = section("Phase D: zkLogin proof + address", PHASE_D)
        parts.append(line)
        for k in PHASE_D:
            parts.append(f"|   `{k}` | {means[k]:.3f} | {100.0*means[k]/total:.2f}% |")
        # Phase E
        line, _ = section("Phase E: on-chain registration", PHASE_E)
        parts.append(line)
        for k in PHASE_E:
            parts.append(f"|   `{k}` | {means[k]:.3f} | {100.0*means[k]/total:.2f}% |")
        parts.append(f"| **Total** | **{total:.3f}** | **100.0%** |")
        parts.append("")

    parts.append("## Headline numbers (suggested for the paper)")
    parts.append("")
    if ok:
        s = stats([r["total_ms"] for r in ok])
        parts.append(
            f"- **zkLogin end-to-end identity-establishment latency** (n={s['n']}, "
            f"includes Google OIDC silent-SSO, single-authority salt, Mysten Labs "
            f"devnet prover, sponsored Sui transaction with WaitForEffectsCert): "
            f"mean = **{s['mean']:.1f} ms**, p50 = **{s['p50']:.1f} ms**, "
            f"p95 = **{s['p95']:.1f} ms**, p99 = **{s['p99']:.1f} ms**, "
            f"std = **{s['std']:.1f} ms**."
        )
        # Identify dominant phase
        s_prov = stats([r["prover_request_ms"] for r in ok])
        s_oidc = stats([r["oidc_login_ms"] for r in ok])
        s_tx   = stats([r["tx_submit_ms"] for r in ok])
        parts.append(
            f"- Mysten zkLogin prover dominates at "
            f"**{s_prov['mean']:.0f} ± {s_prov['std']:.0f} ms** "
            f"({100.0*s_prov['mean']/s['mean']:.0f}% of total). "
            f"OIDC silent-SSO is **{s_oidc['mean']:.0f} ms** "
            f"({100.0*s_oidc['mean']/s['mean']:.0f}%). "
            f"Sui WaitForEffectsCert tx submit is **{s_tx['mean']:.0f} ms** "
            f"({100.0*s_tx['mean']/s['mean']:.0f}%)."
        )
    parts.append("")
    parts.append(
        "These numbers represent the conventional zkLogin baseline against "
        "which zkEHR's keyless, multi-authority-salt identity establishment "
        "is compared. The zkLogin proof step is the immovable cost of any "
        "zk-anchored OIDC binding; zkEHR cannot avoid it but may amortize it."
    )
    parts.append("")

    OUT_MD.write_text("\n".join(parts))
    print(f"Wrote {OUT_MD}")
    print()
    print("\n".join(parts))

if __name__ == "__main__":
    main()
