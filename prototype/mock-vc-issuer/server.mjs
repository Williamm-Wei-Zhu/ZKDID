/**
 * OIDC4VCI-style mock Verifiable Credential issuer.
 *
 * Two endpoints:
 *
 *   POST /issue-vc/ed25519           — W3C VC, canonical JSON, Ed25519 signature
 *   POST /issue-vc/eddsa-poseidon    — ZK-friendly credential: m_jwt + EdDSA-Poseidon sig
 *
 * Both endpoints authenticate the patient by verifying a Google ID token
 * (any standard OIDC issuer). They then sign a VC bound to the requested
 * subject DID and return it.
 *
 * Static (one-time at process boot) costs:
 *   - JWKS cooldown / fetch from Google
 *   - Issuer keypair generation (Ed25519, EdDSA-Poseidon)
 *   - circomlibjs Poseidon + EdDSA WASM init
 *
 * Per-request (measured) costs:
 *   - JWKS lookup (cached)
 *   - JWT signature verification (Google RS256)
 *   - Claim validation
 *   - VC payload construction + canonicalization
 *   - Detached signature (Ed25519 or EdDSA-Poseidon)
 *   - JSON serialization
 *
 * The issuer's public key is returned with each response so the patient
 * (and downstream relying party) can verify without a separate key-fetch.
 *
 * Env vars:
 *   GOOGLE_CLIENT_ID  — required, audience to enforce on the patient JWT
 *   PORT              — default 4321
 */

import express from "express";
import { jwtVerify, createRemoteJWKSet, decodeJwt } from "jose";
import { ed25519 } from "@noble/curves/ed25519";
import { buildEddsa, buildPoseidon } from "circomlibjs";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4321);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.error("FATAL: GOOGLE_CLIENT_ID env var is required");
  process.exit(2);
}

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 },
);

// ---------- Static issuer state (boot-time) ----------------------------------

// Ed25519 issuer keypair for the W3C VC endpoint.
const ED25519_SECRET = ed25519.utils.randomPrivateKey();
const ED25519_PUBLIC = ed25519.getPublicKey(ED25519_SECRET);
const ED25519_PUB_HEX = Buffer.from(ED25519_PUBLIC).toString("hex");

// EdDSA-Poseidon issuer key. Must match the authority key the zkdid-circuit
// was compiled with, otherwise the patient's Groth16 proof will not verify.
// The compile-time default is `0x...01`.
const POSEIDON_SECRET = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000001", "hex");

const eddsa = await buildEddsa();
const poseidon = await buildPoseidon();
const F = poseidon.F;
const POSEIDON_PUBLIC = eddsa.prv2pub(POSEIDON_SECRET);
const POSEIDON_PUB_X = F.toObject(POSEIDON_PUBLIC[0]).toString();
const POSEIDON_PUB_Y = F.toObject(POSEIDON_PUBLIC[1]).toString();

const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function textToFieldDecimal(text) {
  const digest = createHash("sha256").update(String(text), "utf8").digest("hex");
  return ((BigInt("0x" + digest) % SCALAR_FIELD)).toString();
}

const ISSUER_DID = "did:web:trusted-clinic-ca.example";
const ISSUER_DID_FIELD = textToFieldDecimal(ISSUER_DID);

// ---------- HTTP layer -------------------------------------------------------

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    issuer_did: ISSUER_DID,
    ed25519_pubkey_hex: ED25519_PUB_HEX,
    eddsa_poseidon_pubkey: { x: POSEIDON_PUB_X, y: POSEIDON_PUB_Y },
  });
});

/**
 * Authenticate the patient by verifying a Google ID token. Returns the
 * verified payload on success; throws on any failure.
 */
async function authenticatePatient(idToken) {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUER,
    audience: GOOGLE_CLIENT_ID,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Invalid id_token: missing 'sub'");
  }
  return payload;
}

// ---------- W3C VC (Ed25519) -------------------------------------------------

app.post("/issue-vc/ed25519", async (req, res) => {
  try {
    const { id_token, subject_did } = req.body ?? {};
    if (!id_token || typeof id_token !== "string") {
      return res.status(400).json({ error: "id_token (string) required" });
    }
    if (!subject_did || typeof subject_did !== "string") {
      return res.status(400).json({ error: "subject_did (string) required" });
    }
    const claims = await authenticatePatient(id_token);

    const issuanceDate = new Date();
    const expirationDate = new Date(issuanceDate.getTime() + 90 * 86400_000);
    const vc = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiableCredential", "PatientEligibility"],
      issuer: ISSUER_DID,
      issuanceDate: issuanceDate.toISOString(),
      expirationDate: expirationDate.toISOString(),
      credentialSubject: {
        id: subject_did,
        role: "patient",
        eligible: true,
        google_sub: claims.sub,
      },
    };
    const canonical = JSON.stringify(vc);
    const sig = ed25519.sign(new TextEncoder().encode(canonical), ED25519_SECRET);
    res.json({
      vc,
      canonical,
      signature_hex: Buffer.from(sig).toString("hex"),
      issuer_pubkey_hex: ED25519_PUB_HEX,
      issuer_did: ISSUER_DID,
    });
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- ZK-friendly credential (EdDSA-Poseidon) --------------------------
//
// The patient supplies the per-session field elements needed to bind the
// circuit input: aud_field, nonce_jwt_field. The issuer signs
// m_jwt = Poseidon(sub, iss, aud_jwt, nonce_jwt) using its EdDSA-Poseidon
// key. `sub` and `iss` are derived from the verified Google JWT to enforce
// holder-binding.

app.post("/issue-vc/eddsa-poseidon", async (req, res) => {
  try {
    const { id_token, subject_did, aud_field, nonce_jwt_field } = req.body ?? {};
    if (!id_token || !subject_did || !aud_field || !nonce_jwt_field) {
      return res.status(400).json({
        error: "id_token, subject_did, aud_field, nonce_jwt_field all required",
      });
    }
    const claims = await authenticatePatient(id_token);
    const subField = textToFieldDecimal(claims.sub);
    const issField = textToFieldDecimal(claims.iss ?? GOOGLE_ISSUER);

    const mJwt = poseidon([
      BigInt(subField), BigInt(issField),
      BigInt(aud_field), BigInt(nonce_jwt_field),
    ]);
    const sig = eddsa.signPoseidon(POSEIDON_SECRET, mJwt);

    res.json({
      sub: subField,
      iss: issField,
      m_jwt: F.toObject(mJwt).toString(),
      sig_r8x: F.toObject(sig.R8[0]).toString(),
      sig_r8y: F.toObject(sig.R8[1]).toString(),
      sig_s: sig.S.toString(),
      issuer_pubkey: { x: POSEIDON_PUB_X, y: POSEIDON_PUB_Y },
      issuer_did: ISSUER_DID,
      issuer_did_field: ISSUER_DID_FIELD,
      subject_did,
    });
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------- Boot -------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`mock VC issuer listening on http://127.0.0.1:${PORT}`);
  console.log(`  Ed25519 issuer pubkey  : ${ED25519_PUB_HEX}`);
  console.log(`  EdDSA-Poseidon Ax      : ${POSEIDON_PUB_X.slice(0, 24)}...`);
  console.log(`  EdDSA-Poseidon Ay      : ${POSEIDON_PUB_Y.slice(0, 24)}...`);
  console.log(`  expects audience       : ${GOOGLE_CLIENT_ID}`);
});
