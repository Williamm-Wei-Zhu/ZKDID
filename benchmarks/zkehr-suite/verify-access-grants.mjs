#!/usr/bin/env node
// experiments/verify-access-grants.mjs
//
// Round-trip verification for AccessGrant records produced by
// run-session-reuse.mjs --op=access. For each transaction digest in the input
// CSV, this script:
//   1. Fetches the transaction's objectChanges from Sui DevNet.
//   2. Locates the created AccessGrant Move object.
//   3. Loads its on-chain content and decodes the four vector<u8> fields back
//      to UTF-8 strings (patient_did, hospital_did, grantee_did, record_id).
//   4. Verifies that:
//        - patient_did, hospital_did, grantee_did all equal the
//          self-grant target DID (the patient's own zkLogin DID),
//        - record_id matches the experiment driver's `rec-<ts>-<i>` format,
//        - is_active is true.
//   5. Prints a per-row pass/fail line and a final summary.
//
// The expected patient DID can be either:
//   * supplied on the command line via --patient-did=did:zklogin:google:0x…
//   * or auto-derived from the patient_did field of the first successfully
//     fetched AccessGrant (the script uses this as the canonical reference for
//     all subsequent rows; any divergence is reported as a failure).
//
// Usage:
//   node verify-access-grants.mjs                                              # auto-pick latest CSV
//   node verify-access-grants.mjs <csv-path>
//   node verify-access-grants.mjs <csv-path> --patient-did=did:zklogin:google:0x…
//
// Network: queries https://fullnode.devnet.sui.io. Read-only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- helpers ----------------

/**
 * Decode a Move `vector<u8>` field as returned by SuiClient.getObject.
 *
 * Sui SDK can surface vector<u8> in several shapes depending on indexer
 * version: a JS array of byte-valued numbers, a base64 string, a
 * comma-separated decimal string, or sometimes already a UTF-8 string when
 * the indexer pre-decoded it. Handle all four.
 */
function decodeBytesField(field) {
  if (Array.isArray(field)) {
    // JS array of bytes
    return Buffer.from(field).toString("utf-8");
  }
  if (typeof field === "string") {
    // Already-decoded UTF-8 string (newer SDK versions). Recognize by:
    //   - presence of "did:" prefix, or
    //   - ASCII-printable content not in base64 alphabet, or
    //   - matches the experiment record-id format.
    if (field.startsWith("did:") || /^rec-\d+-\d+$/.test(field)) return field;
    // Try base64 decode; if the result is printable ASCII, use it.
    try {
      const buf = Buffer.from(field, "base64");
      const utf = buf.toString("utf-8");
      if (utf && /^[\x20-\x7e]+$/.test(utf)) return utf;
    } catch { /* fall through */ }
    // Last resort — return the raw string.
    return field;
  }
  return String(field);
}

function loadCsv(p) {
  const text = fs.readFileSync(p, "utf-8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // Naive CSV split — our CSVs don't contain quoted commas in the columns we read.
    const fields = line.split(",");
    const r = {};
    headers.forEach((h, i) => (r[h] = fields[i] || ""));
    return r;
  });
}

function findLatestAccessCsv() {
  const dir = path.resolve(__dirname, "results-from-ec2");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /op-access.*runs\d+_sessionreuse\.csv$/.test(f));
  if (!files.length) {
    throw new Error(`no access-sessionreuse CSV found in ${dir}`);
  }
  files.sort().reverse();
  return path.join(dir, files[0]);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--patient-did=")) out.patientDid = a.slice("--patient-did=".length);
    else if (!a.startsWith("--") && !out.csv) out.csv = a;
  }
  return out;
}

// ---------------- main ----------------
async function main() {
  const args = parseArgs(process.argv);
  const csvPath = args.csv || findLatestAccessCsv();
  console.log(`[verify] CSV: ${csvPath}`);

  const rows = loadCsv(csvPath);
  console.log(`[verify] rows: ${rows.length}`);
  if (!rows.length) { console.log("[verify] empty CSV"); process.exit(2); }

  const client = new SuiClient({ url: getFullnodeUrl("devnet") });

  let expectedDid = args.patientDid || null;
  if (expectedDid) console.log(`[verify] expected patient DID (from CLI): ${expectedDid}`);

  let pass = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const digest = r.tx_digest;
    if (!digest) {
      fail++;
      failures.push({ i, error: "no tx_digest in CSV row" });
      console.log(`  ${(i + 1).toString().padStart(3)}/${rows.length}  ❌ no tx_digest in row`);
      continue;
    }

    let tx, accessGrant, fields;
    try {
      // Step 1: fetch the transaction's objectChanges.
      tx = await client.getTransactionBlock({
        digest,
        options: { showObjectChanges: true, showEffects: false, showInput: false },
      });

      // Step 2: locate the created AccessGrant object.
      const created = (tx.objectChanges || []).filter(
        (c) => c.type === "created" && /::AccessGrant$/.test(c.objectType || ""),
      );
      if (created.length === 0) {
        fail++;
        failures.push({ i, digest, error: "no AccessGrant object created in tx" });
        console.log(`  ${(i + 1).toString().padStart(3)}/${rows.length}  ❌ ${digest.slice(0, 14)}…  no AccessGrant object`);
        continue;
      }
      accessGrant = created[0];

      // Step 3: load on-chain content.
      const obj = await client.getObject({
        id: accessGrant.objectId,
        options: { showContent: true, showType: true },
      });
      fields = obj?.data?.content?.fields;
      if (!fields) {
        fail++;
        failures.push({ i, digest, error: "no fields on AccessGrant object" });
        console.log(`  ${(i + 1).toString().padStart(3)}/${rows.length}  ❌ obj=${accessGrant.objectId.slice(0, 12)}…  no fields`);
        continue;
      }
    } catch (e) {
      fail++;
      failures.push({ i, digest, error: e.message });
      console.log(`  ${(i + 1).toString().padStart(3)}/${rows.length}  ❌ ${digest.slice(0, 14)}…  ${e.message}`);
      continue;
    }

    // Step 4: decode the four vector<u8> fields.
    const patient_did  = decodeBytesField(fields.patient_did);
    const hospital_did = decodeBytesField(fields.hospital_did);
    const grantee_did  = decodeBytesField(fields.grantee_did);
    const record_id    = decodeBytesField(fields.record_id);
    const is_active    = fields.is_active;
    const timestamp    = String(fields.timestamp ?? "");

    // First successful row: lock in expectedDid if not given on CLI.
    if (!expectedDid) {
      expectedDid = patient_did;
      console.log(`[verify] auto-detected patient DID = ${expectedDid}\n`);
    }

    // Step 5: verify.
    const checks = [];
    if (patient_did !== expectedDid)
      checks.push(`patient_did mismatch: got "${patient_did}"`);
    if (hospital_did !== expectedDid)
      checks.push(`hospital_did mismatch: got "${hospital_did}" (expected self-grant)`);
    if (grantee_did !== expectedDid)
      checks.push(`grantee_did mismatch: got "${grantee_did}" (expected self-grant)`);
    if (!/^rec-\d+-\d+$/.test(record_id))
      checks.push(`record_id format unexpected: "${record_id}"`);
    if (is_active !== true)
      checks.push(`is_active = ${is_active} (expected true)`);

    if (checks.length === 0) {
      pass++;
      console.log(
        `  ${(i + 1).toString().padStart(3)}/${rows.length}  ✓ tx=${digest.slice(0, 12)}…  obj=${accessGrant.objectId.slice(0, 12)}…  rec=${record_id}  ts=${timestamp}`,
      );
    } else {
      fail++;
      failures.push({ i, digest, objectId: accessGrant.objectId, errors: checks, fields: { patient_did, hospital_did, grantee_did, record_id, is_active } });
      console.log(`  ${(i + 1).toString().padStart(3)}/${rows.length}  ❌ tx=${digest.slice(0, 12)}…`);
      for (const c of checks) console.log(`        ${c}`);
    }
  }

  console.log(`\n[verify] summary: pass = ${pass}/${rows.length}   fail = ${fail}`);
  if (failures.length) {
    console.log("[verify] first failure detail (full structured):");
    console.log("  " + JSON.stringify(failures[0], null, 2).split("\n").join("\n  "));
    process.exit(1);
  }
  console.log(`[verify] all ${pass} AccessGrant objects round-trip OK`);
}

main().catch((e) => {
  console.error("[verify] fatal:", e);
  process.exit(1);
});
