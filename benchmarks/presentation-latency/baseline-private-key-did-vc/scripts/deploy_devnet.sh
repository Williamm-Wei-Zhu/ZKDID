#!/usr/bin/env bash
# Build + publish the did_registry Move package to Sui Devnet.
# Prints the published package id so you can paste it into .env.
#
# Sui CLI 1.40+ requires `test-publish --build-env devnet` for devnet
# (real `publish` is reserved for testnet/mainnet "managed packages").
# That gives the same on-chain object — only the local tracking metadata
# differs, which is irrelevant to this academic baseline.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v sui >/dev/null 2>&1; then
  echo "[deploy] FAIL: 'sui' CLI not found. Install from https://docs.sui.io/guides/developer/getting-started/sui-install"
  exit 1
fi

ENV_NAME=$(sui client active-env 2>/dev/null || true)
if [ "${ENV_NAME}" != "devnet" ]; then
  echo "[deploy] active env is '${ENV_NAME}', switching to devnet..."
  sui client switch --env devnet
fi
echo "[deploy] active address: $(sui client active-address)"

# Faucet top-up if balance is below 0.1 SUI.
GAS_RAW=$(sui client gas --json 2>/dev/null || echo '[]')
GAS_MIST=$(python3 -c "
import json, sys
d = json.loads('''$GAS_RAW''')
if isinstance(d, list):
    print(sum(int(c.get('mistBalance', c.get('gasBalance', 0))) for c in d))
else:
    print(0)
" 2>/dev/null || echo 0)
if [ "${GAS_MIST}" -lt 100000000 ]; then
  echo "[deploy] gas balance < 0.1 SUI -- requesting from faucet..."
  sui client faucet || true
  echo "[deploy] sleeping 5s for faucet to land..."
  sleep 5
fi

# Strip macOS AppleDouble files that confuse the Move compiler.
find move/did_registry -name "._*" -delete 2>/dev/null || true

echo "[deploy] publishing to devnet via 'test-publish --build-env devnet'..."
PUBLISH_OUTPUT=$(sui client test-publish move/did_registry \
  --gas-budget 100000000 --build-env devnet --json 2>&1)

PKG_ID=$(echo "$PUBLISH_OUTPUT" | python3 -c "
import sys, re
text = sys.stdin.read()
m = re.search(r'\"type\":\\s*\"published\"[^}]*?\"packageId\":\\s*\"(0x[0-9a-fA-F]+)\"', text)
if m: print(m.group(1))
")

if [ -z "${PKG_ID}" ]; then
  echo "[deploy] FAIL: could not extract packageId from publish output."
  echo "$PUBLISH_OUTPUT" | head -200
  exit 1
fi

DIGEST=$(echo "$PUBLISH_OUTPUT" | python3 -c "
import sys, re
text = sys.stdin.read()
m = re.search(r'\"digest\":\\s*\"([A-Za-z0-9]+)\"', text)
if m: print(m.group(1))
")

echo ""
echo "================================================================"
echo "[deploy] PACKAGE PUBLISHED"
echo "[deploy] SUI_PACKAGE_ID=${PKG_ID}"
echo "[deploy] tx digest:     ${DIGEST}"
echo "================================================================"
echo ""
echo "Add the line above to .env so the experiment scripts can find it:"
echo "  echo 'SUI_PACKAGE_ID=${PKG_ID}' >> .env"
