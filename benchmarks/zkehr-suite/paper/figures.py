"""
Publication-quality matplotlib figures for the TSC Performance section.

Each figure:
  * saved to experiments/paper/figures/ as BOTH pdf (for LaTeX inclusion)
    and png (for quick preview)
  * sized for a double-column IEEE layout (7 x H inches)
  * uses consistent color palette and sans-serif fonts

Run: python3 experiments/paper/figures.py
"""

import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

from data_loader import (
    load_e2e, load_hockey_salt, load_hockey_prover, load_poseidon_bench,
    summarize,
)

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(_HERE, "figures")
os.makedirs(OUT, exist_ok=True)

# ---- global style ----
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["DejaVu Sans", "Helvetica", "Arial"],
    "font.size": 10,
    "axes.titlesize": 11,
    "axes.labelsize": 10,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "legend.fontsize": 9,
    "axes.grid": True,
    "grid.alpha": 0.3,
    "grid.linestyle": "--",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "savefig.bbox": "tight",
    "savefig.dpi": 150,
})

# Consistent color palette (colorblind-safe)
COLORS = {
    "frontend":  "#1f77b4",
    "backend":   "#ff7f0e",
    "onchain":   "#2ca02c",
    "cache_all": "#d62728",
    "cache_none":"#9467bd",
    "cold":      "#8c564b",
    "warm":      "#17becf",
    "salt":      "#bcbd22",
    "prover":    "#e377c2",
}


def savefig(fig, name):
    pdf = os.path.join(OUT, f"{name}.pdf")
    png = os.path.join(OUT, f"{name}.png")
    fig.savefig(pdf)
    fig.savefig(png)
    plt.close(fig)
    print(f"  ✓ {name}.{{pdf,png}}")


# =====================================================================
# Fig 1 — Per-phase E2E latency, stacked horizontal bar (op=did N=3 cache=all)
# =====================================================================
def fig1_stacked_latency():
    df = load_e2e()
    sub = df[(df["op"] == "did") & (df["institutions"] == 3) & (df["cache_mode"] == "all")]

    phases = [
        ("epoch_fetch_ms",        "Epoch RPC",        COLORS["frontend"]),
        ("gen_params_total_ms",   "Gen params",       COLORS["frontend"]),
        ("oauth_rtt_ms",          "OAuth RTT",        COLORS["frontend"]),
        ("salt_ms",               "Salt derive",      COLORS["frontend"]),
        ("prover_ms",             "ZK prover",        COLORS["frontend"]),
        ("bridge_post_ms",        "Post to bridge",   COLORS["frontend"]),
        ("backend_jwk_precheck_ms","JWK precheck",    COLORS["backend"]),
        ("backend_build_sign_ms", "Build+sign tx",    COLORS["backend"]),
        ("backend_submit_ms",     "Submit tx (Sui)",  COLORS["onchain"]),
        ("backend_query_chain_ms","Query chain",      COLORS["onchain"]),
    ]
    means = [sub[c].mean() for c, _, _ in phases]
    labels = [l for _, l, _ in phases]
    colors = [c for _, _, c in phases]

    fig, ax = plt.subplots(figsize=(7, 2.5))
    left = 0
    for val, lab, col in zip(means, labels, colors):
        ax.barh(0, val, left=left, color=col, edgecolor="white", linewidth=0.5)
        if val > 100:
            ax.text(left + val/2, 0, f"{lab}\n{val:.0f} ms",
                    ha="center", va="center", fontsize=8, color="white", fontweight="bold")
        left += val

    ax.set_xlim(0, left * 1.02)
    ax.set_ylim(-0.5, 0.5)
    ax.set_yticks([])
    ax.set_xlabel("Wall-clock time (ms)")
    ax.set_title(f"End-to-end latency breakdown (op=did, N=3, cache=all, n={len(sub)})")
    ax.grid(axis="x", alpha=0.3)

    # Legend by layer
    legend_handles = [
        Patch(color=COLORS["frontend"], label="Browser (pre-OAuth + post-OAuth)"),
        Patch(color=COLORS["backend"],  label="Backend (bridge-spawned child)"),
        Patch(color=COLORS["onchain"],  label="On-chain (Sui DevNet)"),
    ]
    ax.legend(handles=legend_handles, loc="upper right", ncol=1, frameon=True, fancybox=False)
    savefig(fig, "fig1_stacked_latency")


# =====================================================================
# Fig 2 — CDF of wall_total_ms across all successful op=did runs
# =====================================================================
def fig2_e2e_cdf():
    df = load_e2e()
    fig, ax = plt.subplots(figsize=(5, 3.2))

    groups = [
        (("did", 3, "all"),  "op=did, cache=all (n=%d)",   COLORS["cache_all"]),
        (("did", 3, "none"), "op=did, cache=none (n=%d)",  COLORS["cache_none"]),
        (("vc",  3, "all"),  "op=vc, cache=all (n=%d)",    COLORS["backend"]),
        (("access",3,"all"), "op=access, cache=all (n=%d)",COLORS["onchain"]),
    ]
    for (op, n, cm), label_tmpl, col in groups:
        sub = df[(df["op"] == op) & (df["institutions"] == n) & (df["cache_mode"] == cm)]
        if len(sub) == 0:
            continue
        vals = sub["wall_total_ms"].dropna().sort_values().values
        y = np.arange(1, len(vals) + 1) / len(vals)
        ax.plot(vals, y, label=label_tmpl % len(sub), color=col, linewidth=1.5)

    ax.set_xlabel("End-to-end wall-clock time (ms)")
    ax.set_ylabel("Cumulative fraction of runs")
    ax.set_title("CDF of end-to-end latency across operations")
    ax.legend(loc="lower right", frameon=True)
    ax.set_xlim(5000, 10000)
    ax.axvline(6000, color="gray", linestyle=":", alpha=0.6, linewidth=0.8)
    ax.text(6020, 0.05, "6 s", fontsize=8, color="gray")
    savefig(fig, "fig2_e2e_cdf")


# =====================================================================
# Fig 3 — Scalability: salt_ms and wall_total_ms vs N institutions
# =====================================================================
def fig3_scalability():
    df = load_e2e()
    Ns = [1, 3, 5, 10]
    mean_salt, p95_salt = [], []
    mean_wall, p95_wall = [], []
    n_per_N = []
    for N in Ns:
        sub = df[(df["op"] == "did") & (df["institutions"] == N) & (df["cache_mode"] == "none")]
        n_per_N.append(len(sub))
        mean_salt.append(sub["salt_ms"].mean())
        p95_salt.append(sub["salt_ms"].quantile(0.95))
        mean_wall.append(sub["wall_total_ms"].mean())
        p95_wall.append(sub["wall_total_ms"].quantile(0.95))

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(7, 2.8))

    ax1.plot(Ns, mean_salt, "o-", color=COLORS["salt"], label="mean", linewidth=2, markersize=7)
    ax1.plot(Ns, p95_salt,  "s--", color=COLORS["salt"], label="p95", linewidth=1, markersize=5, alpha=0.6)
    ax1.set_xlabel("# Institutions (N)")
    ax1.set_ylabel("Salt derivation latency (ms)")
    ax1.set_title("(a) Salt derivation vs institution count")
    ax1.set_xticks(Ns)
    ax1.legend(loc="upper left", frameon=True)

    ax2.plot(Ns, mean_wall, "o-", color=COLORS["prover"], label="mean", linewidth=2, markersize=7)
    ax2.plot(Ns, p95_wall,  "s--", color=COLORS["prover"], label="p95", linewidth=1, markersize=5, alpha=0.6)
    for i, N in enumerate(Ns):
        ax2.annotate(f"n={n_per_N[i]}", (N, mean_wall[i]),
                     textcoords="offset points", xytext=(0, -14),
                     ha="center", fontsize=7, color="gray")
    ax2.set_xlabel("# Institutions (N)")
    ax2.set_ylabel("End-to-end wall-clock (ms)")
    ax2.set_title("(b) Total latency vs institution count")
    ax2.set_xticks(Ns)
    ax2.legend(loc="upper left", frameon=True)
    ax2.set_ylim(5500, 7500)

    plt.tight_layout()
    savefig(fig, "fig3_scalability")


# =====================================================================
# Fig 4 — Hockey sticks: salt-service + prover throughput/latency vs C
# =====================================================================
def fig4_hockey_sticks():
    hs = load_hockey_salt()
    hp = load_hockey_prover()

    fig, axes = plt.subplots(1, 2, figsize=(7, 3.2))

    # --- Salt service (left) ---
    ax = axes[0]
    ax.set_xscale("log"); ax.set_yscale("log")
    Cs_s = sorted(hs["concurrency"].unique())
    # true throughput from timestamps
    tp_s, p50_s, p95_s, p99_s = [], [], [], []
    for C in Cs_s:
        g = hs[hs["concurrency"] == C]
        span = (g["ts_ms"].max() - g["ts_ms"].min()) / 1000
        tp_s.append(len(g) / span if span > 0 else 0)
        p50_s.append(g["latency_ms"].quantile(0.5))
        p95_s.append(g["latency_ms"].quantile(0.95))
        p99_s.append(g["latency_ms"].quantile(0.99))

    ax2 = ax.twinx()
    ax2.set_yscale("log")
    l1 = ax.plot(Cs_s, tp_s, "o-", color=COLORS["salt"], linewidth=2, markersize=7, label="throughput")[0]
    l2 = ax2.plot(Cs_s, p50_s, "s--", color="#444", linewidth=1, markersize=4, alpha=0.6, label="latency p50")[0]
    l3 = ax2.plot(Cs_s, p99_s, "^--", color="#888", linewidth=1, markersize=4, alpha=0.6, label="latency p99")[0]
    ax.set_xlabel("Concurrency C")
    ax.set_ylabel("Throughput (rps)", color=COLORS["salt"])
    ax2.set_ylabel("Latency (ms)", color="#444")
    ax.set_title(f"(a) Salt-service ({len(hs):,} req, 10 instances)")
    ax.legend(handles=[l1, l2, l3], loc="lower right", frameon=True)
    ax.set_xticks(Cs_s)
    ax.set_xticklabels([str(c) for c in Cs_s])
    ax.grid(True, which="both", alpha=0.3)
    ax2.grid(False)

    # --- Prover (right) ---
    ax = axes[1]
    ax.set_xscale("log"); ax.set_yscale("log")
    Cs_p = sorted(hp["concurrency"].unique())
    tp_p, p50_p, p95_p, p99_p = [], [], [], []
    for C in Cs_p:
        g = hp[hp["concurrency"] == C]
        span = (g["ts_ms"].max() - g["ts_ms"].min()) / 1000
        tp_p.append(len(g) / span if span > 0 else 0)
        p50_p.append(g["latency_ms"].quantile(0.5))
        p95_p.append(g["latency_ms"].quantile(0.95))
        p99_p.append(g["latency_ms"].quantile(0.99))

    ax2 = ax.twinx(); ax2.set_yscale("log")
    l1 = ax.plot(Cs_p, tp_p, "o-", color=COLORS["prover"], linewidth=2, markersize=7, label="throughput")[0]
    # linear scaling reference line
    ref = [tp_p[0] * c / Cs_p[0] for c in Cs_p]
    l_ref = ax.plot(Cs_p, ref, ":", color="gray", linewidth=1.2, label="ideal linear")[0]
    l2 = ax2.plot(Cs_p, p50_p, "s--", color="#444", linewidth=1, markersize=4, alpha=0.6, label="latency p50")[0]
    l3 = ax2.plot(Cs_p, p99_p, "^--", color="#888", linewidth=1, markersize=4, alpha=0.6, label="latency p99")[0]
    ax.set_xlabel("Concurrency C")
    ax.set_ylabel("Throughput (rps)", color=COLORS["prover"])
    ax2.set_ylabel("Latency (ms)", color="#444")
    ax.set_title(f"(b) Mysten ZK prover ({len(hp):,} req)")
    ax.legend(handles=[l1, l_ref, l2, l3], loc="upper left", frameon=True, fontsize=8)
    ax.set_xticks(Cs_p)
    ax.set_xticklabels([str(c) for c in Cs_p])
    ax.grid(True, which="both", alpha=0.3)
    ax2.grid(False)

    plt.tight_layout()
    savefig(fig, "fig4_hockey_sticks")


# =====================================================================
# Fig 5 — Poseidon amortization curve (per-call latency vs index)
# =====================================================================
def fig5_poseidon_amortization():
    pb = load_poseidon_bench()
    # Aggregate across repeats: for each call_index, list of latencies
    g = pb.groupby("call_index")["latency_ms"]
    idxs = sorted(g.groups.keys())
    means = [g.get_group(i).mean() for i in idxs]
    p95s  = [g.get_group(i).quantile(0.95) for i in idxs]

    fig, ax = plt.subplots(figsize=(5, 3.2))
    ax.plot(idxs, means, "-", color=COLORS["salt"], linewidth=2, label="mean")
    ax.fill_between(idxs,
                    [g.get_group(i).min() for i in idxs],
                    [g.get_group(i).max() for i in idxs],
                    color=COLORS["salt"], alpha=0.15, label="min-max band")
    ax.set_yscale("log")
    ax.set_xlabel("Call index within a page-session")
    ax.set_ylabel("poseidonSaltFromSeed latency (ms, log scale)")
    ax.set_title(f"Poseidon cold-start amortization (n={len(pb)} calls, 10 sessions)")
    # annotations
    ax.annotate(f"cold: {means[0]:.0f} ms",
                xy=(0, means[0]), xytext=(4, means[0]),
                arrowprops=dict(arrowstyle="->", color="gray"), fontsize=9)
    ax.annotate(f"warm: {np.median(means[1:]):.2f} ms",
                xy=(25, np.median(means[1:])), xytext=(25, 0.5),
                arrowprops=dict(arrowstyle="->", color="gray"), fontsize=9)
    ax.legend(loc="upper right")
    savefig(fig, "fig5_poseidon_amortization")


# =====================================================================
# Fig 6 — Cold vs warm page-context (box plots per metric, paired)
# =====================================================================
def fig6_cold_vs_warm():
    df = load_e2e()
    cold = df[df["tag"] == "cold_page_N3"]
    warm = df[df["tag"] == "warm_page_N3"]

    metrics = [
        ("epoch_fetch_ms",   "Epoch RPC"),
        ("gen_params_total_ms", "Gen params"),
        ("oauth_rtt_ms",     "OAuth RTT"),
        ("salt_ms",          "Salt"),
        ("prover_ms",        "Prover"),
        ("wall_total_ms",    "Wall total"),
    ]
    fig, ax = plt.subplots(figsize=(7, 3.2))
    positions = np.arange(len(metrics))
    width = 0.38
    data_cold = [cold[m].dropna() for m, _ in metrics]
    data_warm = [warm[m].dropna() for m, _ in metrics]

    b1 = ax.boxplot(data_cold, positions=positions - width/2, widths=width*0.9,
                    patch_artist=True, medianprops=dict(color="white"),
                    showfliers=False)
    b2 = ax.boxplot(data_warm, positions=positions + width/2, widths=width*0.9,
                    patch_artist=True, medianprops=dict(color="white"),
                    showfliers=False)
    for b in b1["boxes"]: b.set(facecolor=COLORS["cold"])
    for b in b2["boxes"]: b.set(facecolor=COLORS["warm"])

    ax.set_yscale("log")
    ax.set_xticks(positions)
    ax.set_xticklabels([l for _, l in metrics])
    ax.set_ylabel("Latency (ms, log scale)")
    ax.set_title(f"Cold (n={len(cold)}) vs warm (n={len(warm)}) page context, N=3 cache=none")
    legend_handles = [Patch(facecolor=COLORS["cold"], label="cold (fresh page per run)"),
                      Patch(facecolor=COLORS["warm"], label="warm (shared page)")]
    ax.legend(handles=legend_handles, loc="upper left", frameon=True)
    plt.tight_layout()
    savefig(fig, "fig6_cold_vs_warm")


# =====================================================================
# Fig 7 — Cache ablation: cached vs remote at N=3 (horizontal)
# =====================================================================
def fig7_cache_ablation():
    df = load_e2e()
    metrics = [("salt_ms", "Salt derivation"),
               ("prover_ms", "ZK prover"),
               ("wall_total_ms", "End-to-end")]
    cached = df[(df["op"] == "did") & (df["institutions"] == 3) & (df["cache_mode"] == "all")]
    remote = df[(df["op"] == "did") & (df["institutions"] == 3) & (df["cache_mode"] == "none")]

    fig, ax = plt.subplots(figsize=(5.5, 2.8))
    positions = np.arange(len(metrics))
    width = 0.35

    # Use median as central tendency (robust to outliers), p50→p95 as upper cap,
    # p5→p50 as lower cap. For log-x, lower cap clamped >=epsilon to avoid issues.
    def caps(sub, m):
        p5  = sub[m].quantile(0.05)
        p50 = sub[m].quantile(0.50)
        p95 = sub[m].quantile(0.95)
        return p50, max(0, p50 - p5), max(0, p95 - p50)

    cached_p50, cached_lo, cached_hi = zip(*[caps(cached, m) for m, _ in metrics])
    remote_p50, remote_lo, remote_hi = zip(*[caps(remote, m) for m, _ in metrics])

    ax.barh(positions - width/2, cached_p50, height=width,
            xerr=[cached_lo, cached_hi], color=COLORS["cache_all"],
            label=f"cache=all  (n={len(cached)})", capsize=3, error_kw={"elinewidth": 1})
    ax.barh(positions + width/2, remote_p50, height=width,
            xerr=[remote_lo, remote_hi], color=COLORS["cache_none"],
            label=f"cache=none (n={len(remote)})", capsize=3, error_kw={"elinewidth": 1})
    ax.set_yticks(positions); ax.set_yticklabels([l for _, l in metrics])
    ax.set_xlabel("Latency (ms), median with p5–p95 whiskers")
    ax.set_title("Cache ablation at N=3 (whiskers span p5–p95)")
    ax.set_xscale("log")
    ax.legend(loc="lower right", frameon=True)
    plt.tight_layout()
    savefig(fig, "fig7_cache_ablation")


if __name__ == "__main__":
    print("generating figures…")
    fig1_stacked_latency()
    fig2_e2e_cdf()
    fig3_scalability()
    fig4_hockey_sticks()
    fig5_poseidon_amortization()
    fig6_cold_vs_warm()
    fig7_cache_ablation()
    print("done.")
