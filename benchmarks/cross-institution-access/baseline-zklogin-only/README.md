# zkLogin — End-to-End Cross-Institution Access Authorization & Verification Latency

This project measures the latency of an end-to-end **cross-institution
access authorization and verification** flow when the patient identity is
managed via Sui's **zkLogin**, and the access grant is stored as an
on-chain `AccessGrant` Move object on Sui Devnet.

The code is forked from `zklogin-only-baseline` — that baseline's
`establish` mode is preserved here, plus a new **`cross-access`** mode
which is the focus of this experiment.

## What this baseline measures

> **The zkLogin cross-institution access baseline represents an
> address-based blockchain access-control model where the patient
> identity is derived from a federated OIDC login via zkLogin. In each
> measured run, the patient authenticates through zkLogin (OIDC + ZK proof
> + address derivation), creates an address-based `AccessGrant` on Sui
> Devnet via a sponsored Move call, and Hospital A then queries Sui to
> resolve the grant and verify the on-chain `AddressOwner` against the
> patient's zkLogin Sui address before creating an authorized EHR access
> session. This baseline isolates the cost of zkLogin-driven on-chain
> access control while sharing the AccessGrant Move contract with the
> ACTION-EHR-inspired sibling baseline for fair comparison.**

## Cross-institution scenario

Patient *P*'s clinical records live at Hospital *A*. *P* has a zkLogin
identity bound to their Google account; the zkLogin signature derives a
Sui address that becomes *P*'s on-chain identity (the "P-DID" referred
to in the experiment brief). *P* wants Hospital *B* to read EHR record
`ehr_record_001` held at Hospital *A*.

```
                                    ┌────────────────────────────────────────┐
                                    │ Sui Devnet                             │
                                    │   AccessGrant {                        │
+-------+   zkLogin tx (sponsored)  │     patient_id  = P.zkLogin_addr  ←────┼──── on-chain owner
| P     │ ────────────────────────▶ │     data_holder = A_id                 │   = P.zkLogin_addr
|       │   create_access_grant     │     grantee     = B_id, B_addr         │
+-------+                           │     scope, ehr_record_id, exp, active  │
                                    │   }                                    │
                                    └────────────────────────────────────────┘
+-------+   request(grant_id, …)    +-------+   getObject(grant_id)
| B     │ ────────────────────────▶ |   A   │ ──────────────────────────▶ Sui Devnet
+-------+                           |       │                              │
                                    |       │ ◀─────────────────── parse, verify status,
                                    |       │     scope, expiration, AND
                                    |       │     on_chain_owner == P.zkLogin_addr
                                    +-------+
```

The "address-based authorization check" is the **single equality**

```
AccessGrant.on_chain_owner  ==  P.zkLogin_address  ==  AccessGrant.patient_id
```

Sui's transaction-validation rules already enforce that *only* a valid
zkLogin signature for `P.zkLogin_address` could have minted the grant
(it's the `tx_context::sender(ctx)` of the `create_access_grant` call) —
so this single equality is the proof Hospital A needs that the grant
came from the patient.

## Per-run flow (timed)

### Grant phase (`grant_total_ms`)

| Step | Column |
|---|---|
| Generate ephemeral Ed25519 keypair | `ephemeral_keygen_ms` |
| Fetch current Sui epoch | `epoch_fetch_ms` |
| Generate randomness | `randomness_ms` |
| Compute zkLogin nonce | `nonce_compute_ms` |
| OIDC implicit-flow login (silent SSO via primed Chromium profile) | `oidc_login_ms` |
| Decode JWT (sub, aud, iss, nonce check) | `jwt_decode_ms` |
| Single-authority salt derivation | `salt_fetch_ms` |
| Compute zkLogin Sui address | `address_compute_ms` |
| POST to Mysten devnet prover for Groth16 ZK proof | `prover_request_ms` |
| Build sponsored `access_grant::create_access_grant` tx | `tx_build_ms` |
| Assemble zkLogin signature | `zklogin_sig_assemble_ms` |
| Submit tx (`WaitForEffectsCert`) | `tx_submit_ms` |
| Extract created AccessGrant id from objectChanges | `object_extract_ms` |
| Persist grant metadata locally | `local_store_ms` |

### Access phase (`access_total_ms`)

| Step | Column |
|---|---|
| Hospital B builds the access request | `request_construct_ms` |
| Hospital A queries Sui Devnet for the AccessGrant | `blockchain_query_ms` |
| Hospital A parses the on-chain fields | `grant_object_parse_ms` |
| Status check (`active`, `patient_id`, `data_holder`, `grantee_id`, `grantee_address`) | `status_check_ms` |
| Scope + record check | `scope_check_ms` |
| Expiration check | `expiration_check_ms` |
| **zkLogin/address-based authorization check** | `address_authorization_check_ms` |
| Create authorized EHR access session | `access_session_create_ms` |

`total_ms = grant_total_ms + access_total_ms`.

## What is intentionally excluded

- ZK proof *verification* by Hospital A (Sui validators already verified
  the proof at submission time; A only verifies the *consequence* — that
  the on-chain owner matches the claimed patient address).
- Multi-authority salt derivation (this baseline uses single-authority).
- Keyless DID recovery (zkLogin already provides keyless recovery via
  re-running the OIDC flow; no extra primitive is on the critical path).
- zkEHR-specific consent encoding.

## Configuration

Existing zkLogin baseline env vars (`SUI_PRIVATE_KEY`, `SUI_PACKAGE_ID`,
`OIDC_CLIENT_ID`, `ZK_PROVER_URL`, `SALT_SECRET`, `MAX_EPOCH_DELTA`, etc.)
all apply. `SUI_PACKAGE_ID` is **expected to point at the deployed
`access_grant` Move package** (the same one the ACTION-EHR-inspired
sibling project deploys). Override via `ACCESS_GRANT_PACKAGE_ID` if you
want it separate from `SUI_PACKAGE_ID`.

New env vars (all optional with safe defaults):

| Var | Default | Meaning |
|---|---|---|
| `ACCESS_GRANT_PACKAGE_ID` | `SUI_PACKAGE_ID` | published id of the `access_grant` Move package |
| `HOSPITAL_A_ID` | `hospital_A` | logical id baked into every grant + access request |
| `HOSPITAL_A_ADDRESS` | `0xaa..aa` (32 bytes) | Hospital A Sui address |
| `HOSPITAL_B_ID` | `hospital_B` | logical id of the grantee institution |
| `HOSPITAL_B_ADDRESS` | `0xbb..bb` (32 bytes) | Hospital B Sui address |
| `DEFAULT_EHR_RECORD_ID` | `ehr_record_001` | record id encoded in the grant |
| `DEFAULT_SCOPE` | `read` | scope encoded in the grant |
| `DEFAULT_EXPIRATION_SECONDS` | `3600` | grant TTL |
| `STORE_GRANTS_IN` | `data/access_grants.json` | grant audit log |
| `STORE_REQUESTS_IN` | `data/access_requests.json` | request audit log |

## Running

```bash
# On EC2:
cd ~/zklogin-only-cross-institution-access

# One-time setup (only needed if Chromium profile not primed):
./run-in-dcv.sh prelogin
./run-in-dcv.sh prime-consent

# Measured experiment:
npm install
npm run build
./run-in-dcv.sh cross-access   # 100 measured + 10 warmup runs
```

Output CSV: `results/zklogin_cross_institution_access_results.csv`.

Pull back via:

```bash
scp -i aws.pem ubuntu@<host>:~/zklogin-only-cross-institution-access/results/zklogin_cross_institution_access_results.csv ./
```
