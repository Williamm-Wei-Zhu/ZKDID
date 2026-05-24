// Browser-side Poseidon for deriving an institution salt from a cached seed
// without contacting the salt-service. Mirrors the algorithm used server-side
// (salt-service/server.mjs::deriveSalt) so cached and remote paths produce
// identical results:
//
//   salt = Poseidon(institutionSeed, BigInt(jwt.sub))  mod  2^128
//
// Initialization (`buildPoseidon()` builds the BN254 field arithmetic tables
// and instantiates the WASM module) costs ~250 ms on a typical client. We
// kick that work off at module-load time so it runs in parallel with React
// boot and OAuth navigation, dramatically reducing the perceived
// `salt_ms` cost in the post-OAuth `completeZkLogin()` path.

// @ts-expect-error — circomlibjs ships no types
import { buildPoseidon } from "circomlibjs";

const TWO_POW_128 = 1n << 128n;

// Eagerly start initialization at module load.  `buildPoseidon()` is async;
// keeping a single shared promise means callers either await an
// already-resolved value (zero wait) or join the in-flight init.
let poseidonPromise: Promise<any> = buildPoseidon();

async function getPoseidon(): Promise<any> {
  return poseidonPromise;
}

/**
 * Public hook for callers (e.g. `_init.tsx`) that want to *trigger* the warm-up
 * earliest in the page lifecycle without awaiting it.  Importing this module
 * already starts the work; calling this is just a documentation-friendly way
 * to make the intent explicit at the call site.
 */
export function warmupPoseidon(): Promise<unknown> {
  return poseidonPromise;
}

/**
 * Derive a single institution's per-user salt from a cached seed.
 * Must match salt-service/server.mjs::deriveSalt exactly.
 */
export async function poseidonSaltFromSeed(seed: bigint, sub: bigint): Promise<bigint> {
  const p = await getPoseidon();
  const out: bigint = p.F.toObject(p([seed, sub]));
  return out % TWO_POW_128;
}
