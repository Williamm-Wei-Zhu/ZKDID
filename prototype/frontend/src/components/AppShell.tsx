import type { ReactNode } from "react";
import type { SessionSummary } from "../lib/bridge";

export type PageKey = "login" | "did" | "access" | "session";

const NAV: { key: PageKey; label: string; icon: string }[] = [
  { key: "login",   label: "Login",          icon: "⟐" },
  { key: "did",     label: "DID",            icon: "✦" },
  { key: "access",  label: "EHR Access",     icon: "❖" },
  { key: "session", label: "Session",        icon: "◎" },
];

export function AppShell({
  current,
  onNavigate,
  session,
  children,
}: {
  current: PageKey;
  onNavigate: (p: PageKey) => void;
  session: SessionSummary | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex bg-slate-950 text-slate-100">
      {/* sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
        <div className="px-6 py-6 border-b border-slate-800">
          <div className="text-lg font-semibold tracking-tight">zkDID Patient</div>
          <div className="text-xs text-slate-500">Sui DevNet · zkLogin</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((item) => {
            const active = item.key === current;
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.key)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-3 transition-colors ${
                  active
                    ? "bg-indigo-500/10 text-indigo-200 border border-indigo-500/30"
                    : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100 border border-transparent"
                }`}
              >
                <span className="text-base leading-none w-5 text-center">{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-800">
          <SessionPill session={session} />
        </div>
      </aside>

      {/* mobile topnav */}
      <div className="md:hidden fixed top-0 inset-x-0 z-40 bg-slate-900/90 backdrop-blur border-b border-slate-800">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold">zkDID Patient</div>
          <SessionPill session={session} compact />
        </div>
        <div className="flex overflow-x-auto px-2 pb-2 gap-1">
          {NAV.map((item) => {
            const active = item.key === current;
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.key)}
                className={`shrink-0 px-3 py-1.5 rounded-md text-xs ${
                  active ? "bg-indigo-500/20 text-indigo-200" : "text-slate-300 hover:bg-slate-800/60"
                }`}
              >
                {item.icon} {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* content */}
      <main className="flex-1 min-w-0 scroll-area overflow-y-auto pt-20 md:pt-0">
        <div className="max-w-5xl mx-auto px-4 md:px-10 py-8 md:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}

function SessionPill({ session, compact = false }: { session: SessionSummary | null; compact?: boolean }) {
  if (!session || !session.hasSession) {
    return (
      <div className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
        <span className="h-2 w-2 rounded-full bg-slate-500" />
        <span className="text-slate-400">No session</span>
      </div>
    );
  }
  const expired = session.expired;
  const remaining = session.remainingEpochs;
  const color = expired ? "bg-rose-500" : remaining != null && remaining <= 1 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className={`inline-flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <div className="text-slate-300">
        <span className="capitalize">{session.provider}</span>
        <span className="text-slate-500"> · </span>
        {expired ? (
          <span className="text-rose-400">expired</span>
        ) : (
          <span>exp in {remaining ?? "?"} ep</span>
        )}
      </div>
    </div>
  );
}
