import { useEffect, useRef } from "react";
import { useTranslation } from "../../i18n";
import type { Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity } from "../../lib/format";

/** Shown after checkout: the completed bill and exactly how it was settled. */
export function Receipt({
  bill,
  storeName,
  storeGstin,
  onNext,
}: {
  bill: Schemas["BillRead"];
  storeName?: string;
  storeGstin?: string | null;
  onNext: () => void;
}) {
  const { t, label, dateLocale } = useTranslation();
  const { order, customer, payments, khata_entry, customer_balance } = bill;
  const tax = order.tax_summary;
  const taxed = Number(tax.total_tax) > 0;
  // Present only after the backend verified the payment with Paytm.
  const paytm = payments.find((p) => p.provider === "paytm" && p.status === "succeeded");
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center">
        <div className="text-sm text-emerald-800">
          {khata_entry
            ? t("receipt.addedToKhata")
            : order.payment_status !== "paid"
              ? t("receipt.billSaved")
              : paytm
                ? `${t("receipt.paymentSuccessful")} ✓ ${t("receipt.verifiedByPaytm")}`
                : t("receipt.paymentReceived")}
        </div>
        <div className="text-3xl font-bold text-emerald-900">{formatINR(order.total)}</div>
        {paytm?.external_reference && (
          <div className="mt-1 text-xs text-emerald-800">{t("paytm.reference", { reference: paytm.external_reference })}</div>
        )}
      </div>

      <article className="rounded-lg border border-slate-200 bg-white p-5 text-sm">
        <header className="mb-3 border-b border-dashed border-slate-300 pb-3 text-center">
          <div className="font-semibold text-slate-900">{storeName}</div>
          {storeGstin && <div className="text-xs text-slate-500">GSTIN: {storeGstin}</div>}
          <div className="text-xs text-slate-500">
            {t("receipt.billNumber", { number: order.id.slice(0, 8).toUpperCase() })} ·{" "}
            {new Date(order.created_at).toLocaleString(dateLocale, { dateStyle: "medium", timeStyle: "short" })}
          </div>
          {customer && <div className="mt-1 text-slate-700">{customer.name}</div>}
        </header>

        <table className="w-full">
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="align-top">
                <td className="py-1">
                  {item.product_name}
                  <div className="text-xs text-slate-500">
                    {formatQuantity(item.quantity)} × {formatINR(item.unit_price)}
                  </div>
                </td>
                <td className="py-1 text-right">{formatINR(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="mt-3 space-y-1 border-t border-dashed border-slate-300 pt-3">
          <Row label={t("cart.subtotal")} value={formatINR(order.subtotal)} />
          {Number(order.discount) > 0 && <Row label={t("cart.discount")} value={`− ${formatINR(order.discount)}`} />}
          <Row label={t("cart.total")} value={formatINR(order.total)} strong />
          {payments.map((p) => (
            <Row key={p.id} label={t("receipt.paid", { method: label("cart.method", p.method) })} value={formatINR(p.amount)} />
          ))}
          {khata_entry && <Row label={t("receipt.onKhata")} value={formatINR(khata_entry.amount)} />}
        </dl>

        {taxed && (
          <dl className="mt-3 space-y-1 border-t border-dashed border-slate-300 pt-3 text-xs text-slate-500">
            <Row label={t("receipt.taxableValue")} value={formatINR(tax.taxable_value)} />
            {/* CGST and SGST are the names printed on Indian bills in every language. */}
            <Row label="CGST" value={formatINR(tax.cgst)} />
            <Row label="SGST" value={formatINR(tax.sgst)} />
            <Row label={t("receipt.totalGst")} value={formatINR(tax.total_tax)} />
          </dl>
        )}

        {customer && customer_balance !== null && (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-center ${
              Number(customer_balance) > 0 ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600"
            }`}
          >
            {t("receipt.khataBalance", { name: customer.name })} <strong>{formatINR(customer_balance)}</strong>
          </p>
        )}
      </article>

      <button
        ref={nextRef}
        type="button"
        onClick={onNext}
        className="mt-4 w-full rounded-md bg-emerald-600 py-3 font-semibold text-white hover:bg-emerald-700"
      >
        {t("receipt.newBill")}
      </button>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "text-base font-semibold text-slate-900" : "text-slate-600"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
