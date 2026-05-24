/**
 * CLI entrypoint.
 *
 *   establish  -> Mode 1 (mandatory on-chain DID registration on devnet)
 *   auth       -> Mode 2 (challenge auth using on-chain DID resolution)
 *   vc         -> Mode 3 (VC issuance + verification — disabled by default)
 *   all        -> establish then auth (then vc if enabled)
 */

import { runEstablishmentExperiment } from "./experimentDidEstablishment.js";
import { runChallengeAuthExperiment } from "./experimentChallengeAuth.js";
import { runVcExperiment } from "./experimentVc.js";
import { cfg } from "./config.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "all").toLowerCase();
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
    case "all":
      await runEstablishmentExperiment();
      await runChallengeAuthExperiment();
      if (cfg.enableVcExperiment) await runVcExperiment();
      break;
    default:
      console.error(`Unknown command: ${cmd}. Use one of: establish | auth | vc | all`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
