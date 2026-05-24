import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CopyableAddr } from "../components/CopyableAddr";
import { useBridge } from "../hooks/useBridge";
import { clearAllLocalState } from "../lib/auth";
import { pushToast } from "../hooks/useToast";
import type { SessionSummary } from "../lib/bridge";

export function SessionPage({
  session,
  refreshSession,
}: {
  session: SessionSummary | null;
  refreshSession: () => void;
}) {
  const { clearSession, busy } = useBridge();

  const hardReset = async () => {
    await clearSession();
    clearAllLocalState();
    refreshSession();
    pushToast("success", "Cleared server session + browser storage");
  };

  const browserOnly = () => {
    clearAllLocalState();
    pushToast("info", "Cleared browser storage only (sessionStorage + zklogin.lastEpoch)");
    refreshSession();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Session</h1>
          <p className="mt-1 text-slate-400">Inspect and manage the currently active zkLogin session on the bridge.</p>
        </div>
        <Button variant="ghost" onClick={refreshSession}>↻ Refresh</Button>
      </div>

      <Card title="Bridge view" subtitle="Read directly from .zk-session.json via GET /session">
        {!session || !session.hasSession ? (
          <EmptyBox />
        ) : (
          <div className="space-y-3 text-sm">
            <StatusBar session={session} />
            <Row label="Provider"><span className="capitalize">{session.provider}</span></Row>
            <Row label="Saved at">{session.savedAt || "—"}</Row>
            <Row label="Max epoch"><span className="font-mono-tight">{session.maxEpoch}</span></Row>
            <Row label="Current epoch"><span className="font-mono-tight">{session.currentEpoch ?? "?"}</span></Row>
            <Row label="Remaining epochs">
              <span className={`font-mono-tight ${session.expired ? "text-rose-400" : session.remainingEpochs != null && session.remainingEpochs <= 1 ? "text-amber-400" : "text-emerald-400"}`}>
                {session.remainingEpochs ?? "?"}
              </span>
            </Row>
            <Row label="Has ZK proofs">{session.hasZkProofs ? "yes" : "no"}</Row>
            <Row label="User salt present">{session.userSaltPresent ? "yes" : "no"}</Row>
          </div>
        )}
      </Card>

      {session?.hasSession && session.jwtClaims && (
        <Card title="JWT claims (decoded)" subtitle="The raw id_token is never exposed by the bridge.">
          <div className="space-y-2 text-sm">
            <Row label="iss"><CopyableAddr value={session.jwtClaims.iss} /></Row>
            <Row label="sub"><CopyableAddr value={session.jwtClaims.sub} /></Row>
            <Row label="aud"><CopyableAddr value={session.jwtClaims.aud} /></Row>
            <Row label="email">{session.jwtClaims.email || "—"}</Row>
            <Row label="name">{session.jwtClaims.name || "—"}</Row>
            <Row label="iat">{session.jwtClaims.iat ?? "—"}</Row>
            <Row label="exp">{session.jwtClaims.exp ?? "—"}</Row>
            {session.jwtClaims.picture && (
              <Row label="picture">
                <img src={session.jwtClaims.picture} alt="" className="h-10 w-10 rounded-full border border-slate-700" />
              </Row>
            )}
          </div>
        </Card>
      )}

      <Card title="Danger zone" subtitle="Destructive — next op will require fresh browser login">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="danger"
            size="lg"
            loading={busy === "Clear session"}
            disabled={!!busy}
            onClick={hardReset}
          >
            Clear session (server + browser)
          </Button>
          <Button variant="secondary" onClick={browserOnly} disabled={!!busy}>
            Clear browser only
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Server clear deletes <code className="font-mono-tight">.zk-session.json</code> and{" "}
          <code className="font-mono-tight">.zklogin-ok</code> on the host, and terminates any running backend.
          It does not touch <code className="font-mono-tight">dids.json</code> / <code className="font-mono-tight">keys.json</code> (your historical on-chain DIDs).
        </p>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2 border-b border-slate-800/80 last:border-none">
      <div className="w-36 shrink-0 text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="min-w-0 flex-1 text-slate-200">{children}</div>
    </div>
  );
}

function StatusBar({ session }: { session: Extract<SessionSummary, { hasSession: true }> }) {
  const color = session.expired
    ? "bg-rose-500/10 border-rose-500/40 text-rose-300"
    : session.remainingEpochs != null && session.remainingEpochs <= 1
    ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
    : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300";
  const label = session.expired ? "Expired — relogin required"
    : `Active · ${session.remainingEpochs ?? "?"} epoch(s) remaining`;
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${color} inline-flex items-center gap-2`}>
      <span className="h-2 w-2 rounded-full bg-current" />
      {label}
    </div>
  );
}

function EmptyBox() {
  return (
    <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-6 py-8 text-center text-slate-400">
      <div className="text-sm">No session on the bridge</div>
      <div className="mt-1 text-xs text-slate-500">Use the Login page to authenticate.</div>
    </div>
  );
}
