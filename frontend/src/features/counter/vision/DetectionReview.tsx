import { useMutation } from "@tanstack/react-query";
import { useState, type Dispatch, type SetStateAction } from "react";
import type { Schemas } from "../../../lib/api/client";
import { formatINR } from "../../../lib/format";
import { searchProducts } from "../bill";
import { confirmPlan, isValidQuantity, type Product, type ReviewRow } from "./review";

type Props = {
  rows: ReviewRow[];
  setRows: Dispatch<SetStateAction<ReviewRow[]>>;
  products: Product[];
  emptyText: string;
  /** Adds the confirmed items to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onConfirmed: () => void;
};

/**
 * The merchant's confirmation step, shared by "Add from photo" and the live Vision Counter:
 * edit quantity, remove, pick a candidate or search the catalog, then "Add N to bill".
 * Undecided or unmatched detections are never added.
 */
export function DetectionReview({ rows, setRows, products, emptyText, onConfirm, onConfirmed }: Props) {
  const confirm = useMutation({ mutationFn: onConfirm, onSuccess: onConfirmed });
  const update = (id: string, patch: Partial<ReviewRow>) =>
    setRows((current) => current.map((r) => (r.detection.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((current) => current.filter((r) => r.detection.id !== id));
  const plan = confirmPlan(rows);

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-slate-500">Detected products</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{emptyText}</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <DetectionRow
              key={row.detection.id}
              index={i + 1}
              row={row}
              products={products}
              onChange={(patch) => update(row.detection.id, patch)}
              onRemove={() => remove(row.detection.id)}
            />
          ))}
        </ol>
      )}

      {confirm.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {confirm.error.message}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {plan.skipped > 0 && `${plan.skipped} not matched or not chosen: will not be added.`}
        </span>
        <button
          type="button"
          disabled={plan.items.length === 0 || plan.invalid || confirm.isPending}
          onClick={() => confirm.mutate(plan.items)}
          className="shrink-0 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {confirm.isPending ? "Adding…" : `Add ${plan.items.length} to bill`}
        </button>
      </div>
    </div>
  );
}

function DetectionRow({
  index,
  row,
  products,
  onChange,
  onRemove,
}: {
  index: number;
  row: ReviewRow;
  products: Product[];
  onChange: (patch: Partial<ReviewRow>) => void;
  onRemove: () => void;
}) {
  const { detection, product, quantity } = row;
  const label = detection.label ?? detection.barcode ?? "Unknown item";
  const confidence = detection.confidence === null ? null : Math.round(detection.confidence * 100);
  const decided = product !== null;
  const wasChoice = detection.match !== "matched";

  return (
    <li className="py-3" aria-label={`Detection ${index}: ${label}`}>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-0.5 w-5 text-center font-bold ${decided ? "text-emerald-600" : "text-amber-600"}`}
        >
          {decided ? "✓" : "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-500">
            #{index} seen as “{label}”{confidence !== null && ` · ${confidence}% sure`}
          </div>
          {decided ? (
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-slate-900">{product.name}</span>
              <span className="text-sm text-slate-600">{formatINR(product.price)}</span>
            </div>
          ) : (
            <Resolve row={row} products={products} onPick={(p) => onChange({ product: p })} />
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-7">
        {decided && (
          <>
            <label className="text-xs text-slate-500" htmlFor={`qty-${detection.id}`}>
              Qty
            </label>
            <input
              id={`qty-${detection.id}`}
              inputMode="decimal"
              value={quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              aria-invalid={!isValidQuantity(quantity)}
              className={`h-7 w-16 rounded border px-2 text-center text-sm ${
                isValidQuantity(quantity) ? "border-slate-300" : "border-red-400"
              }`}
            />
            {wasChoice && (
              <button
                type="button"
                onClick={() => onChange({ product: null })}
                className="text-xs text-slate-500 hover:text-slate-800"
              >
                Change
              </button>
            )}
          </>
        )}
        <button type="button" onClick={onRemove} className="ml-auto text-xs text-slate-400 hover:text-red-600">
          Remove
        </button>
      </div>
    </li>
  );
}

/** Undecided detection: pick a candidate, or search the catalog for an unmatched one. */
function Resolve({ row, products, onPick }: { row: ReviewRow; products: Product[]; onPick: (p: Product) => void }) {
  const { detection } = row;
  const [query, setQuery] = useState("");
  const results = query.trim() ? searchProducts(query, products).slice(0, 5) : [];

  const prompt =
    detection.match === "low_confidence"
      ? "Not sure. Is it this?"
      : detection.match === "ambiguous"
        ? "Which product is it?"
        : "Not matched to your catalog";

  return (
    <div>
      <div className="text-sm font-medium text-amber-700">{prompt}</div>
      {detection.candidates.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {detection.candidates.map((c) => (
            <CandidateButton key={c.id} product={c} onPick={onPick} />
          ))}
        </div>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search catalog…"
        aria-label={`Find product for ${detection.label ?? "detection"}`}
        className="mt-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
      />
      {results.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {results.map((p) => (
            <CandidateButton key={p.id} product={p} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateButton({ product, onPick }: { product: Product; onPick: (p: Product) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(product)}
      className="rounded-full border border-slate-300 px-2.5 py-1 text-xs hover:border-emerald-500 hover:bg-emerald-50"
    >
      {product.name} · {formatINR(product.price)}
    </button>
  );
}
