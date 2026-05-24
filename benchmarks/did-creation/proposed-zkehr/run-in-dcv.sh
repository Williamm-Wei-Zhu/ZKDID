#!/usr/bin/env bash
# DCV wrapper -- mirrors ../experiments/run-in-dcv.sh and the OIDC-only baseline.
# Reads DISPLAY/XAUTHORITY from the running DCV session so Chromium attaches
# to the DCV X server whether you launch from the DCV terminal or via SSH.
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
  echo "[dcv-wrap] attaching to DCV session '$DCV_SESSION' on DISPLAY=$DISPLAY_NUM (xauth=$XAUTH_PATH)"
  export DISPLAY="$DISPLAY_NUM"
  export XAUTHORITY="$XAUTH_PATH"
fi

cd "$(dirname "$0")"

if [ ! -f "dist/index.js" ]; then
  echo "[dcv-wrap] dist/ missing -- running 'npm run build' first."
  npm run build
fi

exec node dist/index.js "$@"
