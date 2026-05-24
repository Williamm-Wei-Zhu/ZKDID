/**
 * CLI entrypoint.
 *
 *   establish    -> Mode 1 (mandatory on-chain DID registration on devnet)
 *   auth         -> Mode 2 (challenge auth using on-chain DID resolution)
 *   vc           -> Mode 3 (VC issuance + verification — disabled by default)
 *   cross-access -> Mode 4 (end-to-end cross-institution access, DID/VC variant)
 *   all          -> establish then auth (then vc if enabled, then cross-access)
 */

import { runEstablishmentExperiment } from "./experimentDidEstablishment.js";
import { runChallengeAuthExperiment } from "./experimentChallengeAuth.js";
import { runVcExperiment } from "./experimentVc.js";
import { runCrossInstitutionAccessExperiment } from "./experimentCrossInstitutionAccess.js";
import { cfg } from "./config.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "cross-access").toLowerCase();
  switch (cmd) {
    case "establish":
      await runEstablishmentExperiment();
      break;
    case "auth":
      await runChallengeAuthExperiment();
      break;
    case "vc":
      await runVcExperiment();
      break;
    case "cross-access":
    case "cross":
      await runCrossInstitutionAccessExperiment();
      break;
    case "all":
      await runEstablishmentExperiment();
      await runChallengeAuthExperiment();
      if (cfg.enableVcExperiment) await runVcExperiment();
      await runCrossInstitutionAccessExperiment();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: establish | auth | vc | cross-access | all`
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
