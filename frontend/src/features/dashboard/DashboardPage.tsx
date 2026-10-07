import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "../../app/icons";
import { useShell } from "../../app/shell";
import { Badge, Card, PageHeader, QueryState, Stat, type Tone } from "../../app/ui";
import type { Schemas } from "../../lib/api/client";
import { useKhataBalances, useOrders, useProducts } from "../../lib/api/queries";
import { formatINR, orderNumber } from "../../lib/format";
import { LOW_STOCK } from "../catalogue/api";
import { useAssistantStatus } from "../salaahkaar/SalaahkaarPanel";

type Order = Schemas["OrderRead"];

/** The most orders the backend returns at once. Today's numbers are counted from this list. */
const ORDERS_READ = 200;

const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const dayAndTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How an order stands, in one word the merchant acts on. */
function standing(order: Order): { label: string; tone: Tone } {
  if (order.status === "cancelled") return { label: "Cancelled", tone: "slate" };
  if (order.status === "pending") return { label: "New order", tone: "amber" };
  if (order.status === "confirmed") return { label: "Accepted", tone: "blue" };
  if (order.status === "ready") return { label: "Ready", tone: "blue" };
  if (order.payment_status === "credit") return { label: "On khata", tone: "amber" };
  return order.payment_status === "paid" ? { label: "Paid", tone: "emerald" } : { label: "Unpaid", tone: "red" };
}

/**
 * The merchant's command centre: today's numbers, what happened, and what is waiting for them. Every figure
 * is read from the same bills, orders, stock and khata the other sections work on. Nothing is estimated.
 */
export function DashboardPage() {
  const products = useProducts();
  const balances = useKhataBalances();
  const orders = useOrders(ORDERS_READ);

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
  const low = products.data?.filter((p) => Number(p.stock_quantity) < LOW_STOCK) ?? [];

  const earlier = today.length === 0 ? all.slice(0, 5) : [];
  const figure = (ready: unknown, value: ReactNode) => (ready ? value : "–");

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Here's what's happening at your store today." />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Today's sales"
          icon="wallet"
          tone="emerald"
          value={figure(orders.data, `${formatINR(sold.reduce((sum, o) => sum + Number(o.total), 0))}${more}`)}
          hint={orders.data && `${plural(sold.length, "completed sale")}${more}`}
        />
        <Stat
          label="Bills"
          icon="cart"
          value={figure(orders.data, `${bills.length}${more}`)}
          hint={orders.data && "made at the counter today"}
        />
        <Stat
          label="Online orders"
          icon="store"
          tone={pending.length > 0 ? "amber" : "slate"}
          value={figure(orders.data, `${online.length}${more}`)}
          hint={orders.data && (pending.length > 0 ? `${pending.length} waiting for you` : "today · none waiting")}
        />
        <Stat
          label="Khata outstanding"
          icon="book"
          tone={outstanding > 0 ? "red" : "slate"}
          value={figure(balances.data, formatINR(outstanding))}
          hint={balances.data && `${plural(owing.length, "customer")} ${owing.length === 1 ? "owes" : "owe"} you`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title="Today's activity"
            action={orders.data && today.length > 0 && <span className="text-xs text-slate-500">{plural(today.length, "bill or order", "bills and orders")}{more}</span>}
          >
            <QueryState isPending={orders.isPending} error={orders.error} />
            {orders.data && today.length === 0 && (
              <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">
                No bills or orders yet today.{" "}
                <Link to="/counter" className="font-medium text-emerald-700 hover:underline">
                  Start a bill
                </Link>
              </p>
            )}
            <ActivityList orders={today.slice(0, 10)} when={time} />
            {today.length > 10 && <p className="mt-2 text-xs text-slate-500">Showing the latest 10.</p>}
            {earlier.length > 0 && (
              <>
                <h3 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">Earlier</h3>
                <ActivityList orders={earlier} when={dayAndTime} />
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Needs attention">
            <NeedsAttention
              loading={orders.isPending || products.isPending || balances.isPending}
              items={[
                pending.length > 0 && {
                  to: "/shop/orders",
                  icon: "clipboard" as const,
                  tone: "amber" as const,
                  title: `${plural(pending.length, "new online order")}`,
                  detail: "Accept or reject them",
                },
                low.length > 0 && {
                  to: "/catalogue/stock",
                  icon: "stack" as const,
                  tone: "red" as const,
                  title: `${plural(low.length, "product")} low or out of stock`,
                  detail: low.slice(0, 3).map((p) => p.name).join(", ") + (low.length > 3 ? ` and ${low.length - 3} more` : ""), // prettier-ignore
                },
                outstanding > 0 && {
                  to: "/khata/outstanding",
                  icon: "book" as const,
                  tone: "amber" as const,
                  title: `${formatINR(outstanding)} outstanding on khata`,
                  detail: `From ${plural(owing.length, "customer")}`,
                },
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
  if (orders.length === 0) return null;
  return (
    <ul className="divide-y divide-slate-100">
      {orders.map((o) => {
        const shop = o.channel === "shop";
        const { label, tone } = standing(o);
        return (
          <li key={o.id} className="flex items-center gap-3 py-2.5 text-sm">
            <span className={`rounded-lg p-2 ${shop ? "bg-sky-50 text-sky-700" : "bg-emerald-50 text-emerald-700"}`}>
              <Icon name={shop ? "store" : "cart"} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-slate-900">
                {shop ? "Online order" : "Counter bill"} {orderNumber(o.id)}
              </div>
              <div className="truncate text-xs text-slate-500">
                <time dateTime={o.created_at}>{when(o.created_at)}</time> · {o.items.length} {o.items.length === 1 ? "item" : "items"}
                {o.customer_name && ` · ${o.customer_name}`}
              </div>
            </div>
            <Badge tone={tone}>{label}</Badge>
            <span className="w-24 text-right font-semibold tabular-nums text-slate-900">{formatINR(o.total)}</span>
          </li>
        );
      })}
    </ul>
  );
}

type Attention = { to: string; icon: IconName; tone: "amber" | "red"; title: string; detail: string };

/** Only real states the merchant can act on. With none, it says so. */
function NeedsAttention({ items, loading }: { items: (Attention | false)[]; loading: boolean }) {
  const shown = items.filter((item): item is Attention => !!item);
  if (shown.length === 0)
    return <p className="text-sm text-slate-500">{loading ? "Checking…" : "Nothing needs your attention right now."}</p>;
  return (
    <ul className="-mx-2 space-y-0.5">
      {shown.map((item) => (
        <li key={item.to}>
          <Link to={item.to} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
            <span className={`rounded-lg p-2 ${item.tone === "red" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>
              <Icon name={item.icon} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-900">{item.title}</span>
              <span className="block truncate text-xs text-slate-500">{item.detail}</span>
            </span>
            <span aria-hidden="true" className="text-slate-400">
              →
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The assistant as part of the product. It opens the same panel as the top bar, which is honest about what works. */
function SalaahkaarCard() {
  const shell = useShell();
  const status = useAssistantStatus();
  return (
    <section aria-label="Salaahkaar" className="rounded-xl bg-emerald-700 p-4 text-white">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-emerald-100">
        <Icon name="sparkle" className="h-4 w-4" />
        Salaahkaar
      </div>
      <h2 className="mt-2 text-lg font-semibold">Ask your store anything</h2>
      <p className="mt-0.5 text-sm text-emerald-50">Sales, stock, customers, Khata and bills.</p>
      {status.data && !status.data.available && (
        <p role="note" className="mt-3 rounded-lg bg-emerald-800/60 px-3 py-2 text-xs text-emerald-50">
          Not answering yet. {status.data.reason}
        </p>
      )}
      <button
        type="button"
        onClick={() => shell?.openAssistant()}
        className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
      >
        Ask Salaahkaar
      </button>
    </section>
  );
}
