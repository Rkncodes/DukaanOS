import { useState, type FormEvent } from "react";
import { Badge, Card, PageHeader, QueryState } from "../../app/ui";
import { useProducts } from "../../lib/api/queries";
import { formatQuantity } from "../../lib/format";
import { STOCK_LEVEL, stockLevel, useAdjustStock, type Product } from "./api";
import { CatalogueSummary } from "./CatalogueSummary";

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/** What needs the merchant first comes first: out of stock, then low, then the rest. */
const URGENCY = { out: 0, low: 1, ok: 2 };
const ROW = {
  out: "border-l-red-500 bg-red-50/60",
  low: "border-l-amber-400 bg-amber-50/60",
  ok: "border-l-transparent",
};

/**
 * What is on the shelf, for the products on sale. Sales take stock down by themselves; here the merchant
 * records a delivery or corrects a count, and the backend refuses a stock below zero.
 */
export function StockPage() {
  const products = useProducts();
  const [onlyLow, setOnlyLow] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);

  const all = [...(products.data ?? [])].sort((a, b) => URGENCY[stockLevel(a)] - URGENCY[stockLevel(b)]);
  const shown = onlyLow ? all.filter((p) => stockLevel(p) !== "ok") : all;

  return (
    <>
      <PageHeader title="Stock" subtitle="Record deliveries and correct counts. Sales reduce stock on their own." />
      <CatalogueSummary />

      <Card>
        <label className="mb-3 flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Only low or out of stock
        </label>
        <QueryState isPending={products.isPending} error={products.error} />
        {products.data && shown.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">
            {all.length === 0 ? "No products yet. Add them under Products." : "Nothing is low or out of stock."}
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          {shown.map((p) => (
            <li key={p.id} aria-label={p.name} className={`border-l-4 px-3 py-2.5 text-sm ${ROW[stockLevel(p)]}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-40 flex-1 font-medium text-slate-900">{p.name}</span>
                <Badge tone={STOCK_LEVEL[stockLevel(p)].tone}>{STOCK_LEVEL[stockLevel(p)].label}</Badge>
                <span className={`w-24 text-right font-semibold tabular-nums ${stockLevel(p) === "out" ? "text-red-600" : "text-slate-900"}`}>
                  {formatQuantity(p.stock_quantity)} {p.unit}
                </span>
                <button type="button" className={secondary} onClick={() => setAdjusting(adjusting === p.id ? null : p.id)}>
                  Adjust
                </button>
              </div>
              {adjusting === p.id && <AdjustForm product={p} onDone={() => setAdjusting(null)} />}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function AdjustForm({ product, onDone }: { product: Product; onDone: () => void }) {
  const adjust = useAdjustStock();
  const [quantity, setQuantity] = useState("");

  const send = (sign: 1 | -1) => adjust.mutate({ product_id: product.id, delta: String(sign * Number(quantity)) }, { onSuccess: onDone });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(1);
  }

  return (
    <form onSubmit={onSubmit} aria-label={`Adjust stock of ${product.name}`} className="mt-2 flex flex-wrap items-center gap-2">
      <input
        type="number"
        aria-label={`Quantity (${product.unit})`}
        min="0.001"
        step="0.001"
        required
        autoFocus
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        placeholder={`Quantity in ${product.unit}`}
        className={`w-40 ${input}`}
      />
      <button type="submit" className={secondary} disabled={adjust.isPending}>
        Add to stock
      </button>
      <button type="button" className={secondary} disabled={adjust.isPending || !(Number(quantity) > 0)} onClick={() => send(-1)}>
        Remove from stock
      </button>
      <button type="button" className="text-sm text-slate-500 hover:text-slate-800" onClick={onDone}>
        Cancel
      </button>
      {adjust.error && (
        <p role="alert" className="w-full text-red-600">
          {adjust.error.message}
        </p>
      )}
    </form>
  );
}
