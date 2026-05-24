import { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  padding?: "none" | "md" | "lg";
}

export function Card({
  title,
  subtitle,
  actions,
  padding = "md",
  className = "",
  children,
  ...rest
}: CardProps) {
  const pad = padding === "none" ? "" : padding === "lg" ? "p-8" : "p-6";
  return (
    <div
      className={`rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm shadow-lg shadow-black/20 ${className}`}
      {...rest}
    >
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-slate-800">
          <div>
            {title && <h3 className="text-lg font-semibold text-slate-100">{title}</h3>}
            {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={pad}>{children}</div>
    </div>
  );
}
