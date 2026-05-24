// CLI argument parser for experiments/run.mjs.
// Style: plain key=value OR --key=value OR --flag. No external deps.

const USAGE = `
Usage: node run.mjs [options]

Options:
  --op=<did|vc|access>           On-chain op to perform (default: did)
  --institutions=<N>             How many institutions to select (1..10, default: 3)
  --cache=<all|none|mixed>       Salt-seed cache mode:
                                   all    = pre-populate all seeds (local Poseidon path)
                                   none   = clear all seeds (remote EC2 /get-salt path)
                                   mixed  = cache every other institution
                                 default: none
  --runs=<N>                     Number of runs in the batch (default: 5)
  --warm=<true|false>            Keep browser + page open between runs (true) or
                                 close+reopen (false, cold). default: true
  --headless=<true|false>        Headless browser (default: false for first run to
                                 allow manual Google login; then true)
  --outfile=<path>               CSV output path (default: results/<timestamp>.csv)
  --tag=<string>                 Free-form tag written into every CSV row
  --bridge=<url>                 Bridge URL (default: http://localhost:4317)
  --frontend=<url>               Frontend URL (default: http://localhost:1234)
  --sleep-between=<ms>           Sleep between runs (default: 2000)

Examples:
  # 20-run baseline for DID creation with 3 institutions, no cache
  node run.mjs --op=did --institutions=3 --cache=none --runs=20

  # Scalability sweep — run this 5 times with different --institutions values
  node run.mjs --op=did --institutions=1  --cache=all --runs=30 --tag=N1
  node run.mjs --op=did --institutions=10 --cache=all --runs=30 --tag=N10
`;

function parseBool(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const raw = {};
  for (const a of argv) {
    const m = a.match(/^--?([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    raw[m[1]] = m[2] ?? "true";
  }

  const op = raw.op || "did";
  if (!["did", "vc", "access"].includes(op)) {
    throw new Error(`invalid --op=${op} (expected did|vc|access)`);
  }
  const cache = raw.cache || "none";
  if (!["all", "none", "mixed"].includes(cache)) {
    throw new Error(`invalid --cache=${cache} (expected all|none|mixed)`);
  }
  const institutions = Math.max(1, Math.min(11, Number(raw.institutions || 3)));
  const runs = Math.max(1, Number(raw.runs || 5));
  const warm = parseBool(raw.warm, true);
  const headless = parseBool(raw.headless, false);
  const sleepBetween = Number(raw["sleep-between"] || 2000);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outfile = raw.outfile ||
    `results/${ts}_op-${op}_N${institutions}_cache-${cache}_runs${runs}.csv`;

  // --prover-mode controls the §5.8 attribution experiment.
  //   direct  — browser → Mysten (production-default; ~2500 ms)
  //   proxy   — browser → bridge → Mysten (CORS-eliminated; same ~2500 ms,
  //             confirms browser-internal overhead dominates)
  //   backend — browser SKIPS prover entirely; veramo-to-sui.js calls Mysten
  //             itself in Node (~33 ms). The actual win.
  const proverMode = raw["prover-mode"] || "direct";
  if (!["direct", "proxy", "backend"].includes(proverMode)) {
    throw new Error(`invalid --prover-mode=${proverMode} (expected direct|proxy|backend)`);
  }

  return {
    op, cache, institutions, runs, warm, headless, sleepBetween,
    outfile,
    tag: raw.tag || "",
    bridge: raw.bridge || "http://localhost:4317",
    frontend: raw.frontend || "http://localhost:1234",
    proverMode,
  };
}
