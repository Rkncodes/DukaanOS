import { useState } from "react";
import { PageHeader, QueryState } from "../../app/ui";
import type { Schemas } from "../../lib/api/client";
import { useProducts } from "../../lib/api/queries";
import { useSession } from "../auth/session";
import { CartPanel } from "./CartPanel";
import { ProductPicker } from "./ProductPicker";
import { Receipt } from "./Receipt";
import { useCounter } from "./useCounter";
import { LiveVision } from "./vision/LiveVision";
import { PhotoReview } from "./vision/PhotoReview";

/**
 * Counter billing: pick products (scan, search, photo or live camera) -> cart -> checkout (cash/UPI/card or khata).
 * Stock, payments and khata are all updated by the one backend checkout transaction.
 */
export function CounterPage() {
  const products = useProducts();
  const { data: session } = useSession();
  const counter = useCounter();
  const [receipt, setReceipt] = useState<Schemas["BillRead"] | null>(null);
  const [visionMode, setVisionMode] = useState<"photo" | "live" | null>(null);

  // Both vision entry points end at the same existing cart path.
  const confirmVision = (items: Schemas["ConfirmedItem"][]) =>
    counter.addConfirmed.mutateAsync({ source: "vision", items });

  if (receipt) {
    return (
      <>
        <PageHeader title="Counter" subtitle="Bill complete" />
        <Receipt bill={receipt} storeName={session?.merchant.store_name} onNext={() => setReceipt(null)} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Counter" subtitle="Scan or search to add items, then collect payment or add to khata." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <QueryState isPending={products.isPending} error={products.error} />
          {products.data && visionMode === "live" && (
            <LiveVision
              products={products.data}
              onConfirm={confirmVision}
              onClose={() => setVisionMode(null)}
            />
          )}
          {products.data && visionMode === "photo" && (
            <PhotoReview products={products.data} onConfirm={confirmVision} onClose={() => setVisionMode(null)} />
          )}
          {products.data && visionMode === null && (
            <>
              <div className="mb-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setVisionMode("live")}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Vision counter
                </button>
                <button
                  type="button"
                  onClick={() => setVisionMode("photo")}
                  className="rounded-md border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                >
                  Add from photo
                </button>
              </div>
              <ProductPicker
                products={products.data}
                busy={counter.addItem.isPending}
                onAdd={(item) => counter.addItem.mutateAsync(item)}
              />
            </>
          )}
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <CartPanel counter={counter} products={products.data} onCompleted={setReceipt} />
        </div>
      </div>
    </>
  );
}
