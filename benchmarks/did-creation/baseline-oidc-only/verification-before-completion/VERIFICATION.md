# OIDC-Only Baseline — Verification Report

Date: 2026-05-01
Target host: `ubuntu@ec2-52-23-177-7.compute-1.amazonaws.com`
Local project: `/Users/zhuwei/Documents/10-code/zkdid-patient/oidc-only-baseline`
Reference pattern: `/Users/zhuwei/Documents/10-code/zkdid-patient/experiments/`

## Workflow (mirrors zkEHR experiments/EC2-DCV-WORKFLOW.md)

The OIDC-only baseline now uses the same DCV-based remote-execution pattern
as the existing zkEHR experiments:

| Stage | Where | What |
|---|---|---|
| 1. EC2 setup | SSH | `npm install && npm run build && npx playwright install --with-deps chromium`; populate `.env` |
| 2. Interactive Google sign-in | DCV Viewer on Mac → DCV desktop on EC2 | `./run-in-dcv.sh prelogin` opens Chromium directly to `accounts.google.com/signin`; operator signs in; profile saved to `.chrome-profile/` |
| 3. Capture verified ID token for Mode 2 | SSH | `./run-in-dcv.sh prime-token` (or do 2+3 via `prime`) |
| 4. Measured runs (100×) | SSH (no DCV needed) | `./run-in-dcv.sh full` and `./run-in-dcv.sh reuse` |
| 5. Sync results | Mac | `scp -i aws.pem ubuntu@<host>:~/oidc-only-baseline/results/*.csv ./verification-before-completion/` |

DCV Viewer is **only** required for stage 2. After the persistent
`.chrome-profile/` exists, all measured runs are headless (or headed inside
DCV if you happen to be watching) and reuse the cached Google session cookie
via OIDC `prompt=none`.

## Architectural changes since the last revision

| Change | Reason |
|---|---|
| `chromium.launchPersistentContext(.chrome-profile)` replaces `launch + newContext({storageState})` | Persistent profiles preserve full Chromium state including device-trust signals — Google distinguishes between the two, and the profile approach is what zkEHR's experiments already use successfully |
| Prelogin opens `accounts.google.com/signin` directly (not OAuth) | Google's anti-automation heuristic flags Playwright's *redirected* arrival at the sign-in page; a direct visit is treated as a normal human session |
| Stealth: `--disable-blink-features=AutomationControlled`, no `--enable-automation`, init-script erases `navigator.webdriver` | Mirrors `experiments/run.mjs` and `experiments/prelogin.mjs` |
| Wrapper script `run-in-dcv.sh` reads `dcv describe-session` for DISPLAY/XAUTHORITY | Same pattern as `experiments/run-in-dcv.sh`; works whether invoked from DCV terminal or SSH |
| CLI commands renamed to `prelogin`, `prime-token`, `prime`, `full`, `reuse`, `all` | Matches the zkEHR `--prelogin` style |

## What was verified on EC2

| Item | Result |
|---|---|
| `npm install` (85 packages) | OK |
| `npm run build` (TypeScript strict) | OK, 0 errors |
| Smoke test — 20 unit checks (timer / PKCE / claims / stats / CSV) | 20/20 PASS — `ec2-smoke-output-after-prime.log` |
| DCV session detection (`dcv describe-session desktop`) | OK — DISPLAY=`:1`, XAUTH=`/run/user/1000/dcv/desktop.xauth` |
| Headed Chromium launch under DCV with full stealth flags | OK, 2.0s for launch+navigate+close — `ec2-dcv-probe.log` |
| `./run-in-dcv.sh full` without `.env` | Clear error: `Missing required env var: OIDC_ISSUER` (exit=1) |
| Wrapper sets DISPLAY/XAUTHORITY from DCV | OK — `[dcv-wrap] attaching to session 'desktop' on DISPLAY=:1` |

## OIDC credentials inherited from zkEHR

`OIDC_CLIENT_ID` is set to the same Google OAuth client zkEHR uses, found in
[`zklogin/polymedia-zklogin-demo/web/src/config.json`](../../zklogin/polymedia-zklogin-demo/web/src/config.json):

```
OIDC_CLIENT_ID=1097270208419-gpj4s5u9tcf76mblvrf0ehlotjifs08o.apps.googleusercontent.com
OIDC_REDIRECT_URI=http://localhost:1234
CALLBACK_PORT=1234
```

A real `.env` with these values has been written to both
`./oidc-only-baseline/.env` (Mac) and `~/oidc-only-baseline/.env` (EC2).

### One missing piece: `OIDC_CLIENT_SECRET`

zkEHR uses Google's **implicit flow** (`response_type=id_token`) which never
hits the token endpoint, so it has no Google client_secret in its config.
The OIDC-only baseline uses the **authorization-code flow with PKCE** (per
the spec), which Google's "Web application" client type *does* require a
secret for. I confirmed this with a direct probe:

```
$ curl -X POST https://oauth2.googleapis.com/token \
    -d grant_type=authorization_code -d client_id=...gpj4s5u9... \
    -d code=fake -d code_verifier=fake -d redirect_uri=http://localhost:1234
HTTP 400
{ "error": "invalid_request", "error_description": "client_secret is missing." }
```

Full probe output saved at `ec2-token-endpoint-probe.log`.

**Action for the user (one-time, ~30 seconds):**

1. Open Google Cloud Console → APIs & Services → Credentials
2. Click the OAuth 2.0 Client whose ID begins with
   `1097270208419-gpj4s5u9tcf76mblv...`
3. Click "Show client secret" (or copy the existing one)
4. On EC2, edit `~/oidc-only-baseline/.env` and set:
   ```
   OIDC_CLIENT_SECRET=<paste from console>
   ```

After this, `prelogin` and `prime-token` should run end-to-end without any
further changes.

### Port-conflict reminder

`OIDC_REDIRECT_URI=http://localhost:1234` matches the URI registered with
the existing OAuth client (zkEHR uses `window.location.origin`, which is
`http://localhost:1234` for the Vite dev server). The OIDC-only callback
server therefore binds port 1234.

**Stop the zkEHR dev stack (Vite + bridge) before running OIDC-only
experiments**, otherwise the callback server will fail to bind. If you
need to run both side-by-side, either change the OIDC-only callback port
*and* add the new redirect URI to the OAuth client, or use a separate
EC2 host.

## What was verified end-to-end

| Item | Result |
|---|---|
| `npm install` (85 packages) | OK |
| `npm run build` (TypeScript strict) | OK, 0 errors |
| Smoke test — 20 unit checks (timer / PKCE / claims / stats / CSV) | 20/20 PASS — `ec2-smoke-final.log` |
| DCV session detection (`dcv describe-session desktop`) | OK — DISPLAY=`:1`, XAUTH=`/run/user/1000/dcv/desktop.xauth` |
| Headed Chromium launch under DCV with full stealth flags | OK, 2.0s for launch+navigate+close — `ec2-dcv-probe.log` |
| `.env` loads correctly on EC2 with zkEHR-inherited values | OK — config-load probe shows correct client_id, redirect_uri, port |
| Google token endpoint reachable from EC2 | OK — TLS handshake succeeds, returns structured error |
| Specific failure mode without secret | Confirmed — `HTTP 400 invalid_request: client_secret is missing.` |

## Remaining steps for the user

After adding `OIDC_CLIENT_SECRET` to `.env` on EC2:

1. **Connect DCV Viewer** to `<ec2-host>:8443` (security group must allow
   TCP 8443 from your IP). See `../experiments/EC2-DCV-WORKFLOW.md`.
2. **Inside the DCV desktop**, open a terminal:
   ```
   cd ~/oidc-only-baseline
   ./run-in-dcv.sh prelogin     # interactive Google sign-in
   ./run-in-dcv.sh prime-token  # captures verified ID token
   ```
3. **Disconnect DCV. Back on plain SSH:**
   ```
   ./run-in-dcv.sh full
   ./run-in-dcv.sh reuse
   ```
4. **Pull results to Mac:**
   ```
   scp -i aws.pem ubuntu@<host>:~/oidc-only-baseline/results/*.csv \
       ./verification-before-completion/
   ```

## Honest caveats for the paper

1. **Silent-SSO baseline.** Mode 1 in primed mode measures the silent-SSO
   round-trip (cached Google cookie + `prompt=none`). This is the realistic
   case for a clinician already signed into Google. Report this as the
   "OIDC silent-SSO latency" — not "OIDC fresh-login latency".
2. **Browser overhead.** `oidc_login_ms` includes Playwright per-page setup
   (~50–200ms) and a single navigation. Chromium itself is launched once per
   experiment invocation and reused via fresh pages within one persistent
   context.
3. **Excluded from this baseline by design:** DID, VC, blockchain, zkLogin,
   zkDIDProof, salt derivation, smart-contract registration. This is the
   lower-bound federated baseline.
4. **Network locality.** Measurements run from EC2 us-east-1, the same
   region as Google's OAuth endpoints — minimizing cross-region RTT and
   matching the network locality of the zkEHR experiments.

## Files in this folder

- `VERIFICATION.md` — this file.
- `ec2-smoke-output.log` — initial smoke output (pre-prelogin refactor).
- `ec2-smoke-output-after-prime.log` — smoke output after the persistent-profile refactor.
- `ec2-smoke.csv` — round-tripped CSV from EC2 build.
- `smoke-test.mjs` — provider-independent unit smoke test.
- `dcv-probe.sh` — non-interactive DCV detection + headed Chromium launch probe.
- `ec2-dcv-probe.log` — captured probe output proving DCV + Chromium work end-to-end on this host.
