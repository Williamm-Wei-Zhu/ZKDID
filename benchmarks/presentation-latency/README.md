# Benchmark — Credential-presentation latency (cold start)

Latency to present a credential and have a relying party verify it, in the cold-start regime
(every presentation includes credential acquisition; JWTs cannot be cached because the OIDC
nonce binds the per-presentation challenge).

| Variant | Directory |
|---|---|
| zkDIDProof (proposed) | `proposed-zkdidproof/` |
| ZK-based VC (proposed) | `proposed-zk-vc/` |
| OIDC-only | `baseline-oidc-only/` |
| Private-key DID/VC | `baseline-private-key-did-vc/` |

Per-run CSVs live in each variant's `results/`. Aggregated into the paper figure by
[`analysis/presentation-latency/make_figure.py`](../../analysis/presentation-latency/make_figure.py).
See each variant's own README for the exact run command.
