import { useState } from "react";
import { Card } from "../../app/ui";
import { useProducts } from "../../lib/api/queries";
import { useSession } from "../auth/session";
import { QrCode } from "./QrCode";
import { storefrontUrl } from "./storefront";

const STEPS = [
  "Print this page.",
  "Put the code where customers can see it: at your counter, on the door, on a bill.",
  "Customers point their phone camera at it. Your store opens, with nothing to install.",
  "Their order arrives under Orders. You accept it, pack it and collect payment at pickup.",
];

/** The QR code customers scan to open this merchant's storefront. It encodes the real storefront URL. */
export function ShopQrPage() {
  const { data: session } = useSession();
  const products = useProducts();
  const [copied, setCopied] = useState(false);
  if (!session) return null;

  const url = storefrontUrl(session.merchant.store_slug);
  const local = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the link is still shown to copy by hand
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
      {/* The code itself: what gets printed and put on the counter. */}
      <section aria-label="Your store QR" className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-col items-center gap-3 text-center print:p-8">
          <div className="text-xl font-semibold text-slate-900">{session.merchant.store_name}</div>
          <div className="rounded-2xl border-2 border-slate-900 bg-white p-3">
            <QrCode value={url} size={280} label={`QR code for ${url}`} />
          </div>
          <div className="text-base font-semibold text-slate-800">Scan to shop</div>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 print:hidden"
          >
            Print
          </button>
        </div>
      </section>

      <div className="space-y-4 print:hidden">
        <Card title="How to use it">
          <ol className="space-y-2.5 text-sm text-slate-700">
            {STEPS.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-700">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Storefront link">
          <a href={url} target="_blank" rel="noreferrer" className="break-all font-mono text-sm text-emerald-700 underline">
            {url}
          </a>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={copy}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Customers see your {products.data ? products.data.length : "–"} active products with the prices in your
            catalogue. Orders arrive under Orders.
          </p>
          {local && (
            <p role="note" className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              This link points to this computer (localhost), so a phone cannot open it. Open DukaanOS through the
              address your customers can reach, or set VITE_STOREFRONT_ORIGIN, and the QR code will use that address.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
