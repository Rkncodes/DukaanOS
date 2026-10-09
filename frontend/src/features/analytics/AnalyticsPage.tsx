import { useState } from "react";
import { BarChart, LineChart, type ChartPoint } from "../../app/charts";
import { Card, PageHeader, QueryState } from "../../app/ui";
import { useTranslation } from "../../i18n";
import { formatINR } from "../../lib/format";
import { useCategoryBreakdown, useSalesTrend, useTopCustomers, useTopProducts } from "./api";

const RANGES = [7, 14, 30];

const money = (v: number) => formatINR(v);

/**
 * The business over time, not just today: a revenue trend, and what's actually driving
 * it — top products, top customers, which categories sell. One date range scopes every
 * chart on the page, same as Dashboard's "today" scopes its stats.
 */
export function AnalyticsPage() {
  const { t, dateLocale } = useTranslation();
  const shortDate = (iso: string) => new Date(iso).toLocaleDateString(dateLocale, { day: "2-digit", month: "short" });
  const [days, setDays] = useState(14);

  const trend = useSalesTrend(days);
  const products = useTopProducts(days);
  const customers = useTopCustomers(days);
  const categories = useCategoryBreakdown(days);

  const trendPoints: ChartPoint[] = (trend.data ?? []).map((p) => ({ label: shortDate(p.date), value: Number(p.revenue) }));
  const productPoints: ChartPoint[] = (products.data ?? []).map((p) => ({ label: p.name, value: Number(p.revenue) }));
  const customerPoints: ChartPoint[] = (customers.data ?? []).map((c) => ({ label: c.name, value: Number(c.revenue) }));
  const categoryPoints: ChartPoint[] = (categories.data ?? []).map((c) => ({ label: c.name, value: Number(c.revenue) }));
  const totalRevenue = trendPoints.reduce((sum, p) => sum + p.value, 0);

  return (
    <>
      <PageHeader title={t("nav.analytics")} subtitle={t("analytics.subtitle")} />

      <div className="mb-4 flex gap-2" role="group" aria-label={t("analytics.range")}>
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setDays(r)}
            aria-pressed={days === r}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              days === r ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t("analytics.last", { days: r })}
          </button>
        ))}
      </div>

      <div className="mb-4">
        <Card
          title={t("analytics.revenueTrend")}
          action={trend.data && <span className="text-xs text-slate-500">{t("analytics.total", { amount: money(totalRevenue) })}</span>}
        >
          <QueryState isPending={trend.isPending} error={trend.error} />
          {trend.data && <LineChart data={trendPoints} formatValue={money} />}
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={t("analytics.topProducts")}>
          <QueryState isPending={products.isPending} error={products.error} />
          {products.data && <BarChart data={productPoints} formatValue={money} />}
        </Card>
        <Card title={t("analytics.topCustomers")}>
          <QueryState isPending={customers.isPending} error={customers.error} />
          {customers.data && <BarChart data={customerPoints} formatValue={money} />}
        </Card>
      </div>

      <Card title={t("analytics.byCategory")}>
        <QueryState isPending={categories.isPending} error={categories.error} />
        {categories.data && <BarChart data={categoryPoints} formatValue={money} />}
      </Card>
    </>
  );
}
