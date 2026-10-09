import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "../../app/icons";
import { Badge, Card, PageHeader, QueryState, type Tone } from "../../app/ui";
import { useTranslation } from "../../i18n";
import type { Schemas } from "../../lib/api/client";
import { useActOnInsight, useInsights } from "./api";
import { insightText } from "./text";

type Insight = Schemas["InsightRead"];

const KIND_ICON: Record<Insight["kind"], IconName> = {
  stockout_risk: "stack",
  dead_stock: "box",
  customer_winback: "clock",
  khata_risk: "book",
};
const KINDS = Object.keys(KIND_ICON) as Insight["kind"][];

/**
 * Every open, actionable thing the store's own data points to right now: products about to run out,
 * products that have stopped selling, customers overdue for a visit, and khata that has gone stale.
 * Nothing here is estimated or invented; each item names the record it came from and where to act on it.
 */
export function InsightsPage() {
  const { t, language } = useTranslation();
  const insights = useInsights();
  const act = useActOnInsight();
  const [filter, setFilter] = useState<Insight["kind"] | "all">("all");

  const all = insights.data ?? [];
  const shown = filter === "all" ? all : all.filter((i) => i.kind === filter);

  function snooze3Days(key: string) {
    const until = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    act.mutate({ key, status: "snoozed", snoozed_until: until });
  }

  return (
    <>
      <PageHeader title={t("nav.opportunities")} subtitle={t("insights.subtitle")} />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          {t("insights.all", { count: all.length })}
        </FilterButton>
        {KINDS.map((kind) => {
          const count = all.filter((i) => i.kind === kind).length;
          if (count === 0) return null;
          return (
            <FilterButton key={kind} active={filter === kind} onClick={() => setFilter(kind)}>
              {t(`insights.kind.${kind}` as const)} ({count})
            </FilterButton>
          );
        })}
      </div>

      <Card>
        <QueryState isPending={insights.isPending} error={insights.error} />
        {insights.data && shown.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-500">
            {all.length === 0 ? t("dash.nothing") : t("insights.noneOfKind")}
          </p>
        )}
        {shown.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {shown.map((i) => {
              const text = insightText(i, t, language);
              return (
                <li key={i.key} className="flex flex-wrap items-start gap-3 py-3">
                  <span className={`rounded-lg p-2 ${i.tone === "red" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>
                    <Icon name={KIND_ICON[i.kind]} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link to={i.link} className="block text-sm font-medium text-slate-900 hover:text-emerald-700 hover:underline">
                      {text.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">{text.detail}</p>
                    <div className="mt-1.5">
                      <Badge tone={i.tone as Tone}>{t(`insights.kind.${i.kind}` as const)}</Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <ActionButton onClick={() => snooze3Days(i.key)}>{t("insights.snooze")}</ActionButton>
                    <ActionButton onClick={() => act.mutate({ key: i.key, status: "dismissed" })}>{t("common.dismiss")}</ActionButton>
                    <ActionButton primary onClick={() => act.mutate({ key: i.key, status: "resolved" })}>
                      {t("insights.handled")}
                    </ActionButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium ${active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
    >
      {children}
    </button>
  );
}

function ActionButton({ onClick, primary, children }: { onClick: () => void; primary?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "whitespace-nowrap rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
          : "whitespace-nowrap rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {children}
    </button>
  );
}
