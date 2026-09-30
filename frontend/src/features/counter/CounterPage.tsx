import { useState } from "react";
import { PageHeader, QueryState } from "../../app/ui";
import type { Schemas } from "../../lib/api/client";
import { useProducts } from "../../lib/api/queries";
import { useSession } from "../auth/session";
import { CartPanel } from "./CartPanel";
import { ProductPicker } from "./ProductPicker";
import { Receipt } from "./Receipt";
import { useCounter } from "./useCounter";

/**
 * Counter billing: pick products (scan or search) -> cart -> checkout (cash/UPI/card or khata).
 * Stock, payments and khata are all updated by the one backend checkout transaction.
 */
export function CounterPage() {
  const products = useProducts();
  const { data: session } = useSession();
  const counter = useCounter();
  const [receipt, setReceipt] = useState<Schemas["BillRead"] | null>(null);

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
          {products.data && (
            <ProductPicker
              products={products.data}
              busy={counter.addItem.isPending}
              onAdd={(item) => counter.addItem.mutateAsync(item)}
            />
          )}
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
          <CartPanel counter={counter} products={products.data} onCompleted={setReceipt} />
        </div>
      </div>
    </>
  );
}
