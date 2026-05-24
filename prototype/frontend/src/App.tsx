import { useEffect, useState } from "react";
import "./index.css";

import { AppShell, type PageKey } from "./components/AppShell";
import { ToastHost } from "./components/Toast";
import { LoginPage } from "./pages/LoginPage";
import { DIDPage } from "./pages/DIDPage";
import { AccessPage } from "./pages/AccessPage";
import { SessionPage } from "./pages/SessionPage";

import { useSession } from "./hooks/useSession";
import { useBridge } from "./hooks/useBridge";
import { pushToast } from "./hooks/useToast";
import { completeZkLogin, DEFAULT_SALT_SEEDS, INSTITUTIONS, type SaltSeedMap } from "./lib/auth";
import { getSaltSeeds } from "./lib/bridge";
import type { InstitutionConfig } from "./lib/saltClient";
import config from "./config.json";

const PAGE_STORAGE_KEY = "zkdid.currentPage";

function initialPage(): PageKey {
  const fromUrl = new URLSearchParams(window.location.search).get("page") as PageKey | null;
  if (fromUrl && ["login", "did", "access", "session"].includes(fromUrl)) return fromUrl;
  const stored = localStorage.getItem(PAGE_STORAGE_KEY) as PageKey | null;
  if (stored && ["login", "did", "access", "session"].includes(stored)) return stored;
  return "login";
}

export const App: React.FC = () => {
  const [page, setPage] = useState<PageKey>(initialPage);
  const [modal, setModal] = useState<string | null>(null);
  const { session, refresh: refreshSession } = useSession(10_000);
  const { runWithLast } = useBridge();

  // Complete OAuth redirect on mount (runs once).
  useEffect(() => {
    (async () => {
      // Pull current salt picker state (bridge) so completeZkLogin derives the correct salt.
      let selected = INSTITUTIONS.slice() as string[];
      let seeds: SaltSeedMap = DEFAULT_SALT_SEEDS;
      try {
        const data = await getSaltSeeds();
        if (Array.isArray(data.selectedInstitutions) && data.selectedInstitutions.length) {
          selected = data.selectedInstitutions;
        }
        if (data.saltSeeds) seeds = { ...DEFAULT_SALT_SEEDS, ...data.saltSeeds } as SaltSeedMap;
      } catch {}
      // Remote salt-service institutions from config.json, filtered by the user's selection.
      const allServices = (Array.isArray((config as any).institutions) ? (config as any).institutions : []) as InstitutionConfig[];
      const institutionServices = allServices.filter((s) => selected.includes(s.name));
      const acct = await completeZkLogin(
        { selectedInstitutions: selected, saltSeeds: seeds, institutionServices },
        setModal,
      );
      if (acct) {
        pushToast("success", `Logged in as ${acct.provider} (${acct.userAddr.slice(0, 10)}…)`);
        setPage("did");
        refreshSession();
      }
    })().catch((e) => {
      console.error("[App] completeZkLogin failed:", e);
      pushToast("error", `Login completion failed: ${e?.message || e}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(PAGE_STORAGE_KEY, page);
  }, [page]);

  return (
    <>
      <AppShell current={page} onNavigate={setPage} session={session}>
        {page === "login" && (
          <LoginPage
            session={session}
            onStatus={setModal}
            onRunWithLast={async () => { await runWithLast(); refreshSession(); }}
          />
        )}
        {page === "did" && <DIDPage session={session} />}
        {page === "access" && <AccessPage session={session} />}
        {page === "session" && <SessionPage session={session} refreshSession={refreshSession} />}
      </AppShell>

      <ToastHost />

      {modal && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4">
          <div className="rounded-xl border border-slate-700 bg-slate-900 shadow-2xl px-6 py-5 max-w-md w-full text-left">
            <div className="text-slate-100 text-sm whitespace-pre-line">{modal}</div>
          </div>
        </div>
      )}
    </>
  );
};
