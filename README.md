# zkDID / zkEHR — Privacy-Preserving Patient Identity & Access Control

> Blockchain-based healthcare identity and access-control system built on Sui, using
> Decentralized Identifiers (DIDs), Verifiable Credentials (VCs), and zero-knowledge login
> (zkLogin) — together with the full experimental suite that backs the paper's evaluation.

This repository is the research artifact for the zkEHR paper. It contains both the **running
prototype** and every **benchmark + analysis script** used to produce the figures and tables in
the paper. The layout is organized so each evaluation metric maps to one directory.

## Repository layout

```
.
├── prototype/                     # the running zkDID/zkEHR system
│   ├── backend/                   # DID/VC management, Sui transactions (Veramo + Sui)
│   ├── frontend/                  # React + zkLogin web app (Apache-2.0, see its LICENSE)
│   ├── orchestrator/              # bridge.mjs: spawns frontend, validates epochs, sessions
│   ├── salt-service/              # per-institution salt service (Dockerized)
│   ├── mock-vc-issuer/            # mock OIDC4VCI credential issuer for experiments
│   ├── salt-seeds.json            # institution salt-seed template (values blank)
│   └── deploy/                    # EC2/prover deployment helper
│
├── benchmarks/                    # experiments grouped by EVALUATION METRIC
│   ├── did-creation/              # end-to-end identity-establishment latency
│   │   ├── proposed-zkehr/  baseline-oidc-only/  baseline-zklogin-only/  baseline-private-key-did-vc/
│   ├── presentation-latency/      # credential presentation latency (cold-start)
│   │   ├── proposed-zkdidproof/  proposed-zk-vc/  baseline-oidc-only/  baseline-private-key-did-vc/
│   ├── cross-institution-access/  # grant + access latency across institutions
│   │   ├── proposed-zkehr/  baseline-oidc-only/  baseline-zklogin-only/  baseline-private-key-did-vc/  baseline-action-ehr/
│   └── zkehr-suite/               # proposed system's microbenchmark suite
│                                  #   (prover, salt, poseidon, session-reuse, DID-recovery)
│
├── analysis/                      # cross-experiment aggregation + paper figure generation
│   ├── did-creation/              # → identity_establishment_latency figure + .tex
│   ├── presentation-latency/      # → presentation-latency-comparison.pdf + .tex
│   ├── cross-institution-access/  # → cross_institution_latency.pdf (+ A/B/C variants)
│   ├── scalability/               # → salt-scalability.pdf
│   └── storage-communication/     # → storage/gas/communication comparison + resource-and-cost
│
└── paper-assets/                  # LaTeX snippets/tables shared with the manuscript
```

## Paper → directory map

Each evaluation in the paper is reproduced by one benchmark group plus its analysis script.

| Evaluation (paper) | Benchmarks (data) | Analysis (figure/table) | Output artifact |
|---|---|---|---|
| Identity-establishment (DID creation) latency | `benchmarks/did-creation/{proposed-zkehr, baseline-oidc-only, baseline-zklogin-only, baseline-private-key-did-vc}` | `analysis/did-creation/analyze_all.py` | `analysis/did-creation/figures/` + `paper-section/identity_establishment_latency.tex` |
| Credential-presentation latency (cold start) | `benchmarks/presentation-latency/{proposed-zkdidproof, proposed-zk-vc, baseline-oidc-only, baseline-private-key-did-vc}` | `analysis/presentation-latency/make_figure.py` | `presentation-latency-comparison.{pdf,png,tex}` |
| Cross-institution grant + access latency | `benchmarks/cross-institution-access/{proposed-zkehr, baseline-oidc-only, baseline-zklogin-only, baseline-private-key-did-vc, baseline-action-ehr}` | `analysis/cross-institution-access/plot_cross_institution_latency*.py` | `cross_institution_latency*.{pdf,png}` |
| Scalability (salt / DID recovery vs. #institutions) | `benchmarks/zkehr-suite/results-from-ec2/*recovery_N*.csv` | `analysis/scalability/plot_salt_scalability.py` | `salt-scalability.{pdf,png}` |
| Storage & communication cost | (measured values, embedded in script) | `analysis/storage-communication/make_figure.py` | `storage/gas/communication-comparison.{pdf,png}`, `resource-and-cost.{pdf,tex}` |

## Reproducing the results

### Figures (fast — uses the committed result CSVs)

The raw result CSVs are committed, so figures regenerate without re-running experiments:

```bash
# requires: python3 + matplotlib (+ numpy for some scripts)
python3 analysis/did-creation/analyze_all.py
python3 analysis/presentation-latency/make_figure.py
python3 analysis/cross-institution-access/plot_cross_institution_latency.py
python3 analysis/scalability/plot_salt_scalability.py
python3 analysis/storage-communication/make_figure.py
```

Analysis scripts that read raw data resolve it relative to the repo root, so run them from
anywhere (they compute the repo root from their own location).

### Benchmarks (re-running measurements)

Each benchmark variant is self-contained. Re-running requires network access to Sui DevNet and,
for some, OIDC credentials. See the README inside each variant directory for the exact command;
the general pattern is:

```bash
cd benchmarks/<metric>/<variant>
cp .env.example .env        # fill in secrets where required
npm install
# then run the documented script (see that directory's README), e.g.:
npm start        # or: bash run-in-dcv.sh   (varies by variant)
```

## Prototype quickstart

The deployable system lives under `prototype/`. See [`prototype/README.md`](prototype/README.md)
for full setup (Sui Move contract deployment, OAuth/zkLogin config, running the dev server).
In short, from the repo root:

```bash
npm install
(cd prototype/backend && npm install)
(cd prototype/frontend && npm install)
npm run dev          # launches the Vite frontend (http://localhost:1234) via the orchestrator
```

## Secrets & local configuration

No secrets are committed. Provide your own from the templates:

| Provide | Template |
|---|---|
| `prototype/frontend/src/config.json` (OAuth client IDs, prover URL) | `prototype/frontend/src/config.example.json` |
| `prototype/salt-service/config.json` (institution seed) | `prototype/salt-service/config.json.example` |
| `benchmarks/**/.env` (per-experiment keys) | the `.env.example` beside each |
| `prototype/salt-seeds.json` (institution salt seeds) | committed with blank values |

`*.pem`, `*.key`, `.env`, and the live `config.json` files are gitignored.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript 5, Vite 6, Sui zkLogin |
| Backend | Node.js 18+, Veramo 6 (DID/VC) |
| Blockchain | Sui (DevNet), Move smart contracts |
| Auth | zkLogin (Google / Twitch / Facebook OAuth) |
| Crypto | Ed25519, Secp256k1, Poseidon (circomlibjs), Groth16 zk proofs |
| Analysis | Python 3, matplotlib, numpy |

## License

This project is released under the **MIT License** (see [`LICENSE`](LICENSE)).
The web frontend under `prototype/frontend/` is derived from
[Polymedia's zkLogin demo](https://github.com/juzybits/polymedia-zklogin) and remains under the
**Apache License 2.0** — see [`prototype/frontend/LICENSE`](prototype/frontend/LICENSE).
