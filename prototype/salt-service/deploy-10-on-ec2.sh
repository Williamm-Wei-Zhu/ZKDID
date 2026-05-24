#!/usr/bin/env bash
# Deploy 10 salt-service instances to an EC2 host via SSH + pm2.
# Run this from your laptop in the repo root:
#     bash salt-service/deploy-10-on-ec2.sh
#
# Requires:
#   - aws.pem in the repo root (private key, chmod 600)
#   - EC2 reachable at $EC2_HOST
#   - Security group allows inbound TCP 7001-7010 from your IP (or 0.0.0.0/0 for demo)

set -euo pipefail

EC2_HOST="${EC2_HOST:-ec2-35-175-246-19.compute-1.amazonaws.com}"
SSH_KEY="${SSH_KEY:-aws.pem}"
SSH_USER="${SSH_USER:-ubuntu}"
BASE_PORT="${BASE_PORT:-7001}"
COUNT="${COUNT:-10}"

# Generate deterministic-but-unique 128-bit seeds locally so we can write them
# into the client config as well. Use /dev/urandom.
generate_seed() {
  python3 - <<'PY'
import os
print(int.from_bytes(os.urandom(16), 'big'))
PY
}

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_USER@$EC2_HOST"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> Uploading salt-service/"
rsync -az --delete \
  --exclude='node_modules/' \
  --exclude='config.json' \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  salt-service/ "$SSH_USER@$EC2_HOST:~/salt-service/"

echo "==> Installing deps + pm2"
$SSH "cd ~/salt-service && npm install --omit=dev --no-audit --no-fund >/tmp/npm.log 2>&1 && echo 'deps ok' && (command -v pm2 >/dev/null 2>&1 || sudo npm install -g pm2 >/tmp/pm2.log 2>&1) && pm2 -v"

echo "==> Stopping any prior salt-* instances"
$SSH "pm2 delete /salt-/ >/dev/null 2>&1 || true"

CLIENT_CFG=$(mktemp)
echo '  "institutions": [' > "$CLIENT_CFG"

for i in $(seq 1 "$COUNT"); do
  PORT=$((BASE_PORT + i - 1))
  NAME="Institution $i"
  SEED=$(generate_seed)
  echo "==> Starting $NAME on :$PORT (seed ${SEED:0:12}...)"
  $SSH "cd ~/salt-service && PORT=$PORT INSTITUTION_NAME='$NAME' INSTITUTION_SEED='$SEED' pm2 start server.mjs --name 'salt-inst-$i' --update-env" >/dev/null

  SEP=","
  [[ "$i" == "$COUNT" ]] && SEP=""
  printf '    { "name": "%s", "url": "http://%s:%d" }%s\n' "$NAME" "$EC2_HOST" "$PORT" "$SEP" >> "$CLIENT_CFG"
done

echo "  ]," >> "$CLIENT_CFG"

echo "==> Saving pm2 state"
$SSH "pm2 save >/dev/null" || true

echo "==> Health check"
$SSH "for p in \$(seq $BASE_PORT $((BASE_PORT + COUNT - 1))); do echo -n \"  :\$p -> \"; curl -s http://localhost:\$p/healthz || echo '(unreachable)'; echo; done"

echo
echo "==> PM2 listing"
$SSH "pm2 ls"

echo
echo "==============================================================="
echo "Add the following to zklogin/polymedia-zklogin-demo/web/src/config.json"
echo "(overwrite or extend the existing 'institutions' array):"
echo "==============================================================="
cat "$CLIENT_CFG"
rm -f "$CLIENT_CFG"
