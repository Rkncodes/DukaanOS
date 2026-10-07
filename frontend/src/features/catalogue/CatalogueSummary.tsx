import { useProducts } from "../../lib/api/queries";
import { LOW_STOCK, stockLevel } from "./api";

/**
 * The same three numbers at the top of every Catalogue page, so Products, Categories and Stock read as one
 * inventory workspace: how much is on sale, and how much of it is running low or gone.
 */
export function CatalogueSummary() {
  const products = useProducts();
  const all = products.data ?? [];
  const low = all.filter((p) => stockLevel(p) === "low").length;
  const out = all.filter((p) => stockLevel(p) === "out").length;
  const figures = [
    { label: "Products on sale", value: all.length, warn: "" },
    { label: `Low (under ${LOW_STOCK})`, value: low, warn: "text-amber-700" },
    { label: "Out of stock", value: out, warn: "text-red-600" },
  ];

  return (
    <dl className="mb-4 grid grid-cols-3 gap-3">
      {figures.map(({ label, value, warn }) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className={`mt-1 text-2xl font-semibold tabular-nums ${products.data && value > 0 && warn ? warn : "text-slate-900"}`}>
            {products.data ? value : "–"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
