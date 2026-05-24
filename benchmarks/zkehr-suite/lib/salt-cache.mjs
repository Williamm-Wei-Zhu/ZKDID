// Manage local salt-seed cache state across experiments.
// Calls the remote salt-services' /seed endpoints to fetch fixed seeds,
// then persists them (or clears them) via the bridge's /salt-seeds endpoint.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(
  __dirname, "..", "..", "zklogin", "polymedia-zklogin-demo", "web", "src", "config.json",
);

/** Read the frontend config.json to learn which institutions are configured. */
export function loadInstitutions() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return Array.isArray(cfg.institutions) ? cfg.institutions : [];
}

async function fetchSeed(inst) {
  const res = await fetch(`${inst.url.replace(/\/$/, "")}/seed`, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  if (!res.ok || typeof data?.seed !== "string") {
    throw new Error(`${inst.name}: failed to fetch /seed (${res.status})`);
  }
  return data.seed;
}

/**
 * Produce a saltSeeds map + selectedInstitutions list for a given cache mode.
 *   mode='all'   → every selected institution has its seed cached locally
 *   mode='none'  → all seeds empty; login will call EC2 for every institution
 *   mode='mixed' → every other selected institution is cached
 *
 * Returns: { saltSeeds, selectedInstitutions }
 */
export async function buildCacheState(mode, instCount) {
  const all = loadInstitutions();
  if (all.length < instCount) {
    throw new Error(`config.json has only ${all.length} institutions; asked for ${instCount}`);
  }
  const picked = all.slice(0, instCount);

  // Start with an empty entry for EVERY configured institution (not just picked)
  // so the bridge writes a clean file (otherwise stale seeds from earlier runs leak).
  const saltSeeds = Object.fromEntries(all.map((i) => [i.name, ""]));

  if (mode === "all") {
    const pairs = await Promise.all(picked.map(async (i) => [i.name, await fetchSeed(i)]));
    for (const [n, s] of pairs) saltSeeds[n] = s;
  } else if (mode === "mixed") {
    // cache every other picked institution (indices 0, 2, 4, ...)
    const pairs = await Promise.all(
      picked.map(async (i, idx) => [i.name, idx % 2 === 0 ? await fetchSeed(i) : ""]),
    );
    for (const [n, s] of pairs) saltSeeds[n] = s;
  }
  // mode==='none' → all empty (already)

  return {
    saltSeeds,
    selectedInstitutions: picked.map((i) => i.name),
  };
}
