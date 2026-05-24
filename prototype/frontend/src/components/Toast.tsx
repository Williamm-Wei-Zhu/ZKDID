import { useToasts, type ToastLevel } from "../hooks/useToast";

const styles: Record<ToastLevel, string> = {
  info: "bg-slate-800 border-slate-600 text-slate-100",
  success: "bg-emerald-600/90 border-emerald-400 text-white",
  error: "bg-rose-600/90 border-rose-400 text-white",
  warning: "bg-amber-500/90 border-amber-300 text-slate-900",
};

const iconFor: Record<ToastLevel, string> = {
  info: "ℹ", success: "✓", error: "✕", warning: "!",
};

export function ToastHost() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg ${styles[t.level]} animate-[fade-in_0.15s_ease-out]`}
        >
          <span className="font-mono-tight shrink-0">{iconFor[t.level]}</span>
          <span className="text-sm flex-1 break-words">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-xs opacity-70 hover:opacity-100"
            aria-label="dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
