import type { ReactNode } from "react";

/** Minimal shared UI primitives. Visual polish comes in the module phases. */

export function FullPageMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center text-slate-500">{children}</div>;
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
    </header>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      {title && <h2 className="mb-3 text-sm font-medium text-slate-500">{title}</h2>}
      {children}
    </section>
  );
}

export function ComingSoon({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      {children}
    </div>
  );
}

export function QueryState({ isPending, error }: { isPending: boolean; error: Error | null }) {
  if (isPending) return <p className="text-sm text-slate-500">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error.message}</p>;
  return null;
}
