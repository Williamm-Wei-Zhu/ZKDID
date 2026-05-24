import { useCallback, useState } from "react";
import * as bridge from "../lib/bridge";
import type { BackendTimings } from "../lib/bridge";
import { pushToast } from "./useToast";

/** Wraps bridge operations with a shared "in flight" boolean and toast feedback.
 *
 * `onTimings` (optional) is called whenever an /op/* response carries a
 * timings payload. The DIDPage uses this to update its backend-timing card
 * from the exact response of the user's click — no polling, no extra fetch.
 */
export function useBridge(opts?: { onTimings?: (t: BackendTimings) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const onTimings = opts?.onTimings;

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    try {
      const r = await fn();
      return r;
    } catch (e: any) {
      pushToast("error", `${label} failed: ${e?.message || e}`);
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const maybeEmit = useCallback((r: any) => {
    if (r && typeof r === "object" && r.timings && onTimings) onTimings(r.timings as BackendTimings);
  }, [onTimings]);

  const createDID = useCallback(async () => {
    const r = await run("Create DID", bridge.opDID);
    maybeEmit(r);
    if (r?.ok) pushToast("success", "DID transaction dispatched. Watch terminal logs for digest.");
    return r;
  }, [run, maybeEmit]);

  const createVC = useCallback(async () => {
    const r = await run("Create VC", bridge.opVC);
    maybeEmit(r);
    if (r?.ok) pushToast("success", "VC transaction dispatched.");
    return r;
  }, [run, maybeEmit]);

  const createAccess = useCallback(
    async (args: { hospitalDid: string; granteeDid: string; recordId: string }) => {
      const r = await run("Create Access Grant", () => bridge.opAccess(args));
      maybeEmit(r);
      if (r?.ok) pushToast("success", "AccessGrant transaction dispatched.");
      return r;
    },
    [run, maybeEmit],
  );

  const clearSession = useCallback(async () => {
    const r = await run("Clear session", bridge.clearSession);
    if (r?.ok) pushToast("success", `Cleared: ${(r.cleared || []).join(", ") || "nothing"}`);
    return r;
  }, [run]);

  const runWithLast = useCallback(async () => {
    const r = await run("Reuse last session", bridge.runWithLastSession);
    if (r?.ok) pushToast("success", "Backend re-spawned from cached session.");
    return r;
  }, [run]);

  return { busy, createDID, createVC, createAccess, clearSession, runWithLast };
}
