import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CopyableAddr } from "../components/CopyableAddr";
import type { BackendTimings, SessionSummary } from "../lib/bridge";
import { getLatestBackendTimings } from "../lib/bridge";
import { getCurrentAccount, didFromAccount, loadTiming } from "../lib/auth";
import { useBridge } from "../hooks/useBridge";

export function DIDPage({ session }: { session: SessionSummary | null }) {
  // Backend timings are now delivered inline in the /op/* response (the bridge
  // blocks on the child backend and returns its .backend-timings.json contents).
  // We register an onTimings callback with useBridge so we update immediately
  // when an op completes — no polling, no "refetch after N ms" guessing.
  const [backendTimings, setBackendTimings] = useState<BackendTimings | null>(null);
  const { createDID, createVC, busy } = useBridge({ onTimings: setBackendTimings });
  const account = getCurrentAccount();
  const timing = account ? loadTiming()[account.userAddr] : undefined;
  const hasSession = session?.hasSession === true && !session.expired;

  // On mount, seed the card from the last persisted run (if any) so users
  // who haven't clicked since page-load still see yesterday's numbers.
  useEffect(() => {
    getLatestBackendTimings().then((t) => { if (t) setBackendTimings(t); }).catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">DID</h1>
          <p className="mt-1 text-slate-400">Publish a Decentralized Identifier on Sui DevNet. One tx per DID.</p>
        </div>
      </div>

      {!hasSession && (
        <Card>
          <div className="flex items-start gap-3">
            <span className="shrink-0 text-amber-400 text-xl leading-none">!</span>
            <div className="text-sm text-slate-300">
              No valid session. Go to <span className="font-semibold">Login</span> and authenticate first — the backend needs an active zkLogin session to sign the on-chain transaction.
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Your identity"
        subtitle="Derived from the current zkLogin account (browser-side)"
      >
        <div className="space-y-3 text-sm">
          <Row label="zkLogin address">
            <CopyableAddr value={account?.userAddr} />
          </Row>
          <Row label="DID (did:zklogin)">
            <CopyableAddr value={account ? didFromAccount(account) : null} />
          </Row>
          <Row label="OAuth provider">
            <span className="capitalize text-slate-200">{account?.provider || "—"}</span>
          </Row>
          <Row label="maxEpoch">
            <span className="font-mono-tight text-slate-200">{account?.maxEpoch ?? "—"}</span>
          </Row>
          <Row label="Salt (merged)">
            <CopyableAddr value={account?.userSalt} />
          </Row>
        </div>
      </Card>

      <Card
        title="Actions"
        subtitle="Each button dispatches a backend run. Watch your terminal for the tx digest."
      >
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            size="lg"
            disabled={!hasSession || !!busy}
            loading={busy === "Create DID"}
            onClick={() => createDID()}
          >
            Create DID (on-chain)
          </Button>
          <Button
            variant="secondary"
            size="lg"
            disabled={!hasSession || !!busy}
            loading={busy === "Create VC"}
            onClick={() => createVC()}
          >
            Create DID + VC
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          <code className="font-mono-tight">Create DID</code> calls <code className="font-mono-tight">store_did_vc::create_did_vc(did, &quot;&#123;&#125;&quot;)</code>.{" "}
          <code className="font-mono-tight">Create DID + VC</code> issues a W3C Verifiable Credential first and stores both on chain.
        </p>
      </Card>

      {timing && (
        <Card
          title="Timing (most recent login) — browser-side wall clock"
          subtitle={
            "Every row below is a separate timer around a specific code block. " +
            "Pre-OAuth rows run before the Google redirect; post-OAuth rows run after the redirect returns. " +
            "Network RPCs (epoch fetch, salt fetch, prover, bridge post) include any tunnel / internet hop."
          }
        >
          {/* Two sub-grids: pre-OAuth prep, then post-OAuth processing. Keeps the
              card dense but still visually grouped by login phase. */}
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">Pre-OAuth (beginZkLogin)</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <Stat label="Fetch epoch" value={timing.epochFetchMs} />
            <Stat label="Ephemeral key" value={timing.ephKeyMs} />
            <Stat label="Randomness" value={timing.randomnessMs} />
            <Stat label="Nonce" value={timing.nonceMs} />
            <Stat label="Gen params total" value={timing.genParamsMs} />
          </div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mt-4 mb-2">Post-OAuth (completeZkLogin)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="JWT parse" value={timing.jwtParseMs} />
            <Stat label="Fetch salt" value={timing.saltMs} />
            <Stat label="Nonce verify" value={timing.nonceVerifyMs} />
            <Stat label="ZK prover" value={timing.proverMs} />
            <Stat label="Save account" value={timing.saveAccountMs} />
            <Stat label="Post to bridge" value={timing.bridgePostMs} />
            <Stat label="Derive all" value={timing.deriveAllMs} />
          </div>
        </Card>
      )}

      {backendTimings && (
        <Card
          title="Timing (most recent on-chain op) — browser-perspective per-phase"
          subtitle={
            backendOpSubtitle(backendTimings) +
            " · Each phase shown is the EC2-side duration (from the backend), summing to the wall-clock the browser saw for the POST."
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat
              label="OAuth JWT"
              value={backendTimings.timings["6.1b_JWK_precheck"]}
            />
            <Stat
              label="Build & sign tx"
              value={backendTimings.timings["6.5_build_and_sign_Move_tx"]}
            />
            <Stat
              label="Submit tx & return"
              value={backendTimings.timings["6.6b_submit_tx_and_return"]}
            />
            <Stat
              label="Query chain & update DID"
              value={backendTimings.timings["8_query_chain_and_update_DID_doc"]}
            />
          </div>
        </Card>
      )}

      {backendTimings?.gasReport && (
        <Card
          title="Gas & Storage (most recent on-chain op)"
          subtitle={
            `From tx effects: ${backendTimings.digest ? "digest " + backendTimings.digest.slice(0, 10) + "…" : "no digest"}. ` +
            `All values in MIST (1 SUI = 1,000,000,000 MIST). Net gas = computation + storage − rebate.`
          }
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <GasRow label="Computation cost"       mist={backendTimings.gasReport.computationCostMist} />
            <GasRow label="Storage cost"           mist={backendTimings.gasReport.storageCostMist} />
            <GasRow label="Storage rebate"         mist={backendTimings.gasReport.storageRebateMist} negative />
            <GasRow label="Non-refundable fee"     mist={backendTimings.gasReport.nonRefundableStorageFeeMist} />
          </div>
          <div className="mt-3 pt-3 border-t border-slate-800">
            <GasRow label="Net gas (computation + storage − rebate)" mist={backendTimings.gasReport.netGasMist} emphasis />
          </div>

          {backendTimings.storageReport && backendTimings.storageReport.length > 0 && (
            <div className="mt-4 pt-3 border-t border-slate-800">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
                Created objects ({backendTimings.storageReport.length})
              </div>
              <div className="space-y-2">
                {backendTimings.storageReport.map((s, i) => (
                  <div key={s.objectId ?? i} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="font-mono-tight text-slate-200 break-all">
                        {s.objectId ? s.objectId.slice(0, 14) + "…" + s.objectId.slice(-6) : "(no id)"}
                      </span>
                      <span className="text-xs text-slate-500">owner: {s.owner ?? "unknown"}</span>
                      <span className="ml-auto font-mono-tight text-slate-300">
                        {typeof s.bcsBytes === "number" ? `${s.bcsBytes.toLocaleString()} bytes` : "size unknown"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** Format MIST as decimal SUI, trimming trailing zeros. 1 SUI = 10^9 MIST. */
function mistToSui(mist: number): string {
  if (!Number.isFinite(mist)) return "—";
  // Use BigInt-safe division for display (values fit in Number up to ~2^53 MIST ≈ 9 million SUI).
  const sign = mist < 0 ? "-" : "";
  const abs = Math.abs(mist);
  const whole = Math.floor(abs / 1e9);
  const frac = String(abs - whole * 1e9).padStart(9, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${sign}${whole}.${frac} SUI` : `${sign}${whole} SUI`;
}

function GasRow({ label, mist, negative, emphasis }: { label: string; mist: number; negative?: boolean; emphasis?: boolean }) {
  const displayMist = negative && mist > 0 ? -mist : mist;
  return (
    <div className={`rounded-lg border px-3 py-2 ${emphasis ? "border-slate-700 bg-slate-800/40" : "border-slate-800 bg-slate-950/40"}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-0.5 font-mono-tight ${emphasis ? "text-lg text-slate-100" : "text-sm text-slate-200"}`}>
        {displayMist.toLocaleString()} MIST
      </div>
      <div className="text-xs text-slate-500 font-mono-tight">{mistToSui(displayMist)}</div>
    </div>
  );
}

function backendOpSubtitle(t: BackendTimings): string {
  const op = t.op ? `op=${t.op}` : "op=?";
  const status = t.status ?? "?";
  const when =
    typeof t.timestampMs === "number"
      ? new Date(t.timestampMs).toLocaleTimeString()
      : "";
  return `${op} · status=${status}${when ? ` · ${when}` : ""}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2 border-b border-slate-800/80 last:border-none">
      <div className="w-40 shrink-0 text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 text-lg text-slate-100 font-mono-tight">{value != null ? `${value} ms` : "—"}</div>
    </div>
  );
}
