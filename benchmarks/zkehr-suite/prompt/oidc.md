You are helping me implement an experimental baseline for an academic paper targeting IEEE Transactions on Services Computing.

The baseline is called: OIDC-only using Google OpenID Connect.

Context:
I am evaluating zkEHR, a keyless and unlinkable decentralized identity architecture for EHR sharing. I need an OIDC-only baseline using Google OpenID Connect to measure the latency of conventional federated authentication without DID, blockchain, zero-knowledge proof, multi-authority salt, or zkLogin.

Use Google OpenID Connect specifically.

Google OIDC configuration:
Use Google's OpenID Connect discovery document:

https://accounts.google.com/.well-known/openid-configuration

The program should automatically fetch the Google OIDC metadata from the discovery document, including:
- authorization_endpoint
- token_endpoint
- jwks_uri
- issuer

Expected issuer:
https://accounts.google.com

OIDC provider:
Google

Protocol:
OpenID Connect Authorization Code Flow with PKCE.

Goal:
Measure the time from the beginning of a Google OIDC login flow to the point where the EHR service has verified the Google ID token and created a local authenticated session.

Functional endpoint:
The experiment should stop when the system obtains a verified Google OIDC identity/session usable by an EHR service for later access decisions.

OIDC-only workflow to implement:
1. Start a Google OIDC authorization-code flow with PKCE.
2. Redirect the browser to Google's authorization endpoint.
3. Complete Google login using Playwright.
4. Receive the authorization code at a local callback server.
5. Exchange the authorization code for Google tokens.
6. Extract the Google ID token.
7. Verify the ID token signature using Google's JWKS.
8. Validate standard OIDC claims:
   - issuer / iss must be https://accounts.google.com
   - audience / aud must equal GOOGLE_CLIENT_ID
   - expiration / exp
   - issued-at / iat if available
   - nonce if used
   - subject / sub exists
   - email if scope includes email
9. Create a local mock EHR session object.
10. Stop the timer.
11. Record the latency result.

Please implement the project with:
- Node.js 20+
- TypeScript
- Playwright
- jose for JWT/JWKS verification
- express or fastify for the local callback server
- dotenv for configuration
- csv output for experiment results

The program should support two modes:

Mode 1: Full Google OIDC login mode
- Measures full Google OIDC login + authorization-code callback + token exchange + Google ID-token verification + session creation.
- This is the main OIDC-only identity-establishment latency.

Mode 2: Google ID-token/session reuse mode
- Uses an already obtained unexpired Google ID token or cached local session.
- Measures only local Google ID-token verification + claim validation + local session creation.
- This represents repeated OIDC use under an unexpired token/session.

Important fairness requirement:
Do not include DID creation, VC issuance, blockchain registration, blockchain transaction finality, ZK proof generation, salt derivation, zkLogin, zkDIDProof, or any zkEHR-specific logic in this baseline.

Google OAuth / OIDC setup assumptions:
I will create a Google OAuth 2.0 Client ID in Google Cloud Console.

The application type should be:
Web application

Authorized redirect URI should be:
http://localhost:3000/callback

Required scopes:
openid email profile

Create a .env.example file with these variables:
GOOGLE_OIDC_DISCOVERY_URL=https://accounts.google.com/.well-known/openid-configuration
GOOGLE_ISSUER=https://accounts.google.com
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/callback
GOOGLE_SCOPE=openid email profile
GOOGLE_TEST_EMAIL=your_test_google_email_here
GOOGLE_TEST_PASSWORD=your_test_google_password_here
RUNS=100
WARMUP_RUNS=10
OUTPUT_CSV=results/google_oidc_only_results.csv
HEADLESS=false
CACHE_JWKS=true
MANUAL_LOGIN=true
TOKEN_CACHE_FILE=results/google_token_cache.json

Important note about Google login automation:
Google may block fully automated username/password login because of anti-bot detection, MFA, passkeys, or security checks. Therefore, implement manual-login mode as the default.

Manual-login mode:
1. The program opens a visible Playwright browser window.
2. The user manually completes Google login.
3. The local callback server captures the authorization code.
4. The program exchanges the code for tokens.
5. The program verifies the ID token and records latency.
6. The program stores the ID token and metadata in TOKEN_CACHE_FILE for reuse-mode experiments, if still unexpired.

Optional automated-login mode:
You may include a best-effort Playwright login helper using GOOGLE_TEST_EMAIL and GOOGLE_TEST_PASSWORD, but the README must clearly warn that automated Google login may fail and manual-login mode is recommended.

Project structure:
Please create a clean project like this:

google-oidc-only-baseline/
  package.json
  tsconfig.json
  .env.example
  README.md
  src/
    config.ts
    types.ts
    timer.ts
    stats.ts
    csv.ts
    googleDiscovery.ts
    oidcClient.ts
    jwtVerifier.ts
    callbackServer.ts
    playwrightGoogleLogin.ts
    tokenCache.ts
    session.ts
    experimentFullLogin.ts
    experimentTokenReuse.ts
    index.ts
  results/
    .gitkeep

Measurement requirements:
For each run, record:
- run_id
- mode
- start_time_iso
- google_auth_browser_ms
- callback_wait_ms
- token_exchange_ms
- jwks_fetch_or_cache_ms
- jwt_verify_ms
- claim_validation_ms
- session_create_ms
- total_ms
- success
- error_message

For Mode 1:
total_ms should include:
- opening Google authorization URL
- browser/manual Google login
- callback handling
- token exchange
- Google ID-token verification
- claim validation
- local EHR session creation

For Mode 2:
total_ms should include only:
- reading cached unexpired Google ID token
- Google ID-token verification
- claim validation
- local EHR session creation

Statistics:
After all runs, print:
- count
- success_count
- failure_count
- mean
- p50
- p95
- p99
- standard deviation
for total_ms.

Also compute the same statistics for:
- google_auth_browser_ms
- token_exchange_ms
- jwt_verify_ms
- session_create_ms

Implementation details:
1. Use performance.now() or process.hrtime.bigint() for precise timing.
2. Use a warm-up phase before measured runs.
3. Fetch Google OIDC metadata from:
   https://accounts.google.com/.well-known/openid-configuration
4. Use Google's jwks_uri from the discovery document.
5. Make JWKS caching configurable:
   - If CACHE_JWKS=true, fetch/cache Google's JWKS once and reuse it.
   - If CACHE_JWKS=false, fetch JWKS for every run.
6. Generate a fresh state, nonce, and PKCE verifier/challenge for each full-login run.
7. Verify state in the callback.
8. Verify nonce in the ID token.
9. Validate Google ID token:
   - iss equals https://accounts.google.com
   - aud equals GOOGLE_CLIENT_ID
   - exp is valid
   - sub exists
   - email exists when scope includes email
10. Create a mock local EHR session object after verification:
   {
     sessionId,
     provider: "google",
     sub,
     email,
     createdAt
   }
11. Record failed runs in CSV and continue.
12. Do not crash the entire experiment after one failed run.

Playwright behavior:
Manual-login mode:
- Launch browser with headless=false.
- Navigate to the Google authorization URL.
- Wait for redirect to GOOGLE_REDIRECT_URI.
- The user completes login manually.
- The callback server resolves the authorization code.

Automated-login mode:
- Implement best-effort selectors for Google email/password pages.
- Use GOOGLE_TEST_EMAIL and GOOGLE_TEST_PASSWORD.
- Add clear comments that these selectors may break and Google may block automation.
- If automated login fails, show a helpful error suggesting MANUAL_LOGIN=true.

Command-line interface:
Implement commands:
- npm run build
- npm run experiment:full
- npm run experiment:reuse
- npm run experiment:all

README.md should explain:
1. What this Google OIDC-only baseline measures.
2. Why Google OIDC-only is a lower-bound federated-authentication baseline.
3. How to create a Google OAuth 2.0 Web Application client.
4. How to set the authorized redirect URI:
   http://localhost:3000/callback
5. How to configure .env.
6. How to run full Google login experiments.
7. Why manual-login mode is recommended for Google.
8. How to run token/session reuse experiments using TOKEN_CACHE_FILE.
9. How to interpret the CSV results.
10. What is intentionally excluded from the baseline:
   - DID
   - VC
   - blockchain
   - Sui
   - zkLogin
   - zkDIDProof
   - salt derivation
   - smart contract registration

Please also include this academic paragraph in README.md:

"The Google OIDC-only baseline implements a standard federated authentication workflow using Google OpenID Connect. It measures the latency from the beginning of Google OIDC authentication to the creation of a verified local EHR session after ID-token signature verification and claim validation. This baseline serves as a lower-bound authentication baseline because it does not provide decentralized identity, blockchain auditability, zero-knowledge identity hiding, or keyless DID recovery."

Output:
Please generate all source files.
Make the project runnable.
Include clear comments and robust error handling.
Do not use any zkEHR-specific code in this baseline.
Use Google OpenID Connect specifically.