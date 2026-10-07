import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, QueryState, Stat, type Tone } from "../../app/ui";
import { api, unwrap, type Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity, orderNumber } from "../../lib/format";

type Order = Schemas["OrderRead"];
type Status = Schemas["OrderStatus"];
type Method = Schemas["PaymentMethod"];

/** How often the list is re-read, so new orders appear without a refresh. */
export const ORDERS_POLL_MS = 5000;

const STATUS_LABEL: Record<Status, string> = {
  pending: "New order",
  confirmed: "Accepted",
  ready: "Ready for pickup",
  completed: "Completed",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<Status, Tone> = { pending: "amber", confirmed: "blue", ready: "blue", completed: "emerald", cancelled: "slate" };
const STATUS_EDGE: Record<Status, string> = {
  pending: "border-l-amber-400",
  confirmed: "border-l-sky-400",
  ready: "border-l-sky-400",
  completed: "border-l-emerald-500",
  cancelled: "border-l-slate-300",
};
// Paytm is not offered here: it is only ever recorded after Paytm's own verification.
const PAID_BY: { value: Method; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
];

const primary = "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/**
 * Orders customers placed on the storefront. This merchant's only: the backend scopes the list to the
 * logged-in merchant and decides which status change is allowed; the buttons merely ask for the next step.
 */
export function ShopOrdersPage({ pollMs = ORDERS_POLL_MS }: { pollMs?: number } = {}) {
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
              error={move.error && move.variables?.id === order.id ? move.error.message : null}
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
          label="Pending"
          icon="clock"
          tone={fresh.length > 0 ? "amber" : "slate"}
          value={orders.data ? fresh.length : "–"}
          hint={orders.data && (fresh.length > 0 ? "waiting for you to accept" : "nothing waiting")}
        />
        <Stat label="Today" icon="clipboard" value={orders.data ? today.length : "–"} hint={orders.data && "orders placed today"} />
        <Stat
          label="Completed"
          icon="wallet"
          tone="emerald"
          value={orders.data ? open("completed").length : "–"}
          hint={orders.data && `of the ${all.length} listed here`}
        />
      </div>

      <QueryState isPending={orders.isPending} error={orders.error} />
      {orders.data && all.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          No orders yet. Share your store QR code and orders will appear here on their own.
        </p>
      )}
      {section("New orders", fresh)}
      {section("In progress", active)}
      {section("Finished", done)}
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
  const [paidBy, setPaidBy] = useState<Method>("cash");
  const number = orderNumber(order.id);
  const customer = [order.customer_name, order.customer_phone].filter(Boolean).join(" · ");

  return (
    <li
      aria-label={`Order ${number}`}
      className={`rounded-xl border border-l-4 border-slate-200 bg-white p-4 text-sm ${STATUS_EDGE[order.status]}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold leading-tight text-slate-900">{number}</div>
          <time dateTime={order.created_at} className="text-xs text-slate-500">
            {new Date(order.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </div>
        <Badge tone={STATUS_TONE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
      </header>

      <dl className="mt-3 space-y-1">
        <div className="flex justify-between gap-3 text-slate-600">
          <dt>Customer</dt>
          <dd className="text-right font-medium text-slate-900">{customer || "Not given"}</dd>
        </div>
        <div className="flex justify-between gap-3 text-slate-600">
          <dt>Payment</dt>
          <dd className={`text-right font-medium ${order.payment_status === "paid" ? "text-emerald-700" : "text-amber-700"}`}>
            {order.payment_status === "paid" ? "Paid" : "Unpaid: collect at pickup"}
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
          <dt>Total</dt>
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
              Accept
            </button>
            <button type="button" className={secondary} disabled={busy} onClick={() => onMove("cancelled")}>
              Reject
            </button>
          </>
        )}
        {order.status === "confirmed" && (
          <button type="button" className={primary} disabled={busy} onClick={() => onMove("ready")}>
            Mark ready
          </button>
        )}
        {order.status === "ready" && (
          <>
            <label className="flex items-center gap-1 text-slate-600">
              Paid by
              <select
                value={paidBy}
                onChange={(e) => setPaidBy(e.target.value as Method)}
                aria-label={`Paid by, order ${number}`}
                className="rounded-md border border-slate-300 px-2 py-1.5"
              >
                {PAID_BY.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={primary} disabled={busy} onClick={() => onMove("completed", paidBy)}>
              Complete · collect {formatINR(order.total)}
            </button>
          </>
        )}
        {(order.status === "confirmed" || order.status === "ready") && (
          <button type="button" className={secondary} disabled={busy} onClick={() => onMove("cancelled")}>
            Cancel order
          </button>
        )}
      </div>
    </li>
  );
}
