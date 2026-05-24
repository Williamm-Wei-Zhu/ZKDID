/**
 * CLI entrypoint. Mirrors the experiments/run.mjs argv style.
 *
 *   prelogin    -> open Google signin in DCV; user signs in manually
 *   prime-token -> after prelogin, capture a verified ID token (for Mode 2)
 *   prime       -> prelogin + prime-token in sequence
 *   full        -> Mode 1 (silent SSO if profile is primed; else automated)
 *   reuse       -> Mode 2 (token / session reuse)
 *   all         -> Mode 1 then Mode 2
 */

import { runFullLoginExperiment } from "./experimentFullLogin.js";
import { runTokenReuseExperiment } from "./experimentTokenReuse.js";
import { runPrelogin, runPrime, runPrimeToken } from "./primeSession.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "all").toLowerCase();
  switch (cmd) {
    case "prelogin":
      await runPrelogin();
      break;
    case "prime-token":
      await runPrimeToken();
      break;
    case "prime":
      await runPrime();
      break;
    case "full":
      await runFullLoginExperiment();
      break;
    case "reuse":
      await runTokenReuseExperiment();
      break;
    case "all":
      await runFullLoginExperiment();
      await runTokenReuseExperiment();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: prelogin | prime-token | prime | full | reuse | all`
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
