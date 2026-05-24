// Small typed-ish client for the zkorchestrator bridge (localhost:4317).

export function makeBridge(base) {
  const url = (p) => `${base.replace(/\/$/, "")}${p}`;
  async function req(method, path, body) {
    const res = await fetch(url(path), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const err = new Error(parsed?.error || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }
  return {
    getHealth: () => req("GET", "/"),
    getEpoch: () => req("GET", "/epoch"),
    getSession: () => req("GET", "/session"),
    clearSession: () => req("POST", "/session/clear"),
    opDID: () => req("POST", "/op/did"),
    opVC: () => req("POST", "/op/vc"),
    opAccess: (args) => req("POST", "/op/access", args),
    getSaltSeeds: () => req("GET", "/salt-seeds"),
    saveSaltSeeds: (p) => req("POST", "/salt-seeds", p),
    getLatestTimings: async () => {
      try { return await req("GET", "/latest-timings"); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
  };
}

/**
 * Wait until the bridge's /latest-timings payload shows a digest for a run that
 * started at-or-after `after`. Useful between clicking "Create DID" in the UI
 * and reading the backend timings (they're written to disk after tx confirms).
 */
export async function waitForFreshTimings(bridge, after, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const t = await bridge.getLatestTimings();
    if (t && t.timestampMs && t.timestampMs >= after) return t;
    last = t;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`timeout waiting for fresh backend timings (last=${JSON.stringify(last?.timestampMs)})`);
  err.last = last;
  throw err;
}
