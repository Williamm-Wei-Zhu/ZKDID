#!/usr/bin/env python3
"""Generate the End-to-End Presentation Latency comparison figure for the paper.

Single-panel figure (single matplotlib Figure, single tex \\includegraphics):
  Cold-start regime — every presentation includes credential acquisition.
  zkDIDProof's OIDC nonce binds the per-presentation challenge, so the JWT
  cannot be cached; the VC-bearing schemes pay their realistic OIDC4VCI
  acquisition cost on every presentation in this regime.

The figure shows two grouped horizontal bars per scheme: patient-side cost
and hospital-side cost. Each bar carries a one-sided mean->p95 error whisker
(latency is right-skewed, so a symmetric +/- bar would be meaningless) and
is annotated with the mean and, in a smaller font, "(p95, xxx)".
A log x-axis lets the 0.6-1300 ms range fit cleanly.

Reads the four CSVs produced by:
  - oidc-only-presentation-latency
  - private-key-did-vc-presentation-latency  (with OIDC4VCI realistic acquisition)
  - zk-vc-presentation-latency                (with OIDC4VCI realistic acquisition)
  - zkdidproof-presentation-latency

Usage:
    python3 make_figure.py
Outputs:
    presentation-latency-comparison.pdf
    presentation-latency-comparison.png
"""

import csv
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]

# Per-scheme cost decomposition.
#   patient  : columns the patient performs to produce the presentation
#   hospital : columns the relying party performs to verify + create a session
SCHEMES = [
    {
        "name": "OIDC-Only",
        "csv": "benchmarks/presentation-latency/baseline-oidc-only/results/oidc_only_presentation_latency.csv",
        "patient": ["oidc_login_ms"],
        "hospital": [
            "token_exchange_ms",
            "jwks_fetch_or_cache_ms",
            "jwt_verify_ms",
            "claim_validation_ms",
            "session_create_ms",
        ],
    },
    {
        "name": "Private-key DID/VC",
        "csv": "benchmarks/presentation-latency/baseline-private-key-did-vc/results/"
               "private_key_did_vc_presentation_latency.csv",
        "patient": [
            "vc_acquire_oidc_ms",
            "vc_acquire_issuer_rt_ms",
            "vc_store_ms",
            "sign_challenge_ms",
            "present_ms",
        ],
        "hospital": [
            "challenge_create_ms",
            "did_resolve_devnet_ms",
            "did_object_parse_ms",
            "did_signature_verify_ms",
            "vc_verify_ms",
            "patient_mapping_ms",
            "session_create_ms",
        ],
    },
    {
        "name": "ZK-based VC",
        "csv": "benchmarks/presentation-latency/proposed-zk-vc/results/zk_vc_presentation_latency.csv",
        "patient": [
            "vc_acquire_oidc_ms",
            "vc_acquire_issuer_rt_ms",
            "vc_store_ms",
            "sign_challenge_ms",
            "zk_input_build_ms",
            "zk_proof_gen_ms",
            "present_ms",
        ],
        "hospital": [
            "challenge_create_ms",
            "did_resolve_devnet_ms",
            "did_object_parse_ms",
            "did_signature_verify_ms",
            "zk_proof_verify_ms",
            "patient_mapping_ms",
            "session_create_ms",
        ],
    },
    {
        "name": "zkDIDProof (ours)",
        "csv": "benchmarks/presentation-latency/proposed-zkdidproof/results/"
               "zkdidproof_presentation_latency.csv",
        "patient": [
            "nonce_gen_ms",
            "oidc_login_ms",
            "token_exchange_ms",
            "jwt_parse_ms",
            "zk_input_build_ms",
            "zk_proof_gen_ms",
        ],
        "hospital": [
            "challenge_create_ms",
            "zk_proof_verify_ms",
            "session_create_ms",
        ],
    },
]


def load_successful(path: Path) -> list[dict]:
    out: list[dict] = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if str(row.get("success", "")).strip().lower() != "true":
                continue
            parsed: dict = {}
            for k, v in row.items():
                if v is None or v == "":
                    parsed[k] = None
                    continue
                try:
                    parsed[k] = float(v)
                except ValueError:
                    parsed[k] = v
            out.append(parsed)
    return out


def row_sum_series(rows: list[dict], cols: list[str]) -> np.ndarray:
    """Per-run sum of the given columns (missing cells treated as 0).

    p95 is taken over THIS series, not over the sum of per-column p95s --
    the latter would assume every column peaks on the same run and would
    overestimate the tail.
    """
    series = []
    for r in rows:
        series.append(sum(r[c] for c in cols if isinstance(r.get(c), float)))
    return np.asarray(series, dtype=float)


def build_data():
    names: list[str] = []
    p_mean: list[float] = []
    h_mean: list[float] = []
    p_p95: list[float] = []
    h_p95: list[float] = []
    for s in SCHEMES:
        rows = load_successful(REPO_ROOT / s["csv"])
        if not rows:
            raise SystemExit(f"No successful rows in {s['csv']}")
        ps = row_sum_series(rows, s["patient"])
        hs = row_sum_series(rows, s["hospital"])
        names.append(s["name"])
        p_mean.append(float(ps.mean()))
        h_mean.append(float(hs.mean()))
        p_p95.append(float(np.percentile(ps, 95)))
        h_p95.append(float(np.percentile(hs, 95)))
        print(
            f"{s['name']:>22s}: patient mean={ps.mean():8.1f} p95={np.percentile(ps,95):8.1f}"
            f"  ||  hospital mean={hs.mean():8.1f} p95={np.percentile(hs,95):8.1f}"
            f"  ||  total mean={ps.mean()+hs.mean():8.1f}"
        )
    return names, p_mean, h_mean, p_p95, h_p95


def _xerr(means: list[float], p95s: list[float]) -> np.ndarray:
    """One-sided error: 0 below the mean, (p95 - mean) above. Clamp at 0
    so float rounding can never produce a negative whisker."""
    lower = [0.0] * len(means)
    upper = [max(0.0, p - m) for m, p in zip(means, p95s)]
    return np.array([lower, upper])


def render_panel(ax, names, p_mean, h_mean, p_p95, h_p95):
    y = np.arange(len(names))
    width = 0.38
    err_kw = dict(ecolor="#222", elinewidth=0.8, capsize=2.5, capthick=0.8)

    bars_p = ax.barh(
        y - width / 2, p_mean, width,
        color="#4477AA", edgecolor="black", linewidth=0.5,
        xerr=_xerr(p_mean, p_p95), error_kw=err_kw,
    )
    bars_h = ax.barh(
        y + width / 2, h_mean, width,
        color="#EE6677", edgecolor="black", linewidth=0.5,
        xerr=_xerr(h_mean, h_p95), error_kw=err_kw,
    )

    # Linear x-axis: bar length is exactly proportional to latency (no log
    # distortion). The trade-off is that the small hospital-side bars
    # (~18-51 ms) read as thin slivers next to the ~1300 ms patient bars --
    # this is the honest proportional view the reader asked for.
    ax.set_xlabel("Latency (ms, n=100)")
    ax.set_yticks(y)
    ax.set_yticklabels(names)
    ax.invert_yaxis()
    ax.grid(axis="x", which="major", linestyle=":", alpha=0.4)
    ax.set_axisbelow(True)

    def annotate(bars, means, p95s):
        for b, m, p in zip(bars, means, p95s):
            yc = b.get_y() + b.get_height() / 2
            # Mean label: anchored at the p95 cap, nudged right in *points*
            # so it always clears the whisker regardless of the log scale.
            ax.annotate(
                f"{m:.1f}", xy=(p, yc), xytext=(5, 0),
                textcoords="offset points", va="center", ha="left",
                fontsize=7.2, color="#222", annotation_clip=False,
            )
            # p95 label: smaller, lighter, further right (fixed point offset
            # clears mean labels of up to ~7 chars, e.g. "1305.4").
            ax.annotate(
                f"(p95, {p:.1f})", xy=(p, yc), xytext=(40, 0),
                textcoords="offset points", va="center", ha="left",
                fontsize=6.0, color="#666", annotation_clip=False,
            )

    annotate(bars_p, p_mean, p_p95)
    annotate(bars_h, h_mean, h_p95)

    # Linear headroom: from 0 to the tallest p95 plus room for the
    # point-offset "mean  (p95, xxx)" labels that sit past the cap.
    max_p95 = max(max(p_p95), max(h_p95))
    ax.set_xlim(left=0.0, right=max_p95 * 1.55)


def main() -> None:
    names, p_mean, h_mean, p_p95, h_p95 = build_data()

    fig, ax = plt.subplots(figsize=(7.4, 2.9))
    render_panel(ax, names, p_mean, h_mean, p_p95, h_p95)

    handles = [
        plt.Rectangle((0, 0), 1, 1, color="#4477AA", ec="black", lw=0.5),
        plt.Rectangle((0, 0), 1, 1, color="#EE6677", ec="black", lw=0.5),
    ]
    # Legend INSIDE the axes, upper-right: the top rows (OIDC-Only,
    # Private-key) have short bars whose labels end well left of the
    # log-axis right margin, so this corner is genuinely empty (lower-right
    # would overlap zkDIDProof's long "(p95, ...)" label).
    ax.legend(
        handles, ["Patient-side cost", "Hospital-side cost"],
        loc="upper right", ncol=1, frameon=True, fontsize=8.5,
        framealpha=0.92, borderpad=0.4, labelspacing=0.3, handlelength=1.4,
    )

    fig.tight_layout()
    out_dir = Path(__file__).resolve().parent
    pdf_path = out_dir / "presentation-latency-comparison.pdf"
    png_path = out_dir / "presentation-latency-comparison.png"
    fig.savefig(pdf_path, bbox_inches="tight")
    fig.savefig(png_path, dpi=200, bbox_inches="tight")
    print(f"\nwrote {pdf_path}")
    print(f"wrote {png_path}")


if __name__ == "__main__":
    main()
