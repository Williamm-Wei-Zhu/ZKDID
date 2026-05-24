/**
 * CLI entrypoint.
 *
 *   prelogin       -- one-time Google sign-in via DCV
 *   prime-consent  -- one OIDC round-trip to grant OAuth consent
 *   prime          -- prelogin + prime-consent in sequence
 *   establish      -- measured zkLogin end-to-end identity establishment
 */

import { runEstablishExperiment } from "./experimentEstablish.js";
import { runPrelogin, runPrime, runPrimeConsent } from "./primeSession.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "establish").toLowerCase();
  switch (cmd) {
    case "prelogin": await runPrelogin(); break;
    case "prime-consent": await runPrimeConsent(); break;
    case "prime": await runPrime(); break;
    case "establish": await runEstablishExperiment(); break;
    default:
      console.error(`Unknown command: ${cmd}. Use one of: prelogin | prime-consent | prime | establish`);
      process.exit(2);
  }
}
main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
