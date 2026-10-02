import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Schemas } from "../../../lib/api/client";
import { formatINR } from "../../../lib/format";
import { searchProducts } from "../bill";
import { ACCEPTED_IMAGE_TYPES, imageFileError, isValidQuantity } from "../vision/review";
import { initialRows, parchiPlan, readParchi, type ParchiRow, type Product } from "./review";

type Props = {
  products: Product[];
  /** Adds the confirmed lines to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Photo of a parchi -> lines matched to the catalogue -> merchant review. Nothing reaches the bill
 * until "Add to bill"; lines that are not found, not chosen or removed are never added.
 */
export function ParchiReview({ products, onConfirm, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<ParchiRow[]>([]);

  const read = useMutation({ mutationFn: readParchi, onSuccess: (result) => setRows(initialRows(result.lines)) });
  const confirm = useMutation({ mutationFn: onConfirm, onSuccess: onClose });

  function choose(selected: File | undefined) {
    if (!selected) return;
    read.reset();
    confirm.reset();
    setRows([]);
    const error = imageFileError(selected);
    setFileError(error);
    setFileName(error ? null : selected.name);
    if (!error) read.mutate(selected);
  }

  const update = (id: string, patch: Partial<ParchiRow>) =>
    setRows((current) => current.map((r) => (r.line.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((current) => current.filter((r) => r.line.id !== id));
  const plan = parchiPlan(rows);
  const result = read.data;

  return (
    <section aria-label="Add from Parchi" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-slate-900">Add from Parchi</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          Cancel
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        capture="environment"
        aria-label="Photo of parchi"
        className="hidden"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = ""; // allow re-choosing the same file
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={read.isPending}
        className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      >
        {fileName ? "Choose another photo" : "Take or choose a photo of the parchi"}
      </button>
      {fileName && <span className="ml-2 text-xs text-slate-500">{fileName}</span>}
      {fileError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {fileError}
        </p>
      )}
      {read.isPending && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Reading parchi…
        </p>
      )}
      {read.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {read.error.message}
        </p>
      )}

      {result && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-slate-500">Parchi items</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              {result.lines.length === 0 ? "No items could be read from this photo." : "All items removed."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">Parchi item</th>
                  <th className="w-20 py-1 pr-2 font-medium">Quantity</th>
                  <th className="py-1 pr-2 font-medium">Catalogue match</th>
                  <th className="w-14 py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <ParchiRowView
                    key={row.line.id}
                    row={row}
                    products={products}
                    onChange={(patch) => update(row.line.id, patch)}
                    onRemove={() => remove(row.line.id)}
                  />
                ))}
              </tbody>
            </table>
          )}

          {confirm.error && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {confirm.error.message}
            </p>
          )}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {plan.missingQuantity > 0 && (
                <span className="text-amber-700">
                  Enter the quantity for {plan.missingQuantity} {plan.missingQuantity === 1 ? "item" : "items"}.{" "}
                </span>
              )}
              {plan.skipped > 0 && `${plan.skipped} not found or not chosen: will not be added.`}
            </span>
            <button
              type="button"
              disabled={plan.items.length === 0 || plan.missingQuantity > 0 || confirm.isPending}
              onClick={() => confirm.mutate(plan.items)}
              className="shrink-0 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {confirm.isPending ? "Adding…" : `Add ${plan.items.length} to bill`}
            </button>
          </div>
          {result.text && (
            <details className="mt-3 text-xs text-slate-500">
              <summary className="cursor-pointer">Text read from the photo ({result.provider})</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2">{result.text}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ParchiRowView({
  row,
  products,
  onChange,
  onRemove,
}: {
  row: ParchiRow;
  products: Product[];
  onChange: (patch: Partial<ParchiRow>) => void;
  onRemove: () => void;
}) {
  const { line, product, quantity } = row;
  const quantityOk = isValidQuantity(quantity);
  // Why the catalogue match was (or was not) made, in the parchi's own words.
  const basis = product && product.id === line.product?.id && line.matched_words.length > 0;

  return (
    <tr aria-label={`Parchi item: ${line.raw_text}`} className="align-top">
      <td className="py-2 pr-2">
        <span className="font-medium text-slate-900">{line.raw_text}</span>
      </td>
      <td className="py-2 pr-2">
        <input
          inputMode="decimal"
          value={quantity}
          placeholder="?"
          onChange={(e) => onChange({ quantity: e.target.value })}
          aria-label={`Quantity for ${line.raw_text}`}
          aria-invalid={!quantityOk}
          className={`h-7 w-16 rounded border px-2 text-center ${quantityOk ? "border-slate-300" : "border-amber-500"}`}
        />
        {line.quantity === null && quantity === "" && (
          <div className="mt-0.5 text-[11px] text-amber-700">not on parchi</div>
        )}
      </td>
      <td className="py-2 pr-2">
        {product ? (
          <div>
            <span className="font-medium text-slate-900">{product.name}</span>{" "}
            <span className="text-slate-600">{formatINR(product.price)}</span>
            <button
              type="button"
              onClick={() => onChange({ product: null })}
              aria-label={`Change product for ${line.raw_text}`}
              className="ml-2 text-xs text-slate-500 underline hover:text-slate-800"
            >
              Change
            </button>
            {basis && <div className="text-[11px] text-slate-500">matched on: {line.matched_words.join(", ")}</div>}
          </div>
        ) : (
          <Resolve row={row} products={products} onPick={(p) => onChange({ product: p })} />
        )}
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${line.raw_text}`}
          className="text-xs text-slate-400 hover:text-red-600"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

/** Undecided line: pick a candidate, or search the catalogue. Left alone, it is not added. */
function Resolve({ row, products, onPick }: { row: ParchiRow; products: Product[]; onPick: (p: Product) => void }) {
  const { line } = row;
  const [query, setQuery] = useState("");
  const results = query.trim() ? searchProducts(query, products).slice(0, 5) : [];
  const prompt =
    line.match === "unmatched"
      ? "Not found in catalogue"
      : line.match === "low_confidence"
        ? "Not sure. Is it this?"
        : "Which product is it?";

  return (
    <div>
      <div className="font-medium text-amber-700">{prompt}</div>
      {line.candidates.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {line.candidates.map((c) => (
            <CandidateButton key={c.id} product={c} onPick={onPick} />
          ))}
        </div>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search catalogue…"
        aria-label={`Find product for ${line.raw_text}`}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
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
