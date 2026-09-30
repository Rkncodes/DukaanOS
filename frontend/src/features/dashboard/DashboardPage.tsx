import { Card, PageHeader, QueryState } from "../../app/ui";
import { useCustomers, useKhataBalances, useOrders, useProducts } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";

function Stat({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <Card>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value ?? "–"}</div>
    </Card>
  );
}

export function DashboardPage() {
  const products = useProducts();
  const customers = useCustomers();
  const balances = useKhataBalances();
  const orders = useOrders(8);

  const outstanding = balances.data?.reduce((sum, b) => sum + Math.max(Number(b.balance), 0), 0);
  const lowStock = products.data?.filter((p) => Number(p.stock_quantity) < 10).length;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="One view of your dukaan: Counter, Shop and Khata share the same data." />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Products" value={products.data?.length} />
        <Stat label="Low stock (<10)" value={lowStock} />
        <Stat label="Customers" value={customers.data?.length} />
        <Stat label="Khata outstanding" value={outstanding === undefined ? undefined : formatINR(outstanding)} />
      </div>

      <Card title="Recent bills">
        <QueryState isPending={orders.isPending} error={orders.error} />
        <ul className="divide-y divide-slate-100 text-sm">
          {orders.data?.map((o) => (
            <li key={o.id} className="flex justify-between py-2">
              <span>
                {new Date(o.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                {o.items.length} items · <span className="text-slate-500">{o.payment_status}</span>
              </span>
              <span className="font-medium">{formatINR(o.total)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
