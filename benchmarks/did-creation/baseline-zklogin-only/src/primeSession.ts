/**
 * One-time interactive priming for the zkLogin baseline:
 *
 *   1. `prelogin`     -- open accounts.google.com directly inside DCV.
 *                        Operator signs in manually. Persistent profile saved.
 *   2. `prime-consent` -- one OIDC implicit-flow round-trip with prompt=consent
 *                        so the operator can grant the OAuth client access
 *                        to the requested scopes. Subsequent measured runs
 *                        use prompt=none for silent SSO.
 */

import readline from "node:readline/promises";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { cfg } from "./config.js";
import { suiClient } from "./suiClient.js";
import { preloginToGoogle, primeConsent } from "./oidcLogin.js";

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

export async function runPrelogin(): Promise<void> {
  console.log("\n=== Step 1/2: Google prelogin (interactive, in DCV) ===");
  await preloginToGoogle(cfg, () =>
    waitForEnter("[prelogin] Press Enter AFTER you've signed into Google -> "));
}

export async function runPrimeConsent(): Promise<void> {
  console.log("\n=== Step 2/2: Grant OAuth consent (one OIDC round-trip) ===");
  // Build a real zkLogin nonce so Google validates the request the same way
  // it will during measured runs. We do not save the resulting JWT -- this
  // is purely a side-effect call to grant {sub, aud, scope} consent.
  const ephKp = new Ed25519Keypair();
  const sysState = await suiClient().getLatestSuiSystemState();
  const maxEpoch = Number(sysState.epoch) + cfg.maxEpochDelta;
  const randomness = generateRandomness();
  const nonce = generateNonce(ephKp.getPublicKey(), maxEpoch, randomness);
  console.log("[prime-consent] If a Google consent screen appears in DCV, click 'Allow'.");
  await primeConsent(cfg, nonce);
  console.log("[prime-consent] DONE -- silent SSO will work for measured runs.");
}

export async function runPrime(): Promise<void> {
  await runPrelogin();
  await runPrimeConsent();
}
