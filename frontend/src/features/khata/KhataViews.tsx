import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, PageHeader, QueryState } from "../../app/ui";
import { api, unwrap, type Schemas } from "../../lib/api/client";
import { useKhataBalances } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";
import { describeBalance } from "./api";

/**
 * Three more ways into the same khata, all read from the backend's balances (computed from the ledger):
 * who has activity, who owes, and taking a payment. Each leads to the customer's own page, where the
 * ledger is shown and entries are recorded.
 */

type Balance = Schemas["KhataBalance"];

/** Customers who owe, largest first: the backend's own filter and order. */
function useOutstanding() {
  return useQuery({
    queryKey: ["khata", "balances", { outstanding: true }],
    queryFn: () => unwrap(api.GET("/api/v1/khata/balances", { params: { query: { outstanding_only: true } } })),
  });
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function BalanceTable({ rows, action }: { rows: Balance[]; action: (row: Balance) => ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-slate-500">
          <tr>
            <th className="py-1 font-normal">Customer</th>
            <th className="py-1 font-normal">Phone</th>
            <th className="py-1 font-normal">Last entry</th>
            <th className="py-1 text-right font-normal">Balance</th>
            <th className="py-1 text-right font-normal">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const { amount, label } = describeBalance(row.balance);
            return (
              <tr key={row.customer_id}>
                <td className="py-2 font-medium text-slate-900">{row.customer_name}</td>
                <td className="py-2 text-slate-500">{row.phone ?? "No phone"}</td>
                <td className="py-2 text-slate-500">
                  {row.last_entry_at ? <time dateTime={row.last_entry_at}>{day(row.last_entry_at)}</time> : "None"}
                </td>
                <td className={`py-2 text-right font-medium ${label === "outstanding" ? "text-red-600" : "text-slate-500"}`}>
                  {formatINR(amount)} {label}
                </td>
                <td className="py-2 text-right">{action(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const rowLink = "font-medium text-emerald-700 hover:underline";

/** Every customer with khata activity, most recent first. Their entries are on their own page. */
export function KhataLedgerPage() {
  const balances = useKhataBalances();
  const active = (balances.data ?? [])
    .filter((b) => b.last_entry_at)
    .sort((a, b) => b.last_entry_at!.localeCompare(a.last_entry_at!));

  return (
    <>
      <PageHeader title="Ledger" subtitle="Customers with khata entries, most recent first. Open one to see every entry." />
      <Card>
        <QueryState isPending={balances.isPending} error={balances.error} />
        {balances.data && active.length === 0 && <p className="py-4 text-center text-sm text-slate-500">No khata entries yet.</p>}
        {active.length > 0 && (
          <BalanceTable
            rows={active}
            action={(row) => (
              <Link to={`/khata/${row.customer_id}`} className={rowLink} aria-label={`Open ${row.customer_name}'s ledger`}>
                Open ledger
              </Link>
            )}
          />
        )}
      </Card>
    </>
  );
}

/** Who owes, and how much in all. */
export function KhataOutstandingPage() {
  const owing = useOutstanding();
  const total = owing.data?.reduce((sum, b) => sum + Number(b.balance), 0);

  return (
    <>
      <PageHeader title="Outstanding" subtitle="Customers who owe you, largest amount first." />
      <div className="mb-4 max-w-xs">
        <Card title="Total outstanding">
          <div className="text-3xl font-semibold text-slate-900">{total === undefined ? "–" : formatINR(total)}</div>
          {owing.data && (
            <div className="mt-1 text-sm text-slate-500">
              from {owing.data.length} {owing.data.length === 1 ? "customer" : "customers"}
            </div>
          )}
        </Card>
      </div>
      <Card>
        <QueryState isPending={owing.isPending} error={owing.error} />
        {owing.data?.length === 0 && <p className="py-4 text-center text-sm text-slate-500">Nobody owes you anything.</p>}
        {owing.data && owing.data.length > 0 && (
          <BalanceTable
            rows={owing.data}
            action={(row) => (
              <Link to={`/khata/${row.customer_id}`} className={rowLink} aria-label={`Open ${row.customer_name}'s ledger`}>
                Open ledger
              </Link>
            )}
          />
        )}
      </Card>
    </>
  );
}

/** Taking money against udhaar: pick the customer, and their page opens ready to record the payment. */
export function KhataPaymentsPage() {
  const owing = useOutstanding();

  return (
    <>
      <PageHeader title="Payments" subtitle="Record money a customer pays back against their udhaar." />
      <Card>
        <QueryState isPending={owing.isPending} error={owing.error} />
        {owing.data?.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">Nobody owes you anything, so there is no payment to take.</p>
        )}
        {owing.data && owing.data.length > 0 && (
          <BalanceTable
            rows={owing.data}
            action={(row) => (
              <Link
                to={`/khata/${row.customer_id}?record=payment`}
                className="inline-block rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
                aria-label={`Record payment from ${row.customer_name}`}
              >
                Record payment
              </Link>
            )}
          />
        )}
      </Card>
      <p role="note" className="mt-3 text-sm text-slate-500">
        Payments already received are listed in each customer's ledger. One list of all payments is not available yet.
      </p>
    </>
  );
}
