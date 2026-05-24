// Per-run Playwright steps: full DID-creation flow with Google OAuth.
//
// Assumes the Chromium persistent context was opened with a user-data-dir
// where the user has already signed into Google at least once — in that case
// the OAuth redirect is silent (no consent screen).
//
// Exposes:
//   - ensureGoogleLoggedIn(page, frontend) : one-time bootstrap
//   - runSingleExperiment(ctx) : single DID-creation cycle, returns timings

/** Sentinel text used to detect when the OAuth+prover+backend-kick has finished. */
const LOGIN_SUCCESS_TOAST = /Logged in as/;
/**
 * All three ops (did / vc / access) produce toasts ending in
 * "transaction dispatched" — DID: "DID transaction dispatched.",
 * VC: "VC transaction dispatched.", Access: "AccessGrant transaction dispatched.".
 * Match the common substring so a single regex works for every op.
 */
const OP_DISPATCHED_TOAST = /transaction dispatched/;

/**
 * First-time bootstrap. Open the frontend on the LOGIN page explicitly
 * (ignoring any persisted localStorage route state from previous runs that
 * may have landed the app on the DID page). Wait for the Google button.
 *
 * The `?page=login` query param is honored by App.tsx's initialPage() with
 * higher priority than localStorage, so we never race against stale state.
 */
export async function ensureGoogleLoggedIn(page, frontend, { signal } = {}) {
  const loginUrl = `${frontend.replace(/\/$/, "")}/?page=login`;
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  // Belt-and-suspenders: also erase localStorage so a subsequent navigation
  // without the ?page= param behaves predictably.
  try {
    await page.evaluate(() => {
      try { localStorage.removeItem("zkdid.currentPage"); } catch {}
    });
  } catch { /* ignore */ }
  await page.waitForSelector("button:has-text(\"Google\")", { timeout: 15_000 });
}

/**
 * Execute a single DID-creation run.
 *
 * Inputs (ctx):
 *   page          Playwright Page
 *   bridge        bridge client (see lib/bridge.mjs)
 *   frontend      frontend URL (e.g. http://localhost:1234)
 *   op            'did' | 'vc' | 'access'
 *   institutions  how many institutions checkboxes to tick (first N shown)
 *   onLog         optional (msg) => void for per-step diagnostics
 *
 * Output:
 *   {
 *     wall: { loginMs, submitMs, totalMs },
 *     browser: { timing: <the timing map for the new account> | null },
 *     backend: <BackendTimings JSON from /latest-timings>,
 *     digest: string | null,
 *   }
 */
export async function runSingleExperiment(ctx) {
  const { page, bridge, frontend, op, institutions, proverMode = "direct",
          recovery = false, onLog = () => {} } = ctx;

  // ---- fresh navigation (so completeZkLogin doesn't short-circuit on stale state) ----
  // Force ?page=login so we land on the LoginPage regardless of what
  // localStorage.zkdid.currentPage says from a previous successful run.
  // ALWAYS pass ?prover=… (including direct), because cacheProverModeFromUrl()
  // overwrites sessionStorage from this param at boot — if we omit it, a
  // stale value from a previous proxy/backend run would leak into this run.
  // ?mode=recovery (when recovery=true) makes auth.ts skip the prover request
  // and the bridge POST after computing the local DID — used by the
  // DID-recovery experiment driver.
  const params = new URLSearchParams({
    page:   "login",
    prover: proverMode || "direct",
    mode:   recovery ? "recovery" : "normal",
  });
  const loginUrl = `${frontend.replace(/\/$/, "")}/?${params.toString()}`;
  onLog(`navigate to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button:has-text(\"Google\")", { timeout: 15_000 });

  // ---- verify checkbox selection matches desired institution count ----
  // LoginPage already reflects the bridge's persisted selection (we set it
  // before this function was called), but we defensively reconcile here.
  onLog(`ensure ${institutions} checkboxes are checked`);
  const checkboxes = page.locator("input[type=checkbox]");
  const total = await checkboxes.count();
  for (let i = 0; i < total; i++) {
    const shouldBe = i < institutions;
    const isChecked = await checkboxes.nth(i).isChecked();
    if (shouldBe !== isChecked) {
      await checkboxes.nth(i).click();
      // small delay for the bridge-write to fire
      await page.waitForTimeout(150);
    }
  }

  const t0 = Date.now();

  // ---- click Google; wait for either success toast (silent redirect) or
  //      intermediate accounts.google.com navigation ----
  onLog(`click Google`);
  const googleBtn = page.locator("button:has-text(\"Google\")").first();
  await googleBtn.click();

  // Wait for login completion — success toast or DID page header. We allow up
  // to 45s because: (a) if this is the first run the page may have to present
  // a Google account picker, (b) the ZK prover can take 5-10s.
  onLog(`wait for login completion`);
  const toast = page.getByText(LOGIN_SUCCESS_TOAST);
  await toast.waitFor({ state: "visible", timeout: 60_000 });
  const loginMs = Date.now() - t0;

  // ---- recovery mode short-circuit ---------------------------------------
  // The DID-recovery flow stops here: the patient's zkLogin DID has been
  // computed locally from JWT + merged salt, no on-chain submission is
  // required. We pull the browser-side timing record and return without
  // ever clicking a "Create *" button.
  if (recovery) {
    onLog(`recovery mode: pull browser timings + done`);
    const browserTiming = await page.evaluate(() => {
      try {
        const raw = sessionStorage.getItem("zklogin-demo.timing");
        if (!raw) return null;
        const m = JSON.parse(raw);
        const keys = Object.keys(m).filter((k) => k !== "_last");
        if (keys.length) return m[keys[0]];
        return m["_last"] || null;
      } catch { return null; }
    });
    return {
      wall: { loginMs, submitMs: 0, totalMs: loginMs },
      browser: { timing: browserTiming },
      backend: null,
      digest: null,
    };
  }

  // ---- navigate to the correct page depending on op, and for op=access
  //      fill the required form fields before clicking the create button ----
  const createStart = Date.now();

  if (op === "access") {
    onLog(`open EHR Access page`);
    // Sidebar button uses ❖ EHR Access. Tolerant to whitespace around the label.
    await page.getByRole("button", { name: /EHR Access/ }).click().catch(() => {});
    await page.waitForSelector("button:has-text(\"Create AccessGrant\")", { timeout: 15_000 });

    // Use "(use self)" shortcuts to fill hospital + grantee with the patient DID
    // (makes the test self-contained; no need to provision external DIDs).
    onLog(`fill Access form (use self for hospital + grantee)`);
    const useSelfBtns = page.locator("button:has-text(\"(use self)\")");
    // First use-self = Hospital, second = Grantee (in the order they appear in JSX)
    await useSelfBtns.nth(0).click();
    await useSelfBtns.nth(1).click();

    // Unique record id per run so we never accidentally dedupe on chain
    const recordId = `rec-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await page.locator('input[placeholder*="record-"]').fill(recordId);

    onLog(`click Create AccessGrant`);
    await page.locator("button:has-text(\"Create AccessGrant\")").first().click();
  } else {
    onLog(`open DID page`);
    await page.getByRole("button", { name: /^✦ DID$/ }).click().catch(() => {});
    await page.waitForSelector("button:has-text(\"Create DID (on-chain)\")", { timeout: 15_000 });

    const opButton = op === "vc" ? "Create DID + VC" : "Create DID (on-chain)";
    onLog(`click ${opButton}`);
    await page.locator(`button:has-text("${opButton}")`).first().click();
  }

  // Wait for the success toast (regex matches all three op variants)
  await page.getByText(OP_DISPATCHED_TOAST).waitFor({ state: "visible", timeout: 60_000 });
  // give the bridge a moment to persist backend timings to disk
  await page.waitForTimeout(500);
  const submitMs = Date.now() - createStart;

  // ---- read BACKEND timings (waits for fresh write) ----
  onLog(`pull backend timings`);
  const bk = await waitForFreshTimings(bridge, createStart);

  // ---- read BROWSER timings from sessionStorage ----
  // Keyed by userAddr; we grab the FIRST non-"_last" entry (the one created
  // for this login). If for any reason "_last" still exists, fall back to that.
  onLog(`pull browser timings`);
  const browserTiming = await page.evaluate(() => {
    try {
      const raw = sessionStorage.getItem("zklogin-demo.timing");
      if (!raw) return null;
      const m = JSON.parse(raw);
      const keys = Object.keys(m).filter((k) => k !== "_last");
      if (keys.length) return m[keys[0]];
      return m["_last"] || null;
    } catch { return null; }
  });

  return {
    wall: { loginMs, submitMs, totalMs: Date.now() - t0 },
    browser: { timing: browserTiming },
    backend: bk,
    digest: bk?.digest || null,
  };
}

// We inline the waitForFreshTimings import to avoid circularity complexity
async function waitForFreshTimings(bridge, after, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await bridge.getLatestTimings();
    if (t && t.timestampMs && t.timestampMs >= after) return t;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timeout waiting for fresh backend timings");
}
