/**
 * CLI entrypoint.
 *
 *   prelogin             -- one-time Google sign-in via DCV
 *   prime-consent        -- one OIDC round-trip to grant OAuth consent
 *   prime                -- prelogin + prime-consent in sequence
 *   establish            -- measured zkLogin end-to-end identity establishment
 *   cross-access         -- measured zkLogin end-to-end cross-institution access
 *                           (full establishment per run — phases A through F)
 *   cross-access-reuse   -- measured zkLogin cross-institution access with
 *                           SESSION REUSE (phases A–D paid ONCE, then 100
 *                           runs reuse the cached proof + ephemeral key)
 */

import { runEstablishExperiment } from "./experimentEstablish.js";
import { runCrossInstitutionAccessExperiment } from "./experimentCrossInstitutionAccess.js";
import { runCrossAccessSessionReuseExperiment } from "./experimentCrossAccessSessionReuse.js";
import { runPrelogin, runPrime, runPrimeConsent } from "./primeSession.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "cross-access").toLowerCase();
  switch (cmd) {
    case "prelogin": await runPrelogin(); break;
    case "prime-consent": await runPrimeConsent(); break;
    case "prime": await runPrime(); break;
    case "establish": await runEstablishExperiment(); break;
    case "cross-access":
    case "cross":
      await runCrossInstitutionAccessExperiment(); break;
    case "cross-access-reuse":
    case "cross-reuse":
    case "reuse":
      await runCrossAccessSessionReuseExperiment(); break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: prelogin | prime-consent | prime | establish | ` +
          `cross-access | cross-access-reuse`,
      );
      process.exit(2);
  }
}
main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
