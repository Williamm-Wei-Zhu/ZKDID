# EC2 DCV Experiment Workflow (for China / GFW setup)

Everything runs on **EC2 us-east-1** to sidestep the cross-firewall latency and
variance. The only thing you do from your Mac is connect a DCV Viewer for the
one-time Google OAuth login; after that, batch experiments run headless on the
EC2 box.

## Current status on EC2

Verified and running:

| Component | State |
|---|---|
| `dcvserver.service` | active, session `desktop` on DISPLAY=`:1` |
| 10 × salt-service | pm2-managed on ports 7001-7010 |
| Bridge | `localhost:4317` |
| Vite | `localhost:1234` |
| Playwright + Chromium | installed in `~/zkdid-patient/experiments/` |
| Experiment code | synced at `~/zkdid-patient/experiments/` |
| Config | `institutions` URLs point at `localhost:7001..7010` (zero-RTT) |

## One-time: ensure DCV Viewer port is reachable

AWS Security Group must allow **TCP 8443** from your current IP (or `0.0.0.0/0`
for demo). Check in AWS Console → EC2 → Instances → Security tab.

## Mac side — download DCV Viewer

1. Download: <https://download.nice-dcv.com/latest.html> → **NICE DCV Client for macOS**
2. Install the .dmg
3. Launch **DCV Viewer**

## Connect to the EC2 DCV session

In DCV Viewer, create a new connection:

- **Host**: `ec2-54-163-104-155.compute-1.amazonaws.com:8443`
- **Username**: `ubuntu`
- **Password**: the password for the `ubuntu` user on EC2 (if not set yet, run
  `sudo passwd ubuntu` from SSH first)

On first connect, DCV Viewer asks to trust the self-signed cert — click "Trust
and connect". You'll see a small desktop (800×600 default — resizable from DCV
preferences).

## One-time: Google OAuth login inside DCV

Once you see the DCV desktop:

1. Open a terminal inside the DCV session (right-click → Open Terminal, or
   launch `xterm` from an SSH session with `DISPLAY=:1 xterm &`)
2. Run:
   ```bash
   cd ~/zkdid-patient/experiments
   ./run-in-dcv.sh --runs=1 --institutions=3 --cache=none
   ```
3. A Chromium window appears inside the DCV desktop
4. The script auto-clicks "Google" → Google's login page loads
5. **You manually sign into Google** in that window (same as on your Mac)
6. After consent, you're redirected back to `localhost:1234`
7. Script continues autonomously: ZK prover, Sui DevNet submit, CSV write
8. You'll see "Logged in as ..." and "DID transaction dispatched" toasts
9. Chromium closes; CSV row written to `~/zkdid-patient/experiments/results/`

From now on, the Google cookie is stored in `./.chrome-profile/` on EC2 and
every subsequent run is fully silent.

## Batch experiments (after first login)

**You do NOT need DCV Viewer open for these** — they run headless. SSH in from
your Mac as usual and launch them:

```bash
ssh -i aws.pem ubuntu@ec2-54-163-104-155.compute-1.amazonaws.com
cd ~/zkdid-patient/experiments

# Full experiment matrix — roughly 30-45 min for ~180 runs
for N in 1 3 5 10; do
  ./run-in-dcv.sh --op=did --institutions=$N --cache=none \
    --runs=30 --headless=true --tag="scale_N${N}_remote"
done
./run-in-dcv.sh --op=did --institutions=3 --cache=all  --runs=30 --headless=true --tag="ablation_cached"
./run-in-dcv.sh --op=did --institutions=3 --cache=none --runs=30 --headless=true --tag="ablation_remote"
./run-in-dcv.sh --op=vc  --institutions=3 --cache=all  --runs=30 --headless=true --tag="op_vc"
```

Or launch with `nohup`/`tmux` so it survives SSH disconnect:

```bash
tmux new -s exp
cd ~/zkdid-patient/experiments
./run-in-dcv.sh --op=did --institutions=3 --cache=all --runs=100 --headless=true --tag=baseline
# detach with Ctrl-b d; reattach with: tmux attach -t exp
```

## Download results back to Mac

```bash
# On Mac, in this repo root
rsync -av -e "ssh -i aws.pem" \
  ubuntu@ec2-54-163-104-155.compute-1.amazonaws.com:~/zkdid-patient/experiments/results/ \
  ./experiments/results-from-ec2/
```

Then analyze locally with pandas/R/Excel.

## Watching a batch run live (optional)

If you want to observe the headless runs as they happen (useful for debugging
a failing run), keep DCV Viewer open in the background but run the experiment
with `--headless=false`. The Chromium window appears in DCV; the script still
writes CSV rows.

```bash
./run-in-dcv.sh --op=did --institutions=3 --cache=all --runs=5 --headless=false
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| DCV Viewer: "auth failed" | On EC2: `sudo passwd ubuntu` to set a password |
| DCV Viewer: connection refused | Security group → open TCP 8443 from your IP |
| First run: Chromium doesn't appear | Check DCV session: `sudo dcv list-sessions`. If missing: `sudo dcv create-session --owner ubuntu --type virtual desktop` |
| "timeout waiting for fresh backend timings" | Dev stack died. SSH in, run `tail /tmp/zkdev.log`, restart: `cd ~/zkdid-patient && nohup npm run dev > /tmp/zkdev.log 2>&1 &` |
| Google "This browser may not be secure" | Open DCV → in the Chromium that popped up, manually navigate to `https://accounts.google.com` first, complete the "verify it's you" challenge once |
| All runs fail with "nonce mismatch" | Clear the profile: `rm -rf ~/zkdid-patient/experiments/.chrome-profile` and log in fresh |
| "EC2 hostname changed again" | New hostname = new public DNS but probably same instance. Re-set `EC2_HOST` env and SSH as usual |

## Architecture recap

```
     Mac (China + VPN)                      EC2 us-east-1
 ┌────────────────────┐                ┌─────────────────────────────────┐
 │ SSH terminal       │◄──── TCP ─────►│ sshd (one SSH session)          │
 │ (issue commands,   │                │                                  │
 │  review logs)      │                │ dcvserver :8443 (TLS, native)   │
 │                    │                │   └─ session 'desktop' on DISP=:1│
 │ DCV Viewer ────────┼──── UDP+TCP ──►│         │                        │
 │  (first login only)│     8443       │         ▼                        │
 └────────────────────┘                │ Playwright Chromium (headed       │
                                       │     during login, headless later) │
                                       │    │                              │
                                       │    │ fetches                       │
                                       │    ▼                              │
                                       │ Vite :1234 + Bridge :4317         │
                                       │    │                              │
                                       │    │ spawns                       │
                                       │    ▼                              │
                                       │ veramo-to-sui.js                  │
                                       │    │                              │
                                       │    ├──► localhost:7001..7010 (salts)│
                                       │    ├──► prover-dev.mystenlabs.com │
                                       │    └──► fullnode.devnet.sui.io    │
                                       │       (all us-east-1, low-RTT)    │
                                       └─────────────────────────────────┘

DCV Viewer is ONLY used for the one-time Google OAuth.
Batch experiments run headless; you see output via SSH.
```
