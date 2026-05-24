/**
 * CLI entrypoint for the ACTION-EHR-inspired access-control baseline.
 *
 *   create-grant  -> Experiment 1
 *   verify-grant  -> Experiment 2
 *   e2e           -> Experiment 3
 *   all           -> 1 → 2 → 3
 */

import { runGrantCreationExperiment } from "./experimentGrantCreation.js";
import { runGrantVerificationExperiment } from "./experimentGrantVerification.js";
import { runEndToEndExperiment } from "./experimentEndToEnd.js";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "all").toLowerCase();
  switch (cmd) {
    case "create-grant":
    case "grant-creation":
      await runGrantCreationExperiment();
      break;
    case "verify-grant":
    case "grant-verification":
      await runGrantVerificationExperiment();
      break;
    case "e2e":
    case "end-to-end":
      await runEndToEndExperiment();
      break;
    case "all":
      await runGrantCreationExperiment();
      await runGrantVerificationExperiment();
      await runEndToEndExperiment();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. ` +
          `Use one of: create-grant | verify-grant | e2e | all`,
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
