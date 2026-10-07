import type { Schemas } from "../../lib/api/client";

/**
 * Pure bill math for the counter. Money arrives as decimal strings ("14.00"); we work in
 * integer paise so previews match the backend exactly. The backend remains the authority
 * at checkout; this only drives what the cashier sees before pressing the button.
 */

const MONEY_RE = /^\d{1,10}(\.\d{0,2})?$/;

/** "12.5" -> 1250. Returns null for anything that is not a non-negative amount with ≤ 2 decimals. */
export function toPaise(amount: string): number | null {
  const trimmed = amount.trim();
  if (trimmed === "") return 0;
  if (!MONEY_RE.test(trimmed)) return null;
  const [rupees, paise = ""] = trimmed.split(".");
  return Number(rupees) * 100 + Number(paise.padEnd(2, "0"));
}

export function fromPaise(paise: number): string {
  return (paise / 100).toFixed(2);
}

export type BillTotals =
  | { ok: true; subtotal: string; discount: string; total: string }
  | { ok: false; subtotal: string; error: string };

export function billTotals(subtotal: string, discountInput: string): BillTotals {
  const sub = toPaise(subtotal) ?? 0;
  const discount = toPaise(discountInput);
  if (discount === null) return { ok: false, subtotal, error: "Enter a valid discount, e.g. 10 or 2.50" };
  if (discount > sub) return { ok: false, subtotal, error: "Discount cannot exceed the subtotal" };
  return { ok: true, subtotal: fromPaise(sub), discount: fromPaise(discount), total: fromPaise(sub - discount) };
}

/** Lines whose quantity exceeds current stock. Checkout would fail with insufficient_stock. */
export function stockShortfalls(
  items: Schemas["CartItemRead"][],
  products: Schemas["ProductRead"][] | undefined,
): Map<string, string> {
  const stock = new Map(products?.map((p) => [p.id, p.stock_quantity]));
  const short = new Map<string, string>();
  for (const item of items) {
    const available = stock.get(item.product_id);
    if (available !== undefined && Number(item.quantity) > Number(available)) short.set(item.id, available);
  }
  return short;
}

/**
 * What can still be added to this bill, per product: the catalogue's stock minus what the bill
 * already holds. Display only. Adding to the bill changes no stock: the backend takes it at checkout.
 */
export function availableStock(
  products: Schemas["ProductRead"][],
  items: Schemas["CartItemRead"][],
): Map<string, number> {
  const inCart = new Map<string, number>();
  for (const item of items) inCart.set(item.product_id, (inCart.get(item.product_id) ?? 0) + Number(item.quantity));
  return new Map(
    products.map((p) => {
      const left = Number(p.stock_quantity) - (inCart.get(p.id) ?? 0);
      return [p.id, Math.max(0, Math.round(left * 1000) / 1000)]; // quantities have 3 decimals
    }),
  );
}

export type BarcodeLookup =
  | { kind: "found"; product: Schemas["ProductRead"] }
  | { kind: "unknown" }
  | { kind: "ambiguous"; products: Schemas["ProductRead"][] };

/**
 * A scanned barcode against the catalogue: the product whose barcode is exactly this code, or nothing.
 * Never a near match, never a name search. Two products carrying one code is an error to be fixed in the
 * catalogue, not a choice to make silently (the database forbids it; this guards the screen all the same).
 */
export function findByBarcode(code: string, products: Schemas["ProductRead"][]): BarcodeLookup {
  const text = code.trim();
  const matches = text ? products.filter((p) => p.barcode === text) : [];
  if (matches.length === 1) return { kind: "found", product: matches[0] };
  return matches.length === 0 ? { kind: "unknown" } : { kind: "ambiguous", products: matches };
}

export type ScanAction =
  | { kind: "barcode"; barcode: string }
  | { kind: "product"; productId: string }
  | { kind: "none"; reason: string };

/**
 * What pressing Enter in the scan/search box does. A USB barcode scanner "types" the code and
 * presses Enter, so the same box serves both inputs:
 *   1. exact barcode match (or an all-digit code we don't know) -> add by barcode, source=barcode
 *   2. exactly one product matches the search text               -> add it, source=manual
 */
export function resolveScan(input: string, products: Schemas["ProductRead"][]): ScanAction {
  const text = input.trim();
  if (!text) return { kind: "none", reason: "" };
  if (products.some((p) => p.barcode === text) || /^\d{6,}$/.test(text)) return { kind: "barcode", barcode: text };
  const matches = searchProducts(text, products);
  if (matches.length === 1) return { kind: "product", productId: matches[0].id };
  if (matches.length === 0) return { kind: "none", reason: `No product matches “${text}”` };
  return { kind: "none", reason: `${matches.length} products match. Pick one from the list.` };
}

export function searchProducts(query: string, products: Schemas["ProductRead"][]): Schemas["ProductRead"][] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter(
    (p) => p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q || p.barcode === q,
  );
}
