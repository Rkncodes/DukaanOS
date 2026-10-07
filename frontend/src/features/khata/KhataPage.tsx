import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Card, PageHeader, QueryState, Stat } from "../../app/ui";
import { useKhataBalances } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";
import { describeBalance, useCreateCustomer } from "./api";

const input = "rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";

/** Every customer of this merchant with what they owe, computed by the backend from the khata ledger. */
export function KhataPage() {
  const balances = useKhataBalances();
  const [query, setQuery] = useState("");

  const all = balances.data ?? [];
  const owing = all.filter((b) => Number(b.balance) > 0);
  const totalOutstanding = owing.reduce((sum, b) => sum + Number(b.balance), 0);
  const q = query.trim().toLowerCase();
  const shown = all.filter((b) => !q || b.customer_name.toLowerCase().includes(q) || b.phone?.includes(q));

  return (
    <>
      <PageHeader title="Khata" subtitle="Keep track of customer credit and payments." />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Total outstanding"
          icon="wallet"
          tone={totalOutstanding > 0 ? "red" : "slate"}
          value={balances.data ? formatINR(totalOutstanding) : "–"}
          hint={balances.data && `${owing.length} of ${all.length} customers owe you`}
        />
        <Stat
          label="Customers owing"
          icon="users"
          value={balances.data ? owing.length : "–"}
          hint={balances.data && (owing.length > 0 ? `largest: ${owing[0].customer_name}` : "everyone is settled")}
        />
        <div className="col-span-2">
          <AddCustomer />
        </div>
      </div>

      <Card
        title="Customers"
        action={
          <input
            type="search"
            aria-label="Search customers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or phone"
            className={`w-56 max-w-full ${input}`}
          />
        }
      >
        <QueryState isPending={balances.isPending} error={balances.error} />
        {balances.data && all.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">No customers yet. Add one to start their khata.</p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">No customer matches “{query.trim()}”.</p>
        )}
        {shown.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Customer</th>
                  <th className="py-1.5 font-medium">Phone</th>
                  <th className="py-1.5 font-medium">Last entry</th>
                  <th className="py-1.5 text-right font-medium">Outstanding</th>
                  <th className="py-1.5 text-right font-medium">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((b) => {
                  const { amount, label } = describeBalance(b.balance);
                  return (
                    <tr key={b.customer_id} className="hover:bg-slate-50">
                      <td className="py-2.5">
                        <Link to={`/khata/${b.customer_id}`} className="font-medium text-slate-900 hover:text-emerald-700 hover:underline">
                          {b.customer_name}
                        </Link>
                      </td>
                      <td className="py-2.5 text-slate-500">{b.phone ?? "No phone"}</td>
                      <td className="py-2.5 text-slate-500">
                        {b.last_entry_at ? (
                          <time dateTime={b.last_entry_at}>
                            {new Date(b.last_entry_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                          </time>
                        ) : (
                          "None"
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <span className={`tabular-nums ${label === "outstanding" ? "text-base font-semibold text-red-600" : "text-slate-500"}`}>
                          {formatINR(amount)}
                        </span>{" "}
                        <span className="text-xs text-slate-500">{label}</span>
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        {label === "outstanding" ? (
                          <Link
                            to={`/khata/${b.customer_id}?record=payment`}
                            aria-label={`Record payment from ${b.customer_name}`}
                            className="whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            Take payment
                          </Link>
                        ) : (
                          <Link
                            to={`/khata/${b.customer_id}?record=credit`}
                            aria-label={`Record credit for ${b.customer_name}`}
                            className="whitespace-nowrap rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Give credit
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function AddCustomer() {
  const create = useCreateCustomer();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      { name: name.trim(), phone: phone.trim() || null },
      { onSuccess: (customer) => navigate(`/khata/${customer.id}`) },
    );
  }

  return (
    <Card title="Add customer">
      <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2">
        <input
          aria-label="Customer name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          required
          maxLength={120}
          className={`min-w-40 flex-1 ${input}`}
        />
        <input
          aria-label="Customer phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (optional)"
          inputMode="tel"
          maxLength={20}
          className={`min-w-40 flex-1 ${input}`}
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Add customer
        </button>
      </form>
      {create.error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {create.error.message}
        </p>
      )}
    </Card>
  );
}
