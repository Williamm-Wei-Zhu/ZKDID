import { useCallback, useEffect, useState } from "react";

export type ToastLevel = "info" | "success" | "error" | "warning";
export type Toast = { id: number; level: ToastLevel; message: string; ttl?: number };

// Simple event-bus style; not bound to a Context so any component can push.
let _id = 0;
let _listeners: Array<(t: Toast[]) => void> = [];
let _queue: Toast[] = [];

function emit() { for (const l of _listeners) l([..._queue]); }

export function pushToast(level: ToastLevel, message: string, ttl = 5000): number {
  const t: Toast = { id: ++_id, level, message, ttl };
  _queue = [..._queue, t];
  emit();
  if (ttl > 0) setTimeout(() => dismissToast(t.id), ttl);
  return t.id;
}

export function dismissToast(id: number) {
  _queue = _queue.filter((t) => t.id !== id);
  emit();
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>(_queue);
  useEffect(() => {
    const listener = (next: Toast[]) => setToasts(next);
    _listeners.push(listener);
    return () => { _listeners = _listeners.filter((l) => l !== listener); };
  }, []);
  const dismiss = useCallback(dismissToast, []);
  return { toasts, dismiss };
}
