import { useEffect, useRef } from "react";
import type { Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity } from "../../lib/format";

const METHOD_LABEL: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card" };

/** Shown after checkout: the completed bill and exactly how it was settled. */
export function Receipt({ bill, storeName, onNext }: { bill: Schemas["BillRead"]; storeName?: string; onNext: () => void }) {
  const { order, customer, payments, khata_entry, customer_balance } = bill;
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center">
        <div className="text-sm text-emerald-800">
          {khata_entry ? "Added to khata" : order.payment_status === "paid" ? "Payment received" : "Bill saved"}
        </div>
        <div className="text-3xl font-bold text-emerald-900">{formatINR(order.total)}</div>
      </div>

      <article className="rounded-lg border border-slate-200 bg-white p-5 text-sm">
        <header className="mb-3 border-b border-dashed border-slate-300 pb-3 text-center">
          <div className="font-semibold text-slate-900">{storeName}</div>
          <div className="text-xs text-slate-500">
            Bill #{order.id.slice(0, 8).toUpperCase()} ·{" "}
            {new Date(order.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
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
          <Row label="Subtotal" value={formatINR(order.subtotal)} />
          {Number(order.discount) > 0 && <Row label="Discount" value={`− ${formatINR(order.discount)}`} />}
          <Row label="Total" value={formatINR(order.total)} strong />
          {payments.map((p) => (
            <Row key={p.id} label={`Paid · ${METHOD_LABEL[p.method] ?? p.method}`} value={formatINR(p.amount)} />
          ))}
          {khata_entry && <Row label="On khata (udhaar)" value={formatINR(khata_entry.amount)} />}
        </dl>

        {customer && customer_balance !== null && (
          <p
            className={`mt-3 rounded-md px-3 py-2 text-center ${
              Number(customer_balance) > 0 ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600"
            }`}
          >
            {customer.name}'s khata balance: <strong>{formatINR(customer_balance)}</strong>
          </p>
        )}
      </article>

      <button
        ref={nextRef}
        type="button"
        onClick={onNext}
        className="mt-4 w-full rounded-md bg-emerald-600 py-3 font-semibold text-white hover:bg-emerald-700"
      >
        New bill
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
