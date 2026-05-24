/**
 * Patient Wallet — owns a Sui address, signs transactions for grant creation.
 *
 * For the experiment, the patient signing key is sourced from SUI_PRIVATE_KEY
 * in .env and is the same key paying gas. (A real deployment would split
 * the patient signing key from the gas-payer key.)
 *
 * NEVER prints the private key.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

export class PatientWallet {
  readonly keypair: Ed25519Keypair;
  readonly address: string;

  constructor(suiPrivateKeyBech32: string) {
    const { secretKey } = decodeSuiPrivateKey(suiPrivateKeyBech32);
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    this.address = this.keypair.getPublicKey().toSuiAddress();
  }
}

/** Build a patient wallet from the configured `cfg.privateKey`. */
export function patientWalletFromConfigKey(suiPrivateKeyBech32: string): PatientWallet {
  return new PatientWallet(suiPrivateKeyBech32);
}
