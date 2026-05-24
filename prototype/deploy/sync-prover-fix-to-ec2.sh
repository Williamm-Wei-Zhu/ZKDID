#!/usr/bin/env bash
# One-shot sync of the prover-mode fix to EC2.
#
# Usage:
#   EC2_HOST=ec2-XX-XX-XX-XX.compute-1.amazonaws.com ./sync-prover-fix-to-ec2.sh
#   # or pass the IP directly:
#   EC2_HOST=98.93.239.197 ./sync-prover-fix-to-ec2.sh
#
# What it does:
#   1. scp the 3 fixed files to /tmp on EC2
#   2. mv them into place under ~/zkdid-patient
#   3. md5sum each file on EC2 vs on the Mac (sanity check)
#   4. clear the chrome-profile sessionStorage so the cached prover-mode
#      from earlier runs doesn't leak in
#   5. tell Vite to pick up changes (HMR auto-reloads; no restart needed)

set -euo pipefail

EC2_HOST="${EC2_HOST:-ec2-98-93-239-197.compute-1.amazonaws.com}"
SSH_KEY="${SSH_KEY:-aws.pem}"
SSH_USER="${SSH_USER:-ubuntu}"
REMOTE_HOME="${REMOTE_HOME:-/home/ubuntu/zkdid-patient}"

echo "[sync] target = $SSH_USER@$EC2_HOST   key = $SSH_KEY   remote = $REMOTE_HOME"

# Sanity: SSH reachability
if ! ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
        "$SSH_USER@$EC2_HOST" 'echo ssh-ok' >/dev/null 2>&1; then
  echo "[sync] FATAL: cannot SSH to $EC2_HOST. Are you on the VPN?"
  exit 1
fi

# Files to copy: <local-relative-path> <remote-absolute-path>
declare -a FILES=(
  "zklogin/polymedia-zklogin-demo/web/src/lib/auth.ts            $REMOTE_HOME/zklogin/polymedia-zklogin-demo/web/src/lib/auth.ts"
  "zklogin/polymedia-zklogin-demo/web/src/_init.tsx              $REMOTE_HOME/zklogin/polymedia-zklogin-demo/web/src/_init.tsx"
  "experiments/lib/playwright-steps.mjs                          $REMOTE_HOME/experiments/lib/playwright-steps.mjs"
)

# Stage to /tmp on EC2 then mv into place.
TMP=/tmp/zkfix.$$
ssh -i "$SSH_KEY" "$SSH_USER@$EC2_HOST" "mkdir -p $TMP"

for spec in "${FILES[@]}"; do
  read -r LOCAL REMOTE <<<"$spec"
  echo "[sync]   $LOCAL  →  $REMOTE"
  scp -i "$SSH_KEY" -q "$LOCAL" "$SSH_USER@$EC2_HOST:$TMP/$(basename "$LOCAL")"
  ssh -i "$SSH_KEY" "$SSH_USER@$EC2_HOST" \
      "mkdir -p $(dirname "$REMOTE") && mv $TMP/$(basename "$LOCAL") $REMOTE"
done

ssh -i "$SSH_KEY" "$SSH_USER@$EC2_HOST" "rm -rf $TMP"

# md5 verify
echo
echo "[sync] md5 (Mac vs EC2):"
for spec in "${FILES[@]}"; do
  read -r LOCAL REMOTE <<<"$spec"
  LOCAL_MD5=$(md5 -q "$LOCAL" 2>/dev/null || md5sum "$LOCAL" | awk '{print $1}')
  REMOTE_MD5=$(ssh -i "$SSH_KEY" "$SSH_USER@$EC2_HOST" "md5sum $REMOTE | awk '{print \$1}'")
  ok=" "
  [ "$LOCAL_MD5" = "$REMOTE_MD5" ] && ok="✓" || ok="✗"
  printf "  %s  %-60s  mac=%s  ec2=%s\n" "$ok" "$(basename "$LOCAL")" "$LOCAL_MD5" "$REMOTE_MD5"
done

# Wipe sessionStorage in chrome profile so a stale "proxy" / "direct" doesn't
# leak into the next run. Local Storage is also wiped because zkdid.currentPage
# in there can land us on the wrong page on first navigation.
echo
echo "[sync] clearing chrome-profile session/local storage:"
ssh -i "$SSH_KEY" "$SSH_USER@$EC2_HOST" "
  cd $REMOTE_HOME/experiments
  rm -rf '.chrome-profile/Default/Session Storage' '.chrome-profile/Default/Local Storage' 2>/dev/null
  echo '  cleared'
"

# Vite hot-reloads on file change; nothing else to restart.
echo
echo "[sync] DONE. Run a smoke test like:"
echo "  ssh -i $SSH_KEY $SSH_USER@$EC2_HOST 'cd $REMOTE_HOME/experiments && ./run-in-dcv.sh --runs=1 --institutions=3 --cache=all --prover-mode=backend --tag=smoke_backend --headless=true'"
