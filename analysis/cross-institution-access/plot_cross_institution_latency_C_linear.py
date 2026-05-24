#!/usr/bin/env python3
"""
OPTION C -- Fully proportional rendering: single LINEAR y-axis, bars from
zero, no log scale, no axis break. This is the most honest possible bar
chart (bar length is exactly proportional to latency) and it demonstrates
the visualization problem that motivated Options A and B: when data spans
~5 orders of magnitude (0.6 ms .. 3553 ms), the sub-second baselines
collapse into invisible slivers against the ~3500 ms zk* bars.

Output:
    cross_institution_latency_C.pdf
    cross_institution_latency_C.png

Data: 100 measured runs per baseline on Sui Devnet via Amazon EC2
us-east-1, May 2026.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt


BASELINES = [
    "OIDC-only",
    "Private-key\nDID/VC",
    "ACTION-EHR\ninspired",
    "zkLogin-only\n(no-session)",
    "zkLogin-only\n(reuse)",
    "zkEHR\n(no-session)",
    "zkEHR\n(reuse)",
]
GRANT_MS = [255.6, 0.6, 340.8, 3327.1, 294.9, 3364.6, 289.7]
ACCESS_MS = [0.7, 8.4, 171.1, 171.2, 172.0, 188.6, 166.7]
TOTAL_MS = [256.3, 9.1, 514.7, 3498.3, 466.9, 3553.3, 456.5]

# p95 of n=100 measured runs per baseline/phase (computed from the same
# per-run CSVs). Error bars are one-sided (mean -> p95): latency is
# right-skewed, so a symmetric +/- bar would be meaningless.
GRANT_P95 = [297.4, 0.8, 483.8, 3716.4, 394.0, 3788.0, 351.6]
ACCESS_P95 = [0.8, 11.1, 316.6, 262.5, 273.2, 295.5, 277.2]
TOTAL_P95 = [298.2, 11.8, 750.7, 3947.8, 622.2, 4003.7, 590.7]

OURS_IDX = [5, 6]


def _upper_err(means, p95s):
    """Asymmetric error: 0 below the mean, (p95 - mean) above. Clamp at 0
    so float rounding can never produce a negative whisker."""
    lower = [0.0] * len(means)
    upper = [max(0.0, p - m) for m, p in zip(means, p95s)]
    return [lower, upper]

C_GRANT = "#4C72B0"
C_ACCESS = "#DD8452"
C_TOTAL = "#55A868"

plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9,
    "axes.labelsize": 9,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "legend.fontsize": 8.5,
    "axes.linewidth": 0.7,
    "xtick.major.width": 0.7,
    "ytick.major.width": 0.7,
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})


def _fmt(v):
    return f"{v:.1f}" if v < 100 else f"{int(round(v))}"


def _add_labels(ax, bars, p95s, span):
    """Two rotated annotations above each bar:
      * the mean value (closest to the p95 cap), and
      * the p95 value as "(p95, xxx)" stacked above it in a smaller font.

    Both are anchored to the p95 cap in the data direction but offset in
    *points* so the stacking is independent of the y-scale and the rotated
    mean label can never collide with the (centered) error whisker."""
    for bar, p in zip(bars, p95s):
        h = bar.get_height()
        if h <= 0:
            continue
        cx = bar.get_x() + bar.get_width() / 2
        ax.annotate(_fmt(h), xy=(cx, p), xytext=(0, 3),
                    textcoords="offset points", ha="center", va="bottom",
                    fontsize=6.4, rotation=90, color="#222",
                    annotation_clip=False)
        # Mean labels are <=4 chars; at 6.4 pt rotated they occupy ~17 pt of
        # vertical space, so start the p95 line ~22 pt above the cap.
        ax.annotate(f"(p95, {_fmt(p)})", xy=(cx, p), xytext=(0, 22),
                    textcoords="offset points", ha="center", va="bottom",
                    fontsize=5.2, rotation=90, color="#666",
                    annotation_clip=False)


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    n = len(BASELINES)
    x = np.arange(n)
    bar_w = 0.27

    fig, ax = plt.subplots(figsize=(7.16, 3.8))

    err_kw = dict(ecolor="#222", elinewidth=0.8, capsize=2.5, capthick=0.8)
    bg = ax.bar(x - bar_w, GRANT_MS, bar_w, label="Grant phase",
                color=C_GRANT, edgecolor="black", linewidth=0.4,
                yerr=_upper_err(GRANT_MS, GRANT_P95), error_kw=err_kw)
    ba = ax.bar(x, ACCESS_MS, bar_w, label="Access phase",
                color=C_ACCESS, edgecolor="black", linewidth=0.4,
                yerr=_upper_err(ACCESS_MS, ACCESS_P95), error_kw=err_kw)
    bt = ax.bar(x + bar_w, TOTAL_MS, bar_w, label="End-to-end",
                color=C_TOTAL, edgecolor="black", linewidth=0.4,
                yerr=_upper_err(TOTAL_MS, TOTAL_P95), error_kw=err_kw)

    # Headroom must clear the tallest p95 cap plus BOTH stacked rotated
    # labels (mean + "(p95, xxx)") sitting above it.
    ymax = max(max(GRANT_P95), max(ACCESS_P95), max(TOTAL_P95)) * 1.25
    ax.set_ylim(0, ymax)
    ax.set_ylabel("Latency (ms, n=100)")

    _add_labels(ax, bg, GRANT_P95, ymax)
    _add_labels(ax, ba, ACCESS_P95, ymax)
    _add_labels(ax, bt, TOTAL_P95, ymax)

    ax.set_xticks(x)
    ax.set_xticklabels(BASELINES)
    ax.set_xlim(-0.6, n - 0.4)
    for i in OURS_IDX:
        ax.get_xticklabels()[i].set_fontweight("bold")

    ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.13),
              ncol=3, frameon=False)
    ax.grid(axis="y", linestyle="-", linewidth=0.35, alpha=0.45)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

    fig.tight_layout()
    out_pdf = out_dir / "cross_institution_latency_C.pdf"
    out_png = out_dir / "cross_institution_latency_C.png"
    fig.savefig(out_pdf, bbox_inches="tight")
    fig.savefig(out_png, bbox_inches="tight", dpi=500)
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
