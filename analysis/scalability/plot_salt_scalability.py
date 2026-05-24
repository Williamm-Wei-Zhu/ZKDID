#!/usr/bin/env python3
"""
Multi-authority salt scalability figure.

Question answered: as the number of salt-contributing institutions N grows,
how does (a) the multi-authority salt fan-out cost and (b) the end-to-end
DID-recovery latency scale?

Data: benchmarks/zkehr-suite/results-from-ec2/*recovery_N{3,5,7,9,11}_runs30.csv
  - DID *recovery* runs (op=did, mode=recovery), cache_mode=none, n=30 per N.
  - Recovery is the correct vehicle for the multi-salt scalability claim:
    it exercises client-side circomlibjs Poseidon per institution with no
    server assistance, so salt cost is observable above the noise floor
    (in first-time establishment the 2.86 s ZK prover masks it entirely).
  - `salt_ms`        : client-side multi-authority salt reconstruction + merge
  - `wall_total_ms`  : end-to-end recovery wall clock

Conventions match the other paper figures: serif font, linear (proportional)
axes, mean markers with one-sided mean->p95 error bars (latency is
right-skewed), "(p95, xxx)" annotations, legend inside the axes.

Outputs:
    salt-scalability.pdf
    salt-scalability.png
"""

from __future__ import annotations

import csv
import glob
import re
import statistics
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[2]
GLOB = "benchmarks/zkehr-suite/results-from-ec2/*recovery_N*_runs30.csv"

plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9,
    "axes.labelsize": 9,
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "legend.fontsize": 8.5,
    "axes.linewidth": 0.7,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})

C_SALT = "#9467bd"   # purple — matches the "Salt" phase colour used elsewhere
C_WALL = "#2ca02c"   # green  — end-to-end


def load() -> tuple[list[int], dict]:
    files = sorted(
        glob.glob(str(REPO_ROOT / GLOB)),
        key=lambda f: int(re.search(r"_N(\d+)_", f).group(1)),
    )
    if not files:
        raise SystemExit(f"No recovery N-series CSVs found under {GLOB}")
    Ns, salt_mean, salt_p95, wall_mean, wall_p95, n = [], [], [], [], [], []
    for f in files:
        N = int(re.search(r"_N(\d+)_", f).group(1))
        rows = [
            r for r in csv.DictReader(open(f))
            if str(r.get("success", "")).strip() in ("1", "true", "True")
        ]
        s = [float(r["salt_ms"]) for r in rows]
        w = [float(r["wall_total_ms"]) for r in rows]
        Ns.append(N)
        salt_mean.append(statistics.fmean(s))
        salt_p95.append(float(np.percentile(s, 95)))
        wall_mean.append(statistics.fmean(w))
        wall_p95.append(float(np.percentile(w, 95)))
        n.append(len(rows))
    assert len(set(n)) == 1, f"uneven sample sizes: {n}"
    return Ns, dict(
        salt_mean=salt_mean, salt_p95=salt_p95,
        wall_mean=wall_mean, wall_p95=wall_p95, n=n[0],
    )


def main() -> None:
    Ns, d = load()
    x = np.array(Ns)

    fig, ax_l = plt.subplots(figsize=(7.0, 3.5))
    ax_r = ax_l.twinx()

    # --- left axis: multi-authority salt fan-out (the part that scales) ---
    salt_err = np.array([
        [0.0] * len(Ns),
        [max(0.0, p - m) for m, p in zip(d["salt_mean"], d["salt_p95"])],
    ])
    ax_l.errorbar(
        x, d["salt_mean"], yerr=salt_err, fmt="o-", color=C_SALT,
        ecolor="#222", elinewidth=0.8, capsize=2.5, capthick=0.8,
        markersize=5, linewidth=1.4, label="Multi-authority salt fan-out",
        zorder=3,
    )
    for xi, m, p in zip(x, d["salt_mean"], d["salt_p95"]):
        ax_l.annotate(f"{m:.0f}", xy=(xi, p), xytext=(0, 4),
                      textcoords="offset points", ha="center", va="bottom",
                      fontsize=7.0, color="#222", annotation_clip=False)
        ax_l.annotate(f"(p95, {p:.0f})", xy=(xi, p), xytext=(0, 15),
                      textcoords="offset points", ha="center", va="bottom",
                      fontsize=5.6, color="#666", annotation_clip=False)
    ax_l.set_xlabel("Number of salt-contributing institutions, $N$")
    ax_l.set_ylabel("Salt fan-out latency (ms)", color=C_SALT)
    ax_l.tick_params(axis="y", labelcolor=C_SALT)
    ax_l.set_ylim(0, max(d["salt_p95"]) * 1.55)
    ax_l.set_xticks(Ns)
    ax_l.set_xlim(min(Ns) - 0.8, max(Ns) + 0.8)
    ax_l.grid(axis="y", linestyle=":", alpha=0.35)
    ax_l.set_axisbelow(True)

    # --- right axis: end-to-end recovery (shown to be ~N-invariant) ---
    wall_err = np.array([
        [0.0] * len(Ns),
        [max(0.0, p - m) for m, p in zip(d["wall_mean"], d["wall_p95"])],
    ])
    ax_r.errorbar(
        x, d["wall_mean"], yerr=wall_err, fmt="s--", color=C_WALL,
        ecolor=C_WALL, elinewidth=0.9, capsize=3.0, capthick=0.9,
        markersize=4.5, linewidth=1.3,
        label="End-to-end DID recovery", zorder=2,
    )
    # Green-series labels go BELOW the markers (purple labels go above), and
    # are coloured green so the reader binds them to the right-hand axis.
    for xi, m, p in zip(x, d["wall_mean"], d["wall_p95"]):
        ax_r.annotate(f"{m:.0f}", xy=(xi, m), xytext=(0, -6),
                      textcoords="offset points", ha="center", va="top",
                      fontsize=7.0, color="#1b6b1b", annotation_clip=False)
        ax_r.annotate(f"(p95, {p:.0f})", xy=(xi, m), xytext=(0, -16),
                      textcoords="offset points", ha="center", va="top",
                      fontsize=5.6, color="#4a9a4a", annotation_clip=False)
    ax_r.set_ylabel("End-to-end recovery latency (ms)", color=C_WALL)
    ax_r.tick_params(axis="y", labelcolor=C_WALL)
    # Generous, zero-based range so the flat line reads as flat (not noise)
    # and leaves room below the line for the green p95 labels.
    ax_r.set_ylim(0, max(d["wall_p95"]) * 1.30)

    # Single combined legend, inside, upper-centre over empty space.
    h_l, lab_l = ax_l.get_legend_handles_labels()
    h_r, lab_r = ax_r.get_legend_handles_labels()
    ax_l.legend(
        h_l + h_r, lab_l + lab_r, loc="upper center",
        frameon=True, framealpha=0.92, borderpad=0.4,
        labelspacing=0.3, handlelength=2.0, ncol=1,
    )

    ax_l.set_title(
        f"Multi-authority salt scalability "
        f"(DID recovery, $n={d['n']}$ per $N$)",
        fontsize=9.5,
    )
    for side in ("top",):
        ax_l.spines[side].set_visible(False)
        ax_r.spines[side].set_visible(False)

    fig.tight_layout()
    out = Path(__file__).resolve().parent
    fig.savefig(out / "salt-scalability.pdf", bbox_inches="tight")
    fig.savefig(out / "salt-scalability.png", dpi=220, bbox_inches="tight")
    print("data:")
    for i, N in enumerate(Ns):
        print(f"  N={N:2d}  salt mean={d['salt_mean'][i]:7.2f}  "
              f"p95={d['salt_p95'][i]:6.2f}  ||  wall mean={d['wall_mean'][i]:7.1f}  "
              f"p95={d['wall_p95'][i]:7.1f}")
    print(f"\nwrote {out/'salt-scalability.pdf'}")
    print(f"wrote {out/'salt-scalability.png'}")


if __name__ == "__main__":
    main()
