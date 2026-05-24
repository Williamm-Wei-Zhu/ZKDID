# OIDC-Only — End-to-End Cross-Institution Access Authorization & Verification Latency

This project measures the latency of an end-to-end **cross-institution
access authorization and verification** flow under a pure-OIDC baseline (no
DIDs, no VCs, no zk-proofs, no blockchain). It is the OIDC-only comparison
point for the corresponding zkEHR experiment.

The code is forked from the sibling `oidc-only-baseline` project — all of
that baseline's modes (`full`, `reuse`) are still available here, plus a new
**`cross-access`** mode which is the focus of this experiment.

## Experiment flow

Each measured run executes the following two phases. The same `RUNS=100`
warm-up & isolation discipline as the original baseline applies.

### Grant phase (Hospital A side)

1. **Patient logs into Hospital A's consent portal with OIDC.**
   Browser navigates to the IdP, consent portal receives the redirect,
   exchanges the authorization code for tokens.
   → measured as `oidc_login_ms` + `token_exchange_ms`.

2. **Hospital A verifies the patient's JWT.**
   JWKS resolve, RSA/EC signature verify, and OIDC claim validation
   (`iss`/`aud`/`exp`/`iat`/`nonce`/`sub`) — exactly as the baseline does.
   Hospital A then constructs a local EHR session.
   → `jwks_fetch_or_cache_ms`, `jwt_verify_ms`, `claim_validation_ms`,
     `session_create_ms`.

3. **Patient creates a centralized consent grant for Hospital B.**
   The authenticated patient session writes a `(patient_iss, patient_sub,
   grantee_institution_id, scope, expires_at)` row to Hospital A's
   in-memory consent database.
   → `consent_create_ms`.

**`grant_total_ms`** = `oidc_login_ms` + `token_exchange_ms` +
`jwks_fetch_or_cache_ms` + `jwt_verify_ms` + `claim_validation_ms` +
`session_create_ms` + `consent_create_ms`.

### Access phase (Hospital B → Hospital A)

4. **Hospital B requests access.**
   Hospital B (which holds a long-lived ES256 institutional keypair pre-
   registered with Hospital A) builds and signs a JWT bearer assertion
   (`iss=hospital-b`, `aud=hospital-a`, `sub=<patient sub>`,
   `patient_iss=<patient iss>`, `scope=ehr.read`, `iat`, `exp`, `jti`).
   → `b_request_build_ms`.

5. **Hospital A verifies Hospital B's identity.**
   Decode the request `iss`, look up the registered public JWK,
   verify the signature with `jose.jwtVerify` (also enforces `iss`/`aud`/
   `exp`), and validate the request payload (`sub`, `patient_iss`, `scope`,
   `jti`).
   → `a_verify_b_jwt_ms`.

6. **Hospital A checks its consent database.**
   Map lookup keyed on `(patient_iss, patient_sub, grantee_id, scope)`
   plus an `exp` check. Returns the matching grant or null.
   → `a_consent_lookup_ms`.

**`access_total_ms`** = `b_request_build_ms` + `a_verify_b_jwt_ms` +
`a_consent_lookup_ms`.

**`total_ms`** = `grant_total_ms` + `access_total_ms` (recorded for
completeness; the paper reports the two phase totals separately).

## What this experiment intentionally excludes

To remain a fair OIDC-only comparison point, **none** of the following are
included on the critical path of the measured flow:

- DID creation / resolution; verifiable credential issuance / presentation.
- Blockchain state queries or finality wait.
- ZK proof generation / verification.
- Multi-authority salt derivation or threshold signatures.
- Smart-contract registration of consent grants.

Hospital A's consent database is a single in-process `Map`. Inter-institution
trust is bootstrapped via a static institution registry (a `Map<id, JWK>`).
This matches what production EHR / HIE federations actually do today when
no decentralized identity layer is involved.

## Project layout (delta from the baseline)

```
oidc-only-cross-institution-access/
  src/
    consentDb.ts                          # NEW — in-memory consent registry
    hospitalA.ts                          # NEW — RP + institution registry + consent verifier
    hospitalB.ts                          # NEW — institutional ES256 keypair + JWT bearer assertion
    csvCrossAccess.ts                     # NEW — CSV writer for the extended row layout
    experimentCrossInstitutionAccess.ts   # NEW — Mode 3 orchestrator
    types.ts                              # extended: CrossAccessRunRecord, ConsentGrant
    index.ts                              # extended: 'cross-access' command
  results/
    cross_institution_access_results.csv  # output (created at run time)
```

## CSV columns (`results/cross_institution_access_results.csv`)

| Column | Phase | Meaning |
|---|---|---|
| `run_id` | — | sequential run id (warm-ups dropped) |
| `mode` | — | always `cross-access` for this CSV |
| `start_time_iso` | — | run start |
| `oidc_login_ms` | grant | step 1 — browser OIDC flow |
| `token_exchange_ms` | grant | step 1 — code → token |
| `jwks_fetch_or_cache_ms` | grant | step 2 — JWKS resolve |
| `jwt_verify_ms` | grant | step 2 — signature verify |
| `claim_validation_ms` | grant | step 2 — iss/aud/exp/iat/nonce/sub |
| `session_create_ms` | grant | step 2 — Hospital A EHR session create |
| `consent_create_ms` | grant | step 3 — write consent grant to DB |
| `grant_total_ms` | grant | sum of the seven grant-phase columns above |
| `b_request_build_ms` | access | step 4 — Hospital B builds + signs JWT |
| `a_verify_b_jwt_ms` | access | step 5 — Hospital A verifies B's JWT |
| `a_consent_lookup_ms` | access | step 6 — consent DB Map lookup |
| `access_total_ms` | access | sum of the three access-phase columns above |
| `total_ms` | both | `grant_total_ms + access_total_ms` |
| `success` | — | `true` / `false` |
| `error_message` | — | non-empty on failed runs |

## Configuration

All env vars from the baseline (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, etc.) apply.
New env vars introduced by this mode (all optional):

| Var | Default | Meaning |
|---|---|---|
| `HOSPITAL_A_ID` | `hospital-a` | logical identifier for Hospital A (used as `aud` in B's JWT) |
| `HOSPITAL_B_ID` | `hospital-b` | logical identifier for Hospital B (used as `iss` in B's JWT) |
| `CROSS_ACCESS_SCOPE` | `ehr.read` | scope embedded in the consent grant + B's request |
| `CONSENT_TTL_MS` | `86400000` (24h) | grant lifetime |
| `OUTPUT_CSV_CROSS_ACCESS` | `results/cross_institution_access_results.csv` | output path |

## Running on EC2 (matches the existing baseline workflow)

Once the Chromium profile is primed and `prime-token` has captured a
verified ID token (one-time, via DCV; see the parent baseline's README):

```bash
# On EC2:
cd ~/oidc-only-cross-institution-access
npm install
npm run build
./run-in-dcv.sh cross-access
```

Pull the result CSV back:

```bash
scp -i aws.pem ubuntu@<host>:~/oidc-only-cross-institution-access/results/cross_institution_access_results.csv ./
```

## Why each step is fairly attributable to "OIDC-only"

| Step | Why it belongs in the OIDC-only flow |
|---|---|
| Patient OIDC login + token exchange | Standard OIDC flow — every federated authentication does this. |
| JWKS resolve + JWT verify + claim validation | The relying party's required cryptographic + claim work for any OIDC token. |
| Local EHR session create | Conventional RP behavior after federated login. |
| Consent grant create (in-process Map) | Modeling a centralized consent registry — the lower-bound implementation that exists in real OIDC-only HIE deployments. |
| Hospital B builds JWT bearer assertion | RFC 7523 — the standard OIDC/OAuth2 mechanism for service-to-service auth. |
| Hospital A verifies the assertion | Standard JWS signature verify against a pre-registered public key + iss/aud/exp checks. |
| Hospital A consent DB lookup | Map lookup — the lower-bound for "is consent on record?". |

Anything *more* expensive (DID resolve, blockchain query, zk verify) would
be added on top of this baseline; the difference between this baseline and
the zkEHR variant *is* the contribution of zkEHR's added security layer.
