import { useState } from "react";
import type { Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity } from "../../lib/format";
import { billTotals, stockShortfalls } from "./bill";
import { CustomerPicker } from "./CustomerPicker";
import type { useCounter } from "./useCounter";

type Counter = ReturnType<typeof useCounter>;
type Method = Schemas["CheckoutMethod"];

const METHODS: { value: Method; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "khata", label: "Khata" },
];

type Props = {
  counter: Counter;
  products: Schemas["ProductRead"][] | undefined;
  onCompleted: (bill: Schemas["BillRead"]) => void;
};

export function CartPanel({ counter, products, onCompleted }: Props) {
  const { cart, setQuantity, removeItem, setCustomer, checkout } = counter;
  const [discount, setDiscount] = useState("");
  const [method, setMethod] = useState<Method>("cash");

  const items = cart?.items ?? [];
  const totals = billTotals(cart?.subtotal ?? "0.00", discount);
  const shortfalls = stockShortfalls(items, products);
  const needsCustomer = method === "khata" && !cart?.customer_id;
  const editing = setQuantity.isPending || removeItem.isPending || setCustomer.isPending;
  const canCheckout = items.length > 0 && totals.ok && !needsCustomer && !editing && !checkout.isPending;
  const lineError = setQuantity.error ?? removeItem.error ?? setCustomer.error;

  function submit() {
    if (!canCheckout || !totals.ok) return;
    checkout.mutate(
      { method, discount: totals.discount },
      {
        onSuccess: (bill) => {
          setDiscount("");
          setMethod("cash");
          onCompleted(bill);
        },
      },
    );
  }

  return (
    <section className="flex flex-col rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-500">Customer</h2>
        <CustomerPicker
          customerId={cart?.customer_id ?? null}
          onChange={(id) => setCustomer.mutate(id)}
          disabled={setCustomer.isPending || checkout.isPending}
        />
      </div>

      <div className="flex-1 p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-500">Bill</h2>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Scan or tap a product to start the bill.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <CartLine
                key={item.id}
                item={item}
                available={shortfalls.get(item.id)}
                disabled={editing || checkout.isPending}
                onQuantity={(quantity) => setQuantity.mutate({ itemId: item.id, quantity })}
                onRemove={() => removeItem.mutate(item.id)}
              />
            ))}
          </ul>
        )}
        {lineError && <p className="mt-2 text-sm text-red-600">{lineError.message}</p>}
      </div>

      <div className="space-y-3 border-t border-slate-100 p-4">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Subtotal</dt>
            <dd>{formatINR(totals.subtotal)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-slate-500">
              <label htmlFor="counter-discount">Discount</label>
            </dt>
            <dd>
              <input
                id="counter-discount"
                inputMode="decimal"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                placeholder="0"
                className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm"
              />
            </dd>
          </div>
          <div className="flex justify-between pt-1 text-lg font-semibold text-slate-900">
            <dt>Total</dt>
            <dd>{totals.ok ? formatINR(totals.total) : "–"}</dd>
          </div>
        </dl>
        {!totals.ok && <p className="text-sm text-red-600">{totals.error}</p>}

        <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-4 gap-2">
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={method === m.value}
              onClick={() => setMethod(m.value)}
              className={`rounded-md border px-2 py-2 text-sm font-medium ${
                method === m.value
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {needsCustomer && <p className="text-sm text-amber-700">Select a customer to put this bill on khata.</p>}
        {checkout.error && <p className="text-sm text-red-600">{checkout.error.message}</p>}

        <button
          type="button"
          disabled={!canCheckout}
          onClick={submit}
          className="w-full rounded-md bg-emerald-600 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {checkout.isPending
            ? "Completing…"
            : method === "khata"
              ? `Add ${totals.ok ? formatINR(totals.total) : ""} to khata`
              : `Collect ${totals.ok ? formatINR(totals.total) : ""}`}
        </button>
      </div>
    </section>
  );
}

function CartLine({
  item,
  available,
  disabled,
  onQuantity,
  onRemove,
}: {
  item: Schemas["CartItemRead"];
  available: string | undefined;
  disabled: boolean;
  onQuantity: (quantity: string) => void;
  onRemove: () => void;
}) {
  const quantity = Number(item.quantity);
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const next = Number(draft);
    setDraft(null);
    if (Number.isFinite(next) && next > 0 && next !== quantity) onQuantity(draft.trim());
  }

  return (
    <li className="py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-900">{item.product_name}</div>
          <div className="text-xs text-slate-500">
            {formatINR(item.unit_price)} each
            {item.source !== "manual" && <span className="ml-1 rounded bg-slate-100 px-1">{item.source}</span>}
          </div>
        </div>
        <div className="shrink-0 font-medium">{formatINR(item.line_total)}</div>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          aria-label={`Decrease ${item.product_name}`}
          disabled={disabled}
          onClick={() => (quantity > 1 ? onQuantity(String(quantity - 1)) : onRemove())}
          className="h-7 w-7 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          −
        </button>
        <input
          aria-label={`Quantity of ${item.product_name}`}
          inputMode="decimal"
          disabled={disabled}
          value={draft ?? formatQuantity(item.quantity)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="h-7 w-14 rounded border border-slate-300 text-center text-sm"
        />
        <button
          type="button"
          aria-label={`Increase ${item.product_name}`}
          disabled={disabled}
          onClick={() => onQuantity(String(quantity + 1))}
          className="h-7 w-7 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          +
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="ml-auto text-xs text-slate-400 hover:text-red-600 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      {available !== undefined && (
        <p className="mt-1 text-xs text-amber-700">Only {formatQuantity(available)} in stock</p>
      )}
    </li>
  );
}
