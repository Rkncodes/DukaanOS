import { Card, ComingSoon, PageHeader, QueryState } from "../../app/ui";
import { useProducts } from "../../lib/api/queries";
import { formatINR, formatQuantity } from "../../lib/format";

export function CounterPage() {
  const products = useProducts();

  return (
    <>
      <PageHeader title="Counter" subtitle="Smart billing at the shop counter" />
      <ComingSoon>
        Billing UI arrives in the Counter phase: manual, barcode, camera, voice and parchi inputs, all adding to the
        same cart via <code>/api/v1/carts</code>.
      </ComingSoon>
      <Card title="Products">
        <QueryState isPending={products.isPending} error={products.error} />
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-normal">Name</th>
              <th className="py-1 font-normal">Barcode</th>
              <th className="py-1 text-right font-normal">Price</th>
              <th className="py-1 text-right font-normal">Stock</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {products.data?.map((p) => (
              <tr key={p.id}>
                <td className="py-1.5">{p.name}</td>
                <td className="py-1.5 font-mono text-xs text-slate-500">{p.barcode}</td>
                <td className="py-1.5 text-right">{formatINR(p.price)}</td>
                <td className="py-1.5 text-right">
                  {formatQuantity(p.stock_quantity)} {p.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
