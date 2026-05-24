#!/usr/bin/env bash
# Non-interactive probe: confirms the DCV wrapper resolves DISPLAY/XAUTHORITY,
# launches a HEADED Chromium against the DCV X server, and then closes it.
# Mirrors the launch flags used by experimentFullLogin.ts so a working probe
# proves the Mode-1 path will work.
set -euo pipefail
cd "$(dirname "$0")/.."

DCV_SESSION="${DCV_SESSION:-desktop}"
DCV_INFO=$(sudo -n dcv describe-session "$DCV_SESSION" 2>/dev/null \
  || dcv describe-session "$DCV_SESSION" 2>/dev/null)
DISPLAY_NUM=$(echo "$DCV_INFO" | awk '/X display:/ {print $3; exit}')
XAUTH_PATH=$(echo  "$DCV_INFO" | awk '/X authority:/ {print $3; exit}')

if [ -z "$DISPLAY_NUM" ]; then
  echo "FAIL: could not read DCV session '$DCV_SESSION'"
  exit 1
fi

export DISPLAY="$DISPLAY_NUM"
export XAUTHORITY="$XAUTH_PATH"
echo "DCV  DISPLAY=$DISPLAY  XAUTHORITY=$XAUTHORITY"

node -e '
import("playwright").then(async ({ chromium }) => {
  const t0 = process.hrtime.bigint();
  const ctx = await chromium.launchPersistentContext("/tmp/_dcv-probe-profile", {
    headless: false,
    viewport: { width: 1024, height: 600 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto("data:text/html,<title>dcv-probe</title><h1>dcv-probe-ok</h1>");
  const text = await page.textContent("h1");
  await ctx.close();
  console.log(JSON.stringify({
    chromium_headed_under_dcv: text === "dcv-probe-ok",
    launch_to_close_ms: Number(process.hrtime.bigint() - t0) / 1e6,
  }, null, 2));
}).catch((e) => { console.error("PROBE FAIL:", e.stack || e.message); process.exit(2); });
'

rm -rf /tmp/_dcv-probe-profile
