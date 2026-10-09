import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "../../app/icons";
import { useShell } from "../../app/shell";
import { Badge, Card, PageHeader, QueryState, Stat, type Tone } from "../../app/ui";
import { useTranslation, type MessageKey } from "../../i18n";
import type { Schemas } from "../../lib/api/client";
import { useKhataBalances, useOrders } from "../../lib/api/queries";
import { formatINR, orderNumber } from "../../lib/format";
import { useActOnInsight, useInsights, useInsightSummary } from "../insights/api";
import { insightText } from "../insights/text";
import { useAssistantStatus } from "../salaahkaar/SalaahkaarPanel";

type Order = Schemas["OrderRead"];
type Insight = Schemas["InsightRead"];

const INSIGHT_ICON: Record<Insight["kind"], IconName> = {
  stockout_risk: "stack",
  dead_stock: "box",
  customer_winback: "clock",
  khata_risk: "book",
};

/** The most orders the backend returns at once. Today's numbers are counted from this list. */
const ORDERS_READ = 200;

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

/** How an order stands, in one word the merchant acts on. */
function standing(order: Order): { key: MessageKey; tone: Tone } {
  if (order.status === "cancelled") return { key: "dash.standing.cancelled", tone: "slate" };
  if (order.status === "pending") return { key: "dash.standing.pending", tone: "amber" };
  if (order.status === "confirmed") return { key: "dash.standing.confirmed", tone: "blue" };
  if (order.status === "ready") return { key: "dash.standing.ready", tone: "blue" };
  if (order.payment_status === "credit") return { key: "dash.standing.credit", tone: "amber" };
  return order.payment_status === "paid" ? { key: "dash.standing.paid", tone: "emerald" } : { key: "dash.standing.unpaid", tone: "red" };
}

/** How "today's sales" compares with last week's daily average, in one short line. */
function trendHint(pct: number | null, t: ReturnType<typeof useTranslation>["t"]): string {
  if (pct == null) return t("dash.trend.none");
  const rounded = Math.round(Math.abs(pct));
  if (rounded === 0) return t("dash.trend.same");
  return t(pct > 0 ? "dash.trend.above" : "dash.trend.below", { pct: rounded });
}

/**
 * The merchant's command centre: today's numbers, what happened, and what is waiting for them. Every figure
 * is read from the same bills, orders, stock and khata the other sections work on. Nothing is estimated.
 */
export function DashboardPage() {
  const { t, language, dateLocale } = useTranslation();
  const time = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale, { hour: "numeric", minute: "2-digit" });
  const dayAndTime = (iso: string) =>
    new Date(iso).toLocaleString(dateLocale, { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
  const balances = useKhataBalances();
  const orders = useOrders(ORDERS_READ);
  const summary = useInsightSummary();
  const insights = useInsights();
  const act = useActOnInsight();

  const all = orders.data ?? [];
  const today = all.filter((o) => isToday(o.created_at));
  // The list is newest first and capped: if even its oldest order is from today, there were more.
  const more = all.length === ORDERS_READ && isToday(all[all.length - 1].created_at) ? "+" : "";
  const sold = today.filter((o) => o.status === "completed");
  const bills = today.filter((o) => o.channel === "counter");
  const online = today.filter((o) => o.channel === "shop");
  const pending = all.filter((o) => o.channel === "shop" && o.status === "pending");

  const owing = balances.data?.filter((b) => Number(b.balance) > 0) ?? [];
  const outstanding = owing.reduce((sum, b) => sum + Number(b.balance), 0);

  const earlier = today.length === 0 ? all.slice(0, 5) : [];
  const figure = (ready: unknown, value: ReactNode) => (ready ? value : "–");

  return (
    <>
      <PageHeader title={t("nav.dashboard")} subtitle={t("dash.subtitle")} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t("dash.salesToday")}
          icon="wallet"
          tone="emerald"
          value={figure(summary.data, formatINR(summary.data?.sales_today ?? "0"))}
          hint={
            orders.data &&
            summary.data &&
            `${t(sold.length === 1 ? "dash.completedSales.one" : "dash.completedSales.other", { count: sold.length })}${more} · ${trendHint(summary.data.sales_trend_pct, t)}`
          }
        />
        <Stat
          label={t("dash.bills")}
          icon="cart"
          value={figure(orders.data, `${bills.length}${more}`)}
          hint={orders.data && t("dash.billsHint")}
        />
        <Stat
          label={t("dash.online")}
          icon="store"
          tone={pending.length > 0 ? "amber" : "slate"}
          value={figure(orders.data, `${online.length}${more}`)}
          hint={orders.data && (pending.length > 0 ? t("dash.waiting", { count: pending.length }) : t("dash.noneWaiting"))}
        />
        <Stat
          label={t("dash.khataOutstanding")}
          icon="book"
          tone={outstanding > 0 ? "red" : "slate"}
          value={figure(balances.data, formatINR(outstanding))}
          hint={balances.data && t(owing.length === 1 ? "dash.owe.one" : "dash.owe.other", { count: owing.length })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title={t("dash.activity")}
            action={
              orders.data &&
              today.length > 0 && (
                <span className="text-xs text-slate-500">
                  {t(today.length === 1 ? "dash.activityCount.one" : "dash.activityCount.other", { count: today.length })}
                  {more}
                </span>
              )
            }
          >
            <QueryState isPending={orders.isPending} error={orders.error} />
            {orders.data && today.length === 0 && (
              <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
                {t("dash.noneToday")}{" "}
                <Link to="/counter" className="font-medium text-emerald-700 hover:underline">
                  {t("dash.startBill")}
                </Link>
              </p>
            )}
            <ActivityList orders={today.slice(0, 10)} when={time} />
            {today.length > 10 && <p className="mt-2 text-xs text-slate-500">{t("dash.latest10")}</p>}
            {earlier.length > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">{t("dash.earlier")}</h3>
                <ActivityList orders={earlier} when={dayAndTime} />
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card
            title={t("dash.attention")}
            action={
              insights.data && insights.data.length > 0 && (
                <Link to="/insights" className="text-xs font-medium text-emerald-700 hover:underline">
                  {t("dash.seeAll")}
                </Link>
              )
            }
          >
            <NeedsAttention
              loading={orders.isPending || insights.isPending}
              items={[
                pending.length > 0 && {
                  key: "pending-orders",
                  to: "/shop/orders",
                  icon: "clipboard" as const,
                  tone: "amber" as const,
                  title: t(pending.length === 1 ? "dash.newOnline.one" : "dash.newOnline.other", { count: pending.length }),
                  detail: t("dash.acceptOrReject"),
                },
                ...(insights.data ?? []).map((i) => ({
                  key: i.key,
                  to: i.link,
                  icon: INSIGHT_ICON[i.kind],
                  tone: i.tone as "amber" | "red",
                  ...insightText(i, t, language),
                  onDismiss: () => act.mutate({ key: i.key, status: "dismissed" }),
                })),
              ]}
            />
          </Card>
          <SalaahkaarCard />
        </div>
      </div>
    </>
  );
}

function ActivityList({ orders, when }: { orders: Order[]; when: (iso: string) => string }) {
  const { t } = useTranslation();
  if (orders.length === 0) return null;
  return (
    <ul className="divide-y divide-slate-100">
      {orders.map((o) => {
        const shop = o.channel === "shop";
        const { key, tone } = standing(o);
        return (
          <li key={o.id} className="flex items-center gap-3 py-2.5 text-sm">
            <span className={`rounded-lg p-2 ${shop ? "bg-sky-50 text-sky-700" : "bg-emerald-50 text-emerald-700"}`}>
              <Icon name={shop ? "store" : "cart"} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-slate-900">
                {t(shop ? "dash.onlineOrder" : "dash.counterBill", { number: orderNumber(o.id) })}
              </div>
              <div className="truncate text-xs text-slate-500">
                <time dateTime={o.created_at}>{when(o.created_at)}</time> ·{" "}
                {t(o.items.length === 1 ? "dash.items.one" : "dash.items.other", { count: o.items.length })}
                {o.customer_name && ` · ${o.customer_name}`}
              </div>
            </div>
            <Badge tone={tone}>{t(key)}</Badge>
            <span className="w-24 text-right font-semibold tabular-nums text-slate-900">{formatINR(o.total)}</span>
          </li>
        );
      })}
    </ul>
  );
}

type Attention = {
  key: string;
  to: string;
  icon: IconName;
  tone: "amber" | "red";
  title: string;
  detail: string;
  /** Present on a dismissable insight; absent on an operational item like pending online orders. */
  onDismiss?: () => void;
};

/** Only real states the merchant can act on. With none, it says so. */
function NeedsAttention({ items, loading }: { items: (Attention | false)[]; loading: boolean }) {
  const { t } = useTranslation();
  const shown = items.filter((item): item is Attention => !!item);
  if (shown.length === 0)
    return <p className="text-sm text-slate-500">{loading ? t("dash.checking") : t("dash.nothing")}</p>;
  return (
    <ul className="-mx-2 space-y-0.5">
      {shown.map((item) => (
        <li key={item.key} className="flex items-center gap-1 rounded-lg px-2 py-2 hover:bg-slate-50">
          <Link to={item.to} className="flex min-w-0 flex-1 items-center gap-3">
            <span className={`rounded-lg p-2 ${item.tone === "red" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>
              <Icon name={item.icon} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">{item.title}</span>
              <span className="block truncate text-xs text-slate-500">{item.detail}</span>
            </span>
          </Link>
          {item.onDismiss && (
            <button
              type="button"
              onClick={item.onDismiss}
              className="shrink-0 rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              {t("common.dismiss")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The assistant as part of the product. It opens the same panel as the top bar, which is honest about what works. */
function SalaahkaarCard() {
  const { t } = useTranslation();
  const shell = useShell();
  const status = useAssistantStatus();
  return (
    <section aria-label={t("dash.salaahkaar")} className="rounded-xl bg-emerald-700 p-4 text-white">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-emerald-100">
        <Icon name="sparkle" className="h-4 w-4" />
        {t("dash.salaahkaar")}
      </div>
      <h2 className="mt-2 text-lg font-semibold">{t("dash.askAnything")}</h2>
      <p className="mt-0.5 text-sm text-emerald-50">{t("dash.askTopics")}</p>
      {status.data && !status.data.available && (
        <p role="note" className="mt-3 rounded-lg bg-emerald-800/60 px-3 py-2 text-xs text-emerald-50">
          {t("dash.notAnswering")} {status.data.reason}
        </p>
      )}
      <button
        type="button"
        onClick={() => shell?.openAssistant()}
        className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
      >
        {t("shell.askSalaahkaar")}
      </button>
    </section>
  );
}
