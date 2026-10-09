import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useTranslation } from "../../i18n";
import { formatINR } from "../../lib/format";
import { placeOrder } from "./api";
import { orderItems, saveLastOrder } from "./cart";
import { useStoreContext } from "./StoreLayout";

/**
 * Place the order. Only product ids and quantities are sent: the store's backend re-reads the
 * products, checks stock and computes the total, and the order it returns is what the customer sees.
 */
export function CheckoutPage() {
  const { t, problem } = useTranslation();
  const { slug, store, cart, clearCart, refreshProducts } = useStoreContext();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const phoneOk = /^[0-9+ -]*$/.test(phone);

  const order = useMutation({
    mutationFn: () =>
      placeOrder(slug, { items: orderItems(cart), customer_name: name.trim() || null, customer_phone: phone.trim() || null }),
    onSuccess: (placed) => {
      saveLastOrder(slug, placed.id);
      clearCart();
      navigate(`/store/${slug}/order/${placed.id}`, { replace: true });
    },
    // Refused (out of stock, no longer sold, price data stale): show the store as it is now.
    onError: refreshProducts,
  });

  if (cart.lines.length === 0 && !order.isSuccess) return <Navigate to={`/store/${slug}/cart`} replace />;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (phoneOk && !order.isPending) order.mutate();
      }}
    >
      <h1 className="mb-3 text-xl font-semibold text-slate-900">{t("store.checkout")}</h1>

      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <h2 className="mb-2 text-sm font-medium text-slate-500">{t("store.yourOrderFrom", { store: store.store_name })}</h2>
        <ul aria-label={t("store.orderSummary")} className="space-y-1 text-sm">
          {cart.lines.map(({ product, quantity, lineTotal }) => (
            <li key={product.id} className="flex justify-between">
              <span>
                {quantity} × {product.name}
              </span>
              <span>{formatINR(lineTotal)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-dashed border-slate-300 pt-2 font-semibold text-slate-900">
          <span>{t("cart.total")}</span>
          <span>{formatINR(cart.total)}</span>
        </div>
      </section>

      <section className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
        <h2 className="text-sm font-medium text-slate-500">{t("store.yourDetails")}</h2>
        <div>
          <label htmlFor="store-name" className="mb-1 block text-sm text-slate-600">
            {t("store.name")}
          </label>
          <input
            id="store-name"
            value={name}
            maxLength={120}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="store-phone" className="mb-1 block text-sm text-slate-600">
            {t("store.phone")}
          </label>
          <input
            id="store-phone"
            value={phone}
            maxLength={20}
            inputMode="tel"
            autoComplete="tel"
            aria-invalid={!phoneOk}
            onChange={(e) => setPhone(e.target.value)}
            className={`w-full rounded-md border px-3 py-2 ${phoneOk ? "border-slate-300" : "border-red-500"}`}
          />
          {!phoneOk && <p className="mt-1 text-xs text-red-600">{t("store.phoneDigits")}</p>}
        </div>
      </section>

      <p className="mt-4 text-sm text-slate-600">
        {t("store.payAtStore")}
      </p>
      {order.error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {t("store.notPlaced", { reason: problem(order.error) })}
        </p>
      )}

      <button
        type="submit"
        disabled={!phoneOk || order.isPending}
        className="mt-4 w-full rounded-md bg-emerald-600 py-3 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {order.isPending ? t("store.placing") : t("store.place", { amount: formatINR(cart.total) })}
      </button>
      <Link to={`/store/${slug}/cart`} className="block py-3 text-center text-sm font-medium text-emerald-700">
        {t("store.backToCart")}
      </Link>
    </form>
  );
}
