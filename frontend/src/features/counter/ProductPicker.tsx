import { useRef, useState } from "react";
import type { Schemas } from "../../lib/api/client";
import { formatINR, formatQuantity } from "../../lib/format";
import { availableStock, resolveScan, searchProducts } from "./bill";

type Props = {
  products: Schemas["ProductRead"][];
  /** The open bill's lines: each product shows its stock minus what the bill already holds. */
  cartItems: Schemas["CartItemRead"][];
  onAdd: (item: Schemas["CartItemAdd"]) => Promise<unknown>;
  busy: boolean;
};

/** One box for both barcode scanners (which type the code + Enter) and name search. */
export function ProductPicker({ products, cartItems, onAdd, busy }: Props) {
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = searchProducts(query, products);
  const available = availableStock(products, cartItems);
  /** One more unit of this product no longer fits in what is left. */
  const soldOut = (productId: string) => (available.get(productId) ?? 0) < 1;

  async function add(item: Schemas["CartItemAdd"]) {
    setMessage(null);
    try {
      await onAdd(item);
      setQuery("");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not add item");
    } finally {
      inputRef.current?.focus();
    }
  }

  function onEnter() {
    const action = resolveScan(query, products);
    const product =
      action.kind === "barcode"
        ? products.find((p) => p.barcode === action.barcode)
        : action.kind === "product"
          ? products.find((p) => p.id === action.productId)
          : undefined;
    if (product && soldOut(product.id)) setMessage(`No more ${product.name} in stock`);
    else if (action.kind === "barcode") void add({ barcode: action.barcode, source: "barcode" });
    else if (action.kind === "product") void add({ product_id: action.productId, source: "manual" });
    else setMessage(action.reason || null);
  }

  return (
    <div className="flex min-h-0 flex-col">
      <label htmlFor="counter-scan" className="mb-1 block text-sm font-medium text-slate-600">
        Scan barcode or search product
      </label>
      <input
        id="counter-scan"
        ref={inputRef}
        autoFocus
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setMessage(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape") {
            setQuery("");
            setMessage(null);
          }
        }}
        placeholder="e.g. 8901058000017 or maggi"
        className="w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
      />
      <p className="mt-1 h-5 text-sm text-red-600" role="status">
        {message}
      </p>

      <ul aria-label="Products" className="mt-2 grid grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
        {matches.map((p) => {
          const left = available.get(p.id) ?? 0;
          return (
            <li key={p.id}>
              <button
                type="button"
                disabled={busy || soldOut(p.id)}
                onClick={() => void add({ product_id: p.id, source: "manual" })}
                className="flex w-full flex-col rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-60"
              >
                <span className="font-medium text-slate-900">{p.name}</span>
                <span className="mt-1 flex items-baseline justify-between text-sm">
                  <span className="font-semibold text-emerald-700">
                    {formatINR(p.price)}
                    <span className="font-normal text-slate-400"> / {p.unit}</span>
                  </span>
                  <span className={left <= 0 ? "text-red-600" : "text-slate-500"}>
                    {formatQuantity(String(left))} left
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {matches.length === 0 && <li className="text-sm text-slate-500">No products match.</li>}
      </ul>
    </div>
  );
}
