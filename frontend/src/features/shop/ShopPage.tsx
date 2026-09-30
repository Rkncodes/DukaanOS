import { Card, ComingSoon, PageHeader } from "../../app/ui";
import { useProducts } from "../../lib/api/queries";
import { useSession } from "../auth/session";

export function ShopPage() {
  const { data: session } = useSession();
  const products = useProducts();

  return (
    <>
      <PageHeader title="Shop" subtitle="Your online storefront, reachable by QR code" />
      <ComingSoon>
        Storefront, QR access, customer cart and online orders arrive in the Shop phase. Shop orders use the same
        cart → checkout pipeline as the Counter (channel = shop).
      </ComingSoon>
      <Card title="Storefront">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Store link (planned)</dt>
          <dd className="font-mono">/s/{session?.merchant.store_slug}</dd>
          <dt className="text-slate-500">Products in catalogue</dt>
          <dd>{products.data?.length ?? "–"}</dd>
        </dl>
      </Card>
    </>
  );
}
