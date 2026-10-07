import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "./icons";

/** Minimal shared UI primitives. Visual polish comes in the module phases. */

export function FullPageMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center text-slate-500">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </header>
  );
}

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  const heading = "text-sm font-semibold text-slate-700";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      {action ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className={heading}>{title}</h2>}
          {action}
        </div>
      ) : (
        title && <h2 className={`mb-3 ${heading}`}>{title}</h2>
      )}
      {children}
    </section>
  );
}

const TONES = {
  slate: "bg-slate-100 text-slate-600",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-700",
  blue: "bg-sky-50 text-sky-700",
};
export type Tone = keyof typeof TONES;

/** A short status label. The tone carries meaning: emerald = fine/done, amber = needs a look, red = a problem. */
export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

/** One number the merchant reads at a glance, with a line of context under it. */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone = "slate",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  /** Colours the icon, and the number too when it is a warning. */
  tone?: Tone;
}) {
  const strong = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-4">
      <div className="pr-9 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${strong}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      {icon && (
        <span className={`absolute right-3 top-3 rounded-lg p-1.5 ${TONES[tone]}`}>
          <Icon name={icon} className="h-4 w-4" />
        </span>
      )}
    </div>
  );
}

/**
 * A page for something DukaanOS does not do yet. It says so, points at what already works, and offers no
 * control that would look like the feature.
 */
export function ComingSoon({
  title,
  children,
  available = [],
}: {
  title: string;
  children: ReactNode;
  /** Pages that work today and cover a nearby need. */
  available?: { to: string; label: string }[];
}) {
  return (
    <>
      <PageHeader title={title} />
      <section className="max-w-xl rounded-lg border border-dashed border-slate-300 bg-white p-6">
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Coming soon</span>
        <div className="mt-3 space-y-2 text-sm text-slate-600">{children}</div>
        {available.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <h2 className="mb-2 text-sm font-medium text-slate-500">Available today</h2>
            <ul className="flex flex-wrap gap-2">
              {available.map((page) => (
                <li key={page.to}>
                  <Link to={page.to} className="inline-block rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50">
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}

export function QueryState({ isPending, error }: { isPending: boolean; error: Error | null }) {
  if (isPending) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  return null;
}
