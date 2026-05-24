/**
 * Two-step priming, modeled on experiments/prelogin.mjs + experiments/run.mjs:
 *
 *   1. `prelogin` — open Google's signin page DIRECTLY (not via OAuth) inside
 *      the DCV desktop. Operator signs in manually. The persistent Chromium
 *      profile retains the session cookie. Subsequent OAuth redirects become
 *      silent because Google's anti-automation heuristics never see a redirect-
 *      driven sign-in flow.
 *
 *   2. `prime-token` — run one full OAuth code-exchange + ID-token verify and
 *      save the verified token to session-cache.json. Used by Mode 2
 *      (experiment:reuse).
 *
 * The combined `prime` command runs (1) then (2). On a host where the profile
 * already exists, only (2) is needed — it is fast and non-interactive.
 */

import readline from "node:readline/promises";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { cfg } from "./config.js";
import { startCallbackServer } from "./callbackServer.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateNonce,
  generatePkce,
  generateState,
} from "./oidcClient.js";
import { buildJwksFetcher, verifyIdToken } from "./jwtVerifier.js";
import { buildLoginRunner, preloginToGoogle } from "./playwrightLogin.js";
import type { SessionCache } from "./types.js";

const SESSION_CACHE_PATH = resolve(process.cwd(), "session-cache.json");

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

/** Step 1 — interactive Google sign-in inside the DCV desktop. */
export async function runPrelogin(): Promise<void> {
  console.log("\n=== Step 1/2: Google prelogin (one-time, interactive) ===");
  await preloginToGoogle(cfg, () =>
    waitForEnter("[prelogin] Press Enter AFTER you've signed into Google → ")
  );
}

/**
 * Step 2 — perform one full OAuth flow against the now-primed profile and
 * save a verified ID token for Mode 2.
 *
 * This step is non-interactive: Google sees the cookie from step 1 and
 * silently redirects to /callback.
 */
export async function runPrimeToken(): Promise<void> {
  console.log("\n=== Step 2/2: Capture verified ID token for reuse-mode ===");

  if (!existsSync(cfg.browser.chromeProfileDir)) {
    throw new Error(
      `Chromium profile not found at ${cfg.browser.chromeProfileDir}. ` +
        `Run 'npm run experiment:prelogin' first.`
    );
  }

  // Force a visible browser for prime-token: Google may show the OAuth
  // consent screen on the first authorization for {account, client_id,
  // scope}. The operator must be inside the DCV desktop to click "Allow".
  // Once consent is granted, subsequent silent runs (prompt=none) work.
  cfg.browser.headless = false;

  const state = generateState();
  const nonce = generateNonce();
  const pkce = generatePkce();
  // Intentionally omit `prompt`. With no prompt parameter, Google uses the
  // cached session for identity (no signin UI) but will show the consent
  // screen if consent has not yet been granted for this {account, client_id,
  // scope} tuple. This is exactly what prime-token needs to do once.
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: cfg.oidc.authorizationEndpoint,
    clientId: cfg.oidc.clientId,
    redirectUri: cfg.oidc.redirectUri,
    scope: cfg.oidc.scope,
    state,
    nonce,
    pkce,
  });

  const server = await startCallbackServer(cfg.callbackPort, state);
  const login = await buildLoginRunner(cfg);
  console.log(`[prime-token] login strategy = ${login.strategy} (headed)`);
  console.log(
    `[prime-token] If a consent screen appears in DCV, click "Allow" — ` +
      `that one click is what enables silent SSO for all subsequent runs.`
  );
  try {
    // Promise.all attaches rejection handlers to both promises immediately,
    // preventing Node 20 from reporting an unhandled rejection if the
    // callback server rejects before the experiment loop awaits it.
    const [cb] = await Promise.all([
      server.awaitCallback(5 * 60_000),
      login.runOnce(authUrl, cfg.oidc.redirectUri),
    ]);

    console.log(`[prime-token] got code, exchanging for tokens...`);
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: cfg.oidc.tokenEndpoint,
      clientId: cfg.oidc.clientId,
      clientSecret: cfg.oidc.clientSecret,
      redirectUri: cfg.oidc.redirectUri,
      code: cb.code,
      codeVerifier: pkce.code_verifier,
    });

    const fetcher = buildJwksFetcher(cfg.oidc.jwksUri, true);
    await fetcher.warmUp();
    const v = await verifyIdToken(tokens.id_token, fetcher, {
      expectedIssuer: cfg.oidc.issuer,
      expectedAudience: cfg.oidc.clientId,
      expectedNonce: nonce,
    });
    console.log(
      `[prime-token] verified token. sub=${v.claims.sub} iss=${v.claims.iss} ` +
        `exp=${v.claims.exp}`
    );

    const cache: SessionCache = {
      id_token: tokens.id_token,
      nonce,
      cached_at_iso: new Date().toISOString(),
    };
    await writeFile(SESSION_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
    console.log(`[prime-token] wrote session-cache.json`);
    console.log("[prime-token] DONE — you can now run:");
    console.log("        npm run experiment:full");
    console.log("        npm run experiment:reuse");
  } finally {
    await login.close();
    await server.close();
  }
}

/** Convenience: prelogin + prime-token in sequence. */
export async function runPrime(): Promise<void> {
  await runPrelogin();
  await runPrimeToken();
}
