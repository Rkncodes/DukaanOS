import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, unwrap, type Schemas } from "../../lib/api/client";
import { useCustomers, useKhataBalances } from "../../lib/api/queries";
import { formatINR } from "../../lib/format";

type Props = {
  customerId: string | null;
  onChange: (customerId: string | null) => void;
  disabled: boolean;
};

/** Attach a customer to the bill: required for khata, optional (but linked) for paid sales. */
export function CustomerPicker({ customerId, onChange, disabled }: Props) {
  const customers = useCustomers();
  const balances = useKhataBalances();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const create = useMutation({
    mutationFn: (body: Schemas["CustomerCreate"]) => unwrap(api.POST("/api/v1/customers", { body })),
    onSuccess: (customer) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["khata"] });
      onChange(customer.id);
      setQuery("");
      setOpen(false);
    },
  });

  const balanceOf = (id: string) => balances.data?.find((b) => b.customer_id === id)?.balance;
  const selected = customers.data?.find((c) => c.id === customerId);

  if (selected) {
    const balance = balanceOf(selected.id);
    return (
      <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
        <div>
          <div className="font-medium text-slate-900">{selected.name}</div>
          <div className="text-slate-500">
            {selected.phone ?? "No phone"}
            {balance !== undefined && Number(balance) !== 0 && (
              <span className={Number(balance) > 0 ? "text-red-600" : ""}> · Khata {formatINR(balance)}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="text-slate-500 hover:text-slate-800 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (customers.data ?? [])
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone?.includes(q))
    .slice(0, 6);
  const looksLikePhone = /^\d{10}$/.test(query.trim());

  return (
    <div className="relative">
      <input
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Customer name or phone (optional)"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
      />
      {open && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white text-sm shadow-lg">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(c.id);
                  setQuery("");
                  setOpen(false);
                }}
                className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50"
              >
                <span>
                  {c.name} <span className="text-slate-400">{c.phone}</span>
                </span>
                {Number(balanceOf(c.id) ?? 0) > 0 && (
                  <span className="text-red-600">{formatINR(balanceOf(c.id)!)}</span>
                )}
              </button>
            </li>
          ))}
          {q && (
            <li>
              <button
                type="button"
                disabled={create.isPending}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  create.mutate(looksLikePhone ? { name: query.trim(), phone: query.trim() } : { name: query.trim() })
                }
                className="w-full border-t border-slate-100 px-3 py-2 text-left font-medium text-emerald-700 hover:bg-emerald-50"
              >
                + Add “{query.trim()}” as new customer
              </button>
            </li>
          )}
        </ul>
      )}
      {create.error && <p className="mt-1 text-sm text-red-600">{create.error.message}</p>}
    </div>
  );
}
