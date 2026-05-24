"""
Shared data-loader for all paper figures/tables.
Loads the relevant CSV subsets from experiments/results-from-ec2/.
"""

import glob
import os
import pandas as pd

# Make pathing work regardless of where the script is invoked from
_HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(_HERE, "..", "results-from-ec2")


def _read_e2e():
    """End-to-end DID/VC/Access CSVs (exclude micro-benchmarks and load tests)."""
    frames = []
    for f in sorted(glob.glob(os.path.join(RESULTS, "*.csv"))):
        base = os.path.basename(f)
        if base.startswith("concurrent-salt") or base.startswith("concurrent-prover"):
            continue
        if base.startswith("poseidon-bench"):
            continue
        df = pd.read_csv(f)
        df["_source"] = base
        frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    return out[out["success"] == 1].copy()


def load_e2e():
    """All successful end-to-end runs (DID/VC/Access) with consistent types."""
    df = _read_e2e()
    num_cols = [
        "epoch_fetch_ms", "eph_key_ms", "randomness_ms", "nonce_ms",
        "gen_params_total_ms", "oauth_rtt_ms", "jwt_parse_ms", "salt_ms",
        "nonce_verify_ms", "prover_ms", "save_account_ms", "bridge_post_ms",
        "derive_all_ms",
        "backend_restore_ms", "backend_jwk_precheck_ms", "backend_prover_request_ms",
        "backend_faucet_ms", "backend_build_sign_ms", "backend_assemble_sig_ms",
        "backend_submit_ms", "backend_query_chain_ms", "backend_total_ms",
        "gas_computation_mist", "gas_storage_mist", "gas_rebate_mist",
        "gas_nonrefundable_mist", "gas_net_mist", "object_bcs_bytes",
        "wall_login_ms", "wall_submit_ms", "wall_total_ms",
    ]
    for c in num_cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["institutions"] = pd.to_numeric(df["institutions"], errors="coerce").astype("Int64")
    return df


def load_hockey_salt():
    """Salt-service load test (large, one row per request)."""
    path = sorted(glob.glob(os.path.join(RESULTS, "concurrent-salt-*T03-24-30*.csv")))
    if not path:
        path = sorted(glob.glob(os.path.join(RESULTS, "concurrent-salt-*.csv")))
    # Pick the HOCKEY_STICK-tagged run (not the smoke)
    df = pd.read_csv(path[-1])
    df = df[(df["tag"] == "hockey_stick") & (df["success"] == 1)].copy()
    return df


def load_hockey_prover():
    path = sorted(glob.glob(os.path.join(RESULTS, "concurrent-prover-*T04-41-52*.csv")))
    if not path:
        path = sorted(glob.glob(os.path.join(RESULTS, "concurrent-prover-*.csv")))
    df = pd.read_csv(path[-1])
    return df[(df["tag"] == "prover_hockey") & (df["success"] == 1)].copy()


def load_poseidon_bench():
    path = sorted(glob.glob(os.path.join(RESULTS, "poseidon-bench-*.csv")))[-1]
    return pd.read_csv(path)


def summarize(series):
    """Return mean / p50 / p95 / p99 / min / max / std as a dict."""
    s = series.dropna().astype(float)
    if len(s) == 0:
        return {"n": 0}
    return {
        "n": len(s),
        "mean": s.mean(),
        "p50": s.median(),
        "p95": s.quantile(0.95),
        "p99": s.quantile(0.99),
        "min": s.min(),
        "max": s.max(),
        "std": s.std(ddof=0),
    }


if __name__ == "__main__":
    e2e = load_e2e()
    print(f"e2e rows (success=1): {len(e2e)}")
    print(f"configurations:\n{e2e.groupby(['op','institutions','cache_mode']).size()}")
    hs = load_hockey_salt()
    print(f"\nsalt hockey rows: {len(hs):,}")
    print(f"concurrency levels: {sorted(hs['concurrency'].unique())}")
    hp = load_hockey_prover()
    print(f"\nprover hockey rows: {len(hp):,}")
    print(f"concurrency levels: {sorted(hp['concurrency'].unique())}")
    pb = load_poseidon_bench()
    print(f"\nposeidon bench rows: {len(pb):,}")
