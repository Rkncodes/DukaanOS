import { useState } from "react";
import type { Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity } from "../../lib/format";
import { billTotals, stockShortfalls } from "./bill";
import { CustomerPicker } from "./CustomerPicker";
import { PaytmPay } from "./paytm/PaytmPay";
import { usePaytm } from "./paytm/usePaytm";
import type { useCounter } from "./useCounter";

type Counter = ReturnType<typeof useCounter>;
/** How the bill is settled. Paytm is not a checkout method: the backend verifies it with Paytm first. */
type Method = Schemas["CheckoutMethod"] | "paytm";

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
  const [enteredDiscount, setDiscount] = useState("");
  const [chosenMethod, setMethod] = useState<Method>("cash");

  function completed(bill: Schemas["BillRead"]) {
    setDiscount("");
    setMethod("cash");
    onCompleted(bill);
  }
  const paytm = usePaytm(cart?.id ?? null, (bill) => {
    counter.billCompleted();
    completed(bill);
  });
  // While a Paytm payment is in flight (or Paytm holds money for this bill) the bill stays as it was charged.
  const locked = paytm.live;
  const method: Method = locked ? "paytm" : chosenMethod;
  const discount = locked && paytm.payment ? paytm.payment.discount : enteredDiscount;
  const methods = paytm.enabled ? [...METHODS, { value: "paytm" as const, label: "Paytm" }] : METHODS;

  const items = cart?.items ?? [];
  const totals = billTotals(cart?.subtotal ?? "0.00", discount);
  const shortfalls = stockShortfalls(items, products);
  const stock = new Map(products?.map((p) => [p.id, Number(p.stock_quantity)]));
  const needsCustomer = method === "khata" && !cart?.customer_id;
  const editing = setQuantity.isPending || removeItem.isPending || setCustomer.isPending;
  const canCheckout = items.length > 0 && totals.ok && !needsCustomer && !editing && !checkout.isPending;
  const lineError = setQuantity.error ?? removeItem.error ?? setCustomer.error;

  function submit() {
    if (!canCheckout || !totals.ok || method === "paytm") return;
    checkout.mutate({ method, discount: totals.discount }, { onSuccess: completed });
  }

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-slate-200 border-t-4 border-t-emerald-600 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Customer</h2>
        <CustomerPicker
          customerId={cart?.customer_id ?? null}
          onChange={(id) => setCustomer.mutate(id)}
          disabled={setCustomer.isPending || checkout.isPending || locked}
        />
      </div>

      <div className="flex-1 p-4">
        <h2 className="mb-2 text-base font-semibold text-slate-900">Bill</h2>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Scan or tap a product to start the bill.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <CartLine
                key={item.id}
                item={item}
                available={shortfalls.get(item.id)}
                stock={stock.get(item.product_id)}
                disabled={editing || checkout.isPending || locked}
                onQuantity={(quantity) => setQuantity.mutate({ itemId: item.id, quantity })}
                onRemove={() => removeItem.mutate(item.id)}
              />
            ))}
          </ul>
        )}
        {lineError && <p className="mt-2 text-sm text-red-600">{lineError.message}</p>}
      </div>

      <div className="space-y-3 border-t border-slate-200 bg-slate-50 p-4">
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
                disabled={locked}
                placeholder="0"
                className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-right text-sm"
              />
            </dd>
          </div>
          <div className="flex items-baseline justify-between border-t border-slate-200 pt-2 font-semibold text-slate-900">
            <dt className="text-base">Total</dt>
            <dd className="text-2xl tabular-nums">{totals.ok ? formatINR(totals.total) : "–"}</dd>
          </div>
        </dl>
        {!totals.ok && <p className="text-sm text-red-600">{totals.error}</p>}

        <div
          role="radiogroup"
          aria-label="Payment method"
          className={`grid gap-2 ${paytm.enabled ? "grid-cols-5" : "grid-cols-4"}`}
        >
          {methods.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={method === m.value}
              disabled={locked}
              onClick={() => setMethod(m.value)}
              className={`rounded-md border px-2 py-2 text-sm font-medium ${
                method === m.value
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {needsCustomer && <p className="text-sm text-amber-700">Select a customer to put this bill on khata.</p>}
        {checkout.error && <p className="text-sm text-red-600">{checkout.error.message}</p>}

        {method === "paytm" ? (
          <PaytmPay
            paytm={paytm}
            total={totals.ok ? totals.total : null}
            discount={totals.ok ? totals.discount : "0"}
            ready={canCheckout}
          />
        ) : (
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
        )}
      </div>
    </section>
  );
}

function CartLine({
  item,
  available,
  stock,
  disabled,
  onQuantity,
  onRemove,
}: {
  item: Schemas["CartItemRead"];
  available: string | undefined;
  /** The product's stock in the catalogue; the line cannot be raised above it. Undefined: not known yet. */
  stock: number | undefined;
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
    if (!Number.isFinite(next) || next <= 0) return;
    // A typed quantity above the stock becomes the stock. The backend still decides at checkout.
    const capped = stock !== undefined && next > stock ? stock : next;
    if (capped > 0 && capped !== quantity) onQuantity(capped === next ? draft.trim() : String(capped));
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
          disabled={disabled || (stock !== undefined && quantity + 1 > stock)}
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
