import { useState } from "react";
import { Link, Outlet, useOutletContext, useParams } from "react-router";
import { FullPageMessage } from "../../app/ui";
import { useTranslation } from "../../i18n";
import { ApiError, type Schemas } from "../../lib/api/client";
import { formatINR } from "../../lib/format";
import { useStore, useStoreProducts } from "./api";
import { cartView, loadCart, saveCart, withQuantity, type CartView, type StoreCart, type StoreProduct } from "./cart";

export type StoreContext = {
  slug: string;
  store: Schemas["StoreRead"];
  products: StoreProduct[];
  cart: CartView;
  /** Quantity 0 removes the product from the cart. */
  setQuantity: (productId: string, quantity: number) => void;
  clearCart: () => void;
  /** Re-read the catalogue (prices, what is in stock) after an order was refused. */
  refreshProducts: () => void;
};

export const useStoreContext = () => useOutletContext<StoreContext>();

/**
 * The public storefront of one merchant: /store/:storeSlug. No login. Loads the store and its
 * real catalogue once, keeps the customer's cart, and frames the storefront, cart, checkout and
 * order pages. Laid out for a phone, since customers arrive by scanning the shop's QR code.
 */
export function StoreLayout() {
  const { t } = useTranslation();
  const { storeSlug = "" } = useParams();
  const store = useStore(storeSlug);
  const products = useStoreProducts(storeSlug, store.isSuccess);
  const [cart, setCart] = useState<StoreCart>(() => loadCart(storeSlug));

  const update = (next: StoreCart) => {
    saveCart(storeSlug, next);
    setCart(next);
  };

  if (store.error instanceof ApiError && store.error.status === 404)
    return <FullPageMessage>{t("store.notFound")}</FullPageMessage>;
  if (store.error || products.error) return <FullPageMessage>{t("store.loadFailed")}</FullPageMessage>;
  if (!store.data || !products.data) return <FullPageMessage>{t("common.loading")}</FullPageMessage>;

  const view = cartView(cart, products.data);
  const context: StoreContext = {
    slug: storeSlug,
    store: store.data,
    products: products.data,
    cart: view,
    setQuantity: (productId, quantity) => update(withQuantity(cart, productId, quantity)),
    clearCart: () => update({}),
    refreshProducts: () => void products.refetch(),
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
          <Link to={`/store/${storeSlug}`} className="text-lg font-bold text-emerald-700">
            {store.data.store_name}
          </Link>
          <Link
            to={`/store/${storeSlug}/cart`}
            aria-label={t(view.count === 1 ? "store.cartCount.one" : "store.cartCount.other", { count: view.count })}
            className="rounded-full border border-emerald-600 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
          >
            {t("store.cart")}
            {view.count > 0 && ` · ${view.count} · ${formatINR(view.total)}`}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-4">
        <Outlet context={context} />
      </main>
    </div>
  );
}
