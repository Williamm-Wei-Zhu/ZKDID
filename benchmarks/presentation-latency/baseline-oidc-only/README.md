# OIDC-Only — End-to-End Off-Chain Identity/Credential Presentation Latency

> **Variant of the zkEHR comparative-presentation-latency series.** This
> measures the OIDC-Only data point. Sibling experiments (private-key DID/VC,
> ZK-based VC presentation, zkDIDProof) measure the same end-to-end flow
> against alternative presentation schemes for direct comparison.
>
> **Flow measured here:** hospital issues nonce → patient performs OIDC login
> and presents Google ID token → hospital verifies JWT signature, issuer,
> audience, expiry, and nonce → hospital creates local patient session.
>
> Forked from `oidc-only-baseline/` on 2026-05-02. Code is identical; only
> `package.json` name and `OUTPUT_CSV` filename changed so this experiment
> writes to its own results CSV.

This project implements a **standalone OIDC-only identity-establishment latency
baseline** for the zkEHR paper. It measures the time from the start of a user
OIDC login to the moment a relying-party EHR service has a verified, locally-
authenticated session — and nothing more.

## What this baseline measures

> **The OIDC-only baseline implements a standard federated authentication
> workflow. It measures the latency from the beginning of OIDC authentication
> to the creation of a verified local EHR session after ID-token signature
> verification and claim validation. This baseline serves as a lower-bound
> authentication baseline because it does not provide decentralized identity,
> blockchain auditability, zero-knowledge identity hiding, or keyless DID
> recovery.**

Two modes are supported:

| Mode | What is measured (the `total_ms` column) |
|------|-------------------------------------------|
| **Mode 1: Full OIDC login** (`experiment:full`) | browser OIDC login → callback handling → token exchange → JWT verify → claim validation → local session creation |
| **Mode 2: Token / session reuse** (`experiment:reuse`) | JWT verify → claim validation → local session creation (uses a previously captured ID token to model repeated EHR access under an unexpired session) |

### Intentionally excluded from this baseline

This is the lower-bound federated baseline. It does **not** include any of:

- Decentralized identifier (DID) creation or resolution
- Verifiable Credential (VC) issuance or presentation
- Blockchain transactions or finality wait
- zkLogin / zkDIDProof zero-knowledge proof generation or verification
- Multi-authority salt derivation
- Smart-contract registration or query

## Why "OIDC-only" is a fair lower-bound baseline

In the conventional federated-authentication setting, the relying party does
exactly the steps measured here. Because zkEHR adds privacy, key-recoverability,
and decentralized auditability *on top of* this baseline, OIDC-only acts as the
fastest reasonable comparison point.

## Project layout

```
oidc-only-baseline/
  package.json
  tsconfig.json
  .env.example
  README.md
  src/
    config.ts          # typed env loader
    types.ts           # shared types (RunRecord, EhrSession, ...)
    timer.ts           # process.hrtime.bigint()-based timing helpers
    stats.ts           # mean / p50 / p95 / p99 / std
    csv.ts             # RFC 4180 CSV writer
    oidcClient.ts      # PKCE + state + nonce + auth URL + code exchange
    jwtVerifier.ts     # JWKS fetcher (cached/uncached) + jwtVerify + claim validation
    callbackServer.ts  # one-shot Express server for /callback
    playwrightLogin.ts # IdP login automation (Google / Keycloak / generic)
    session.ts         # mock EHR session creation
    experimentFullLogin.ts
    experimentTokenReuse.ts
    index.ts           # CLI entrypoint: full | reuse | all
  results/
```

## Setup

Requires Node.js 20+.

```bash
cd oidc-only-baseline
npm install
npx playwright install --with-deps chromium
cp .env.example .env
# edit .env with your provider credentials
npm run build
```

## Configuration

All configuration goes through `.env`. See `.env.example` for inline docs.

### Option A — Local Keycloak (recommended for reproducible measurement)

Keycloak gives you full control over the login flow, accepts Playwright
automation reliably, and yields stable measurements.

```bash
docker run --rm -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:24.0 start-dev
```

In the admin console:
1. Create realm `oidc-baseline`.
2. Create client `oidc-only` (Client authentication ON, Standard flow ON,
   Valid redirect URIs `http://localhost:8765/callback`).
3. Copy the client secret into `.env`.
4. Create a user (Username + Set password, "Temporary" OFF).

`.env` keys:

```
OIDC_PROVIDER_KIND=keycloak
OIDC_ISSUER=http://localhost:8080/realms/oidc-baseline
OIDC_AUTHORIZATION_ENDPOINT=http://localhost:8080/realms/oidc-baseline/protocol/openid-connect/auth
OIDC_TOKEN_ENDPOINT=http://localhost:8080/realms/oidc-baseline/protocol/openid-connect/token
OIDC_JWKS_URI=http://localhost:8080/realms/oidc-baseline/protocol/openid-connect/certs
OIDC_CLIENT_ID=oidc-only
OIDC_CLIENT_SECRET=<from-keycloak>
OIDC_REDIRECT_URI=http://localhost:8765/callback
OIDC_TEST_USERNAME=<keycloak-user>
OIDC_TEST_PASSWORD=<keycloak-password>
```

### Option B — Google OIDC

1. In Google Cloud Console: APIs & Services → Credentials → Create OAuth 2.0
   Client ID (Web). Add `http://localhost:8765/callback` to authorized redirect URIs.
2. Use a dedicated test account that allows automation, or set `MANUAL_LOGIN=true`.

> **Heads-up:** Google blocks Playwright for many accounts ("Couldn't sign you
> in. This browser or app may not be secure"). If you hit this, set
> `MANUAL_LOGIN=true` — the browser opens visibly, you log in once per run, and
> the experiment captures the callback automatically. For 100 runs this is
> tedious; Keycloak is strongly recommended for the measured baseline.

## Running the experiments

### Recommended workflow for Google OIDC on EC2 + DCV (matches zkEHR experiments)

This baseline reuses the EC2-NICE-DCV pattern from
[`../experiments/EC2-DCV-WORKFLOW.md`](../experiments/EC2-DCV-WORKFLOW.md). All
measurement runs happen on the EC2 host (us-east-1, low-latency to Google
endpoints); your Mac is only needed for the one-time interactive Google login,
done through the DCV remote desktop.

#### One-time setup (per EC2 host)

```bash
# On EC2 (via SSH):
cd ~/oidc-only-baseline
cp .env.example .env && $EDITOR .env     # set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, etc.
npm install
npm run build
npx playwright install --with-deps chromium
```

#### One-time interactive Google sign-in (via DCV Viewer on your Mac)

DCV Viewer must be installed and the EC2 security group must allow TCP 8443.
See [`../experiments/EC2-DCV-WORKFLOW.md`](../experiments/EC2-DCV-WORKFLOW.md)
for full DCV setup. Then:

1. Connect DCV Viewer to `<ec2-host>:8443` as user `ubuntu`.
2. Inside the DCV desktop, open a terminal and run:
   ```bash
   cd ~/oidc-only-baseline
   ./run-in-dcv.sh prelogin
   ```
3. A Chromium window opens to `https://accounts.google.com/signin`.
4. **Sign in to Google manually** (including 2FA / consent).
5. Return to the terminal and press Enter — the script saves the persistent
   profile to `.chrome-profile/`.
6. Capture one verified ID token for Mode 2:
   ```bash
   ./run-in-dcv.sh prime-token
   ```
   (or run both in one shot: `./run-in-dcv.sh prime`)
7. You can now disconnect DCV Viewer.

#### Measured experiments (headless, via SSH)

```bash
ssh -i aws.pem ubuntu@<ec2-host>
cd ~/oidc-only-baseline
./run-in-dcv.sh full      # Mode 1 — silent SSO via cached profile
./run-in-dcv.sh reuse     # Mode 2 — token / session reuse
# or
./run-in-dcv.sh all       # both, in order
```

The `run-in-dcv.sh` wrapper extracts `DISPLAY` / `XAUTHORITY` from the running
DCV session via `dcv describe-session`, so Chromium attaches to the DCV X
server even when launched from a plain SSH session. With `HEADLESS=true`
(default), Chromium runs invisibly under that X server; with
`HEADLESS=false`, the windows appear inside the DCV desktop if you happen to
be connected.

If Google's session expires (~weeks for Workspace accounts, sooner for
personal), reconnect DCV and re-run `./run-in-dcv.sh prelogin`.

### Direct (non-DCV) workflow — for Keycloak or local runs

If you're running locally on macOS or Linux with a regular display, the
`run-in-dcv.sh` wrapper still works (the DCV-session lookup falls back to
your existing `DISPLAY`). Or invoke node directly:

```bash
node dist/index.js prelogin    # opens Chromium against your local display
node dist/index.js full        # measured runs
```

Output files:
- `results/oidc_only_results.csv` — Mode 1 per-run rows
- `results/oidc_only_results_reuse.csv` — Mode 2 per-run rows
- `session-cache.json` — verified ID token captured by `prime-token`
- `.chrome-profile/` — persistent Chromium profile (Google session cookie lives here)

## CSV columns

| Column | Meaning |
|---|---|
| `run_id` | Sequential run id (warm-ups are dropped) |
| `mode` | `full` or `reuse` |
| `start_time_iso` | When the run started |
| `oidc_login_ms` | Browser-side OIDC flow time (Mode 1) |
| `token_exchange_ms` | Authorization-code → token exchange (Mode 1) |
| `jwks_fetch_or_cache_ms` | JWKS retrieval (cold or cache hit, per `CACHE_JWKS`) |
| `jwt_verify_ms` | RSA/EC signature verification only |
| `claim_validation_ms` | iss / aud / exp / iat / nonce / sub checks |
| `session_create_ms` | Local EHR session object construction |
| `total_ms` | End-to-end latency (definition depends on mode) |
| `success` | `true` / `false` |
| `error_message` | Error detail when `success=false` (empty otherwise) |

## Console summary

After each mode the program prints `count / success_count / failure_count /
mean / p50 / p95 / p99 / std / min / max` for `total_ms`, plus the same set of
statistics for `oidc_login_ms`, `token_exchange_ms`, `jwt_verify_ms`, and
`session_create_ms`.

## Silent-SSO vs. fresh-login: which Mode 1 number to report

When `experiment:full` runs after `prelogin`, the OIDC `prompt=none` parameter
is sent. Chromium opens with a persistent profile that already holds Google's
session cookie (from the direct `accounts.google.com/signin` step), so the
authorization endpoint immediately redirects to `/callback`. The
`oidc_login_ms` column then measures:

- browser navigation to Google's authorization endpoint
- Google's session-state validation
- 302 redirect back to the local callback

This is the **silent-SSO baseline** — the realistic case for a clinician who
is already signed into Google in their work browser. It is the appropriate
comparison point for any zkEHR scenario that also caches an authenticated
state.

If you want **fresh-login Mode 1** numbers (cold session every run), delete
`.chrome-profile/` and re-run `experiment:full` with `MANUAL_LOGIN=true` and
DCV viewer connected — the operator logs in inside DCV for each run. Only
practical with small `RUNS` counts.

## Methodological notes for the paper

- Timing primitive: `process.hrtime.bigint()` (nanosecond resolution, divided
  to milliseconds).
- Warm-up: `WARMUP_RUNS` runs are executed before measurement and dropped from
  the CSV / statistics. Default 10.
- Per-run isolation: Mode 1 uses a fresh Playwright incognito context per run
  and the OIDC `prompt=login` parameter so each run forces a fresh
  authentication step.
- Failed runs: counted in `count` and `failure_count`, excluded from latency
  percentiles (mixing them would skew the distribution).
- JWKS caching: `CACHE_JWKS=true` (default) reflects production behavior;
  `CACHE_JWKS=false` measures cold JWKS retrieval on every run.

## Manual-login fallback

If the IdP refuses Playwright automation (typical for Google), set:

```
MANUAL_LOGIN=true
HEADLESS=false
```

The browser opens visibly per run and you complete the IdP login by hand.
The experiment captures the callback automatically and proceeds with token
exchange + verification + session creation. This is suitable for small `RUNS`
counts (e.g., 10) when you only need to validate the pipeline.

## Running on EC2

The experiment ships ready to run on Ubuntu 22.04 / 24.04 with Node 20:

```bash
# On the EC2 host:
sudo apt-get update
sudo apt-get install -y nodejs npm
npm install --no-audit --no-fund
npx playwright install --with-deps chromium
npm run build
npm run experiment:all
```

For headless runs Playwright needs the Chromium dependencies — `--with-deps`
installs them via apt.

Pull the resulting CSVs back to your laptop with `scp`:

```bash
scp -i aws.pem ubuntu@<host>:~/oidc-only-baseline/results/*.csv \
    ./verification-before-completion/
```
