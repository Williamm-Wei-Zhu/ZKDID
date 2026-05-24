#!/usr/bin/env python3
"""Analysis of the Private-key DID/VC baseline CSVs (Sui Devnet).

Run after pulling the three CSVs into this folder:
  python3 verification-before-completion/analyze.py
"""
import csv, math, statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ESTAB = ROOT / "private_key_did_establishment_devnet.csv"
AUTH  = ROOT / "private_key_did_auth_devnet.csv"
VC    = ROOT / "private_key_did_vc.csv"
OUT_MD = ROOT / "ANALYSIS.md"

ESTAB_METRICS = [
    "keygen_ms", "did_derivation_ms", "did_document_create_ms",
    "tx_build_ms", "tx_submit_ms", "tx_finality_ms",
    "object_extract_ms", "local_store_ms", "total_ms",
]
AUTH_METRICS = [
    "challenge_create_ms", "sign_challenge_ms", "did_resolve_devnet_ms",
    "did_object_parse_ms", "signature_verify_ms", "patient_mapping_ms",
    "session_create_ms", "total_ms",
]
VC_METRICS = ["vc_create_ms", "vc_sign_ms", "vc_verify_ms", "total_ms"]

def load(path: Path, metrics):
    if not path.exists():
        return []
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            r["success"] = r["success"].lower() == "true"
            for k in metrics:
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

def per_mode(rows, label, metrics):
    out = [f"## {label}", ""]
    n = len(rows)
    ok = [r for r in rows if r["success"]]
    fail = [r for r in rows if not r["success"]]
    out.append(f"- Total measured runs: **{n}**")
    out.append(f"- Successes: **{len(ok)}** ({100.0*len(ok)/n:.1f}%)")
    out.append(f"- Failures: **{len(fail)}**")
    if fail:
        out.append("")
        out.append("First few error messages:")
        for f in fail[:3]:
            out.append(f"  - run_id={f['run_id']}  err=`{f['error_message']}`")
    out.append("")
    out.append("| Metric (ms) |  n |    mean |    std |    min |    p50 |    p95 |    p99 |    max |")
    out.append("|---|--:|--:|--:|--:|--:|--:|--:|--:|")
    for m in metrics:
        s = stats([r[m] for r in ok if isinstance(r.get(m), float)])
        if s is None:
            out.append(f"| `{m}` | 0 | - | - | - | - | - | - | - |")
            continue
        out.append(
            f"| `{m}` | {s['n']:>3} | "
            f"{s['mean']:>7.3f} | {s['std']:>6.3f} | "
            f"{s['min']:>6.3f} | {s['p50']:>6.3f} | "
            f"{s['p95']:>6.3f} | {s['p99']:>6.3f} | {s['max']:>6.3f} |"
        )
    out.append("")
    return "\n".join(out), ok

def breakdown_table(label, ok, metrics, total_key="total_ms"):
    if not ok:
        return ""
    means = {m: statistics.fmean([r[m] for r in ok if isinstance(r.get(m), float)]) for m in metrics}
    total = means[total_key]
    rows = [f"## {label} -- step breakdown", "",
            "| Step | Mean (ms) | % of total |",
            "|---|--:|--:|"]
    for m in metrics:
        if m == total_key: continue
        v = means[m]
        pct = 100.0 * v / total if total > 0 else 0.0
        rows.append(f"| `{m}` | {v:.3f} | {pct:.1f}% |")
    rows.append(f"| **`{total_key}`** | **{total:.3f}** | **100.0%** |")
    rows.append("")
    return "\n".join(rows)

def main():
    estab = load(ESTAB, ESTAB_METRICS)
    auth  = load(AUTH,  AUTH_METRICS)
    vc    = load(VC,    VC_METRICS)

    parts = [
        "# Private-key DID/VC on Sui Devnet -- Analysis Report",
        "",
        f"- Sources: `{ESTAB.name}`, `{AUTH.name}`, `{VC.name}`",
        f"- Captured on EC2 us-east-1; Sui CLI 1.70 + @mysten/sui ^1.45.2",
        f"- Move package: did_registry::did_registry on Sui Devnet",
        f"- Clock: process.hrtime.bigint()",
        "",
    ]
    s1, ok1 = per_mode(estab, "Mode 1: First-time DID establishment (mandatory on-chain)", ESTAB_METRICS)
    s2, ok2 = per_mode(auth,  "Mode 2: DID challenge auth (on-chain DID resolve)", AUTH_METRICS)
    parts.append(s1)
    parts.append(s2)
    if vc:
        s3, ok3 = per_mode(vc, "Mode 3: VC issuance + verification", VC_METRICS)
        parts.append(s3)

    parts.append(breakdown_table("Mode 1", ok1, ESTAB_METRICS))
    parts.append(breakdown_table("Mode 2", ok2, AUTH_METRICS))

    # Headlines for the paper
    parts.append("## Headline numbers (suggested for the paper)")
    parts.append("")
    if ok1:
        s = stats([r["total_ms"] for r in ok1])
        parts.append(
            f"- **Private-key DID first-time establishment latency** (Mode 1, n={s['n']}, "
            f"includes mandatory Sui Devnet transaction submission + finality): "
            f"mean = **{s['mean']:.1f} ms**, p50 = **{s['p50']:.1f} ms**, "
            f"p95 = **{s['p95']:.1f} ms**, p99 = **{s['p99']:.1f} ms**, "
            f"std = **{s['std']:.1f} ms**."
        )
    if ok2:
        s = stats([r["total_ms"] for r in ok2])
        parts.append(
            f"- **Private-key DID challenge-auth latency** (Mode 2, n={s['n']}, "
            f"includes on-chain DID resolution): "
            f"mean = **{s['mean']:.1f} ms**, p50 = **{s['p50']:.1f} ms**, "
            f"p95 = **{s['p95']:.1f} ms**, p99 = **{s['p99']:.1f} ms**, "
            f"std = **{s['std']:.1f} ms**."
        )
    if vc:
        s = stats([r["total_ms"] for r in vc if r["success"]])
        if s:
            parts.append(
                f"- **VC issuance+verify latency** (Mode 3, n={s['n']}): "
                f"mean = **{s['mean']:.3f} ms**, p99 = **{s['p99']:.3f} ms**."
            )
    parts.append("")
    parts.append(
        "These numbers represent the conventional decentralized-identity "
        "baseline against which zkEHR's keyless, blockchain-backed identity "
        "model is compared. Mode 1 includes mandatory on-chain DID "
        "registration (transaction submit + Sui Devnet finality), so the "
        "headline number reflects user-perceived latency for first-time "
        "DID establishment."
    )
    parts.append("")

    OUT_MD.write_text("\n".join(parts))
    print(f"Wrote {OUT_MD}")
    print()
    print("\n".join(parts))

if __name__ == "__main__":
    main()
