"""
LaTeX table generator for the TSC Performance section.

Produces .tex files in experiments/paper/tables/ ready for \\input{} in the
main document. Each table is self-contained (uses \\begin{table} ... \\end{table}).

Run: python3 experiments/paper/tables.py
"""

import os
import numpy as np
import pandas as pd

from data_loader import (
    load_e2e, load_hockey_salt, load_hockey_prover, load_poseidon_bench, summarize,
)

_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(_HERE, "tables")
os.makedirs(OUT, exist_ok=True)


def write_table(name, content):
    path = os.path.join(OUT, f"{name}.tex")
    with open(path, "w") as f:
        f.write(content)
    print(f"  ✓ {name}.tex")


def fmt(v, decimals=1, suffix=""):
    if v is None or pd.isna(v):
        return "--"
    if decimals == 0:
        return f"{v:.0f}{suffix}"
    return f"{v:.{decimals}f}{suffix}"


# =====================================================================
# Table I — System configuration (hand-written, but parametrized from data)
# =====================================================================
def table1_system_config():
    e2e = load_e2e()
    n_total = len(e2e)
    n_concurrent_salt = len(load_hockey_salt())
    n_concurrent_prover = len(load_hockey_prover())
    n_poseidon = len(load_poseidon_bench())
    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{System configuration and dataset summary.}}
  \label{{tab:system_config}}
  \footnotesize
  \begin{{tabular}}{{ll}}
    \toprule
    \textbf{{Component}} & \textbf{{Configuration}} \\
    \midrule
    Load generator & AWS EC2 t3.small, us-east-1, 2 vCPU, 8\,GB RAM \\
    OS / runtime   & Ubuntu 24.04, Node.js 20.20.2, Playwright 1.48 \\
    Blockchain     & Sui DevNet 1.70.0 (chain id \texttt{{e8118007}}) \\
    ZK prover      & Mysten \texttt{{prover-dev.mystenlabs.com/v1}} (us-east-1) \\
    OIDC provider  & Google (\texttt{{accounts.google.com}}, silent redirect) \\
    Salt service   & 10 pm2-managed Node 20 instances, ports 7001--7010, \\
                   & loopback network only, 128-bit Poseidon-based derivation \\
    \midrule
    \multicolumn{{2}}{{l}}{{\emph{{Measurement volume}}}} \\
    End-to-end DID/VC/Access runs & {n_total} successful observations \\
    Poseidon primitive micro-benchmark & {n_poseidon} call samples \\
    Salt-service concurrent load test  & {n_concurrent_salt:,} requests \\
    ZK prover concurrent load test     & {n_concurrent_prover:,} requests \\
    \midrule
    \multicolumn{{2}}{{l}}{{\emph{{Statistical methodology}}}} \\
    Minimum batch size per condition & 30 runs \\
    Significance test for paired comparisons & Mann--Whitney $U$ (two-tailed) \\
    Reported statistics & mean, median ($p_{{50}}$), $p_{{95}}$, $p_{{99}}$, $\sigma$ \\
    \bottomrule
  \end{{tabular}}
\end{{table}}
"""
    write_table("tab1_system_config", tex)


# =====================================================================
# Table II — End-to-end latency breakdown (per-phase stats, op=did N=3 cache=all)
# =====================================================================
def table2_latency_breakdown():
    df = load_e2e()
    sub = df[(df["op"] == "did") & (df["institutions"] == 3) & (df["cache_mode"] == "all")]
    n = len(sub)

    rows = [
        ("Fetch Sui epoch",         "epoch_fetch_ms",        "browser"),
        ("Generate eph. key+nonce", "gen_params_total_ms",   "browser"),
        ("OAuth round-trip (silent)","oauth_rtt_ms",         "browser"),
        ("Derive salt",             "salt_ms",               "browser"),
        ("Request ZK proof",        "prover_ms",             "browser"),
        ("POST session to bridge",  "bridge_post_ms",        "browser"),
        ("JWK freshness check",     "backend_jwk_precheck_ms", "backend"),
        ("Build + sign Move tx",    "backend_build_sign_ms", "backend"),
        ("Submit tx to Sui",        "backend_submit_ms",     "backend"),
        ("Query tx effects",        "backend_query_chain_ms","backend"),
        ("\\textbf{End-to-end (wall-clock)}", "wall_total_ms", "total"),
    ]

    body = []
    last_group = None
    for label, col, group in rows:
        if group != last_group and last_group is not None:
            body.append(r"\addlinespace")
        last_group = group
        s = summarize(sub[col])
        body.append(
            f"  {label} & "
            f"{fmt(s.get('mean'),0)} & "
            f"{fmt(s.get('p50'),0)} & "
            f"{fmt(s.get('p95'),0)} & "
            f"{fmt(s.get('p99'),0)} & "
            f"{fmt(s.get('std'),0)} \\\\"
        )

    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{End-to-end latency breakdown, grouped by execution context
    (browser vs. backend child). Single patient, N=3 institutions, cache=all
    (n={n} successful runs). All values in milliseconds.}}
  \label{{tab:latency_breakdown}}
  \footnotesize
  \begin{{tabular}}{{lrrrrr}}
    \toprule
    \textbf{{Phase}} & \textbf{{Mean}} & \textbf{{$p_{{50}}$}} & \textbf{{$p_{{95}}$}} & \textbf{{$p_{{99}}$}} & \textbf{{$\sigma$}} \\
    \midrule
{chr(10).join(body)}
    \bottomrule
  \end{{tabular}}
\end{{table}}
"""
    write_table("tab2_latency_breakdown", tex)


# =====================================================================
# Table III — Scalability: salt_ms + wall_total vs N institutions (cache=none)
# =====================================================================
def table3_scalability():
    df = load_e2e()
    Ns = [1, 3, 5, 10]
    rows = []
    for N in Ns:
        sub = df[(df["op"] == "did") & (df["institutions"] == N) & (df["cache_mode"] == "none")]
        salt = summarize(sub["salt_ms"])
        wall = summarize(sub["wall_total_ms"])
        rows.append(
            f"  {N} & {len(sub)} & "
            f"{fmt(salt.get('mean'),1)} & {fmt(salt.get('p50'),1)} & {fmt(salt.get('p95'),1)} & "
            f"{fmt(wall.get('mean'),0)} & {fmt(wall.get('p50'),0)} & {fmt(wall.get('p95'),0)} \\\\"
        )

    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{Scalability: salt derivation and end-to-end latency vs.\ number of
    selected institutions. No local cache, every institution's salt fetched
    remotely at login time.}}
  \label{{tab:scalability}}
  \footnotesize
  \begin{{tabular}}{{rrrrrrrr}}
    \toprule
    & & \multicolumn{{3}}{{c}}{{\textbf{{Salt derivation (ms)}}}} & \multicolumn{{3}}{{c}}{{\textbf{{End-to-end (ms)}}}} \\
    \cmidrule(lr){{3-5}} \cmidrule(lr){{6-8}}
    \textbf{{N}} & \textbf{{n}} & \textbf{{Mean}} & \textbf{{$p_{{50}}$}} & \textbf{{$p_{{95}}$}} & \textbf{{Mean}} & \textbf{{$p_{{50}}$}} & \textbf{{$p_{{95}}$}} \\
    \midrule
{chr(10).join(rows)}
    \bottomrule
  \end{{tabular}}
\end{{table}}
"""
    write_table("tab3_scalability", tex)


# =====================================================================
# Table IV — Operation comparison (did / vc / access, all at N=3 cache=all)
# =====================================================================
def table4_op_comparison():
    df = load_e2e()
    ops = ["did", "vc", "access"]

    metrics = [
        ("salt_ms",              "Salt derivation"),
        ("prover_ms",            "ZK prover"),
        ("backend_build_sign_ms","Build+sign tx"),
        ("backend_submit_ms",    "Submit tx"),
        ("wall_total_ms",        "End-to-end"),
        ("gas_net_mist",         "Net gas (MIST)"),
        ("object_bcs_bytes",     "Object bytes (BCS)"),
    ]

    rows = []
    for label, col in [(l, c) for c, l in metrics]:  # preserve order
        pass

    lines = []
    # header
    op_labels = []
    sub_map = {}
    for op in ops:
        sub = df[(df["op"] == op) & (df["institutions"] == 3) & (df["cache_mode"] == "all")]
        sub_map[op] = sub
        op_labels.append(f"{op}\\\\(n={len(sub)})")

    for col, label in metrics:
        def format_value(val, col):
            if col == "gas_net_mist":
                return f"{val/1e6:.2f}M" if val is not None and not pd.isna(val) else "--"
            if col == "object_bcs_bytes":
                return f"{val:.0f}" if val is not None and not pd.isna(val) else "--"
            return fmt(val, 0 if val > 10 else 1)

        means = [sub_map[op][col].mean() for op in ops]
        p50s = [sub_map[op][col].median() for op in ops]
        line = (
            f"  {label} & "
            + " & ".join(format_value(m, col) for m in means)
            + " & "
            + " & ".join(format_value(p, col) for p in p50s)
            + r" \\"
        )
        lines.append(line)

    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{Operation comparison (N=3, cache=all). DIDs ($n={len(sub_map['did'])}$),
    VCs ($n={len(sub_map['vc'])}$), and Access Grants ($n={len(sub_map['access'])}$).
    Latency in ms; gas in MIST; storage in BCS-serialized bytes.}}
  \label{{tab:op_comparison}}
  \footnotesize
  \setlength{{\tabcolsep}}{{4pt}}
  \begin{{tabular}}{{l rrr rrr}}
    \toprule
    & \multicolumn{{3}}{{c}}{{\textbf{{Mean}}}} & \multicolumn{{3}}{{c}}{{\textbf{{Median ($p_{{50}}$)}}}} \\
    \cmidrule(lr){{2-4}} \cmidrule(lr){{5-7}}
    \textbf{{Metric}} & \textbf{{DID}} & \textbf{{VC}} & \textbf{{Access}}
                     & \textbf{{DID}} & \textbf{{VC}} & \textbf{{Access}} \\
    \midrule
{chr(10).join(lines)}
    \bottomrule
  \end{{tabular}}
\end{{table}}
"""
    write_table("tab4_op_comparison", tex)


# =====================================================================
# Table V — Concurrent capacity (salt-service + prover hockey sticks)
# =====================================================================
def table5_concurrent_capacity():
    hs = load_hockey_salt()
    hp = load_hockey_prover()

    def stats_by_c(df, col="latency_ms"):
        Cs = sorted(df["concurrency"].unique())
        rows = []
        for C in Cs:
            g = df[df["concurrency"] == C]
            span = (g["ts_ms"].max() - g["ts_ms"].min()) / 1000
            tp = len(g) / span if span > 0 else 0
            rows.append({
                "C": int(C),
                "n": len(g),
                "tp": tp,
                "p50": g[col].quantile(0.5),
                "p95": g[col].quantile(0.95),
                "p99": g[col].quantile(0.99),
            })
        return rows

    salt_rows = stats_by_c(hs)
    prov_rows = stats_by_c(hp)

    def emit(rows, label):
        out = [rf"  \multicolumn{{6}}{{l}}{{\textit{{{label}}}}} \\"]
        for r in rows:
            out.append(
                f"    C={r['C']} & {r['n']:,} & "
                f"{r['tp']:,.1f} & "
                f"{r['p50']:.1f} & "
                f"{r['p95']:.1f} & "
                f"{r['p99']:.1f} \\\\"
            )
        return out

    body = []
    body.extend(emit(salt_rows, f"Salt-service (loopback, 10 instances)"))
    body.append(r"  \addlinespace")
    body.extend(emit(prov_rows, f"Mysten ZK prover (HTTPS, us-east-1 $\\leftrightarrow$ us-east-1)"))

    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{Concurrent capacity characterization. Throughput and latency vs.\
    concurrency $C$ for two system components. Salt service: loopback load test
    with per-IP rate limiter raised to $10^5$/min. Prover: direct HTTPS calls
    to Mysten DevNet prover from co-located EC2 host.}}
  \label{{tab:concurrent}}
  \footnotesize
  \begin{{tabular}}{{l rrrrr}}
    \toprule
     & \textbf{{\# req}} & \textbf{{Throughput}} & \textbf{{Latency}} & \textbf{{Latency}} & \textbf{{Latency}} \\
     & & \textbf{{(rps)}} & \textbf{{$p_{{50}}$ (ms)}} & \textbf{{$p_{{95}}$ (ms)}} & \textbf{{$p_{{99}}$ (ms)}} \\
    \midrule
{chr(10).join(body)}
    \bottomrule
  \end{{tabular}}
\end{{table}}
"""
    write_table("tab5_concurrent_capacity", tex)


# =====================================================================
# Table VI — Cold vs warm page-context paired test (supplementary)
# =====================================================================
def table6_cold_warm():
    import math
    df = load_e2e()
    cold = df[df["tag"] == "cold_page_N3"]
    warm = df[df["tag"] == "warm_page_N3"]

    def mwu(xs, ys):
        """Mann-Whitney U, returns (U, z, p two-tailed)."""
        xs = list(xs.dropna()); ys = list(ys.dropna())
        n1, n2 = len(xs), len(ys)
        combined = sorted([(v, 0) for v in xs] + [(v, 1) for v in ys])
        ranks = [0] * (n1 + n2)
        i = 0
        while i < len(combined):
            j = i
            while j + 1 < len(combined) and combined[j + 1][0] == combined[i][0]:
                j += 1
            avg_rank = (i + j) / 2 + 1
            for k in range(i, j + 1):
                ranks[k] = avg_rank
            i = j + 1
        r1 = sum(r for r, c in zip(ranks, [c for _, c in combined]) if c == 0)
        u1 = r1 - n1 * (n1 + 1) / 2
        U = min(u1, n1 * n2 - u1)
        mu = n1 * n2 / 2
        sigma = (n1 * n2 * (n1 + n2 + 1) / 12) ** 0.5
        z = (U - mu) / sigma if sigma else 0
        p = math.erfc(abs(z) / math.sqrt(2))
        return U, z, p

    metrics = [
        ("epoch_fetch_ms",       "Sui epoch RPC"),
        ("gen_params_total_ms",  "Gen params (eph key+rand+nonce)"),
        ("oauth_rtt_ms",         "OAuth round-trip"),
        ("jwt_parse_ms",         "JWT parse"),
        ("salt_ms",              "Salt derivation"),
        ("nonce_verify_ms",      "Nonce verify"),
        ("prover_ms",            "ZK prover"),
        ("bridge_post_ms",       "Bridge POST"),
        ("backend_submit_ms",    "Submit to Sui"),
        ("wall_total_ms",        "\\textbf{End-to-end wall-clock}"),
    ]

    lines = []
    for col, label in metrics:
        cm = cold[col].mean(); wm = warm[col].mean()
        delta = cm - wm
        delta_pct = (delta / wm * 100) if wm else 0
        _, _, p = mwu(cold[col], warm[col])
        if p < 0.001: sig = r"\ssstar"
        elif p < 0.01: sig = r"\sstar"
        elif p < 0.05: sig = r"\star"
        else: sig = ""
        lines.append(
            f"  {label} & "
            f"{fmt(cm,1)} & {fmt(wm,1)} & "
            f"{'+' if delta > 0 else ''}{fmt(delta,1)} & "
            f"{'+' if delta_pct > 0 else ''}{fmt(delta_pct,1)}\\% & "
            f"{p:.4f}{sig} \\\\"
        )

    tex = rf"""\begin{{table}}[t]
  \centering
  \caption{{Cold vs.\ warm page-context paired test (op=did, N=3, cache=none,
    each n=30). Cold = fresh Chromium page per run; warm = shared page across
    runs. $p$ values from two-tailed Mann--Whitney $U$ test.}}
  \label{{tab:cold_warm}}
  \footnotesize
  \newcommand{{\star}}{{$^{{*}}$}}
  \newcommand{{\sstar}}{{$^{{**}}$}}
  \newcommand{{\ssstar}}{{$^{{***}}$}}
  \begin{{tabular}}{{l rr r r r}}
    \toprule
    \textbf{{Metric}} & \textbf{{Cold (ms)}} & \textbf{{Warm (ms)}} & \textbf{{$\Delta$}} & \textbf{{$\Delta\%$}} & \textbf{{$p$}} \\
    \midrule
{chr(10).join(lines)}
    \bottomrule
  \end{{tabular}}
  \newline
  \scriptsize{{$^{{*}}\,p < 0.05$,\quad $^{{**}}\,p < 0.01$,\quad $^{{***}}\,p < 0.001$}}
\end{{table}}
"""
    write_table("tab6_cold_warm", tex)


if __name__ == "__main__":
    print("generating LaTeX tables…")
    table1_system_config()
    table2_latency_breakdown()
    table3_scalability()
    table4_op_comparison()
    table5_concurrent_capacity()
    table6_cold_warm()
    print("done.")
