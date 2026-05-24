#!/usr/bin/env python3
"""Generate paper figures for Section 5.1 (Timing Distribution) and Section 5.2
(Phase Composition + Module Overhead Analysis).

Reads CSVs from experiments/results-from-ec2/ and the bridge log slice from
experiments/paper/devstack-log-30run-slice.log.

Outputs PDF + PNG into experiments/paper/figures/.

Usage:
    python3 make_figures.py
"""

import csv
import os
import re
from statistics import mean, median, stdev

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


# ---------------- paths ----------------
ROOT = os.path.dirname(os.path.abspath(__file__))
PAPER_DIR = os.path.dirname(ROOT)
DATA_DIR = os.path.normpath(os.path.join(PAPER_DIR, "..", "results-from-ec2"))
LOG_PATH = os.path.join(PAPER_DIR, "devstack-30run-worker-4inst.log")  # worker-mode log slice
OUT_DIR = ROOT

CSV_30   = os.path.join(DATA_DIR, "2026-04-26T03-22-45-998Z_op-did_N4_cache-none_runs30.csv")    # Mode B: fresh-flow + worker
CSV_30_SPAWN = os.path.join(DATA_DIR, "2026-04-25T15-15-23-421Z_op-did_N4_cache-none_runs30.csv") # Mode A: fresh-flow + spawn baseline
CSV_LOC5 = os.path.join(DATA_DIR, "2026-04-25T14-02-08-647Z_op-did_N3_cache-none_runs5.csv")
CSV_X3   = os.path.join(DATA_DIR, "2026-04-25T15-00-21-641Z_op-did_N3_cache-none_runs3.csv")
CSV_SREUSE_SPAWN  = os.path.join(DATA_DIR, "2026-04-26T02-26-48-089Z_op-did_N3_cache-none_runs30_sessionreuse.csv")  # Mode C: session-reuse + spawn
CSV_SREUSE_WORKER = os.path.join(DATA_DIR, "2026-04-26T03-53-37-505Z_op-did_N4_cache-all_runs30_sessionreuse.csv")  # Mode D: session-reuse + worker

# DID-recovery sweep: 5 batches, n=30 each, N ∈ {3,5,7,9,11} institutions
CSV_RECOVERY = {
    3:  os.path.join(DATA_DIR, "2026-04-26T05-34-06-837Z_recovery_N3_runs30.csv"),
    5:  os.path.join(DATA_DIR, "2026-04-26T05-35-17-188Z_recovery_N5_runs30.csv"),
    7:  os.path.join(DATA_DIR, "2026-04-26T05-36-27-597Z_recovery_N7_runs30.csv"),
    9:  os.path.join(DATA_DIR, "2026-04-26T05-37-37-657Z_recovery_N9_runs30.csv"),
    11: os.path.join(DATA_DIR, "2026-04-26T05-38-48-272Z_recovery_N11_runs30.csv"),
}


# ---------------- style ----------------
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 10,
    "axes.labelsize": 10,
    "axes.titlesize": 11,
    "legend.fontsize": 8.5,
    "xtick.labelsize": 9,
    "ytick.labelsize": 9,
    "savefig.dpi": 200,
    "savefig.bbox": "tight",
})


# ---------------- helpers ----------------
def load_csv(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def col_int(rows, key):
    out = []
    for r in rows:
        v = r.get(key, "")
        if v in ("", None, "null"):
            continue
        try:
            out.append(int(float(v)))
        except (TypeError, ValueError):
            pass
    return out


def parse_node_phases(log_path):
    """Each successful run prints 7 '- 6.X_phase: N ms' lines. We collect them
    in order. Returns a dict of lists keyed by phase id."""
    phases = {
        "1-3_restore":   [],
        "1b_JWK":        [],
        "4_prover":      [],
        "4b_faucet":     [],
        "5_build_sign":  [],
        "6a_assemble":   [],
        "6b_submit":     [],
    }
    if not os.path.exists(log_path):
        return phases
    pat = re.compile(r"^- (6\.[\w\-+]+): (\d+) ms\s*$")
    block = {}
    with open(log_path, errors="replace") as f:
        for line in f:
            m = pat.match(line.strip())
            if not m:
                if block and len(block) >= 5:
                    # commit a complete-enough block
                    phases["1-3_restore"]  .append(block.get("6.1-3_restore_key+randomness+nonce_verify+address_seed", 0))
                    phases["1b_JWK"]       .append(block.get("6.1b_JWK_precheck", 0))
                    phases["4_prover"]     .append(block.get("6.4_request_Prover", 0))
                    phases["4b_faucet"]    .append(block.get("6.4b_request_Faucet", 0))
                    phases["5_build_sign"] .append(block.get("6.5_build_and_sign_Move_tx", 0))
                    phases["6a_assemble"]  .append(block.get("6.6a_assemble_zkLogin_signature", 0))
                    phases["6b_submit"]    .append(block.get("6.6b_submit_tx_and_return", 0))
                    block = {}
                continue
            block[m.group(1)] = int(m.group(2))
        # tail
        if block and len(block) >= 5:
            phases["1-3_restore"]  .append(block.get("6.1-3_restore_key+randomness+nonce_verify+address_seed", 0))
            phases["1b_JWK"]       .append(block.get("6.1b_JWK_precheck", 0))
            phases["4_prover"]     .append(block.get("6.4_request_Prover", 0))
            phases["4b_faucet"]    .append(block.get("6.4b_request_Faucet", 0))
            phases["5_build_sign"] .append(block.get("6.5_build_and_sign_Move_tx", 0))
            phases["6a_assemble"]  .append(block.get("6.6a_assemble_zkLogin_signature", 0))
            phases["6b_submit"]    .append(block.get("6.6b_submit_tx_and_return", 0))
    return phases


# ---------------- Figure 1: ECDF (Section 5.1) ----------------
def fig_wall_total_cdf():
    rows = load_csv(CSV_30)
    wall_total  = sorted(col_int(rows, "wall_total_ms"))
    wall_login  = sorted(col_int(rows, "wall_login_ms"))
    wall_submit = sorted(col_int(rows, "wall_submit_ms"))
    n = len(wall_total)

    fig, ax = plt.subplots(figsize=(5.6, 3.4))
    ax.step(wall_login,  np.arange(1, n+1) / n, label="login (Google → toast)",
            where="post", linewidth=1.3, color="#3498db")
    ax.step(wall_submit, np.arange(1, n+1) / n, label="submit (Create DID → toast)",
            where="post", linewidth=1.3, color="#27ae60")
    ax.step(wall_total,  np.arange(1, n+1) / n, label="total",
            where="post", linewidth=1.7, color="#2c3e50")

    p50 = wall_total[n // 2]
    p95 = wall_total[max(0, min(n-1, int(0.95 * n) - 1))]
    ax.axvline(p50, color="grey", linestyle="--", alpha=0.5, linewidth=0.8)
    ax.axvline(p95, color="grey", linestyle=":",  alpha=0.5, linewidth=0.8)
    ax.text(p50, 0.04, f" p50={p50}", fontsize=8, color="grey")
    ax.text(p95, 0.55, f" p95={p95}", fontsize=8, color="grey")

    ax.set_xlabel("wall-clock time (ms)")
    ax.set_ylabel("empirical CDF")
    ax.set_xlim(0, max(wall_total) * 1.05)
    ax.set_ylim(0, 1.02)
    ax.grid(True, alpha=0.3)
    ax.legend(loc="lower right", framealpha=0.9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_wall_total_cdf.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_wall_total_cdf.png"))
    plt.close(fig)
    print("wrote fig_wall_total_cdf.{pdf,png}")


# ---------------- Figure 2: Phase composition stacked bar (Section 5.2) ----------------
def fig_phase_composition():
    rows = load_csv(CSV_30)
    node = parse_node_phases(LOG_PATH)

    wall_total_mean = mean(col_int(rows, "wall_total_ms"))

    # Browser-side
    prover    = mean(col_int(rows, "prover_ms"))
    oauth     = mean(col_int(rows, "oauth_rtt_ms"))
    salt      = mean(col_int(rows, "salt_ms"))
    bro_misc  = (mean(col_int(rows, "epoch_fetch_ms"))
                 + mean(col_int(rows, "eph_key_ms"))
                 + mean(col_int(rows, "randomness_ms"))
                 + mean(col_int(rows, "nonce_ms"))
                 + mean(col_int(rows, "jwt_parse_ms"))
                 + mean(col_int(rows, "nonce_verify_ms"))
                 + mean(col_int(rows, "save_account_ms"))
                 + mean(col_int(rows, "bridge_post_ms")))

    # Node-side (from log slice)
    jwk       = mean(node["1b_JWK"]) if node["1b_JWK"] else 91
    submit_tx = mean(node["6b_submit"]) if node["6b_submit"] else 369
    node_misc = ((mean(node["1-3_restore"]) if node["1-3_restore"] else 23) +
                 (mean(node["4b_faucet"])   if node["4b_faucet"]   else 0)  +
                 (mean(node["5_build_sign"])if node["5_build_sign"]else 43) +
                 (mean(node["6a_assemble"]) if node["6a_assemble"] else 0))

    accounted = prover + oauth + salt + bro_misc + jwk + submit_tx + node_misc
    unaccounted = max(0, wall_total_mean - accounted)

    parts = [
        ("ZK proof (Mysten SNARK)",       prover,      "#c0392b"),
        ("OAuth round-trip",              oauth,       "#f39c12"),
        ("salt fetch (4 inst, parallel)", salt,        "#2980b9"),
        ("submit tx + chain finality",    submit_tx,   "#27ae60"),
        ("JWK precheck",                  jwk,         "#7f8c8d"),
        ("Node misc",                     node_misc,   "#bdc3c7"),
        ("Browser misc",                  bro_misc,    "#dfe6e9"),
        ("page mount + IPC + polling",    unaccounted, "#ecf0f1"),
    ]

    fig, ax = plt.subplots(figsize=(7.2, 1.7))
    cum = 0
    for label, val, color in parts:
        ax.barh(0, val, left=cum, color=color, edgecolor="black", linewidth=0.5,
                label=f"{label}: {int(val)} ms ({100*val/wall_total_mean:.1f}%)")
        cum += val
    ax.set_xlim(0, wall_total_mean * 1.02)
    ax.set_xlabel(f"wall-clock time (ms)  —  total mean = {int(wall_total_mean)} ms")
    ax.set_yticks([])
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.5), ncol=2, frameon=False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_phase_composition.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_phase_composition.png"))
    plt.close(fig)
    print("wrote fig_phase_composition.{pdf,png}")


# ---------------- Figure 3: Salt deployment comparison (Section 5.2) ----------------
def fig_salt_comparison():
    s_local  = col_int(load_csv(CSV_LOC5), "salt_ms")  # n=5  all-localhost
    s_xreg   = col_int(load_csv(CSV_X3),   "salt_ms")  # n=3  all-cross-region
    s_mixed  = col_int(load_csv(CSV_30),   "salt_ms")  # n=30 mixed 1L+3W

    fig, ax = plt.subplots(figsize=(5.6, 3.4))

    bp = ax.boxplot(
        [s_local, s_xreg, s_mixed],
        labels=[
            "all localhost\n(3 inst, n=5)",
            "all cross-region\n(3 inst, n=3)",
            "1 local + 3 cross\n(4 inst, n=30)",
        ],
        widths=0.55, patch_artist=True,
        medianprops=dict(color="red", linewidth=1.8),
        whiskerprops=dict(linewidth=1.0),
        flierprops=dict(marker="x", markersize=6, markeredgecolor="red"),
    )
    colors = ["#dfe6e9", "#f39c12", "#2980b9"]
    for patch, c in zip(bp["boxes"], colors):
        patch.set_facecolor(c)
        patch.set_alpha(0.55)

    rng = np.random.default_rng(42)
    for i, vals in enumerate([s_local, s_xreg, s_mixed], 1):
        if not vals: continue
        x = rng.normal(i, 0.04, len(vals))
        ax.scatter(x, vals, s=12, color="black", alpha=0.55, zorder=3, linewidth=0)

    ax.set_ylabel("salt fetch latency (ms, log scale)")
    ax.set_yscale("log")
    ax.set_ylim(5, 1500)
    ax.grid(True, axis="y", alpha=0.3, which="both")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_salt_comparison.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_salt_comparison.png"))
    plt.close(fig)
    print("wrote fig_salt_comparison.{pdf,png}")


# ---------------- Figure 4: Four-mode amortization comparison (Section 5.3) ----------------
def fig_amortization_4modes():
    """Per-DID steady-state wall-clock cost across 4 operational modes,
    visualized on a log scale with absolute and relative annotations."""

    a_wall = col_int(load_csv(CSV_30_SPAWN),       "wall_total_ms")  # Mode A
    b_wall = col_int(load_csv(CSV_30),              "wall_total_ms") # Mode B
    c_wall = col_int(load_csv(CSV_SREUSE_SPAWN),    "wall_post_ms")  # Mode C
    d_wall = col_int(load_csv(CSV_SREUSE_WORKER),   "wall_post_ms")  # Mode D

    a_mean, b_mean = int(np.mean(a_wall)), int(np.mean(b_wall))
    c_mean, d_mean = int(np.mean(c_wall)), int(np.mean(d_wall))

    labels = [
        "(A) Fresh+Spawn\nfull flow each call",
        "(B) Fresh+Worker\npersistent backend",
        "(C) Session+Spawn\nsession reused",
        "(D) Session+Worker\nboth optimizations",
    ]
    means = [a_mean, b_mean, c_mean, d_mean]
    colors = ["#c0392b", "#e67e22", "#3498db", "#27ae60"]

    fig, ax = plt.subplots(figsize=(6.8, 3.8))
    bars = ax.bar(labels, means, color=colors, edgecolor="black", linewidth=0.8, width=0.62)

    # Per-bar annotation: absolute mean + reduction vs Mode A
    for i, (bar, m) in enumerate(zip(bars, means)):
        h = bar.get_height()
        red = f"{100*(a_mean - m)/a_mean:.1f}%" if i > 0 else ""
        label = f"{m:,} ms" + (f"\n(−{red} vs A)" if red else "\n(baseline)")
        ax.text(bar.get_x() + bar.get_width()/2, h * 1.15, label,
                ha="center", va="bottom", fontsize=8.5, fontweight="bold" if i == 3 else "normal")

    ax.set_yscale("log")
    ax.set_ylim(50, 12000)
    ax.set_ylabel("per-DID wall-clock cost (ms, log scale)")
    ax.grid(True, axis="y", alpha=0.3, which="both")
    ax.set_title("Per-DID latency across operational modes (n=30 each)", fontsize=10)

    # Subtle horizontal line at Mode A baseline for visual reference
    ax.axhline(a_mean, color="#c0392b", linestyle=":", alpha=0.3, linewidth=0.8)

    plt.xticks(fontsize=8.5)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_amortization_4modes.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_amortization_4modes.png"))
    plt.close(fig)
    print("wrote fig_amortization_4modes.{pdf,png}")


# ---------------- Figure 5: Session-reuse phase decomposition C vs D ----------------
def fig_session_reuse_phase_breakdown():
    """Side-by-side stacked bars: Mode C vs Mode D backend phase breakdown.
    Shows where the worker's caches (Sui RPC, JWKS, balance, coin metadata)
    eliminate per-iteration cost."""

    rows_c = load_csv(CSV_SREUSE_SPAWN)
    rows_d = load_csv(CSV_SREUSE_WORKER)

    def phase(rows, key):
        a = [int(float(r[key])) for r in rows if r.get(key) not in ("", "null", None)]
        return int(np.mean(a)) if a else 0

    # backend_* columns and the residual (wall_post - sum of timed phases)
    keys = [
        ("restore",     "backend_restore_ms",        "#7f8c8d"),
        ("JWK",         "backend_jwk_precheck_ms",   "#bdc3c7"),
        ("prover",      "backend_prover_request_ms", "#34495e"),  # always 0 in both
        ("faucet",      "backend_faucet_ms",         "#95a5a6"),
        ("build+sign",  "backend_build_sign_ms",     "#e67e22"),
        ("submit+finality", "backend_submit_ms",     "#c0392b"),
    ]

    c_phases = [phase(rows_c, k) for _, k, _ in keys]
    d_phases = [phase(rows_d, k) for _, k, _ in keys]
    c_wall = phase(rows_c, "wall_post_ms")
    d_wall = phase(rows_d, "wall_post_ms")
    c_residual = max(0, c_wall - sum(c_phases))
    d_residual = max(0, d_wall - sum(d_phases))

    fig, ax = plt.subplots(figsize=(6.4, 3.6))

    bar_width = 0.5
    x = [0, 1]

    # Stack each phase, both bars
    bottom_c, bottom_d = 0, 0
    for (name, _, color), c_v, d_v in zip(keys, c_phases, d_phases):
        ax.bar(x[0], c_v, bottom=bottom_c, width=bar_width, color=color,
               edgecolor="black", linewidth=0.4, label=name)
        ax.bar(x[1], d_v, bottom=bottom_d, width=bar_width, color=color,
               edgecolor="black", linewidth=0.4)
        # Annotate each segment if material
        if c_v >= 8:
            ax.text(x[0], bottom_c + c_v/2, f"{c_v}", ha="center", va="center", fontsize=7)
        if d_v >= 8:
            ax.text(x[1], bottom_d + d_v/2, f"{d_v}", ha="center", va="center", fontsize=7)
        bottom_c += c_v
        bottom_d += d_v

    # Residual (IPC + HTTP + bridge handler) on top
    ax.bar(x[0], c_residual, bottom=bottom_c, width=bar_width, color="#ecf0f1",
           edgecolor="black", linewidth=0.4, label="residual\n(IPC, HTTP, handler)")
    ax.bar(x[1], d_residual, bottom=bottom_d, width=bar_width, color="#ecf0f1",
           edgecolor="black", linewidth=0.4)
    ax.text(x[0], bottom_c + c_residual/2, f"{c_residual}", ha="center", va="center", fontsize=7)
    ax.text(x[1], bottom_d + d_residual/2, f"{d_residual}", ha="center", va="center", fontsize=7)

    # Total annotation above each bar
    ax.text(x[0], c_wall * 1.04, f"total\n{c_wall} ms", ha="center", va="bottom",
            fontsize=9, fontweight="bold")
    ax.text(x[1], d_wall * 1.04, f"total\n{d_wall} ms", ha="center", va="bottom",
            fontsize=9, fontweight="bold")

    ax.set_xticks(x)
    ax.set_xticklabels(["(C) Session + Spawn", "(D) Session + Worker"])
    ax.set_ylabel("per-iteration wall time (ms)")
    ax.set_ylim(0, max(c_wall, d_wall) * 1.25)
    ax.legend(loc="center right", fontsize=7.5, frameon=True, framealpha=0.9,
              bbox_to_anchor=(1.32, 0.5))
    ax.grid(True, axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_session_reuse_phases.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_session_reuse_phases.png"))
    plt.close(fig)
    print("wrote fig_session_reuse_phases.{pdf,png}")


# ---------------- Figure 6: DID-recovery scaling vs # institutions ----------------
def fig_recovery_scaling():
    """Two-panel figure: (left) salt fetch latency distribution vs N institutions
    as a boxplot; (right) wall_login total median vs N as a line chart.
    Visualizes the N-invariance of recovery latency under Promise.all fan-out."""

    Ns = sorted(CSV_RECOVERY.keys())
    salts = []
    walls = []
    for N in Ns:
        rows = load_csv(CSV_RECOVERY[N])
        salts.append(col_int(rows, "salt_ms"))
        walls.append(col_int(rows, "wall_login_ms"))

    fig, (ax_l, ax_r) = plt.subplots(1, 2, figsize=(8.6, 3.4))

    # LEFT: salt fetch boxplot (log scale to keep cold-start outliers visible)
    bp = ax_l.boxplot(
        salts,
        labels=[f"N={n}" for n in Ns],
        widths=0.55, patch_artist=True,
        medianprops=dict(color="red", linewidth=1.6),
        whiskerprops=dict(linewidth=1.0),
        flierprops=dict(marker="x", markersize=5, markeredgecolor="red", alpha=0.5),
    )
    palette = ["#2980b9", "#3498db", "#5dade2", "#85c1e9", "#aed6f1"]
    for patch, c in zip(bp["boxes"], palette):
        patch.set_facecolor(c); patch.set_alpha(0.55)

    rng = np.random.default_rng(7)
    for i, vals in enumerate(salts, 1):
        x = rng.normal(i, 0.04, len(vals))
        ax_l.scatter(x, vals, s=8, color="black", alpha=0.45, zorder=3, linewidth=0)

    ax_l.set_yscale("log")
    ax_l.set_ylim(40, 1500)
    ax_l.set_ylabel("salt fetch latency (ms, log scale)")
    ax_l.set_xlabel("number of institutions N")
    ax_l.set_title("Salt fetch latency vs N", fontsize=10)
    ax_l.grid(True, axis="y", alpha=0.3, which="both")

    # RIGHT: wall_login median + p95 as a line
    p50s = [sorted(w)[len(w)//2] for w in walls]
    p95s = [sorted(w)[max(0, min(len(w)-1, int(0.95*len(w)) - 1))] for w in walls]
    means = [int(np.mean(w)) for w in walls]
    ax_r.plot(Ns, p50s, marker="o", color="#27ae60", linewidth=2.0, label="p50")
    ax_r.plot(Ns, means, marker="s", color="#2c3e50", linewidth=1.4, label="mean", linestyle="--")
    ax_r.plot(Ns, p95s, marker="^", color="#e67e22", linewidth=1.4, label="p95", linestyle=":")
    for n, p in zip(Ns, p50s):
        ax_r.annotate(f"{p}", (n, p), textcoords="offset points", xytext=(0, 8),
                      fontsize=8, ha="center", color="#27ae60")
    ax_r.set_xticks(Ns)
    ax_r.set_xlabel("number of institutions N")
    ax_r.set_ylabel("wall\\_login latency (ms)")
    ax_r.set_title("Recovery wall\\_login vs N", fontsize=10)
    ax_r.set_ylim(0, max(p95s) * 1.15)
    ax_r.grid(True, alpha=0.3)
    ax_r.legend(loc="lower right", fontsize=9)

    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, "fig_recovery_scaling.pdf"))
    fig.savefig(os.path.join(OUT_DIR, "fig_recovery_scaling.png"))
    plt.close(fig)
    print("wrote fig_recovery_scaling.{pdf,png}")


if __name__ == "__main__":
    print(f"data dir: {DATA_DIR}")
    print(f"out dir:  {OUT_DIR}")
    fig_wall_total_cdf()
    fig_phase_composition()
    fig_salt_comparison()
    fig_amortization_4modes()
    fig_session_reuse_phase_breakdown()
    fig_recovery_scaling()
