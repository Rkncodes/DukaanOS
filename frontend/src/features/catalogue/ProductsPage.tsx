import { useState, type FormEvent } from "react";
import { Badge, Card, PageHeader, QueryState } from "../../app/ui";
import { formatINR, formatQuantity } from "../../lib/format";
import { STOCK_LEVEL, stockLevel, useAllProducts, useCategories, useSaveProduct, useSetProductActive, type Category, type Product } from "./api";
import { CatalogueSummary } from "./CatalogueSummary";

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const primary = "rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/** The merchant's products: what the Counter bills and the Shop lists. Stock is changed under Stock. */
export function ProductsPage() {
  const products = useAllProducts();
  const categories = useCategories();
  const setActive = useSetProductActive();
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  /** The product being edited, "new" while adding one, or null when the form is closed. */
  const [editing, setEditing] = useState<Product | "new" | null>(null);

  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name ?? "";
  const q = query.trim().toLowerCase();
  const all = products.data ?? [];
  const shown = all.filter(
    (p) => (showInactive || p.is_active) && (!q || p.name.toLowerCase().includes(q) || p.barcode?.includes(q)),
  );

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="What you sell: the same products at the Counter and in your Shop."
        actions={
          <button type="button" className={primary} onClick={() => setEditing("new")}>
            Add product
          </button>
        }
      />
      <CatalogueSummary />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          aria-label="Search products"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or barcode"
          className={`max-w-xs ${input}`}
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show products taken off sale
        </label>
      </div>

      {editing && (
        <div className="mb-4">
          <ProductForm
            key={editing === "new" ? "new" : editing.id}
            product={editing === "new" ? null : editing}
            categories={categories.data ?? []}
            onDone={() => setEditing(null)}
          />
        </div>
      )}

      <Card>
        <QueryState isPending={products.isPending} error={products.error} />
        {setActive.error && (
          <p role="alert" className="mb-2 text-sm text-red-600">
            {setActive.error.message}
          </p>
        )}
        {products.data && shown.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">
            {all.length === 0 ? "No products yet. Add your first product." : "No products match."}
          </p>
        )}
        {shown.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Product</th>
                  <th className="py-1.5 font-medium">Category</th>
                  <th className="py-1.5 font-medium">Barcode</th>
                  <th className="py-1.5 text-right font-medium">Price</th>
                  <th className="py-1.5 text-right font-medium">In stock</th>
                  <th className="py-1.5 pl-4 font-medium">Status</th>
                  <th className="py-1.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((p) => (
                  <tr key={p.id} aria-label={p.name} className={p.is_active ? "" : "text-slate-400"}>
                    <td className="py-2 font-medium">
                      {p.name}
                      {!p.is_active && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal">Off sale</span>}
                    </td>
                    <td className="py-2">{categoryName(p.category_id)}</td>
                    <td className="py-2 font-mono text-xs">{p.barcode}</td>
                    <td className="py-2 text-right">
                      {formatINR(p.price)} / {p.unit}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatQuantity(p.stock_quantity)}</td>
                    <td className="py-2 pl-4">
                      <Badge tone={STOCK_LEVEL[stockLevel(p)].tone}>{STOCK_LEVEL[stockLevel(p)].label}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <button type="button" className={secondary} onClick={() => setEditing(p)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className={secondary}
                          disabled={setActive.isPending}
                          onClick={() => setActive.mutate({ id: p.id, active: !p.is_active })}
                        >
                          {p.is_active ? "Take off sale" : "Put on sale"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function ProductForm({ product, categories, onDone }: { product: Product | null; categories: Category[]; onDone: () => void }) {
  const save = useSaveProduct();
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product?.price ?? "");
  const [unit, setUnit] = useState(product?.unit ?? "pcs");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [barcode, setBarcode] = useState(product?.barcode ?? "");
  const [stock, setStock] = useState("0");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const fields = { name: name.trim(), price, unit: unit.trim() || "pcs", category_id: categoryId || null, barcode: barcode.trim() || null };
    // Opening stock is set once, with the product. Afterwards it only changes through sales and Stock.
    save.mutate(product ? { id: product.id, body: fields } : { id: null, body: { ...fields, stock_quantity: stock || "0" } }, {
      onSuccess: onDone,
    });
  }

  const title = product ? `Edit ${product.name}` : "Add product";
  return (
    <Card title={title}>
      <form onSubmit={onSubmit} aria-label={title} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm text-slate-600 sm:col-span-2 lg:col-span-1">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} autoFocus className={`mt-1 ${input}`} />
        </label>
        <label className="text-sm text-slate-600">
          Price (₹)
          <input type="number" min="0" step="0.01" required value={price} onChange={(e) => setPrice(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        <label className="text-sm text-slate-600">
          Unit
          <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={16} placeholder="pcs, kg, L" className={`mt-1 ${input}`} />
        </label>
        <label className="text-sm text-slate-600">
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={`mt-1 ${input}`}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Barcode (optional)
          <input value={barcode} onChange={(e) => setBarcode(e.target.value)} maxLength={64} className={`mt-1 ${input}`} />
        </label>
        {!product && (
          <label className="text-sm text-slate-600">
            Opening stock
            <input type="number" min="0" step="0.001" value={stock} onChange={(e) => setStock(e.target.value)} className={`mt-1 ${input}`} />
          </label>
        )}
        {save.error && (
          <p role="alert" className="text-sm text-red-600 sm:col-span-2 lg:col-span-3">
            {save.error.message}
          </p>
        )}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <button type="submit" className={primary} disabled={save.isPending}>
            {save.isPending ? "Saving…" : product ? "Save changes" : "Save product"}
          </button>
          <button type="button" className={secondary} disabled={save.isPending} onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
