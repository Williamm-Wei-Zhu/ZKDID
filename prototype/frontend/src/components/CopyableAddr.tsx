import { useState } from "react";

export function CopyableAddr({ value, label, short = true }: { value: string | null | undefined; label?: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-slate-500 italic">—</span>;
  const display = short && value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch {}
  };
  return (
    <span className="inline-flex items-center gap-2 max-w-full">
      {label && <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>}
      <code className="font-mono-tight text-sm text-slate-200 truncate">{display}</code>
      <button
        onClick={copy}
        className="shrink-0 text-xs px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-slate-100"
        title="Copy to clipboard"
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}
