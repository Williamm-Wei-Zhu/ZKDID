/**
 * CLI entrypoint.
 *
 *   prelogin                 one-time Google sign-in via DCV
 *   prime-consent            one OIDC round-trip to grant OAuth consent
 *   prime                    prelogin + prime-consent
 *   establish                measured zkEHR identity-establishment baseline
 *   setup-hospital-dids      one-time: register A-DID and B-DID on chain
 *   cross-access             measured cross-institution access (session reuse)
 *   cross-access-no-session  measured cross-institution access (full zkLogin per run)
 */

import { runEstablishExperiment } from "./experimentEstablish.js";
import { runSetupHospitalDidsExperiment } from "./experimentSetupHospitalDids.js";
import { runZkehrCrossAccessExperiment } from "./experimentZkehrCrossAccess.js";
import { runZkehrNoSessionCrossAccessExperiment } from "./experimentZkehrNoSessionCrossAccess.js";
import { runPrelogin, runPrime, runPrimeConsent } from "./primeSession.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "cross-access").toLowerCase();
  switch (cmd) {
    case "prelogin": await runPrelogin(); break;
    case "prime-consent": await runPrimeConsent(); break;
    case "prime": await runPrime(); break;
    case "establish": await runEstablishExperiment(); break;
    case "setup-hospital-dids":
    case "setup":
      await runSetupHospitalDidsExperiment(); break;
    case "cross-access":
    case "cross":
      await runZkehrCrossAccessExperiment(); break;
    case "cross-access-no-session":
    case "no-session":
      await runZkehrNoSessionCrossAccessExperiment(); break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: prelogin | prime-consent | prime | establish | ` +
          `setup-hospital-dids | cross-access | cross-access-no-session`,
      );
      process.exit(2);
  }
}
main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
