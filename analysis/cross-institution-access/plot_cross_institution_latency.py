#!/usr/bin/env python3
"""
Generate the cross-institution access-latency comparison figure for the
zkEHR paper.

Output:
    cross_institution_latency.pdf   (vector, for LaTeX \\includegraphics)
    cross_institution_latency.png   (raster preview)

The figure is laid out for an IEEE double-column figure* environment
(\\textwidth ~= 7.16in). Reduce `figsize` to (3.5, 4.0) and rotate the
x-tick labels less aggressively for single-column placement.

Data source: 100 measured runs per baseline on Sui Devnet via Amazon
EC2 us-east-1, May 2026. See the per-run CSV files under each
experiment's results/ directory.

Run:
    python3 plot_cross_institution_latency.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import LogLocator, NullFormatter, FuncFormatter


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

# Indices of "ours" (zkEHR variants) — used for emphasis
OURS_IDX = [5, 6]


# ---- Figure styling --------------------------------------------------------

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
    "ytick.minor.width": 0.5,
    "pdf.fonttype": 42,   # editable text in PDF
    "ps.fonttype": 42,
})

# Color palette: muted, color-blind-friendly (Tableau 10 subset)
C_GRANT = "#4C72B0"   # blue
C_ACCESS = "#DD8452"  # orange
C_TOTAL = "#55A868"   # green


# ---- Plot ------------------------------------------------------------------

def main() -> None:
    out_dir = Path(__file__).resolve().parent
    n = len(BASELINES)
    x = np.arange(n)
    bar_w = 0.27

    fig, ax = plt.subplots(figsize=(7.16, 3.8))

    bars_g = ax.bar(x - bar_w, GRANT_MS, bar_w, label="Grant phase",
                    color=C_GRANT, edgecolor="black", linewidth=0.4)
    bars_a = ax.bar(x, ACCESS_MS, bar_w, label="Access phase",
                    color=C_ACCESS, edgecolor="black", linewidth=0.4)
    bars_t = ax.bar(x + bar_w, TOTAL_MS, bar_w, label="End-to-end",
                    color=C_TOTAL, edgecolor="black", linewidth=0.4)

    ax.set_yscale("log")
    ax.set_ylim(0.1, 1.5e4)
    ax.set_ylabel("Latency (ms, log scale)")

    # Major ticks at decades; minor ticks at 2,3,...,9 of each decade
    ax.yaxis.set_major_locator(LogLocator(base=10, numticks=6))
    ax.yaxis.set_minor_locator(
        LogLocator(base=10, subs=tuple(np.arange(2, 10) * 0.1), numticks=12)
    )
    ax.yaxis.set_minor_formatter(NullFormatter())
    ax.yaxis.set_major_formatter(FuncFormatter(_fmt_log_label))

    ax.set_xticks(x)
    ax.set_xticklabels(BASELINES)

    # Bold the x-tick labels for our zkEHR rows
    for i in OURS_IDX:
        ax.get_xticklabels()[i].set_fontweight("bold")

    ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.13),
              ncol=3, frameon=False)

    ax.grid(axis="y", which="major", linestyle="-", linewidth=0.35, alpha=0.5)
    ax.grid(axis="y", which="minor", linestyle=":", linewidth=0.25, alpha=0.4)
    ax.set_axisbelow(True)

    # Trim the top and right spines a little for a cleaner look
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

    # Value labels above each bar
    _add_value_labels(ax, bars_g)
    _add_value_labels(ax, bars_a)
    _add_value_labels(ax, bars_t)

    fig.tight_layout()

    out_pdf = out_dir / "cross_institution_latency.pdf"
    out_png = out_dir / "cross_institution_latency.png"
    fig.savefig(out_pdf, bbox_inches="tight")
    fig.savefig(out_png, bbox_inches="tight", dpi=220)
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


def _add_value_labels(ax: plt.Axes, bars) -> None:
    """Place a numeric label above each bar (rotated for density)."""
    for bar in bars:
        h = bar.get_height()
        if h <= 0:
            continue
        # Format: 1 decimal for sub-10ms, integer for >= 100, else 1 decimal
        if h < 10:
            txt = f"{h:.1f}"
        elif h < 100:
            txt = f"{h:.1f}"
        else:
            txt = f"{int(round(h))}"
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            h * 1.07,
            txt,
            ha="center",
            va="bottom",
            fontsize=6.6,
            rotation=90,
            color="#222",
        )


def _fmt_log_label(value: float, _pos: int) -> str:
    """Format major y-tick labels: 0.1, 1, 10, 100, 1k, 10k."""
    if value < 1:
        return f"{value:g}"
    if value < 1000:
        return f"{int(value)}"
    return f"{int(value / 1000)}k"


if __name__ == "__main__":
    main()
