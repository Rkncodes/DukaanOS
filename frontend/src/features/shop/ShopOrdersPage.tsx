import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, QueryState, Stat, type Tone } from "../../app/ui";
import { useTranslation } from "../../i18n";
import { api, unwrap, type Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity, orderNumber } from "../../lib/format";

type Order = Schemas["OrderRead"];
type Status = Schemas["OrderStatus"];
type Method = Schemas["PaymentMethod"];

/** How often the list is re-read, so new orders appear without a refresh. */
export const ORDERS_POLL_MS = 5000;

const STATUS_TONE: Record<Status, Tone> = { pending: "amber", confirmed: "blue", ready: "blue", completed: "emerald", cancelled: "slate" };
const STATUS_EDGE: Record<Status, string> = {
  pending: "border-l-amber-400",
  confirmed: "border-l-sky-400",
  ready: "border-l-sky-400",
  completed: "border-l-emerald-500",
  cancelled: "border-l-slate-300",
};
// Paytm is not offered here: it is only ever recorded after Paytm's own verification.
const PAID_BY = ["cash", "upi", "card"] as const satisfies readonly Method[];

const primary = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/**
 * Orders customers placed on the storefront. This merchant's only: the backend scopes the list to the
 * logged-in merchant and decides which status change is allowed; the buttons merely ask for the next step.
 */
export function ShopOrdersPage({ pollMs = ORDERS_POLL_MS }: { pollMs?: number } = {}) {
  const { t, problem } = useTranslation();
  const qc = useQueryClient();
  const orders = useQuery({
    queryKey: ["orders", { channel: "shop" }],
    queryFn: () => unwrap(api.GET("/api/v1/orders", { params: { query: { channel: "shop", limit: 100 } } })),
    refetchInterval: pollMs,
  });
  const move = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Schemas["OrderStatusUpdate"]) =>
      unwrap(api.PATCH("/api/v1/orders/{order_id}/status", { params: { path: { order_id: id } }, body })),
    // A cancelled order returns stock and a completed one records money: refresh what shows them.
    onSettled: () => {
      for (const key of [["orders"], ["products"]]) qc.invalidateQueries({ queryKey: key });
    },
  });

  const all = orders.data ?? [];
  const open = (status: Status) => all.filter((o) => o.status === status);
  const fresh = open("pending");
  const active = [...open("confirmed"), ...open("ready")];
  const done = all.filter((o) => o.status === "completed" || o.status === "cancelled");
  const section = (title: string, list: Order[]) =>
    list.length > 0 && (
      <section aria-label={title} className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">
          {title} ({list.length})
        </h2>
        <ul className="grid gap-3 lg:grid-cols-2">
          {list.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              busy={move.isPending && move.variables?.id === order.id}
              error={move.error && move.variables?.id === order.id ? problem(move.error) : null}
              onMove={(status, payment_method) => move.mutate({ id: order.id, status, payment_method })}
            />
          ))}
        </ul>
      </section>
    );

  const today = all.filter((o) => new Date(o.created_at).toDateString() === new Date().toDateString());

  return (
    <>
      {/* Counted from the orders listed below (the latest 100), not estimated. */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat
          label={t("orders.pending")}
          icon="clock"
          tone={fresh.length > 0 ? "amber" : "slate"}
          value={orders.data ? fresh.length : "–"}
          hint={orders.data && (fresh.length > 0 ? t("orders.pendingWaiting") : t("orders.pendingNone"))}
        />
        <Stat label={t("orders.today")} icon="clipboard" value={orders.data ? today.length : "–"} hint={orders.data && t("orders.todayHint")} />
        <Stat
          label={t("orders.completed")}
          icon="wallet"
          tone="emerald"
          value={orders.data ? open("completed").length : "–"}
          hint={orders.data && t("orders.completedHint", { count: all.length })}
        />
      </div>

      <QueryState isPending={orders.isPending} error={orders.error} />
      {orders.data && all.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          {t("orders.empty")}
        </p>
      )}
      {section(t("orders.sectionNew"), fresh)}
      {section(t("orders.sectionActive"), active)}
      {section(t("orders.sectionDone"), done)}
    </>
  );
}

function OrderCard({
  order,
  busy,
  error,
  onMove,
}: {
  order: Order;
  busy: boolean;
  error: string | null;
  onMove: (status: Status, paymentMethod?: Method) => void;
}) {
  const { t, dateLocale } = useTranslation();
  const [paidBy, setPaidBy] = useState<Method>("cash");
  const number = orderNumber(order.id);
  const customer = [order.customer_name, order.customer_phone].filter(Boolean).join(" · ");

  return (
    <li
      aria-label={t("orders.order", { number })}
      className={`rounded-xl border border-l-4 border-slate-200 bg-white p-4 text-sm ${STATUS_EDGE[order.status]}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold leading-tight text-slate-900">{number}</div>
          <time dateTime={order.created_at} className="text-xs text-slate-500">
            {new Date(order.created_at).toLocaleString(dateLocale, { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </div>
        <Badge tone={STATUS_TONE[order.status]}>{t(`orders.status.${order.status}` as const)}</Badge>
      </header>

      <dl className="mt-3 space-y-1">
        <div className="flex justify-between gap-3 text-slate-600">
          <dt>{t("cart.customer")}</dt>
          <dd className="text-right font-medium text-slate-900">{customer || t("orders.notGiven")}</dd>
        </div>
        <div className="flex justify-between gap-3 text-slate-600">
          <dt>{t("orders.payment")}</dt>
          <dd className={`text-right font-medium ${order.payment_status === "paid" ? "text-emerald-700" : "text-amber-700"}`}>
            {order.payment_status === "paid" ? t("orders.paid") : t("orders.unpaid")}
          </dd>
        </div>
      </dl>

      <ul className="mt-3 space-y-0.5 rounded-lg bg-slate-50 px-3 py-2">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between gap-3">
            <span>
              {formatQuantity(item.quantity)} × {item.product_name}
            </span>
            <span className="tabular-nums text-slate-500">{formatINR(item.line_total)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2">
        <div className="flex items-baseline justify-between font-semibold text-slate-900">
          <dt>{t("cart.total")}</dt>
          <dd className="text-lg tabular-nums">{formatINR(order.total)}</dd>
        </div>
      </dl>

      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {order.status === "pending" && (
          <>
            <button type="button" className={primary} disabled={busy} onClick={() => onMove("confirmed")}>
              {t("orders.accept")}
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => onMove("cancelled")}>
              {t("orders.reject")}
            </button>
          </>
        )}
        {order.status === "confirmed" && (
          <button type="button" className={primary} disabled={busy} onClick={() => onMove("ready")}>
            {t("orders.markReady")}
          </button>
        )}
        {order.status === "ready" && (
          <>
            <label className="flex items-center gap-1 text-slate-600">
              {t("orders.paidBy")}
              <select
                value={paidBy}
                onChange={(e) => setPaidBy(e.target.value as Method)}
                aria-label={t("orders.paidByOrder", { number })}
                className="rounded-md border border-slate-300 px-2 py-1.5"
              >
                {PAID_BY.map((m) => (
                  <option key={m} value={m}>
                    {t(`cart.method.${m}` as const)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={primary} disabled={busy} onClick={() => onMove("completed", paidBy)}>
              {t("orders.complete", { amount: formatINR(order.total) })}
            </button>
          </>
        )}
        {(order.status === "confirmed" || order.status === "ready") && (
          <button type="button" className={secondary} disabled={busy} onClick={() => onMove("cancelled")}>
            {t("orders.cancel")}
          </button>
        )}
      </div>
    </li>
  );
}
