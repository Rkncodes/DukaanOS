import { useTranslation } from "../../../i18n";
import { formatINR } from "../../../lib/format";
import { CHECKOUT_UNAVAILABLE } from "./checkout";
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
  const { t, problem } = useTranslation();
  const { payment, start, verify, cancel, busy } = paytm;
  const amount = payment && paytm.live ? formatINR(payment.amount) : total ? formatINR(total) : "";
  // Paytm's and the backend's own words (result_msg, detail) are shown as they came.
  const error = paytm.error
    ? problem(paytm.error)
    : paytm.checkoutError === CHECKOUT_UNAVAILABLE
      ? t("paytm.checkoutUnavailable")
      : paytm.checkoutError;

  return (
    <div className="space-y-2">
      {paytm.environment === "sandbox" && <p className="text-xs text-slate-500">{t("paytm.sandbox")}</p>}

      {payment?.status === "pending" && (
        <>
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {verify.isPending ? t("paytm.checking") : cancel.isPending ? t("paytm.cancelling") : t("paytm.pending", { amount })}
            {payment.result_msg && !busy && <span className="mt-1 block text-xs">Paytm: {payment.result_msg}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => verify.mutate(payment.id)}>
              {t("paytm.checkStatus")}
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => start.mutate(payment.discount)}>
              {t("paytm.continue")}
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => cancel.mutate(payment.id)}>
              {t("paytm.cancelPayment")}
            </button>
          </div>
        </>
      )}

      {payment?.status === "needs_review" && (
        <>
          <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {payment.detail ?? t("paytm.needsReview")}
            {payment.txn_id && <span className="mt-1 block text-xs">{t("paytm.reference", { reference: payment.txn_id })}</span>}
          </div>
          <button type="button" className={button} disabled={busy} onClick={() => verify.mutate(payment.id)}>
            {verify.isPending ? t("paytm.checking") : t("paytm.checkAgain")}
          </button>
        </>
      )}

      {payment?.status === "failed" && (
        <p role="alert" className="text-sm text-red-600">
          {payment.result_msg ? t("paytm.failedBecause", { reason: payment.result_msg }) : t("paytm.failed")}
        </p>
      )}
      {payment?.status === "cancelled" && (
        <p role="status" className="text-sm text-slate-600">
          {t("paytm.cancelled")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {!paytm.live && payment?.status !== "paid" && (
        <button type="button" disabled={!ready || busy} onClick={() => start.mutate(discount)} className={primary}>
          {start.isPending ? t("paytm.starting") : t("paytm.pay", { amount })}
        </button>
      )}
    </div>
  );
}
