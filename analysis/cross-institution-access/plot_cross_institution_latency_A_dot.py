#!/usr/bin/env python3
"""
OPTION A -- Cross-institution access-latency comparison as a grouped
dot/lollipop chart on a logarithmic y-axis.

Why this layout: latency spans ~5 orders of magnitude (0.6 ms .. 3553 ms),
so a log axis is required to keep small values visible. Unlike bars, a
*marker* is read by its position only, so a log axis introduces no
proportionality distortion (bars on a log axis have no honest zero baseline;
markers do not need one). A thin lollipop stem is drawn only as a visual
guide to the x-tick label and is deliberately much thinner than a bar so it
is not mistaken for a length encoding.

Output:
    cross_institution_latency_A.pdf
    cross_institution_latency_A.png

Data: 100 measured runs per baseline on Sui Devnet via Amazon EC2
us-east-1, May 2026.
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

OURS_IDX = [5, 6]

SERIES = [
    ("Grant phase",  GRANT_MS,  "#4C72B0", "o"),
    ("Access phase", ACCESS_MS, "#DD8452", "s"),
    ("End-to-end",   TOTAL_MS,  "#55A868", "D"),
]


# ---- Styling ---------------------------------------------------------------

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
    "pdf.fonttype": 42,
    "ps.fonttype": 42,
})

Y_FLOOR = 0.1   # only a drawing floor for the guide stems; not a data baseline


def _fmt_log_label(value: float, _pos: int) -> str:
    if value < 1:
        return f"{value:g}"
    if value < 1000:
        return f"{int(value)}"
    return f"{int(value / 1000)}k"


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    n = len(BASELINES)
    x = np.arange(n)
    # x-offset for the three phase markers within each baseline group
    offsets = (-0.22, 0.0, 0.22)

    fig, ax = plt.subplots(figsize=(7.16, 3.8))

    for (label, vals, color, marker), dx in zip(SERIES, offsets):
        xs = x + dx
        # Thin guide stem (lollipop) -- clearly not a bar.
        ax.vlines(xs, Y_FLOOR, vals, color=color, linewidth=0.8, alpha=0.35)
        ax.scatter(xs, vals, s=42, color=color, marker=marker,
                   edgecolor="black", linewidth=0.5, label=label, zorder=3)
        # Numeric labels
        for xi, v in zip(xs, vals):
            txt = f"{v:.1f}" if v < 100 else f"{int(round(v))}"
            ax.text(xi, v * 1.18, txt, ha="center", va="bottom",
                    fontsize=6.4, rotation=90, color="#222", zorder=4)

    ax.set_yscale("log")
    ax.set_ylim(Y_FLOOR, 1.5e4)
    ax.set_ylabel("Latency (ms, log scale)")

    ax.yaxis.set_major_locator(LogLocator(base=10, numticks=6))
    ax.yaxis.set_minor_locator(
        LogLocator(base=10, subs=tuple(np.arange(2, 10) * 0.1), numticks=12)
    )
    ax.yaxis.set_minor_formatter(NullFormatter())
    ax.yaxis.set_major_formatter(FuncFormatter(_fmt_log_label))

    ax.set_xticks(x)
    ax.set_xticklabels(BASELINES)
    ax.set_xlim(-0.6, n - 0.4)
    for i in OURS_IDX:
        ax.get_xticklabels()[i].set_fontweight("bold")

    ax.legend(loc="upper center", bbox_to_anchor=(0.5, 1.13),
              ncol=3, frameon=False)

    ax.grid(axis="y", which="major", linestyle="-", linewidth=0.35, alpha=0.5)
    ax.grid(axis="y", which="minor", linestyle=":", linewidth=0.25, alpha=0.4)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)

    fig.tight_layout()
    out_pdf = out_dir / "cross_institution_latency_A.pdf"
    out_png = out_dir / "cross_institution_latency_A.png"
    fig.savefig(out_pdf, bbox_inches="tight")
    fig.savefig(out_png, bbox_inches="tight", dpi=220)
    print(f"wrote {out_pdf}")
    print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
