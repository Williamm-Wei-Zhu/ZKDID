/**
 * Playwright login automation, modeled on the zkEHR experiments/run.mjs
 * pattern: a single PERSISTENT Chromium profile is reused across all measured
 * runs.
 *
 * Why persistent profile (not storageState):
 *   Google's anti-automation heuristic flags Playwright's *redirected*
 *   navigation to accounts.google.com when the OAuth flow sends it there.
 *   But a profile that already holds a Google session cookie — from a prior
 *   DIRECT visit to accounts.google.com — bypasses the sign-in form
 *   entirely on every subsequent OAuth round-trip. So:
 *     1. one-time `prelogin`: open accounts.google.com directly, user signs
 *        in manually inside the DCV desktop, profile is saved.
 *     2. measured runs: open the OAuth authorization URL; Google sees the
 *        cookie and redirects silently to /callback.
 *
 * Stealth flags + init scripts mirror experiments/run.mjs to keep Google's
 * anti-automation detector quiet.
 */

import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";

export type LoginStrategy = "automated" | "manual" | "primed";

const CHROME_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-first-run",
  "--no-default-browser-check",
];
const CHROME_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function applyStealth(ctx: BrowserContext): Promise<void> {
  // Erase common automation fingerprints BEFORE any page loads.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
}

interface ProviderSelectors {
  usernameInput: string;
  usernameSubmit?: string;
  passwordInput: string;
  passwordSubmit: string;
}

const SELECTORS: Record<AppConfig["oidc"]["providerKind"], ProviderSelectors> = {
  google: {
    usernameInput: 'input[type="email"]',
    usernameSubmit: "#identifierNext button, #identifierNext",
    passwordInput: 'input[type="password"]',
    passwordSubmit: "#passwordNext button, #passwordNext",
  },
  keycloak: {
    usernameInput: "#username",
    passwordInput: "#password",
    passwordSubmit: "#kc-login",
  },
  generic: {
    usernameInput: 'input[type="email"], input[name="username"], input[id="username"]',
    passwordInput: 'input[type="password"]',
    passwordSubmit: 'button[type="submit"], input[type="submit"]',
  },
};

export interface LoginRunner {
  strategy: LoginStrategy;
  /** Run one OAuth navigation; resolves when the page reaches `redirectUri`. */
  runOnce(authUrl: string, redirectUri: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Resolve which strategy applies given config + filesystem state.
 *
 *   - manualLogin=true                          -> "manual"
 *   - persistent Chromium profile dir exists    -> "primed"
 *   - otherwise                                 -> "automated"
 */
export function resolveStrategy(cfg: AppConfig): LoginStrategy {
  if (cfg.browser.manualLogin) return "manual";
  if (cfg.browser.chromeProfileDir && existsSync(cfg.browser.chromeProfileDir))
    return "primed";
  return "automated";
}

/**
 * Build a single-context runner for the duration of an experiment.
 * One persistent profile is shared across all runs; each run uses a fresh
 * page so navigation history doesn't accumulate.
 */
export async function buildLoginRunner(cfg: AppConfig): Promise<LoginRunner> {
  const strategy = resolveStrategy(cfg);
  const headless = strategy === "manual" ? false : cfg.browser.headless;
  const selectors = SELECTORS[cfg.oidc.providerKind];

  // Persistent context if we have a profile dir (primed or about-to-be-primed);
  // otherwise a transient context.
  const useProfile = !!cfg.browser.chromeProfileDir;
  const ctx: BrowserContext = useProfile
    ? await chromium.launchPersistentContext(cfg.browser.chromeProfileDir, {
        headless,
        viewport: { width: 1400, height: 900 },
        userAgent: CHROME_USER_AGENT,
        args: CHROME_LAUNCH_ARGS,
        ignoreDefaultArgs: ["--enable-automation"],
      })
    : await (
        await chromium.launch({
          headless,
          args: CHROME_LAUNCH_ARGS,
          ignoreDefaultArgs: ["--enable-automation"],
        })
      ).newContext({ viewport: { width: 1400, height: 900 }, userAgent: CHROME_USER_AGENT });

  await applyStealth(ctx);

  return {
    strategy,
    async runOnce(authUrl, redirectUri) {
      // Fresh page per run: closing the old page between runs avoids accumulating
      // navigation history and disposes any per-run JavaScript state.
      const page: Page = await ctx.newPage();
      try {
        if (strategy === "primed" || strategy === "manual") {
          // Primed: Google sees the cached cookie and redirects silently.
          // Manual: operator does the login inside the DCV desktop window.
          const timeout = strategy === "manual" ? 5 * 60_000 : 60_000;
          await page.goto(authUrl, { waitUntil: "domcontentloaded" });
          await page.waitForURL((url) => url.toString().startsWith(redirectUri), { timeout });
          return;
        }

        // Automated (Keycloak, generic): fill username/password.
        await page.goto(authUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(selectors.usernameInput, { timeout: 30_000 });
        await page.fill(selectors.usernameInput, cfg.test.username);
        if (selectors.usernameSubmit) await page.click(selectors.usernameSubmit);
        await page.waitForSelector(selectors.passwordInput, { timeout: 30_000 });
        await page.fill(selectors.passwordInput, cfg.test.password);
        await page.click(selectors.passwordSubmit);
        await page
          .waitForSelector(
            'button:has-text("Continue"), button:has-text("Allow"), button:has-text("Yes")',
            { timeout: 3_000 }
          )
          .then((el) => el?.click().catch(() => undefined))
          .catch(() => undefined);
        await page.waitForURL((url) => url.toString().startsWith(redirectUri), {
          timeout: 60_000,
        });
      } finally {
        await page.close();
      }
    },
    async close() {
      await ctx.close();
      // For non-persistent contexts the underlying browser is owned by the context;
      // close it explicitly when present.
      const browser = ctx.browser();
      if (browser) await browser.close();
    },
  };
}

/**
 * One-time interactive prelogin — modeled on experiments/prelogin.mjs.
 *
 * Opens a VISIBLE Chromium (must be inside the DCV desktop session) directly
 * to https://accounts.google.com/signin so Google's anti-automation heuristic
 * sees a normal direct visit (not an OAuth redirect). The operator signs in,
 * then presses Enter in the controlling terminal. The persistent profile dir
 * captures the resulting Google session cookie automatically.
 */
export async function preloginToGoogle(
  cfg: AppConfig,
  waitForOperatorEnter: () => Promise<void>
): Promise<void> {
  if (!cfg.browser.chromeProfileDir) {
    throw new Error("CHROME_PROFILE_DIR must be set in .env to prelogin.");
  }
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
  console.log(`[prelogin] DO NOT close the window — return here and press Enter.\n`);

  await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded" });

  await waitForOperatorEnter();

  // Sanity check: a logged-in Google account can hit myaccount.google.com.
  try {
    await page.goto("https://myaccount.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    const url = page.url();
    if (url.includes("myaccount.google.com") && !url.includes("signin")) {
      console.log(`[prelogin] OK — logged in. URL: ${url}`);
    } else {
      console.log(`[prelogin] WARNING — URL suggests not signed in: ${url}`);
      console.log(`[prelogin]   You can still try experiment:full; if it fails, re-run prelogin.`);
    }
  } catch (e) {
    console.log(`[prelogin] could not verify login state: ${(e as Error).message}`);
  }

  await ctx.close();
  console.log(`[prelogin] profile saved to ${cfg.browser.chromeProfileDir}`);
}
