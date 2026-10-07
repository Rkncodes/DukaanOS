import { Link } from "react-router";
import { formatINR } from "../../lib/format";
import { QuantityStepper } from "./QuantityStepper";
import { useStoreContext } from "./StoreLayout";

/** The customer's cart: change quantities, remove products, then go to checkout. */
export function CartPage() {
  const { slug, cart, setQuantity } = useStoreContext();
  const soldOut = cart.lines.filter((line) => !line.product.in_stock);

  if (cart.lines.length === 0)
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-slate-500">Your cart is empty.</p>
        <Link to={`/store/${slug}`} className="mt-3 inline-block text-sm font-medium text-emerald-700 underline">
          Browse products
        </Link>
      </div>
    );

  return (
    <>
      <h1 className="mb-3 text-xl font-semibold text-slate-900">Your cart</h1>
      {cart.unavailable.length > 0 && (
        <p role="status" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {cart.unavailable.length === 1 ? "A product" : `${cart.unavailable.length} products`} in your cart{" "}
          {cart.unavailable.length === 1 ? "is" : "are"} no longer sold by this store and will not be ordered.
        </p>
      )}
      <ul aria-label="Cart items" className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {cart.lines.map(({ product, quantity, lineTotal }) => (
          <li key={product.id} aria-label={product.name} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-slate-900">{product.name}</div>
                <div className="text-xs text-slate-500">
                  {formatINR(product.price)} / {product.unit}
                </div>
                {!product.in_stock && <div className="text-xs text-red-600">Out of stock. Remove it to order.</div>}
              </div>
              <div className="font-medium">{formatINR(lineTotal)}</div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <QuantityStepper
                name={product.name}
                quantity={quantity}
                onChange={(next) => setQuantity(product.id, next)}
                disabled={!product.in_stock}
              />
              <button
                type="button"
                aria-label={`Remove ${product.name}`}
                onClick={() => setQuantity(product.id, 0)}
                className="text-xs text-slate-400 hover:text-red-600"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Subtotal</dt>
          <dd>{formatINR(cart.total)}</dd>
        </div>
        <div className="flex justify-between text-lg font-semibold text-slate-900">
          <dt>Total</dt>
          <dd>{formatINR(cart.total)}</dd>
        </div>
      </dl>

      <div className="mt-4 space-y-2">
        {soldOut.length === 0 ? (
          <Link
            to={`/store/${slug}/checkout`}
            className="block rounded-md bg-emerald-600 py-3 text-center font-semibold text-white hover:bg-emerald-700"
          >
            Proceed to checkout
          </Link>
        ) : (
          <p className="text-center text-sm text-red-600">Remove the out-of-stock products to continue.</p>
        )}
        <Link to={`/store/${slug}`} className="block py-2 text-center text-sm font-medium text-emerald-700">
          Continue shopping
        </Link>
      </div>
    </>
  );
}
