import { Link, useParams } from "react-router";
import { useTranslation } from "../../i18n";
import { ApiError } from "../../lib/api/client";
import { formatINR, formatQuantity, orderNumber } from "../../lib/format";
import { useStoreOrder, type StoreOrder } from "./api";
import { useStoreContext } from "./StoreLayout";

const STEPS = ["pending", "confirmed", "ready", "completed"] as const satisfies readonly StoreOrder["status"][];

/** The customer's order, as the store's backend reports it. Re-read every few seconds until it is finished. */
export function OrderPage({ pollMs }: { pollMs?: number } = {}) {
  const { t, dateLocale } = useTranslation();
  const { slug, store } = useStoreContext();
  const { orderId = "" } = useParams();
  const { data: order, error } = useStoreOrder(slug, orderId, pollMs);

  if (error)
    return (
      <p role="alert" className="py-10 text-center text-sm text-red-600">
        {error instanceof ApiError && error.status === 404
          ? t("store.orderNotFound")
          : t("store.orderLoadFailed")}
      </p>
    );
  if (!order) return <p className="py-10 text-center text-sm text-slate-500">{t("common.loading")}</p>;

  const reached = STEPS.findIndex((step) => step === order.status);

  return (
    <>
      <div
        role="status"
        className={`rounded-lg border p-4 text-center ${
          order.status === "cancelled" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"
        }`}
      >
        <div className="text-sm">{t("orders.order", { number: orderNumber(order.id) })}</div>
        <div className="mt-1 font-semibold">{t(`store.headline.${order.status}` as const)}</div>
      </div>

      {order.status !== "cancelled" && (
        <ol aria-label={t("store.orderProgress")} className="mt-4 flex justify-between text-xs">
          {STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === reached ? "step" : undefined}
              className={`flex-1 border-t-4 pt-1 text-center ${
                index <= reached ? "border-emerald-600 font-medium text-emerald-800" : "border-slate-200 text-slate-400"
              }`}
            >
              {t(`store.step.${step}` as const)}
            </li>
          ))}
        </ol>
      )}

      <article className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <header className="mb-2 text-xs text-slate-500">
          {store.store_name} ·{" "}
          {new Date(order.created_at).toLocaleString(dateLocale, { dateStyle: "medium", timeStyle: "short" })}
          {order.customer_name && ` · ${order.customer_name}`}
        </header>
        <ul aria-label={t("store.orderedItems")} className="space-y-1">
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
          <span>{t("cart.total")}</span>
          <span>{formatINR(order.total)}</span>
        </div>
        <p className="mt-2 text-slate-600">
          {order.payment_status === "paid"
            ? t("store.paid")
            : order.status === "cancelled"
              ? t("store.nothingCharged")
              : t("store.notPaid")}
        </p>
      </article>

      <Link to={`/store/${slug}`} className="block py-4 text-center text-sm font-medium text-emerald-700">
        {t("store.back")}
      </Link>
    </>
  );
}
