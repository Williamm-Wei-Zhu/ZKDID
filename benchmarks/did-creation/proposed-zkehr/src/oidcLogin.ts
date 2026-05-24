/**
 * OIDC implicit-flow login for zkLogin.
 *
 * Differs from the OIDC-only baseline in two important ways:
 *  - response_type=id_token (NOT code) -- zkLogin needs the JWT directly.
 *  - The JWT comes back in the URL FRAGMENT (#id_token=...), not the query
 *    string. Fragments never reach the server, so we capture the JWT
 *    inside the Playwright page via `page.url()` after redirect.
 *
 * Login automation pattern is identical to the OIDC-only baseline:
 *  - persistent Chromium profile (.chrome-profile) with Google session cookie
 *  - direct visit to accounts.google.com/signin during one-time prelogin
 *  - silent SSO via prompt=none on subsequent measured runs
 */

import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import type { AppConfig } from "./config.js";

/**
 * Start a tiny HTTP server that returns a minimal 200 page on the redirect
 * port. Required because zkLogin uses OIDC implicit flow: Google's response
 * to prompt=none is a 302 to redirect_uri#id_token=... -- if nothing is
 * listening on redirect_uri, Chromium reports ERR_CONNECTION_REFUSED and
 * page.goto() throws before we can read the URL fragment.
 *
 * The page contains a script that captures and exposes the fragment via
 * window.__capturedHash, but Playwright reads `window.location.hash`
 * directly, so the script body is just for human debugging in DCV.
 */
function startFragmentCatchServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!doctype html><html><body style="font-family:sans-serif">
        <h2>Login complete.</h2>
        <p id="hash"></p>
        <script>document.getElementById("hash").textContent = window.location.hash;</script>
        </body></html>`
      );
    });
    server.listen(port, () => resolve(server));
    server.once("error", reject);
  });
}
async function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

const CHROME_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-first-run",
  "--no-default-browser-check",
];
const CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function applyStealth(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
}

export type LoginStrategy = "automated" | "manual" | "primed";

export function resolveStrategy(cfg: AppConfig): LoginStrategy {
  if (cfg.browser.manualLogin) return "manual";
  if (cfg.browser.chromeProfileDir && existsSync(cfg.browser.chromeProfileDir)) return "primed";
  return "automated";
}

export interface ZkLoginOidcRunner {
  strategy: LoginStrategy;
  /** Builds the Google authorize URL with the given nonce, drives Playwright,
   *  and returns the JWT extracted from the URL fragment. */
  loginAndCaptureJwt(nonce: string, redirectUri: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Build a runner with one persistent Chromium context shared across all
 * measured runs. Each run gets a fresh page within that context so cookies
 * persist (silent SSO) but per-run state is isolated.
 */
export async function buildOidcRunner(cfg: AppConfig): Promise<ZkLoginOidcRunner> {
  const strategy = resolveStrategy(cfg);
  const headless = strategy === "manual" ? false : cfg.browser.headless;

  const ctx: BrowserContext = await chromium.launchPersistentContext(
    cfg.browser.chromeProfileDir, {
      headless,
      viewport: { width: 1400, height: 900 },
      userAgent: CHROME_USER_AGENT,
      args: CHROME_LAUNCH_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    },
  );
  await applyStealth(ctx);

  return {
    strategy,
    async loginAndCaptureJwt(nonce, redirectUri) {
      const params: Record<string, string> = {
        response_type: "id_token",
        client_id: cfg.oidc.clientId,
        redirect_uri: redirectUri,
        scope: "openid email profile",
        nonce,
      };
      // Silent SSO when primed; force fresh login otherwise.
      if (strategy === "primed") params.prompt = "none";
      else params.prompt = "login";
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams(params).toString();

      const page: Page = await ctx.newPage();
      // Start a tiny catch server before navigation so the final hop
      // (redirect_uri#id_token=...) gets a 200 response from us.
      const server = await startFragmentCatchServer(cfg.oidc.callbackPort);
      try {
        const timeout = strategy === "manual" ? 5 * 60_000 : 60_000;
        await page.goto(authUrl, { waitUntil: "domcontentloaded" });
        // Wait until the URL starts with the redirect URI -- the JWT is in
        // the fragment of that URL.
        await page.waitForURL((u) => u.toString().startsWith(redirectUri), { timeout });
        // Read window.location.hash from the page (Playwright's page.url()
        // already includes the fragment when reading it on a navigated page,
        // but reading via evaluate is the safest portable way).
        const hash = await page.evaluate(() => window.location.hash);
        const frag = hash.startsWith("#") ? hash.slice(1) : hash;
        const search = new URLSearchParams(frag);
        const idToken = search.get("id_token");
        const error = search.get("error");
        if (error) {
          throw new Error(`OIDC error from provider: ${error} - ${search.get("error_description") ?? ""}`);
        }
        if (!idToken) {
          throw new Error(`No id_token in redirect fragment: ${hash.slice(0, 200)}`);
        }
        return idToken;
      } finally {
        await page.close();
        await stopServer(server);
      }
    },
    async close() {
      await ctx.close();
    },
  };
}

/**
 * One-time interactive prelogin: opens Chromium VISIBLY, navigates to
 * accounts.google.com/signin (direct, NOT via OAuth redirect to avoid
 * Google's anti-automation heuristic), waits for the operator to sign in
 * manually, and saves the persistent profile.
 */
export async function preloginToGoogle(
  cfg: AppConfig,
  waitForOperatorEnter: () => Promise<void>,
): Promise<void> {
  console.log(`[prelogin] profile=${cfg.browser.chromeProfileDir}`);
  console.log(`[prelogin] DISPLAY=${process.env.DISPLAY ?? "(unset)"}`);
  const ctx = await chromium.launchPersistentContext(cfg.browser.chromeProfileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: CHROME_USER_AGENT,
    args: CHROME_LAUNCH_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await applyStealth(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  console.log(`\n[prelogin] opening https://accounts.google.com/signin`);
  console.log(`[prelogin] Sign in to Google in the window that just appeared.`);
  console.log(`[prelogin] DO NOT close the window -- return here and press Enter.\n`);
  await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded" });
  await waitForOperatorEnter();
  try {
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    const url = page.url();
    if (url.includes("myaccount.google.com") && !url.includes("signin")) {
      console.log(`[prelogin] OK -- logged in. URL: ${url}`);
    } else {
      console.log(`[prelogin] WARNING -- URL suggests not signed in: ${url}`);
    }
  } catch (e) {
    console.log(`[prelogin] could not verify login state: ${(e as Error).message}`);
  }
  await ctx.close();
  console.log(`[prelogin] profile saved to ${cfg.browser.chromeProfileDir}`);
}

/**
 * One-time consent-grant flow: drives a real OIDC implicit-flow round-trip
 * with prompt=consent so the user can grant the OAuth client access to the
 * required scopes. After this completes, prompt=none silent SSO works for
 * 100+ measured runs.
 *
 * Returns the captured JWT so the caller can also seed any session cache
 * with a fresh verified token.
 */
export async function primeConsent(
  cfg: AppConfig,
  nonce: string,
): Promise<string> {
  if (!existsSync(cfg.browser.chromeProfileDir)) {
    throw new Error(
      `Chromium profile not found at ${cfg.browser.chromeProfileDir}. ` +
        `Run prelogin first.`,
    );
  }
  // Use a headed browser regardless of HEADLESS env -- the operator must
  // see the consent screen and click Allow.
  const cfgHeaded: AppConfig = {
    ...cfg,
    browser: { ...cfg.browser, headless: false },
  };
  const runner = await buildOidcRunner(cfgHeaded);
  try {
    return await runner.loginAndCaptureJwt(nonce, cfg.oidc.redirectUri);
  } finally {
    await runner.close();
  }
}
