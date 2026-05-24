/**
 * Ed25519 key-pair helpers.
 *
 * The patient's long-term key is generated via the Sui SDK's Ed25519Keypair
 * (which wraps @noble/ed25519). We can also import a pre-existing key from
 * a Sui-CLI-exported `suiprivkey1...` bech32 string so the gas-payer key set
 * in .env is reused.
 *
 * ACADEMIC BASELINE — keys are persisted unencrypted in `data/`. Real wallets
 * MUST use OS keystores or hardware-backed keychains.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

export function generatePatientKeypair(): Ed25519Keypair {
  return new Ed25519Keypair();
}

/**
 * Restore a keypair from its Sui CLI bech32 export (`suiprivkey1...`).
 * Used to reconstruct previously-stored patient wallets so the auth
 * experiment can replay an existing DID.
 */
export function keypairFromSuiPrivateKey(bech32: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(bech32);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export function publicKeyHex(kp: Ed25519Keypair): string {
  return Buffer.from(kp.getPublicKey().toRawBytes()).toString("hex");
}

export function suiAddress(kp: Ed25519Keypair): string {
  return kp.getPublicKey().toSuiAddress();
}

/** Export to the bech32 form for persistence. */
export function exportSuiPrivateKey(kp: Ed25519Keypair): string {
  return kp.getSecretKey();
}
