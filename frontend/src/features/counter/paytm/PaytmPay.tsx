import { formatINR } from "../../../lib/format";
import type { usePaytm } from "./usePaytm";

type Props = {
  paytm: ReturnType<typeof usePaytm>;
  /** The bill total shown to the cashier; the amount charged is computed by the backend. */
  total: string | null;
  discount: string;
  /** The bill can be paid: it has items and a valid discount, and nothing else is in progress. */
  ready: boolean;
};

const button = "rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";
const primary =
  "w-full rounded-md bg-emerald-600 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300";

/**
 * "Pay with Paytm" for the open bill. Every state shown here is the backend's: a payment is only
 * successful once the backend has verified it with Paytm, at which point the receipt takes over.
 */
export function PaytmPay({ paytm, total, discount, ready }: Props) {
  const { payment, start, verify, cancel, busy } = paytm;
  const amount = payment && paytm.live ? formatINR(payment.amount) : total ? formatINR(total) : "";
  const error = paytm.error?.message ?? paytm.checkoutError;

  return (
    <div className="space-y-2">
      {paytm.environment === "sandbox" && (
        <p className="text-xs text-slate-500">Paytm sandbox: test payments only, no real money.</p>
      )}

      {payment?.status === "pending" && (
        <>
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {verify.isPending
              ? "Checking with Paytm…"
              : cancel.isPending
                ? "Cancelling…"
                : `Payment pending: waiting for ${amount} in Paytm. The bill is not paid yet.`}
            {payment.result_msg && !busy && <span className="mt-1 block text-xs">Paytm: {payment.result_msg}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => verify.mutate(payment.id)}>
              Check payment status
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => start.mutate(payment.discount)}>
              Continue in Paytm
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => cancel.mutate(payment.id)}>
              Cancel payment
            </button>
          </div>
        </>
      )}

      {payment?.status === "needs_review" && (
        <>
          <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {payment.detail ?? "Paytm received a payment for this bill, but the bill was not completed."}
            {payment.txn_id && <span className="mt-1 block text-xs">Paytm reference: {payment.txn_id}</span>}
          </div>
          <button type="button" className={button} disabled={busy} onClick={() => verify.mutate(payment.id)}>
            {verify.isPending ? "Checking with Paytm…" : "Check again and complete the bill"}
          </button>
        </>
      )}

      {payment?.status === "failed" && (
        <p role="alert" className="text-sm text-red-600">
          Paytm payment failed{payment.result_msg ? `: ${payment.result_msg}` : "."} The bill is not paid.
        </p>
      )}
      {payment?.status === "cancelled" && (
        <p role="status" className="text-sm text-slate-600">
          Paytm payment cancelled. The bill is not paid.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {!paytm.live && payment?.status !== "paid" && (
        <button type="button" disabled={!ready || busy} onClick={() => start.mutate(discount)} className={primary}>
          {start.isPending ? "Starting Paytm…" : `Pay ${amount} with Paytm`}
        </button>
      )}
    </div>
  );
}
