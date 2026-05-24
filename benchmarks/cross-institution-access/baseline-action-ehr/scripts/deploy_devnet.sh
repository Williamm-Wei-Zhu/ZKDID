#!/usr/bin/env bash
# Build + publish the access_grant Move package to Sui Devnet.
# Prints the published package id so you can paste it into .env.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v sui >/dev/null 2>&1; then
  echo "[deploy] FAIL: 'sui' CLI not found. Install: https://docs.sui.io/guides/developer/getting-started/sui-install"
  exit 1
fi

ENV_NAME=$(sui client active-env 2>/dev/null || true)
if [ "${ENV_NAME}" != "devnet" ]; then
  echo "[deploy] active env is '${ENV_NAME}', switching to devnet..."
  sui client switch --env devnet
fi
echo "[deploy] active address: $(sui client active-address)"

GAS=$(sui client gas --json 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(int(c.get("mistBalance",c.get("gasBalance",0))) for c in d) if isinstance(d,list) else 0)' 2>/dev/null \
  || echo 0)
if [ "${GAS}" -lt 100000000 ]; then
  echo "[deploy] gas balance < 0.1 SUI — requesting from faucet..."
  sui client faucet || true
  echo "[deploy] sleeping 5s for faucet to land..."
  sleep 5
fi

echo "[deploy] building Move package..."
sui move build --path move/access_grant

echo "[deploy] publishing to devnet..."
PUBLISH_OUTPUT=$(sui client publish move/access_grant --gas-budget 100000000 --json)

PKG_ID=$(echo "$PUBLISH_OUTPUT" | python3 -c '
import json, sys
o = json.load(sys.stdin)
for c in o.get("objectChanges", []):
    if c.get("type") == "published":
        print(c["packageId"]); break
')

if [ -z "${PKG_ID}" ]; then
  echo "[deploy] FAIL: could not extract packageId from publish output."
  echo "$PUBLISH_OUTPUT" | head -200
  exit 1
fi

echo ""
echo "================================================================"
echo "[deploy] PACKAGE PUBLISHED"
echo "[deploy] SUI_PACKAGE_ID=${PKG_ID}"
echo "================================================================"
echo ""
echo "Paste the line above into .env:"
echo "  echo 'SUI_PACKAGE_ID=${PKG_ID}' >> .env"
