import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, unwrap, type Schemas } from "../../../lib/api/client";
import { openPaytmCheckout } from "./checkout";

export type PaytmPayment = Schemas["PaytmPaymentRead"];

const verifyPayment = (id: string) =>
  unwrap(api.POST("/api/v1/payments/paytm/{payment_id}/verify", { params: { path: { payment_id: id } } }));
const cancelPayment = (id: string) =>
  unwrap(api.POST("/api/v1/payments/paytm/{payment_id}/cancel", { params: { path: { payment_id: id } } }));

/** The backend's verdict, with the completed bill when (and only when) the payment is verified. */
async function settle(result: PaytmPayment) {
  const bill =
    result.status === "paid" && result.order_id
      ? await unwrap(api.GET("/api/v1/orders/{order_id}/bill", { params: { path: { order_id: result.order_id } } }))
      : null;
  return { result, bill };
}

/**
 * Paytm payment of the open Counter bill. The backend is the authority throughout: it computes the
 * amount, and a payment only becomes "paid" in an answer from POST .../verify (or .../cancel), which
 * the backend gives after asking Paytm. Nothing here marks a bill paid.
 */
export function usePaytm(cartId: string | null, onPaid: (bill: Schemas["BillRead"]) => void) {
  const [payment, setPayment] = useState<PaytmPayment | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const config = useQuery({
    queryKey: ["paytm", "config"],
    queryFn: () => unwrap(api.GET("/api/v1/payments/paytm/config")),
    staleTime: Infinity,
  });
  const enabled = config.data?.enabled === true;

  // After a page refresh the payment that was in progress for this bill is picked up again.
  const current = useQuery({
    queryKey: ["paytm", "current", cartId],
    enabled: enabled && cartId !== null,
    queryFn: async () =>
      (await unwrap(api.GET("/api/v1/payments/paytm/current", { params: { query: { cart_id: cartId! } } }))) ?? null,
  });
  useEffect(() => setPayment(null), [cartId]);
  useEffect(() => {
    if (current.data) setPayment(current.data);
  }, [current.data]);

  const onSettled = ({ result, bill }: Awaited<ReturnType<typeof settle>>) => {
    setPayment(result);
    if (bill) onPaid(bill);
  };
  const verify = useMutation({ mutationFn: async (id: string) => settle(await verifyPayment(id)), onSuccess: onSettled });
  const cancel = useMutation({ mutationFn: async (id: string) => settle(await cancelPayment(id)), onSuccess: onSettled });

  /** Starts the payment, or continues the one in progress, and shows Paytm's payment page. */
  const start = useMutation({
    mutationFn: (discount: string) => unwrap(api.POST("/api/v1/payments/paytm", { body: { cart_id: cartId!, discount } })),
    onSuccess: ({ payment: started, checkout }) => {
      setPayment(started);
      setCheckoutError(null);
      verify.reset();
      cancel.reset();
      openPaytmCheckout(checkout, {
        onResult: () => verify.mutate(started.id),
        onError: setCheckoutError,
      }).catch((e: Error) => setCheckoutError(e.message));
    },
  });

  return {
    enabled,
    environment: config.data?.environment ?? null,
    payment,
    /** A payment is in flight, or Paytm holds money for this bill: the bill must not change. */
    live: payment?.status === "pending" || payment?.status === "needs_review",
    busy: start.isPending || verify.isPending || cancel.isPending,
    error: start.error ?? verify.error ?? cancel.error ?? null,
    checkoutError,
    start,
    verify,
    cancel,
  };
}
