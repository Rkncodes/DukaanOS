import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "../../i18n";
import { formatINR } from "../../lib/format";
import { loadLastOrder, type StoreProduct } from "./cart";
import { QuantityStepper } from "./QuantityStepper";
import { useStoreContext } from "./StoreLayout";

/** Browse the store's catalogue: search, filter by category, add to cart. */
export function StorefrontPage() {
  const { t } = useTranslation();
  const { slug, store, products, cart, setQuantity } = useStoreContext();
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const lastOrder = loadLastOrder(slug);

  const q = query.trim().toLowerCase();
  const shown = products.filter(
    (p) => (categoryId === null || p.category_id === categoryId) && (q === "" || p.name.toLowerCase().includes(q)),
  );
  const inCart = new Map(cart.lines.map((line) => [line.product.id, line.quantity]));
  const categoryName = new Map(store.categories.map((c) => [c.id, c.name]));

  return (
    <>
      {lastOrder && (
        <Link
          to={`/store/${slug}/order/${lastOrder}`}
          className="mb-3 block rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 hover:bg-emerald-100"
        >
          {t("store.trackLast")} →
        </Link>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("store.searchPlaceholder")}
        aria-label={t("products.search")}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2"
      />
      {store.categories.length > 0 && (
        <div role="group" aria-label={t("nav.categories")} className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {[{ id: null, name: t("store.all") }, ...store.categories].map((category) => (
            <button
              key={category.id ?? "all"}
              type="button"
              aria-pressed={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
              className={`shrink-0 rounded-full border px-3 py-1 text-sm ${
                categoryId === category.id
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-slate-300 bg-white text-slate-700"
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      )}

      {products.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">{t("store.noProducts")}</p>
      ) : shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">{t("picker.noMatch")}</p>
      ) : (
        <ul aria-label={t("nav.products")} className="mt-4 grid grid-cols-2 gap-3 pb-20">
          {shown.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              category={product.category_id ? categoryName.get(product.category_id) : undefined}
              quantity={inCart.get(product.id) ?? 0}
              onChange={(quantity) => setQuantity(product.id, quantity)}
            />
          ))}
        </ul>
      )}

      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-3">
          <Link
            to={`/store/${slug}/cart`}
            className="mx-auto block max-w-xl rounded-md bg-emerald-600 py-3 text-center font-semibold text-white hover:bg-emerald-700"
          >
            {t(cart.count === 1 ? "store.viewCart.one" : "store.viewCart.other", { count: cart.count, amount: formatINR(cart.total) })}
          </Link>
        </div>
      )}
    </>
  );
}

function ProductCard({
  product,
  category,
  quantity,
  onChange,
}: {
  product: StoreProduct;
  category: string | undefined;
  quantity: number;
  onChange: (quantity: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <li aria-label={product.name} className="flex flex-col rounded-lg border border-slate-200 bg-white p-3">
      {product.image_url && (
        <img src={product.image_url} alt="" loading="lazy" className="mb-2 h-24 w-full rounded object-contain" />
      )}
      {category && <div className="text-xs text-slate-500">{category}</div>}
      <div className="font-medium text-slate-900">{product.name}</div>
      <div className="mt-auto flex items-end justify-between pt-2">
        <div>
          <span className="font-semibold text-emerald-700">{formatINR(product.price)}</span>
          <span className="text-xs text-slate-400"> / {product.unit}</span>
        </div>
        {product.in_stock || quantity > 0 ? (
          <QuantityStepper name={product.name} quantity={quantity} onChange={onChange} disabled={!product.in_stock} />
        ) : (
          <span className="text-xs text-slate-400">{t("catalogue.outOfStock")}</span>
        )}
      </div>
    </li>
  );
}
