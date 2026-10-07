import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../lib/api/client";

/** One customer's ledger: who they are, what they owe, and every entry (newest first) with its running balance. */
export function useLedger(customerId: string) {
  return useQuery({
    queryKey: ["khata", "ledger", customerId],
    queryFn: () => unwrap(api.GET("/api/v1/customers/{customer_id}/khata", { params: { path: { customer_id: customerId } } })),
  });
}

export type NewEntry =
  | ({ type: "credit" } & Pick<Schemas["KhataCreditCreate"], "amount" | "description">)
  | ({ type: "payment" } & Pick<Schemas["KhataPaymentCreate"], "amount" | "description" | "method">);

/** Records udhaar given or a payment received. The backend validates it and owns the resulting balance. */
export function useRecordEntry(customerId: string) {
  const qc = useQueryClient();
  const params = { path: { customer_id: customerId } };
  return useMutation({
    mutationFn: ({ type, ...body }: NewEntry) =>
      type === "credit"
        ? unwrap(api.POST("/api/v1/customers/{customer_id}/khata/credits", { params, body }))
        : unwrap(api.POST("/api/v1/customers/{customer_id}/khata/payments", { params, body })),
    // Balances are computed from the ledger: re-read them everywhere they show (Khata, Counter, Dashboard).
    onSuccess: () => qc.invalidateQueries({ queryKey: ["khata"] }),
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["CustomerCreate"]) => unwrap(api.POST("/api/v1/customers", { body })),
    onSuccess: () => {
      for (const key of [["customers"], ["khata"]]) qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** A balance is what the customer owes; below zero they have paid ahead. */
export function describeBalance(balance: string): { amount: number; label: "outstanding" | "advance" | "settled" } {
  const value = Number(balance);
  if (value > 0) return { amount: value, label: "outstanding" };
  if (value < 0) return { amount: -value, label: "advance" };
  return { amount: 0, label: "settled" };
}
