# Private-Key DID/VC — End-to-End Cross-Institution Access Latency

This project measures the latency of an end-to-end **cross-institution
access authorization and verification** flow using the conventional
private-key DID/VC model on Sui Devnet. It is the DID/VC comparison point
for the OIDC-only and zkEHR variants of the same experiment.

The code is forked from the sibling `private-key-did-vc-sui-devnet`
project — all of that baseline's modes (`establish`, `auth`, `vc`) are
still available here, plus a new **`cross-access`** mode which is the
focus of this experiment.

## Experiment flow

Each measured run executes the following two phases.

### Grant phase (patient side, fully local — no chain, no network)

1. **Patient builds the consent VC payload.**
   Constructs a W3C VC Data Model 1.1 envelope with:
   `issuer = patient DID`, `issuer_sui_object_id = <patient DIDObject id>`,
   `credentialSubject.id = Hospital B id`, `credentialSubject.scope = ehr.read`,
   `issuanceDate`, `expirationDate`, `jti`.
   → measured as `consent_payload_build_ms`.

2. **Patient signs the VC with their DID Ed25519 private key.**
   Detached Ed25519 signature over the canonicalized JSON payload.
   → measured as `consent_sign_ms`.

**`grant_total_ms`** = `consent_payload_build_ms + consent_sign_ms`.

### Access phase (Hospital B → Hospital A)

3. **Hospital B presents the signed consent / VC to Hospital A.**
   Wire-format serialization of the signed VC (`JSON.stringify`).
   → `consent_present_ms`.

4. **Hospital A receives + parses the presentation.**
   `JSON.parse` of the wire payload.
   → `consent_receive_ms`.

5. **Hospital A resolves the patient's DID on Sui Devnet.**
   `getObject` RPC against `fullnode.devnet.sui.io` for the DIDObject
   referenced in the VC's `issuer_sui_object_id`.
   → `did_resolve_devnet_ms`.

6. **Hospital A parses the on-chain DIDObject fields.**
   Decode `did`, `public_key`, `active`. Reject inactive DIDs and
   DID-string mismatches.
   → `did_object_parse_ms`.

7. **Hospital A verifies the Ed25519 signature.**
   `ed25519.verify(sig, canonical_bytes, on_chain_public_key)`.
   → `signature_verify_ms`.

8. **Hospital A checks consent claims.**
   Scope match + expiration in the future + grantee_id matches Hospital B
   + patient_did consistency.
   → `scope_expiration_check_ms`.

**`access_total_ms`** = `consent_present_ms + consent_receive_ms +
did_resolve_devnet_ms + did_object_parse_ms + signature_verify_ms +
scope_expiration_check_ms`.

**`total_ms`** = `grant_total_ms + access_total_ms`.

## What this experiment intentionally excludes

To remain a fair comparison with both the OIDC-only and zkEHR variants,
**none** of the following are included on the critical path of the
measured flow:

- DID establishment cost (treated separately by `experiment:establish`;
  here we reuse the 100 already-registered DIDs from `data/dids.json`).
- ZK proof generation / verification.
- Multi-authority salt derivation or threshold signatures.
- OIDC federated login (the DID/VC model assumes the patient already
  controls the DID's private key offline — no IdP involvement).
- Holder Binding (Hospital B doesn't sign a separate presentation; the
  VC is presented as-is). Modeling holder binding would add one more
  Ed25519 verify on Hospital A's side.

## Trust model summary

| Variant | Who proves consent? | Who Hospital A trusts | What it costs |
|---|---|---|---|
| OIDC-only | Centralized DB at Hospital A | Pre-registered Hospital B JWK | ~0.7 ms (in-process) |
| **DID/VC (this)** | **Patient signs a portable VC** | **On-chain patient DID public key** | **dominated by 1 chain RPC** |
| zkEHR (target) | Patient via zkProof of grant | Smart-contract-verified proof | TBD |

## Project layout (delta from the baseline)

```
private-key-did-vc-cross-access/
  src/
    consentVc.ts                          # NEW — consent VC build/sign/present/verify
    csvCrossAccess.ts                     # NEW — CSV writer for the extended row layout
    experimentCrossInstitutionAccess.ts   # NEW — Mode 4 orchestrator
    types.ts                              # extended: CrossAccessRunRecord
    index.ts                              # extended: 'cross-access' command
  data/
    wallets.json                          # 100 reused patient wallets
    dids.json                             # 100 reused on-chain DIDObjects
  results/
    private_key_did_vc_cross_institution_access_results.csv  # output
```

## CSV columns

| Column | Phase | Meaning |
|---|---|---|
| `run_id` | — | sequential run id (warm-ups dropped) |
| `mode` | — | always `cross-access` for this CSV |
| `start_time_iso` | — | run start |
| `consent_payload_build_ms` | grant | step 1 — build VC envelope |
| `consent_sign_ms` | grant | step 2 — Ed25519 sign |
| `grant_total_ms` | grant | sum of the two grant-phase columns above |
| `consent_present_ms` | access | step 3 — JSON.stringify by Hospital B |
| `consent_receive_ms` | access | step 4 — JSON.parse by Hospital A |
| `did_resolve_devnet_ms` | access | step 5 — Sui Devnet `getObject` RPC |
| `did_object_parse_ms` | access | step 6 — decode on-chain fields |
| `signature_verify_ms` | access | step 7 — Ed25519 verify |
| `scope_expiration_check_ms` | access | step 8 — scope + exp + grantee + patient consistency |
| `access_total_ms` | access | sum of the six access-phase columns above |
| `total_ms` | both | `grant_total_ms + access_total_ms` |
| `sui_object_id` | — | on-chain DIDObject id used in this run |
| `patient_did` | — | DID string used in this run |
| `success` | — | `true` / `false` |
| `error_message` | — | non-empty on failed runs |

## Configuration

All env vars from the baseline (`SUI_RPC_URL`, `SUI_PRIVATE_KEY`,
`SUI_PACKAGE_ID`, `RUNS`, `WARMUP_RUNS`, etc.) apply.
New env vars introduced by this mode (all optional):

| Var | Default | Meaning |
|---|---|---|
| `HOSPITAL_B_ID` | `hospital-b` | grantee institution id baked into the consent VC |
| `CROSS_ACCESS_SCOPE` | `ehr.read` | scope embedded in the VC |
| `CONSENT_TTL_SECONDS` | `86400` (24h) | VC lifetime in seconds |

## Running

The DID pool is already populated in `data/dids.json` (100 DIDs registered
on Sui Devnet via the parent baseline). Just build and run:

```bash
# On EC2:
cd ~/private-key-did-vc-cross-access
npm install
npm run build
node dist/index.js cross-access
```

The CSV is written to
`results/private_key_did_vc_cross_institution_access_results.csv`.
