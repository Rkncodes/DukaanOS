import type { Schemas } from "../../lib/api/client";
import { fromPaise, toPaise } from "../counter/bill";

/**
 * The customer's cart on the public storefront. It holds only product ids and quantities, kept in
 * this browser. Names and prices always come from the store's catalogue as the backend serves it,
 * and the amount actually charged is computed by the backend when the order is placed.
 */

export type StoreProduct = Schemas["StoreProduct"];
/** product id -> how many */
export type StoreCart = Record<string, number>;

export const MAX_QUANTITY = 999; // mirrors backend app.modules.shop.schemas.MAX_LINE_QUANTITY

const cartKey = (slug: string) => `dukaanos.store.${slug}.cart`;
const lastOrderKey = (slug: string) => `dukaanos.store.${slug}.lastOrder`;

export function loadCart(slug: string): StoreCart {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(cartKey(slug)) ?? "{}");
    if (typeof stored !== "object" || stored === null) return {};
    const cart: StoreCart = {};
    for (const [id, quantity] of Object.entries(stored))
      if (Number.isInteger(quantity) && quantity > 0) cart[id] = Math.min(quantity as number, MAX_QUANTITY);
    return cart;
  } catch {
    return {}; // unreadable or unavailable storage: start with an empty cart
  }
}

export function saveCart(slug: string, cart: StoreCart) {
  try {
    localStorage.setItem(cartKey(slug), JSON.stringify(cart));
  } catch {
    // Storage unavailable (private mode): the cart just won't survive a reload.
  }
}

export function loadLastOrder(slug: string): string | null {
  try {
    return localStorage.getItem(lastOrderKey(slug));
  } catch {
    return null;
  }
}

export function saveLastOrder(slug: string, orderId: string) {
  try {
    localStorage.setItem(lastOrderKey(slug), orderId);
  } catch {
    // Not remembered: the order page itself still works.
  }
}

/** Quantity 0 (or less) removes the product. */
export function withQuantity(cart: StoreCart, productId: string, quantity: number): StoreCart {
  const next = { ...cart };
  if (quantity <= 0) delete next[productId];
  else next[productId] = Math.min(Math.floor(quantity), MAX_QUANTITY);
  return next;
}

export type CartLine = { product: StoreProduct; quantity: number; lineTotal: string };

export type CartView = {
  lines: CartLine[]; // in catalogue order
  /** Ids in the cart that the store no longer sells: shown as removed, never ordered. */
  unavailable: string[];
  count: number;
  /** A preview from the catalogue's prices; the backend computes the real total. */
  total: string;
};

export function cartView(cart: StoreCart, products: StoreProduct[]): CartView {
  const lines = products
    .filter((p) => cart[p.id] > 0)
    .map((product) => ({
      product,
      quantity: cart[product.id],
      lineTotal: fromPaise((toPaise(product.price) ?? 0) * cart[product.id]),
    }));
  const known = new Set(products.map((p) => p.id));
  return {
    lines,
    unavailable: Object.keys(cart).filter((id) => !known.has(id)),
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
    total: fromPaise(lines.reduce((sum, line) => sum + (toPaise(line.lineTotal) ?? 0), 0)),
  };
}

/** What is sent when ordering: ids and quantities only. */
export function orderItems(view: CartView): Schemas["StoreOrderItem"][] {
  return view.lines.map((line) => ({ product_id: line.product.id, quantity: String(line.quantity) }));
}
