import { Link, useParams } from "react-router";
import { ApiError } from "../../lib/api/client";
import { formatINR, formatQuantity, orderNumber } from "../../lib/format";
import { useStoreOrder, type StoreOrder } from "./api";
import { useStoreContext } from "./StoreLayout";

const STEPS: { status: StoreOrder["status"]; label: string }[] = [
  { status: "pending", label: "Placed" },
  { status: "confirmed", label: "Accepted" },
  { status: "ready", label: "Ready" },
  { status: "completed", label: "Collected" },
];

const HEADLINE: Record<StoreOrder["status"], string> = {
  pending: "Order placed. Waiting for the store to accept it.",
  confirmed: "The store accepted your order and is getting it ready.",
  ready: "Your order is ready to collect.",
  completed: "Order collected. Thank you!",
  cancelled: "The store cancelled this order.",
};

/** The customer's order, as the store's backend reports it. Re-read every few seconds until it is finished. */
export function OrderPage({ pollMs }: { pollMs?: number } = {}) {
  const { slug, store } = useStoreContext();
  const { orderId = "" } = useParams();
  const { data: order, error } = useStoreOrder(slug, orderId, pollMs);

  if (error)
    return (
      <p role="alert" className="py-10 text-center text-sm text-red-600">
        {error instanceof ApiError && error.status === 404
          ? "This order could not be found at this store."
          : "The order could not be loaded. Please try again."}
      </p>
    );
  if (!order) return <p className="py-10 text-center text-sm text-slate-500">Loading…</p>;

  const reached = STEPS.findIndex((step) => step.status === order.status);

  return (
    <>
      <div
        role="status"
        className={`rounded-lg border p-4 text-center ${
          order.status === "cancelled" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"
        }`}
      >
        <div className="text-sm">Order {orderNumber(order.id)}</div>
        <div className="mt-1 font-semibold">{HEADLINE[order.status]}</div>
      </div>

      {order.status !== "cancelled" && (
        <ol aria-label="Order progress" className="mt-4 flex justify-between text-xs">
          {STEPS.map((step, index) => (
            <li
              key={step.status}
              aria-current={index === reached ? "step" : undefined}
              className={`flex-1 border-t-4 pt-1 text-center ${
                index <= reached ? "border-emerald-600 font-medium text-emerald-800" : "border-slate-200 text-slate-400"
              }`}
            >
              {step.label}
            </li>
          ))}
        </ol>
      )}

      <article className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <header className="mb-2 text-xs text-slate-500">
          {store.store_name} ·{" "}
          {new Date(order.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          {order.customer_name && ` · ${order.customer_name}`}
        </header>
        <ul aria-label="Ordered items" className="space-y-1">
          {order.items.map((item) => (
            <li key={item.product_id} className="flex justify-between">
              <span>
                {formatQuantity(item.quantity)} × {item.product_name}
              </span>
              <span>{formatINR(item.line_total)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-dashed border-slate-300 pt-2 text-base font-semibold text-slate-900">
          <span>Total</span>
          <span>{formatINR(order.total)}</span>
        </div>
        <p className="mt-2 text-slate-600">
          {order.payment_status === "paid"
            ? "Paid."
            : order.status === "cancelled"
              ? "Nothing was charged."
              : "Not paid yet: pay at the store when you collect it."}
        </p>
      </article>

      <Link to={`/store/${slug}`} className="block py-4 text-center text-sm font-medium text-emerald-700">
        Back to the store
      </Link>
    </>
  );
}
