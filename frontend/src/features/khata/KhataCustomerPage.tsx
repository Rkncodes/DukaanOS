import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Card, QueryState } from "../../app/ui";
import { ApiError, type Schemas } from "../../lib/api/client";
import { formatINR } from "../../lib/format";
import { describeBalance, useLedger, useRecordEntry } from "./api";

type EntryType = Schemas["KhataEntryType"];
type Method = Schemas["PaymentMethod"];

const TYPE_LABEL: Record<EntryType, string> = { credit: "Credit", payment: "Payment" };
// Paytm is not offered here: it is only ever recorded after Paytm's own verification.
const PAID_BY: { value: Method; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
];

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";
const primary = "rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const secondary = "rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

/** One customer's khata: what they owe, the ledger behind that number, and recording udhaar or a payment. */
export function KhataCustomerPage() {
  const { customerId = "" } = useParams();
  const ledger = useLedger(customerId);
  // ?record=payment (or credit) arrives with that form already open, e.g. from Khata > Payments.
  const [search] = useSearchParams();
  const [recording, setRecording] = useState<EntryType | null>(() => {
    const asked = search.get("record");
    return asked === "payment" || asked === "credit" ? asked : null;
  });

  const back = (
    <Link to="/khata" className="text-sm text-emerald-700 hover:underline">
      ← All customers
    </Link>
  );

  if (!ledger.data) {
    const notFound = ledger.error instanceof ApiError && (ledger.error.status === 404 || ledger.error.status === 422);
    return (
      <>
        <div className="mb-4">{back}</div>
        {notFound ? (
          <p role="alert" className="text-sm text-red-600">
            This customer was not found in your khata.
          </p>
        ) : (
          <QueryState isPending={ledger.isPending} error={ledger.error} />
        )}
      </>
    );
  }

  const { customer, balance, entries } = ledger.data;
  const { amount, label } = describeBalance(balance);

  return (
    <>
      <div className="mb-4">{back}</div>
      <header className="mb-5 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-lg font-semibold text-emerald-700"
        >
          {customer.name.trim().charAt(0).toUpperCase()}
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{customer.name}</h1>
          <p className="text-sm text-slate-500">{customer.phone ?? "No phone"}</p>
        </div>
      </header>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title={label === "advance" ? "Advance" : "Outstanding"}>
          <div
            aria-label="Balance"
            className={`text-3xl font-semibold tabular-nums ${label === "outstanding" ? "text-red-600" : "text-slate-900"}`}
          >
            {formatINR(amount)}
          </div>
          <div className="mt-1 text-sm text-slate-500">
            {label === "outstanding" && "owed to you"}
            {label === "advance" && "paid ahead by the customer"}
            {label === "settled" && "nothing owed"}
          </div>
        </Card>

        <div className="lg:col-span-2">
          <Card>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={recording === "credit" ? primary : secondary} onClick={() => setRecording("credit")}>
                Record credit
              </button>
              <button type="button" className={recording === "payment" ? primary : secondary} onClick={() => setRecording("payment")}>
                Record payment
              </button>
            </div>
            {recording && (
              <EntryForm
                key={recording}
                customerId={customer.id}
                type={recording}
                balance={Number(balance)}
                onDone={() => setRecording(null)}
              />
            )}
          </Card>
        </div>
      </div>

      <Card title="Ledger">
        {entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">No entries yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-normal">Date</th>
                <th className="py-1 font-normal">Entry</th>
                <th className="py-1 font-normal">Note</th>
                <th className="py-1 text-right font-normal">Amount</th>
                <th className="py-1 text-right font-normal">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-2 text-slate-500">
                    <time dateTime={entry.created_at}>
                      {new Date(entry.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                    </time>
                  </td>
                  <td className={`py-2 font-medium ${entry.type === "credit" ? "text-red-600" : "text-emerald-700"}`}>
                    {TYPE_LABEL[entry.type]}
                  </td>
                  <td className="py-2 text-slate-500">{entry.description}</td>
                  <td className="py-2 text-right">{formatINR(entry.amount)}</td>
                  <td className="py-2 text-right text-slate-500">{formatINR(entry.balance_after)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-semibold text-slate-900">
                <td className="py-2" colSpan={4}>
                  {label === "advance" ? "Advance" : "Outstanding"}
                </td>
                <td className="py-2 text-right">{formatINR(amount)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>
    </>
  );
}

function EntryForm({
  customerId,
  type,
  balance,
  onDone,
}: {
  customerId: string;
  type: EntryType;
  balance: number;
  onDone: () => void;
}) {
  const record = useRecordEntry(customerId);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<Method>("cash");

  // The backend allows paying more than is owed and keeps the rest as advance: say so before it is saved.
  const extra = type === "payment" ? Number(amount) - Math.max(balance, 0) : 0;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const description = note.trim() || null;
    record.mutate(type === "credit" ? { type, amount, description } : { type, amount, description, method }, {
      onSuccess: onDone,
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label={type === "credit" ? "Record credit" : "Record payment"} className="mt-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-slate-600">
          {type === "credit" ? "Amount given on udhaar (₹)" : "Amount received (₹)"}
          <input
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`mt-1 ${input}`}
          />
        </label>
        {type === "payment" && (
          <label className="text-sm text-slate-600">
            Paid by
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)} className={`mt-1 ${input}`}>
              {PAID_BY.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm text-slate-600 sm:col-span-2">
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} className={`mt-1 ${input}`} />
        </label>
      </div>

      {extra > 0 && (
        <p role="note" className="text-sm text-amber-700">
          This is {formatINR(extra)} more than is owed. The extra will be kept as the customer's advance.
        </p>
      )}
      {record.error && (
        <p role="alert" className="text-sm text-red-600">
          {record.error.message}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={record.isPending}>
          {record.isPending ? "Saving…" : type === "credit" ? "Save credit" : "Save payment"}
        </button>
        <button type="button" className={secondary} disabled={record.isPending} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
