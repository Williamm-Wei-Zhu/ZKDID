import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import {
  beginZkLogin,
  DEFAULT_SALT_SEEDS,
  INSTITUTIONS,
  type InstitutionName,
  type OpenIdProvider,
  type SaltSeedMap,
} from "../lib/auth";
import { getSaltSeeds, saveSaltSeeds } from "../lib/bridge";
import { fetchSeed, type InstitutionConfig } from "../lib/saltClient";
import { pushToast } from "../hooks/useToast";
import type { SessionSummary } from "../lib/bridge";
import config from "../config.json";

export function LoginPage({
  session,
  onStatus,
  onRunWithLast,
}: {
  session: SessionSummary | null;
  onStatus: (s: string | null) => void;
  onRunWithLast: () => Promise<unknown>;
}) {
  const [seeds, setSeeds] = useState<SaltSeedMap>(DEFAULT_SALT_SEEDS);
  const [selected, setSelected] = useState<string[]>([]);
  const [booting, setBooting] = useState<OpenIdProvider | null>(null);
  const [generating, setGenerating] = useState<Set<string>>(new Set());

  // Refs track the latest committed state so concurrent async callbacks
  // (parallel "Generate" clicks) never persist against a stale snapshot.
  const seedsRef = useRef<SaltSeedMap>(DEFAULT_SALT_SEEDS);
  const selectedRef = useRef<string[]>([]);
  useEffect(() => { seedsRef.current = seeds; }, [seeds]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Fast lookup: institution name → EC2 service URL from config.json.
  const servicesByName = useMemo(() => {
    const m = new Map<string, InstitutionConfig>();
    const arr = (config as any).institutions as InstitutionConfig[] | undefined;
    if (Array.isArray(arr)) for (const s of arr) m.set(s.name, s);
    return m;
  }, []);

  useEffect(() => {
    getSaltSeeds()
      .then((data) => {
        const merged = { ...DEFAULT_SALT_SEEDS, ...(data.saltSeeds || {}) } as SaltSeedMap;
        setSeeds(merged);
        seedsRef.current = merged;
        if (Array.isArray(data.selectedInstitutions)) {
          setSelected(data.selectedInstitutions);
          selectedRef.current = data.selectedInstitutions;
        }
      })
      .catch(() => {});
  }, []);

  /**
   * Persist current seeds + selected list to the bridge, AWAITED.
   * We also synchronously update the refs so a subsequent concurrent caller
   * sees the merged state instead of stomping it.
   *
   * `updater` receives the latest committed values and returns the next ones.
   */
  const commit = async (
    updater: (prev: { seeds: SaltSeedMap; selected: string[] }) => { seeds: SaltSeedMap; selected: string[] },
  ) => {
    const next = updater({ seeds: seedsRef.current, selected: selectedRef.current });
    seedsRef.current = next.seeds;
    selectedRef.current = next.selected;
    setSeeds(next.seeds);
    setSelected(next.selected);
    try {
      await saveSaltSeeds({ saltSeeds: next.seeds, selectedInstitutions: next.selected });
    } catch (e: any) {
      pushToast("error", `Failed to save to local config: ${e?.message || e}`);
    }
  };

  const toggleSelected = (name: InstitutionName) => {
    commit(({ seeds, selected }) => ({
      seeds,
      selected: selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name],
    }));
  };

  // Generate: fetch the institution's fixed seed from its EC2 salt-service.
  // Cached locally so subsequent logins derive the user salt in-browser
  // (via poseidonSaltFromSeed) instead of round-tripping to EC2.
  const generate = async (name: InstitutionName) => {
    const svc = servicesByName.get(name);
    if (!svc) {
      pushToast("error", `${name}: no EC2 service URL configured in config.json`);
      return;
    }
    setGenerating((s) => new Set(s).add(name));
    try {
      const { seed, institution } = await fetchSeed(svc);
      const seedStr = seed.toString();
      await commit(({ seeds, selected }) => ({
        seeds: { ...seeds, [name]: seedStr },
        selected,
      }));
      pushToast("success", `Paired with ${institution} · seed ${seedStr.slice(0, 10)}…`);
    } catch (e: any) {
      pushToast("error", `${name}: ${e?.message || e}`);
    } finally {
      setGenerating((s) => {
        const copy = new Set(s);
        copy.delete(name);
        return copy;
      });
    }
  };

  const clearOne = async (name: InstitutionName) => {
    await commit(({ seeds, selected }) => ({
      seeds: { ...seeds, [name]: "" },
      selected,
    }));
  };

  const clearAll = async () => {
    await commit(({ selected }) => ({
      seeds: { ...DEFAULT_SALT_SEEDS },
      selected,
    }));
    pushToast("info", "Cleared all cached seeds");
  };

  const login = async (provider: OpenIdProvider) => {
    setBooting(provider);
    try {
      await beginZkLogin(provider, onStatus);
    } catch (e: any) {
      pushToast("error", `Login failed: ${e?.message || e}`);
      setBooting(null);
    }
  };

  const disabled = !!booting;
  const hasSession = session?.hasSession === true;
  const cachedCount = Object.values(seeds).filter(Boolean).length;
  const selectedCount = selected.length;
  const selectedWithCache = selected.filter((n) => seeds[n as InstitutionName]).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Login</h1>
        <p className="mt-1 text-slate-400">
          Pick which institutions to include. For each checked institution:
          {" "}if its seed is cached locally, the salt is derived offline via Poseidon;
          {" "}otherwise the salt-service on EC2 is called at login time.
        </p>
      </div>

      <Card
        title="Institutions"
        subtitle={`${selectedCount} selected · ${selectedWithCache} cached locally · ${selectedCount - selectedWithCache} will call EC2 at login`}
        actions={
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={cachedCount === 0}>
            Clear all cached seeds
          </Button>
        }
      >
        <div className="space-y-2">
          {INSTITUTIONS.map((name) => {
            const v = seeds[name] || "";
            const isChecked = selected.includes(name);
            const hasSvc = servicesByName.has(name);
            const svcUrl = servicesByName.get(name)?.url;
            const isGenerating = generating.has(name);
            const cached = !!v;

            return (
              <div
                key={name}
                className={`flex flex-col md:flex-row md:items-center gap-3 rounded-lg border px-4 py-3 ${
                  cached ? "border-emerald-700/40 bg-emerald-500/5" : "border-slate-800 bg-slate-950/40"
                }`}
              >
                <label className="flex items-center gap-2 md:w-52 shrink-0">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleSelected(name)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{name}</div>
                    <div className="text-xs text-slate-500 truncate">{svcUrl || "(no service URL)"}</div>
                  </div>
                </label>

                <input
                  readOnly
                  className="flex-1 min-w-0 rounded-md bg-slate-950/70 border border-slate-800 px-3 py-1.5 font-mono-tight text-xs text-slate-300 cursor-default"
                  value={v}
                  placeholder={hasSvc ? "(not paired — click Generate)" : "(no EC2 service configured)"}
                />

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant={cached ? "secondary" : "primary"}
                    size="sm"
                    disabled={!hasSvc || isGenerating}
                    loading={isGenerating}
                    onClick={() => generate(name)}
                    title={hasSvc ? `Fetch seed from ${svcUrl}` : "No service URL configured"}
                  >
                    {cached ? "Regenerate" : "Generate"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => clearOne(name)}
                    disabled={!cached}
                    title="Clear cached seed"
                  >
                    Clear
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-md bg-slate-950/60 border border-slate-800 px-3 py-2 text-xs text-slate-400">
          <strong className="text-slate-300">How it works.</strong>{" "}
          Each salt-service on EC2 holds a fixed 128-bit seed. "Generate" fetches and caches
          that seed in <code className="font-mono-tight">salt-seeds.json</code>. At login the
          browser computes <code className="font-mono-tight">salt = Poseidon(seed, jwt.sub) mod 2<sup>128</sup></code>
          {" "}for each checked institution — from the local cache when available, from the EC2
          service otherwise — and merges the results into your final zkLogin salt.
        </div>
      </Card>

      <Card
        title="Authenticate"
        subtitle={hasSession ? `A valid session is already active (${session!.provider}). Logging in again overwrites it.` : "Pick a provider to start the zkLogin flow."}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Button variant="primary" size="lg" loading={booting === "Google"} disabled={disabled || selectedCount === 0} onClick={() => login("Google")}>
            Google
          </Button>
          <Button variant="secondary" size="lg" loading={booting === "Twitch"} disabled={disabled || selectedCount === 0} onClick={() => login("Twitch")}>
            Twitch
          </Button>
          <Button variant="secondary" size="lg" loading={booting === "Facebook"} disabled={disabled || selectedCount === 0} onClick={() => login("Facebook")}>
            Facebook
          </Button>
        </div>
        {selectedCount === 0 && (
          <div className="mt-3 text-xs text-amber-400">Check at least one institution before logging in.</div>
        )}
        {hasSession && (
          <div className="mt-4 flex items-center justify-between rounded-md bg-slate-950/60 border border-slate-800 px-3 py-2">
            <span className="text-sm text-slate-400">Re-use the cached session without browser re-auth (if still within epoch window).</span>
            <Button size="sm" variant="ghost" onClick={onRunWithLast}>↻ Re-spawn backend</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
