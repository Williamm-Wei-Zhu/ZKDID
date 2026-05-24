#!/usr/bin/env python3
"""
print-detailed-runs.py — read a results CSV + the bridge stdout log, print a
per-run, per-phase breakdown for human review.

Usage:
  python3 print-detailed-runs.py <csv-path> [log-path]

CSV layout: see lib/metrics.mjs flattenRun().
Log layout: veramo-to-sui.js prints lines like "- 6.4_request_Prover: 2682 ms"
            after each run; we slice the log by the timestamp range of the
            CSV's runs. (Best-effort — if log slicing misses a run we just
            show "N/A" for the Node phases.)
"""

import csv, sys, os, re
from statistics import mean, median

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else None
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "/tmp/devstack.log"

if not CSV_PATH or not os.path.exists(CSV_PATH):
    print(f"usage: {sys.argv[0]} <csv-path> [log-path]   (csv missing or unreadable)")
    sys.exit(1)

with open(CSV_PATH) as f:
    rows = list(csv.DictReader(f))

# Try to grab veramo-to-sui.js phase summaries from the log.
# Each successful run prints a block ending with the seven "- 6.x_*: N ms" lines.
# We collect ALL such blocks and assume they map to rows in order.
log_blocks = []
if os.path.exists(LOG_PATH):
    with open(LOG_PATH, errors="replace") as f:
        log = f.read()
    # find non-overlapping sequences of "- 6.X..." lines
    block = []
    for line in log.splitlines():
        m = re.match(r"^- (6\.[0-9a-z_+]+_[a-zA-Z_]+\S*): (\d+) ms\s*$", line)
        if m:
            block.append((m.group(1), int(m.group(2))))
        else:
            if block:
                log_blocks.append(dict(block))
                block = []
    if block:
        log_blocks.append(dict(block))

# Heuristic: take the LAST len(rows) log blocks. Bridge log is append-only and
# this run is the most recent activity.
if len(log_blocks) >= len(rows):
    log_blocks = log_blocks[-len(rows):]
else:
    # pad with empty dicts if log slicing failed for early runs
    log_blocks = [{}] * (len(rows) - len(log_blocks)) + log_blocks


def col(r, k, suffix="ms"):
    v = r.get(k, "")
    if v in ("", None, "null"):
        return "  N/A"
    try:
        return f"{int(float(v)):>5} {suffix}"
    except (TypeError, ValueError):
        return str(v)


def phase(label, value, comment=""):
    return f"    {label:<32} {value:>9}    {comment}"


print("\n" + "=" * 78)
print(f"DETAILED PER-RUN BREAKDOWN — {os.path.basename(CSV_PATH)}")
print(f"  rows: {len(rows)}   tag: {rows[0].get('tag', '?')}")
print(f"  config: op={rows[0].get('op')}, institutions={rows[0].get('institutions')}, "
      f"cache={rows[0].get('cache_mode')}, warm={rows[0].get('warm')}")
print("=" * 78)

for i, r in enumerate(rows, 1):
    bk = log_blocks[i - 1] if i - 1 < len(log_blocks) else {}
    digest = (r.get("tx_digest") or "").strip()
    digest_short = digest[:14] + "..." if len(digest) > 14 else digest

    print(f"\n──── Run {i}/{len(rows)} ──────────────────────────────────────────")
    print(f"  status   : {'OK' if r.get('success') == '1' else 'FAILED'}     digest: {digest_short}")
    print(f"  timestamp: {r.get('timestamp', '?')}")
    print()
    print("  BROWSER (auth.ts)  ─ pre-OAuth + post-OAuth (in user's browser)")
    print(phase("epoch_fetch_ms",    col(r, "epoch_fetch_ms"),     "getLatestSuiSystemState (browser→Sui)"))
    print(phase("eph_key_ms",        col(r, "eph_key_ms"),         "new Ed25519Keypair()"))
    print(phase("randomness_ms",     col(r, "randomness_ms"),      "generateRandomness() — 16 bytes"))
    print(phase("nonce_ms",          col(r, "nonce_ms"),           "Poseidon hash for OAuth nonce"))
    print(phase("oauth_rtt_ms",      col(r, "oauth_rtt_ms"),       "click Google → JWT back in URL"))
    print(phase("jwt_parse_ms",      col(r, "jwt_parse_ms"),       "jwtDecode + sub/aud sanity"))
    print(phase("salt_ms",           col(r, "salt_ms"),             "parallel /get-salt to 3 EC2 services"))
    print(phase("nonce_verify_ms",   col(r, "nonce_verify_ms"),     "setupData.nonce == jwt.nonce"))
    print(phase("prover_ms",         col(r, "prover_ms"),           "browser → prover-dev.mystenlabs.com"))
    print(phase("save_account_ms",   col(r, "save_account_ms"),     "sessionStorage.setItem"))
    print(phase("bridge_post_ms",    col(r, "bridge_post_ms"),      "POST /zklogin-session (with ZK_PROOFS)"))
    print()
    print("  NODE (veramo-to-sui.js, spawned by bridge AFTER 'Create DID' click)")
    print(phase("6.1-3 restore+nonce+addrSeed",
                f"{bk.get('6.1-3_restore_key+randomness+nonce_verify+address_seed', 'N/A')} ms"
                if '6.1-3_restore_key+randomness+nonce_verify+address_seed' in bk else "  N/A",
                "restore eph key + verify nonce + addrSeed"))
    print(phase("6.1b JWK_precheck",
                f"{bk.get('6.1b_JWK_precheck', 'N/A')} ms" if '6.1b_JWK_precheck' in bk else "  N/A",
                "verify JWT kid still in JWKS"))
    print(phase("6.4  request_Prover",
                f"{bk.get('6.4_request_Prover', 'N/A')} ms" if '6.4_request_Prover' in bk else "  N/A",
                "(should be ~0 — uses preloaded zkProofs)"))
    print(phase("6.4b request_Faucet",
                f"{bk.get('6.4b_request_Faucet', 'N/A')} ms" if '6.4b_request_Faucet' in bk else "  N/A",
                "DevNet faucet pre-flight"))
    print(phase("6.5  build_and_sign_Move_tx",
                f"{bk.get('6.5_build_and_sign_Move_tx', 'N/A')} ms" if '6.5_build_and_sign_Move_tx' in bk else "  N/A",
                "construct & sign Move call"))
    print(phase("6.6a assemble_zkLogin_signature",
                f"{bk.get('6.6a_assemble_zkLogin_signature', 'N/A')} ms" if '6.6a_assemble_zkLogin_signature' in bk else "  N/A",
                "wrap ed25519 sig with zkLogin envelope"))
    print(phase("6.6b submit_tx_and_return",
                f"{bk.get('6.6b_submit_tx_and_return', 'N/A')} ms" if '6.6b_submit_tx_and_return' in bk else "  N/A",
                "executeTransactionBlock → digest"))
    print()
    print("  WALL CLOCK (playwright observer)")
    print(phase("wall_login_ms",   col(r, "wall_login_ms"),    "click Google → 'Logged in' toast"))
    print(phase("wall_submit_ms",  col(r, "wall_submit_ms"),   "click Create DID → 'dispatched' toast"))
    print(phase("wall_total_ms",   col(r, "wall_total_ms"),    "= login + submit"))
    print()
    print(f"  GAS NET: {r.get('gas_net_mist', '?')} MIST   "
          f"(gas computation+storage−rebate−nonrefundable)")

# Summary stats
def get_int(r, k):
    v = r.get(k, "")
    if v in ("", None, "null"):
        return None
    try: return int(float(v))
    except (TypeError, ValueError): return None

def stat(rows, key, log_key=None):
    if log_key is not None:
        vals = [b.get(log_key) for b in log_blocks]
        vals = [int(v) for v in vals if v is not None]
    else:
        vals = [get_int(r, key) for r in rows]
        vals = [v for v in vals if v is not None]
    if not vals:
        return "      N/A"
    sorted_vals = sorted(vals)
    n = len(sorted_vals)
    p50 = sorted_vals[n // 2]
    p95_i = max(0, min(n - 1, int(0.95 * n) - 1)) if n >= 2 else 0
    p95 = sorted_vals[p95_i]
    return (f"n={n}  mean={int(mean(vals)):>5}  p50={p50:>5}  "
            f"p95={p95:>5}  min={min(vals):>5}  max={max(vals):>5}")

print("\n" + "=" * 78)
print(f"SUMMARY (N={len(rows)})")
print("=" * 78)
print()
print("  BROWSER phase                            stats (ms)")
print("  ----------------------------------       ------------------------------------")
for k, label in [
    ("epoch_fetch_ms",   "epoch_fetch_ms"),
    ("eph_key_ms",       "eph_key_ms"),
    ("randomness_ms",    "randomness_ms"),
    ("nonce_ms",         "nonce_ms"),
    ("oauth_rtt_ms",     "oauth_rtt_ms"),
    ("jwt_parse_ms",     "jwt_parse_ms"),
    ("salt_ms",          "salt_ms"),
    ("nonce_verify_ms",  "nonce_verify_ms"),
    ("prover_ms",        "prover_ms          ⬅ ZK proof"),
    ("save_account_ms",  "save_account_ms"),
    ("bridge_post_ms",   "bridge_post_ms"),
]:
    print(f"  {label:<40} {stat(rows, k)}")

print()
print("  NODE (veramo-to-sui.js) phase            stats (ms)")
print("  ----------------------------------       ------------------------------------")
for k, label in [
    ("6.1-3_restore_key+randomness+nonce_verify+address_seed", "6.1-3 restore+nonce+addrSeed"),
    ("6.1b_JWK_precheck",                                       "6.1b JWK_precheck"),
    ("6.4_request_Prover",                                      "6.4  request_Prover (preloaded)"),
    ("6.4b_request_Faucet",                                     "6.4b request_Faucet"),
    ("6.5_build_and_sign_Move_tx",                              "6.5  build_and_sign_Move_tx"),
    ("6.6a_assemble_zkLogin_signature",                         "6.6a assemble_zkLogin_signature"),
    ("6.6b_submit_tx_and_return",                               "6.6b submit_tx_and_return"),
]:
    print(f"  {label:<40} {stat(rows, '', log_key=k)}")

print()
print("  WALL CLOCK                               stats (ms)")
print("  ----------------------------------       ------------------------------------")
for k, label in [
    ("wall_login_ms",   "wall_login_ms     (click→login)"),
    ("wall_submit_ms",  "wall_submit_ms    (click→dispatched)"),
    ("wall_total_ms",   "wall_total_ms"),
]:
    print(f"  {label:<40} {stat(rows, k)}")

print()
print(f"  GAS net (MIST):                          {stat(rows, 'gas_net_mist')}")
