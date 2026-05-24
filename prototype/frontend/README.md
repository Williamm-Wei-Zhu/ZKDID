# zkDID / zkEHR — Frontend

React + TypeScript + Vite web app implementing the patient-facing zkLogin flow: OAuth login,
ephemeral keypair generation, ZK proof acquisition from the Sui zkLogin prover, and timing
instrumentation for the experiments.

## Attribution

This frontend is derived from **[Polymedia's zkLogin demo](https://github.com/juzybits/polymedia-zklogin)**,
which is licensed under the **Apache License 2.0**. The original license is retained in
[`LICENSE`](LICENSE) as required.

## Running

It is normally launched from the repo root via the orchestrator (which sets epoch/session
environment and spawns Vite):

```bash
# from the repo root
npm run dev          # → http://localhost:1234
```

Standalone (without the orchestrator):

```bash
npm install
npm run dev
```

## Configuration

Copy the template and fill in your OAuth client IDs / prover URL / salt seeds:

```bash
cp src/config.example.json src/config.json
```

`src/config.json` is gitignored.
