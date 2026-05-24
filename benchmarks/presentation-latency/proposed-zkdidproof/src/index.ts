/**
 * CLI entrypoint.
 *
 *   prelogin    -> open Google signin in DCV; user signs in manually
 *   prime-token -> after prelogin, capture a verified ID token
 *   prime       -> prelogin + prime-token in sequence
 *   zkdidproof  -> END-TO-END zkDIDProof PRESENTATION LATENCY (this folder's headline experiment)
 *   full        -> legacy OIDC-only Mode 1 (carried over from oidc-only-presentation-latency)
 *   reuse       -> legacy OIDC-only Mode 2
 */

import { runFullLoginExperiment } from "./experimentFullLogin.js";
import { runTokenReuseExperiment } from "./experimentTokenReuse.js";
import { runPrelogin, runPrime, runPrimeToken } from "./primeSession.js";
import { runZkdidProofExperiment } from "./experimentZkdidProof.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "zkdidproof").toLowerCase();
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
    case "zkdidproof":
      await runZkdidProofExperiment();
      break;
    case "full":
      await runFullLoginExperiment();
      break;
    case "reuse":
      await runTokenReuseExperiment();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: prelogin | prime-token | prime | zkdidproof | full | reuse`,
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
