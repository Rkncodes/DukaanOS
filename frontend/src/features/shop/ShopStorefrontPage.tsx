import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "../../app/icons";
import { Card } from "../../app/ui";
import { useTranslation } from "../../i18n";
import { useProducts } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";
import { useSession } from "../auth/session";
import { storefrontUrl } from "./storefront";

/** How many of the merchant's own products the preview shows. */
const PREVIEW = 6;

/** The merchant's way to their own storefront: the same public page customers reach from the QR code. */
export function ShopStorefrontPage() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const products = useProducts();
  const [copied, setCopied] = useState(false);
  if (!session) return null;

  const url = storefrontUrl(session.merchant.store_slug);
  const listed = products.data ?? [];
  // The sentence names the Orders page, which is a link in the middle of it.
  const [ordersBefore, ordersAfter] = t("storefront.opensAs").split("{{orders}}");

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
      <section aria-label={t("storefront.yours")} className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-3">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-emerald-50 p-3 text-emerald-700">
            <Icon name="store" className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{t("storefront.yours")}</div>
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
            {t("storefront.open")}
          </a>
          <button type="button" onClick={copy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">
            {copied ? t("qr.copied") : t("qr.copy")}
          </button>
          <Link to="/shop/qr" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">
            {t("storefront.getQr")}
          </Link>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          {ordersBefore}
          <Link to="/shop/orders" className="font-medium text-emerald-700 hover:underline">
            {t("nav.orders")}
          </Link>
          {ordersAfter}
        </p>
      </section>

      <div className="lg:col-span-2">
        <Card
          title={t("storefront.whatCustomersSee")}
          action={
            <Link to="/catalogue/products" className="text-sm font-medium text-emerald-700 hover:underline">
              {t("storefront.editProducts")}
            </Link>
          }
        >
          <p className="mb-2 text-sm text-slate-600">
            {t("storefront.onSale", { count: products.data ? listed.length : "–" })}
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
          {listed.length > PREVIEW && <p className="mt-2 text-xs text-slate-500">{t("storefront.more", { count: listed.length - PREVIEW })}</p>}
        </Card>
      </div>
    </div>
  );
}
