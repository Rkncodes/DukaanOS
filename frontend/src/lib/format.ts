const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

/** Money arrives from the API as a decimal string ("1663.00"). */
export function formatINR(amount: string | number): string {
  return inr.format(Number(amount));
}

export function formatQuantity(quantity: string): string {
  return String(Number(quantity));
}

/** The short number an order or bill is called by, for merchant and customer alike. */
export function orderNumber(orderId: string): string {
  return `#${orderId.slice(0, 8).toUpperCase()}`;
}
