/**
 * CLI entrypoint.
 *
 *   establish    -> DID establishment (one-time on-chain registration on devnet)
 *   auth         -> challenge auth using on-chain DID resolution (legacy)
 *   vc           -> VC issuance + verification (legacy)
 *   presentation -> END-TO-END ZK-VC PRESENTATION LATENCY (this folder's headline experiment)
 *   all          -> establish then auth (then vc if enabled)
 */

import { runEstablishmentExperiment } from "./experimentDidEstablishment.js";
import { runChallengeAuthExperiment } from "./experimentChallengeAuth.js";
import { runVcExperiment } from "./experimentVc.js";
import { runZkVcPresentationLatencyExperiment } from "./experimentZkVcPresentationLatency.js";
import { cfg } from "./config.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "presentation").toLowerCase();
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
    case "presentation":
      await runZkVcPresentationLatencyExperiment();
      break;
    case "all":
      await runEstablishmentExperiment();
      await runChallengeAuthExperiment();
      if (cfg.enableVcExperiment) await runVcExperiment();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: establish | auth | vc | presentation | all`,
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
