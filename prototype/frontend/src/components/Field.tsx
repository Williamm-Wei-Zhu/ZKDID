import { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type BaseProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
};

const inputBase =
  "block w-full rounded-lg bg-slate-950/70 border border-slate-700 text-slate-100 placeholder:text-slate-500 " +
  "focus:outline-none focus:ring-2 focus:ring-indigo-500/60 focus:border-indigo-500 " +
  "disabled:opacity-60 disabled:cursor-not-allowed font-mono-tight text-sm";

export function Field({
  label, hint, error, className = "", ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm font-medium text-slate-300">{label}</span>
      <input
        {...rest}
        className={`${inputBase} px-3 py-2 mt-1.5 ${error ? "border-rose-500 focus:ring-rose-500" : ""}`}
      />
      {error ? (
        <span className="mt-1 block text-xs text-rose-400">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextArea({
  label, hint, error, className = "", ...rest
}: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm font-medium text-slate-300">{label}</span>
      <textarea
        {...rest}
        className={`${inputBase} px-3 py-2 mt-1.5 ${error ? "border-rose-500 focus:ring-rose-500" : ""}`}
      />
      {error ? (
        <span className="mt-1 block text-xs text-rose-400">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}
