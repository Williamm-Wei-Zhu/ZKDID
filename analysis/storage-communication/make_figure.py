#!/usr/bin/env python3
"""Generate the Resource-and-Cost comparison figures for the paper.

This is a *theoretical* analysis. Sizes (storage / communication) are derived
from the Move struct definitions, the TypeScript type schemas, and the
serialized JSON fixtures of the six sibling experiment trees. Gas numbers
are derived from Sui's published gas-cost coefficients (per-byte storage
cost + per-transaction computation cost) applied to the same on-chain
artefact sizes; they are theoretical estimates, not measured.

Three figures are emitted, plus a 3-panel composite:
  - storage-comparison.{pdf,png}        per-party durable storage per patient
  - communication-comparison.{pdf,png}  per-interaction wire bytes
  - gas-comparison.{pdf,png}            per-interaction on-chain gas (MIST)
  - resource-and-cost.{pdf,png}         3-panel composite

Usage:
    python3 make_figure.py
"""

import matplotlib.pyplot as plt
import numpy as np

# -----------------------------------------------------------------------------
# Storage (durable bytes per patient, mid-range estimate)
# -----------------------------------------------------------------------------
SCHEMES_STORAGE = [
    # (display name, patient, issuer/holder-RP, on-chain)
    # Hospital (verifier) durable per-patient cost is zero in every scheme
    # (it caches transient state only), so it is omitted from the figure.
    #
    # zkDIDProof patient stores 32 B for the cached DID = Poseidon(sub,iss,salt)
    # so the wallet does not recompute it every session.
    #
    # zkEHR hospital row records only the *mandatory* per-patient state at the
    # issuer/data holder: a signed profile keyed by DID (~600 B, same order as
    # an OIDC session row). Issuing a W3C VC for selective disclosure is
    # *optional* and would add ~12 KB per credential.
    ("OIDC-Only",           0,     500,    0),
    ("Private-DID/VC",     750,    64,   575),
    ("zkLogin-Only",       230,    300,  450),
    ("Action-EHR",         350,    50,   400),
    ("zkEHR (ours)",       50,    600,   650),
    ("zkDIDProof (ours)",  32,     300,    0),
]

STORAGE_PARTS = ["Patient", "Hospital (issuer / RP)", "On-chain"]
STORAGE_COLORS = ["#4477AA", "#EE6677", "#CCBB44"]

# -----------------------------------------------------------------------------
# Communication (wire bytes per interaction, mid-range estimate)
# -----------------------------------------------------------------------------
SCHEMES_COMM = [
    # (display name, establishment, presentation, cross-institution access)
    ("OIDC-Only",           7500,    1500,   1100),
    ("Private-DID/VC",      1200,     800,   1200),
    ("zkLogin-Only",        8000,       0,   1100),
    ("Action-EHR",             0,       0,   3500),
    ("zkEHR (ours)",       12400,       0,   1900),
    ("zkDIDProof (ours)",      0,    4300,      0),
]

COMM_PARTS = ["Establishment", "Per-presentation", "Cross-institution access"]
COMM_COLORS = ["#4477AA", "#EE6677", "#228833"]

# -----------------------------------------------------------------------------
# Gas (MIST per chain-touching interaction, theoretical from Sui coefficients)
# -----------------------------------------------------------------------------
# Sui gas model:
#   gas = computation_cost + storage_cost - storage_rebate
# We use the published reference coefficients:
#   g_tx_ed25519  ~  800,000  MIST  (Ed25519-signed transaction baseline)
#   g_tx_zklogin  ~ 1,500,000 MIST  (zkLogin sig: extra Groth16 verify cost)
#   c_store       ~       100 MIST / byte
# and apply them to the on-chain object sizes from the storage table:
#   O_did   = 500-650 B,  O_grant = 400-450 B.
# Storage rebate is ~99% on object deletion; since we are pricing CREATION of
# objects that remain on chain, the rebate term is dropped.
#
# Per scheme (rounded to the nearest 10 kMIST):
#   Private-DID/VC est:  800,000 + 575*100 = 857,500   ~  860,000
#   zkLogin-Only   est:1,500,000 + 450*100 = 1,545,000 ~ 1,550,000
#   Action-EHR     acc:  800,000 + 400*100 = 840,000   ~   840,000
#   zkEHR          est:1,500,000 + 650*100 = 1,565,000 ~ 1,570,000
#   zkEHR          acc:1,500,000 + 400*100 = 1,540,000 ~ 1,540,000  (zkLogin-signed)
#   zkLogin-Only   acc:1,500,000 + 450*100 = 1,545,000 ~ 1,550,000
SCHEMES_GAS = [
    # (display name, establishment_gas, presentation_gas, access_gas)  in MIST
    ("OIDC-Only",                0,       0,         0),
    ("Private-DID/VC",      860000,       0,         0),
    ("zkLogin-Only",       1550000,       0,   1550000),
    ("Action-EHR",               0,       0,    840000),
    ("zkEHR (ours)",       1570000,       0,   1540000),
    ("zkDIDProof (ours)",        0,       0,         0),
]

GAS_PARTS = ["Establishment", "Per-presentation", "Cross-institution access"]
GAS_COLORS = ["#4477AA", "#EE6677", "#228833"]


# =============================================================================
# Plotting helpers
# =============================================================================

def _grouped_bars(ax, schemes, parts, colors, xlabel, unit_suffix=" B"):
    """Render the grouped horizontal bars on the given axis.

    On a log-x scale, true stacking is misleading because adding small
    numbers to large numbers visually disappears. We instead draw each
    component as a separate bar at the same y-coordinate using thin offsets.
    Components with a value of zero are not drawn (NaN on a log axis).
    """
    names = [row[0] for row in schemes]
    matrix = np.array([row[1:] for row in schemes], dtype=float)

    y = np.arange(len(names))
    n_parts = len(parts)
    height = 0.7 / n_parts

    for i, (label, color) in enumerate(zip(parts, colors)):
        offset = (i - (n_parts - 1) / 2) * height
        vals = matrix[:, i]
        display_vals = np.where(vals > 0, vals, np.nan)
        bars = ax.barh(
            y + offset,
            display_vals,
            height,
            label=label,
            color=color,
            edgecolor="black",
            linewidth=0.4,
        )
        for b, v in zip(bars, vals):
            if v <= 0:
                continue
            ax.text(
                v * 1.05,
                b.get_y() + b.get_height() / 2,
                f"{int(v):,}{unit_suffix}",
                va="center",
                ha="left",
                fontsize=7,
            )

    ax.set_xscale("log")
    ax.set_xlabel(f"{xlabel} (log scale)")
    cur_lo, cur_hi = ax.get_xlim()
    ax.set_xlim(left=max(cur_lo, 1.0), right=cur_hi * 6.0)

    ax.set_yticks(y)
    ax.set_yticklabels(names)
    ax.invert_yaxis()
    ax.grid(axis="x", which="both", linestyle=":", alpha=0.4)
    ax.set_axisbelow(True)


def _emit_standalone(schemes, parts, colors, xlabel, basename, unit_suffix=" B"):
    """Render one figure on its own canvas and save as PDF + PNG."""
    fig, ax = plt.subplots(figsize=(7.2, 3.6))
    _grouped_bars(ax, schemes, parts, colors, xlabel, unit_suffix=unit_suffix)
    ax.legend(
        loc="upper center",
        bbox_to_anchor=(0.5, -0.18),
        ncol=len(parts),
        frameon=True,
        fontsize=8,
    )
    fig.tight_layout()
    fig.savefig(f"{basename}.pdf", bbox_inches="tight")
    fig.savefig(f"{basename}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print(f"wrote {basename}.pdf")
    print(f"wrote {basename}.png")


def _emit_composite():
    """Render the three axes as a 3-panel figure stacked vertically."""
    fig, axes = plt.subplots(3, 1, figsize=(7.4, 9.2))

    panels = [
        (axes[0], SCHEMES_STORAGE, STORAGE_PARTS, STORAGE_COLORS,
         "Durable storage per patient (bytes)", " B",
         "(a) Storage"),
        (axes[1], SCHEMES_COMM, COMM_PARTS, COMM_COLORS,
         "Communication per interaction (bytes)", " B",
         "(b) Communication"),
        (axes[2], SCHEMES_GAS, GAS_PARTS, GAS_COLORS,
         "On-chain gas per interaction (MIST)", " MIST",
         "(c) Gas"),
    ]
    for ax, schemes, parts, colors, xlabel, suffix, title in panels:
        _grouped_bars(ax, schemes, parts, colors, xlabel, unit_suffix=suffix)
        ax.set_title(title, loc="left", fontsize=10, fontweight="bold")
        ax.legend(loc="lower right", frameon=True, fontsize=7)

    fig.tight_layout()
    fig.savefig("resource-and-cost.pdf", bbox_inches="tight")
    fig.savefig("resource-and-cost.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print("wrote resource-and-cost.pdf")
    print("wrote resource-and-cost.png")


def main() -> None:
    _emit_standalone(
        SCHEMES_STORAGE, STORAGE_PARTS, STORAGE_COLORS,
        xlabel="Durable storage per patient (bytes)",
        basename="storage-comparison",
    )
    _emit_standalone(
        SCHEMES_COMM, COMM_PARTS, COMM_COLORS,
        xlabel="Communication per interaction (bytes)",
        basename="communication-comparison",
    )
    _emit_standalone(
        SCHEMES_GAS, GAS_PARTS, GAS_COLORS,
        xlabel="On-chain gas per interaction (MIST)",
        basename="gas-comparison",
        unit_suffix=" MIST",
    )
    _emit_composite()


if __name__ == "__main__":
    main()
