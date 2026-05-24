#!/usr/bin/env python3
"""
OPTION B -- Cross-institution access-latency comparison as a broken-axis
two-panel grouped bar chart on LINEAR scale.

Why this layout: a single linear axis cannot show both the ~0.6 ms and the
~3553 ms values without one of them becoming unreadable. Splitting the y-axis
into two linearly-scaled panels (a high band for the zk* baselines and a low
band for the fast baselines) keeps bars proportional WITHIN each panel while
still showing the full dynamic range. Diagonal break marks signal the axis
discontinuity. Bars are an honest length-from-zero encoding in each panel.

Output:
    cross_institution_latency_B.pdf
    cross_institution_latency_B.png

Data: 100 measured runs per baseline on Sui Devnet via Amazon EC2
us-east-1, May 2026.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt


# ---- Data (mean of n=100 measured runs per baseline) -----------------------

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

OURS_IDX = [5, 6]

# Panel break: anything above HI_MIN goes in the top panel, the full small
# range (0 .. LO_MAX) is shown proportionally in the bottom panel.
LO_MAX = 600.0      # bottom panel: 0 .. 600 ms (covers all sub-second bars)
HI_MIN = 3000.0     # top panel: 3000 .. 3700 ms (covers the zk* big bars)
HI_MAX = 3700.0

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


def _add_labels(ax, bars):
    """Label only bars whose TOP is visible inside this panel's (already-set)
    y-limits. Must be called AFTER ax.set_ylim()."""
    y0, y1 = ax.get_ylim()
    span = y1 - y0
    for bar in bars:
        h = bar.get_height()
        if h <= 0 or h < y0 or h > y1:
            continue
        txt = f"{h:.1f}" if h < 100 else f"{int(round(h))}"
        ax.text(bar.get_x() + bar.get_width() / 2, h + span * 0.02, txt,
                ha="center", va="bottom", fontsize=6.4, rotation=90,
                color="#222", clip_on=False)


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    n = len(BASELINES)
    x = np.arange(n)
    bar_w = 0.27

    fig, (ax_hi, ax_lo) = plt.subplots(
        2, 1, sharex=True, figsize=(7.16, 4.6),
        gridspec_kw={"height_ratios": [1.0, 1.7], "hspace": 0.08},
    )

    panel_bars = {}
    for ax in (ax_hi, ax_lo):
        bg = ax.bar(x - bar_w, GRANT_MS, bar_w, label="Grant phase",
                    color=C_GRANT, edgecolor="black", linewidth=0.4)
        ba = ax.bar(x, ACCESS_MS, bar_w, label="Access phase",
                    color=C_ACCESS, edgecolor="black", linewidth=0.4)
        bt = ax.bar(x + bar_w, TOTAL_MS, bar_w, label="End-to-end",
                    color=C_TOTAL, edgecolor="black", linewidth=0.4)
        panel_bars[ax] = (bg, ba, bt)

    # Set panel y-ranges FIRST, then label (labels gate on final ylim).
    ax_hi.set_ylim(HI_MIN, HI_MAX)
    ax_lo.set_ylim(0, LO_MAX)
    for ax in (ax_hi, ax_lo):
        for bars in panel_bars[ax]:
            _add_labels(ax, bars)

    # Hide the spines between the two panels
    ax_hi.spines["bottom"].set_visible(False)
    ax_lo.spines["top"].set_visible(False)
    ax_hi.tick_params(bottom=False)
    for side in ("top", "right"):
        ax_hi.spines[side].set_visible(False)
        ax_lo.spines[side].set_visible(False)

    # Diagonal break marks
    d = 0.012
    kw = dict(transform=ax_hi.transAxes, color="black", clip_on=False, linewidth=0.8)
    ax_hi.plot((-d, +d), (-d, +d), **kw)
    ax_hi.plot((1 - d, 1 + d), (-d, +d), **kw)
    kw.update(transform=ax_lo.transAxes)
    yb = 1.0
    ax_lo.plot((-d, +d), (yb - d * 1.7, yb + d * 1.7), **kw)
    ax_lo.plot((1 - d, 1 + d), (yb - d * 1.7, yb + d * 1.7), **kw)

    ax_lo.set_xticks(x)
    ax_lo.set_xticklabels(BASELINES)
    for i in OURS_IDX:
        ax_lo.get_xticklabels()[i].set_fontweight("bold")

    ax_hi.legend(loc="upper center", bbox_to_anchor=(0.5, 1.22),
                 ncol=3, frameon=False)

    for ax in (ax_hi, ax_lo):
        ax.grid(axis="y", linestyle="-", linewidth=0.35, alpha=0.45)
        ax.set_axisbelow(True)

    # Shared y-label centered across both panels (fig.text avoids the
    # tight_layout incompatibility that fig.supylabel triggers with
    # broken-axis subplots).
    fig.text(0.02, 0.55, "Latency (ms, linear scale)", rotation=90,
             va="center", ha="center", fontsize=9)

    fig.subplots_adjust(left=0.11, right=0.985, top=0.88, bottom=0.13,
                        hspace=0.10)
    out_pdf = out_dir / "cross_institution_latency_B.pdf"
    out_png = out_dir / "cross_institution_latency_B.png"
    fig.savefig(out_pdf, bbox_inches="tight")
    fig.savefig(out_png, bbox_inches="tight", dpi=220)
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
