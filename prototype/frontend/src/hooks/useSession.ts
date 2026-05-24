import { useCallback, useEffect, useState } from "react";
import { getSession, type SessionSummary } from "../lib/bridge";

/** Polls GET /session every `intervalMs`; pauses when the tab is hidden. */
export function useSession(intervalMs = 10_000) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getSession();
      setSession(s);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    let id: number | undefined;
    const start = () => {
      stop();
      id = window.setInterval(refresh, intervalMs);
    };
    const stop = () => { if (id) { window.clearInterval(id); id = undefined; } };
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh, intervalMs]);

  return { session, loading, error, refresh };
}
