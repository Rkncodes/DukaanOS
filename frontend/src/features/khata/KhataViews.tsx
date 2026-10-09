import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Card, PageHeader, QueryState } from "../../app/ui";
import { useTranslation } from "../../i18n";
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

function BalanceTable({ rows, action }: { rows: Balance[]; action: (row: Balance) => ReactNode }) {
  const { t, dateLocale } = useTranslation();
  const day = (iso: string) => new Date(iso).toLocaleDateString(dateLocale, { day: "2-digit", month: "short", year: "numeric" });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-slate-500">
          <tr>
            <th className="py-1 font-normal">{t("cart.customer")}</th>
            <th className="py-1 font-normal">{t("khata.col.phone")}</th>
            <th className="py-1 font-normal">{t("khata.col.lastEntry")}</th>
            <th className="py-1 text-right font-normal">{t("khata.col.balance")}</th>
            <th className="py-1 text-right font-normal">
              <span className="sr-only">{t("khata.col.action")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const { amount, label } = describeBalance(row.balance);
            return (
              <tr key={row.customer_id}>
                <td className="py-2 font-medium text-slate-900">{row.customer_name}</td>
                <td className="py-2 text-slate-500">{row.phone ?? t("customer.noPhone")}</td>
                <td className="py-2 text-slate-500">
                  {row.last_entry_at ? <time dateTime={row.last_entry_at}>{day(row.last_entry_at)}</time> : t("khata.none")}
                </td>
                <td className={`py-2 text-right font-medium ${label === "outstanding" ? "text-red-600" : "text-slate-500"}`}>
                  {formatINR(amount)} {t(`khata.balance.${label}` as const)}
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
  const { t } = useTranslation();
  const balances = useKhataBalances();
  const active = (balances.data ?? [])
    .filter((b) => b.last_entry_at)
    .sort((a, b) => b.last_entry_at!.localeCompare(a.last_entry_at!));

  return (
    <>
      <PageHeader title={t("nav.ledger")} subtitle={t("khata.ledgerSubtitle")} />
      <Card>
        <QueryState isPending={balances.isPending} error={balances.error} />
        {balances.data && active.length === 0 && <p className="py-4 text-center text-sm text-slate-500">{t("khata.noLedgerEntries")}</p>}
        {active.length > 0 && (
          <BalanceTable
            rows={active}
            action={(row) => (
              <Link to={`/khata/${row.customer_id}`} className={rowLink} aria-label={t("khata.openLedgerOf", { name: row.customer_name })}>
                {t("khata.openLedger")}
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
  const { t } = useTranslation();
  const owing = useOutstanding();
  const total = owing.data?.reduce((sum, b) => sum + Number(b.balance), 0);

  return (
    <>
      <PageHeader title={t("nav.outstanding")} subtitle={t("khata.outstandingSubtitle")} />
      <div className="mb-4 max-w-xs">
        <Card title={t("khata.totalOutstanding")}>
          <div className="text-3xl font-semibold text-slate-900">{total === undefined ? "–" : formatINR(total)}</div>
          {owing.data && (
            <div className="mt-1 text-sm text-slate-500">
              {t(owing.data.length === 1 ? "khata.fromCustomers.one" : "khata.fromCustomers.other", { count: owing.data.length })}
            </div>
          )}
        </Card>
      </div>
      <Card>
        <QueryState isPending={owing.isPending} error={owing.error} />
        {owing.data?.length === 0 && <p className="py-4 text-center text-sm text-slate-500">{t("khata.nobodyOwes")}</p>}
        {owing.data && owing.data.length > 0 && (
          <BalanceTable
            rows={owing.data}
            action={(row) => (
              <Link to={`/khata/${row.customer_id}`} className={rowLink} aria-label={t("khata.openLedgerOf", { name: row.customer_name })}>
                {t("khata.openLedger")}
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
  const { t } = useTranslation();
  const owing = useOutstanding();

  return (
    <>
      <PageHeader title={t("nav.payments")} subtitle={t("khata.paymentsSubtitle")} />
      <Card>
        <QueryState isPending={owing.isPending} error={owing.error} />
        {owing.data?.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">{t("khata.nobodyOwesPayment")}</p>
        )}
        {owing.data && owing.data.length > 0 && (
          <BalanceTable
            rows={owing.data}
            action={(row) => (
              <Link
                to={`/khata/${row.customer_id}?record=payment`}
                className="inline-block rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
                aria-label={t("khata.recordPaymentFrom", { name: row.customer_name })}
              >
                {t("khata.recordPayment")}
              </Link>
            )}
          />
        )}
      </Card>
      <p role="note" className="mt-3 text-sm text-slate-500">
        {t("khata.paymentsNote")}
      </p>
    </>
  );
}
