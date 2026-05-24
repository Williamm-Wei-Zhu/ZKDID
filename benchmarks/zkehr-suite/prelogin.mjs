#!/usr/bin/env node
// experiments/prelogin.mjs — One-time Google OAuth cookie seeding.
//
// Problem: Playwright's Chromium triggers Google's "This browser or app may
// not be secure" warning when OAuth sends it to accounts.google.com via a
// redirect — Google's heuristics flag the unusual navigation pattern.
//
// Workaround: let the user sign into Google DIRECTLY (not via OAuth redirect)
// in the same persistent profile. Google treats a direct accounts.google.com
// visit as a normal human session and accepts the login. Once the session
// cookie is stored in the profile, every subsequent OAuth redirect silently
// reuses it and never shows the sign-in form at all — so the anti-automation
// heuristic is bypassed by construction.
//
// Usage (inside DCV desktop terminal):
//   cd ~/zkdid-patient/experiments
//   ./run-in-dcv.sh --prelogin    # OR: DISPLAY=:1 XAUTHORITY=... node prelogin.mjs
//
// Then:
//   1) Chromium window opens to https://accounts.google.com
//   2) You manually sign into your Google account
//   3) After successful sign-in, press Enter in the terminal
//   4) Chromium closes; profile is saved
//   5) Normal batch runs now work silently via `run.mjs`

import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

async function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function main() {
  console.log(`[prelogin] profile=${PROFILE_DIR}`);
  console.log(`[prelogin] DISPLAY=${process.env.DISPLAY || "(unset)"}`);

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, // must be headed — user has to see the window to type password
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  await browser.addInitScript(() => {
    // @ts-expect-error
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    // @ts-expect-error
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  const page = browser.pages()[0] || await browser.newPage();

  console.log(`\n[prelogin] opening https://accounts.google.com`);
  console.log(`[prelogin] Please sign into your Google account in the window that just appeared.`);
  console.log(`[prelogin] DO NOT close the window manually — come back here and press Enter.\n`);

  await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded" });

  await waitForEnter("[prelogin] Press Enter AFTER you've signed into Google successfully → ");

  // Sanity check: visit a Google domain that only works when logged in. If we
  // land on something that contains "myaccount", we have a valid session.
  try {
    await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    const url = page.url();
    if (url.includes("myaccount.google.com") && !url.includes("signin")) {
      console.log(`[prelogin] ✅ logged in. Current URL: ${url}`);
    } else {
      console.log(`[prelogin] ⚠️  URL suggests not fully signed in: ${url}`);
      console.log(`[prelogin]    You can still try running an experiment; if OAuth fails, re-run prelogin.`);
    }
  } catch (e) {
    console.log(`[prelogin] could not verify login state: ${e?.message}`);
  }

  console.log(`[prelogin] closing browser. Profile saved to ${PROFILE_DIR}`);
  await browser.close();
}

main().catch((e) => { console.error("[prelogin] fatal:", e); process.exit(1); });
