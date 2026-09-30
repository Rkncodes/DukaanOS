import { Card, ComingSoon, PageHeader, QueryState } from "../../app/ui";
import { useKhataBalances } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";

export function KhataPage() {
  const balances = useKhataBalances();

  return (
    <>
      <PageHeader title="Khata" subtitle="Customer udhaar ledger" />
      <ComingSoon>
        Ledger details, recording udhaar/payments and reminders arrive in the Khata phase.
      </ComingSoon>
      <Card title="Balances">
        <QueryState isPending={balances.isPending} error={balances.error} />
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-normal">Customer</th>
              <th className="py-1 font-normal">Phone</th>
              <th className="py-1 text-right font-normal">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {balances.data?.map((b) => (
              <tr key={b.customer_id}>
                <td className="py-1.5">{b.customer_name}</td>
                <td className="py-1.5 text-slate-500">{b.phone}</td>
                <td className={`py-1.5 text-right font-medium ${Number(b.balance) > 0 ? "text-red-600" : "text-slate-500"}`}>
                  {formatINR(b.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
