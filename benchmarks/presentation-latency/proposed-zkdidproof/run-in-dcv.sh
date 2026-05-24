#!/usr/bin/env bash
# Wrapper that runs the OIDC-only baseline inside the DCV virtual X session.
# Modeled on ../experiments/run-in-dcv.sh.
#
# Usage:
#   ./run-in-dcv.sh prelogin           one-time Google sign-in (must be inside DCV)
#   ./run-in-dcv.sh prime-token        after prelogin, capture an ID token for Mode 2
#   ./run-in-dcv.sh prime              prelogin + prime-token
#   ./run-in-dcv.sh full               Mode 1 — full OIDC login (silent SSO if primed)
#   ./run-in-dcv.sh reuse              Mode 2 — token / session reuse
#   ./run-in-dcv.sh all                Mode 1 then Mode 2
#
# Reads DISPLAY / XAUTHORITY from the running DCV session so the same script
# works whether you launch it from the DCV desktop's terminal or from an SSH
# session — Chromium attaches to the DCV X server in both cases.
set -euo pipefail

DCV_SESSION="${DCV_SESSION:-desktop}"

DCV_INFO=$(sudo -n dcv describe-session "$DCV_SESSION" 2>/dev/null \
  || dcv describe-session "$DCV_SESSION" 2>/dev/null \
  || true)
DISPLAY_NUM=$(echo "$DCV_INFO" | awk '/X display:/ {print $3; exit}')
XAUTH_PATH=$(echo  "$DCV_INFO" | awk '/X authority:/ {print $3; exit}')

if [ -z "${DISPLAY_NUM}" ]; then
  echo "[dcv-wrap] WARNING: could not read DCV session '$DCV_SESSION'." >&2
  echo "[dcv-wrap]          Is dcvserver running?  Try: sudo dcv list-sessions" >&2
  echo "[dcv-wrap]          Falling back to current DISPLAY=${DISPLAY:-unset}." >&2
else
  echo "[dcv-wrap] attaching to session '$DCV_SESSION' on DISPLAY=$DISPLAY_NUM (xauth=$XAUTH_PATH)"
  export DISPLAY="$DISPLAY_NUM"
  export XAUTHORITY="$XAUTH_PATH"
fi

cd "$(dirname "$0")"

# Lazy-build if dist/ missing.
if [ ! -f "dist/index.js" ]; then
  echo "[dcv-wrap] dist/ missing — running 'npm run build' first."
  npm run build
fi

exec node dist/index.js "$@"
