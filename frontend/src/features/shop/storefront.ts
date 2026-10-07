/**
 * The public address of a merchant's storefront: what the QR code encodes and what a customer opens.
 * It is this app's own /store/:slug route. Set VITE_STOREFRONT_ORIGIN when customers reach the app
 * at a different address than the merchant's browser shows (e.g. the shop's LAN address or the
 * deployed domain: a phone cannot open "localhost").
 */
export function storefrontUrl(slug: string, origin?: string): string {
  const base = origin ?? (import.meta.env.VITE_STOREFRONT_ORIGIN || window.location.origin);
  return `${base.replace(/\/+$/, "")}/store/${encodeURIComponent(slug)}`;
}
