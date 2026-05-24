# zkDID Salt Service

A tiny standalone service that derives a **per-institution salt** for Sui zkLogin,
given a user's JWT. One instance = one institution. Run N instances on N different
servers to simulate a multi-institutional healthcare network.

Deterministic. Stateless (apart from an in-memory rate limiter). No database.

## Algorithm

```
salt = Poseidon(institution_seed, BigInt(jwt.sub))   mod   2^128
```

This matches the browser-side derivation in the zkDID Patient frontend
(`zklogin/polymedia-zklogin-demo/web/src/App.tsx::deriveSaltFromSelectedSeeds`),
so patients get the **same zkLogin address** whether the salt comes from this
service or is computed locally.

## API

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/healthz` | — | `{ ok: true, institution, version }` |
| GET | `/institution` | — | `{ name, verifyJwt }` (seed is never exposed) |
| POST | `/get-salt` | `{ jwt: string }` | `{ salt: "<decimal>", institution }` |

Errors are JSON `{ error: "..." }` with appropriate HTTP status.

## Configuration

Priority: environment variable **overrides** value in `config.json`.

| Env | File key | Default | Notes |
|---|---|---|---|
| `PORT` | `port` | `7000` | |
| `INSTITUTION_NAME` | `institution` | `"Institution 1"` | Displayed in `/institution` and logs |
| `INSTITUTION_SEED` | `seed` | **(required)** | 128-bit integer string |
| `CORS_ORIGIN` | `corsOrigin` | `*` | Pin to your frontend origin in prod |
| `VERIFY_JWT` | `verifyJwt` | `false` | Enables provider-JWKS `kid` check |
| `RATE_LIMIT_WINDOW_MS` | `rateLimit.windowMs` | `60000` | |
| `RATE_LIMIT_MAX` | `rateLimit.max` | `60` | per-IP, in-memory only |

## Running locally

```bash
cd salt-service
npm install
cp config.json.example config.json
# edit config.json: change "institution" and "seed"
node server.mjs
```

Smoke test:

```bash
# health
curl -s http://localhost:7000/healthz
# institution info
curl -s http://localhost:7000/institution
# salt — replace <JWT> with a Google/Twitch id_token
curl -s -X POST http://localhost:7000/get-salt \
  -H 'content-type: application/json' \
  -d "{\"jwt\":\"<JWT>\"}"
```

## Deploying to EC2

### Plain process (simplest)

```bash
ssh -i aws.pem ubuntu@your-ec2-host
# node 18+ required
scp -i aws.pem -r salt-service/ ubuntu@your-ec2-host:~/
ssh -i aws.pem ubuntu@your-ec2-host
cd ~/salt-service
npm install --omit=dev
cp config.json.example config.json
nano config.json   # set institution name + seed
# open port 7000 in the EC2 security group first!
INSTITUTION_NAME="Hospital A" INSTITUTION_SEED="287311...088" node server.mjs
```

### With `pm2` (survives SSH disconnect)

```bash
sudo npm install -g pm2
cd ~/salt-service
pm2 start server.mjs --name salt-hosp-a \
  --env "INSTITUTION_NAME=Hospital A" \
  --env "INSTITUTION_SEED=287311..." \
  --env "PORT=7001"
pm2 save && pm2 startup      # optional: autostart on reboot
pm2 logs salt-hosp-a
```

Run multiple institutions by repeating with different `--name`, different `PORT`, and different `INSTITUTION_SEED`.

### Docker (portable)

```bash
cd salt-service
docker build -t zkdid-salt:1.0.0 .

docker run -d --name salt-hosp-a \
  -p 7001:7000 \
  -e INSTITUTION_NAME="Hospital A" \
  -e INSTITUTION_SEED="287311631180190480659416554780786503088" \
  zkdid-salt:1.0.0

docker run -d --name salt-hosp-b \
  -p 7002:7000 \
  -e INSTITUTION_NAME="Hospital B" \
  -e INSTITUTION_SEED="223808564815128095305694472431833434294" \
  zkdid-salt:1.0.0
```

### Render / Fly.io / Railway

Point the platform at this directory — the Dockerfile is self-contained.
Set `INSTITUTION_NAME` and `INSTITUTION_SEED` in the platform's env UI.

## Wiring into the frontend

In `zklogin/polymedia-zklogin-demo/web/src/config.json`, add an `institutions` array:

```json
{
  "institutions": [
    { "name": "Hospital A", "url": "https://salt-a.example.com" },
    { "name": "Hospital B", "url": "http://your-ec2:7002" }
  ]
}
```

The frontend fetches salts from selected institutions (via POST `/get-salt`)
and Poseidon-merges them into a single `USER_SALT` — the existing salt-seeds
behavior, now remote-sourced instead of locally derived.

## Security caveats

- This is a **research-grade** service. In particular:
  - `VERIFY_JWT=false` means anyone can request a salt with any (well-formed) JWT. The returned salt doesn't grant anything on its own — it's only useful combined with a valid zkLogin flow — but a malicious client could enumerate salts for known `sub` values.
  - The rate limiter is in-memory per process; a multi-replica deployment loses enforcement across replicas. Pair with a reverse proxy (Caddy/nginx) rate limit for real use.
  - CORS defaults to `*`. Pin to your origin in production.
- The **seed is your institution's long-lived secret**. Treat it as such:
  - Never commit `config.json` (already in `.dockerignore` and the project `.gitignore`).
  - Prefer passing via `INSTITUTION_SEED` env through your platform's secret store.
  - Rotating the seed invalidates every existing zkLogin address derived against it.

## License

MIT
