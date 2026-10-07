import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "../../app/icons";
import { Card } from "../../app/ui";
import { useProducts } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";
import { useSession } from "../auth/session";
import { storefrontUrl } from "./storefront";

/** How many of the merchant's own products the preview shows. */
const PREVIEW = 6;

/** The merchant's way to their own storefront: the same public page customers reach from the QR code. */
export function ShopStorefrontPage() {
  const { data: session } = useSession();
  const products = useProducts();
  const [copied, setCopied] = useState(false);
  if (!session) return null;

  const url = storefrontUrl(session.merchant.store_slug);
  const listed = products.data ?? [];

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the link is still shown to copy by hand
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <section aria-label="Your storefront" className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-3">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-emerald-50 p-3 text-emerald-700">
            <Icon name="store" className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Your storefront</div>
            <div className="truncate text-xl font-semibold text-slate-900">{session.merchant.store_name}</div>
          </div>
        </div>
        <p className="mt-4 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm text-slate-700">{url}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Open storefront
          </a>
          <button type="button" onClick={copy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">
            {copied ? "Copied" : "Copy link"}
          </button>
          <Link to="/shop/qr" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">
            Get the store QR
          </Link>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          It opens as your customers see it: no login, your catalogue and prices, pay at the store. Orders arrive under{" "}
          <Link to="/shop/orders" className="font-medium text-emerald-700 hover:underline">
            Orders
          </Link>
          .
        </p>
      </section>

      <div className="lg:col-span-2">
        <Card
          title="What customers see"
          action={
            <Link to="/catalogue/products" className="text-sm font-medium text-emerald-700 hover:underline">
              Edit products
            </Link>
          }
        >
          <p className="mb-2 text-sm text-slate-600">
            Your {products.data ? listed.length : "–"} products on sale, with the prices and stock in your catalogue.
          </p>
          <ul className="divide-y divide-slate-100 text-sm">
            {listed.slice(0, PREVIEW).map((p) => (
              <li key={p.id} className="flex justify-between gap-3 py-1.5">
                <span className="truncate text-slate-900">{p.name}</span>
                <span className="whitespace-nowrap tabular-nums text-slate-600">
                  {formatINR(p.price)} / {p.unit}
                </span>
              </li>
            ))}
          </ul>
          {listed.length > PREVIEW && <p className="mt-2 text-xs text-slate-500">and {listed.length - PREVIEW} more</p>}
        </Card>
      </div>
    </div>
  );
}
