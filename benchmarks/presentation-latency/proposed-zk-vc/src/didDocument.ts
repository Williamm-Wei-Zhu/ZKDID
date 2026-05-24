/**
 * Build a minimal W3C DID Document. Conforms to:
 *   https://www.w3.org/TR/did-core/
 *
 * The verificationMethod includes both `publicKeyHex` (canonical for our
 * baseline) and `publicKeyMultibase` (so the doc validates against W3C
 * tooling). The `service` endpoint is included as an example.
 */

import type { DidDocument } from "./types.js";

function bytesToMultibaseBase58btc(_bytes: Uint8Array): string {
  // We use a base58 implementation only for completeness in the DID document;
  // the on-chain object stores raw bytes, and signature verification operates
  // on the raw public key — never on the multibase string.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leadingZeros = 0;
  for (const b of _bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  let n = 0n;
  for (const b of _bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    out = ALPHABET[r] + out;
    n = n / 58n;
  }
  out = "1".repeat(leadingZeros) + out;
  return "z" + out; // multibase prefix `z` = base58btc
}

export function buildDidDocument(
  did: string,
  controllerSuiAddress: string,
  publicKeyBytes: Uint8Array,
  serviceEndpoint?: string,
): DidDocument {
  const vmId = `${did}#keys-1`;
  const doc: DidDocument = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    controller: controllerSuiAddress,
    verificationMethod: [
      {
        id: vmId,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyHex: Buffer.from(publicKeyBytes).toString("hex"),
        publicKeyMultibase: bytesToMultibaseBase58btc(publicKeyBytes),
      },
    ],
    authentication: [vmId],
  };
  if (serviceEndpoint) {
    doc.service = [
      { id: `${did}#service-1`, type: "EhrEndpoint", serviceEndpoint },
    ];
  }
  return doc;
}
