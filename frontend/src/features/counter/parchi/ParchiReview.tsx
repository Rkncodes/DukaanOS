import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "../../../i18n";
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
  const { t, problem } = useTranslation();
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
    <section aria-label={t("counter.mode.parchi.name")} className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-slate-900">{t("counter.mode.parchi.name")}</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          {t("common.cancel")}
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        capture="environment"
        aria-label={t("parchi.photo")}
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
        {fileName ? t("review.chooseAnother") : t("parchi.choose")}
      </button>
      {fileName && <span className="ml-2 text-xs text-slate-500">{fileName}</span>}
      {fileError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {fileError}
        </p>
      )}
      {read.isPending && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          {t("parchi.reading")}
        </p>
      )}
      {read.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {problem(read.error)}
        </p>
      )}

      {result && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-slate-500">{t("parchi.items")}</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              {result.lines.length === 0 ? t("parchi.nothingRead") : t("review.allRemoved")}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">{t("parchi.item")}</th>
                  <th className="w-20 py-1 pr-2 font-medium">{t("review.quantity")}</th>
                  <th className="py-1 pr-2 font-medium">{t("review.catalogueMatch")}</th>
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
              {problem(confirm.error)}
            </p>
          )}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {plan.missingQuantity > 0 && (
                <span className="text-amber-700">
                  {t(plan.missingQuantity === 1 ? "review.enterQuantity.one" : "review.enterQuantity.other", { count: plan.missingQuantity })}{" "}
                </span>
              )}
              {plan.skipped > 0 && t("review.skipped", { count: plan.skipped })}
            </span>
            <button
              type="button"
              disabled={plan.items.length === 0 || plan.missingQuantity > 0 || confirm.isPending}
              onClick={() => confirm.mutate(plan.items)}
              className="shrink-0 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {confirm.isPending ? t("review.adding") : t("review.addToBill", { count: plan.items.length })}
            </button>
          </div>
          {result.text && (
            <details className="mt-3 text-xs text-slate-500">
              <summary className="cursor-pointer">{t("parchi.textRead", { provider: result.provider })}</summary>
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
  const { t } = useTranslation();
  const { line, product, quantity } = row;
  const quantityOk = isValidQuantity(quantity);
  // Why the catalogue match was (or was not) made, in the parchi's own words.
  const basis = product && product.id === line.product?.id && line.matched_words.length > 0;

  return (
    <tr aria-label={t("parchi.itemNamed", { text: line.raw_text })} className="align-top">
      <td className="py-2 pr-2">
        <span className="font-medium text-slate-900">{line.raw_text}</span>
      </td>
      <td className="py-2 pr-2">
        <input
          inputMode="decimal"
          value={quantity}
          placeholder="?"
          onChange={(e) => onChange({ quantity: e.target.value })}
          aria-label={t("review.quantityFor", { text: line.raw_text })}
          aria-invalid={!quantityOk}
          className={`h-7 w-16 rounded border px-2 text-center ${quantityOk ? "border-slate-300" : "border-amber-500"}`}
        />
        {line.quantity === null && quantity === "" && (
          <div className="mt-0.5 text-[11px] text-amber-700">{t("parchi.notOnParchi")}</div>
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
              aria-label={t("review.changeFor", { text: line.raw_text })}
              className="ml-2 text-xs text-slate-500 underline hover:text-slate-800"
            >
              {t("review.change")}
            </button>
            {basis && <div className="text-[11px] text-slate-500">{t("parchi.matchedOn", { words: line.matched_words.join(", ") })}</div>}
          </div>
        ) : (
          <Resolve row={row} products={products} onPick={(p) => onChange({ product: p })} />
        )}
      </td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("review.removeNamed", { name: line.raw_text })}
          className="text-xs text-slate-400 hover:text-red-600"
        >
          {t("common.remove")}
        </button>
      </td>
    </tr>
  );
}

/** Undecided line: pick a candidate, or search the catalogue. Left alone, it is not added. */
function Resolve({ row, products, onPick }: { row: ParchiRow; products: Product[]; onPick: (p: Product) => void }) {
  const { t } = useTranslation();
  const { line } = row;
  const [query, setQuery] = useState("");
  const results = query.trim() ? searchProducts(query, products).slice(0, 5) : [];
  const prompt =
    line.match === "unmatched"
      ? t("review.notFound")
      : line.match === "low_confidence"
        ? t("review.notSure")
        : t("review.which");

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
        placeholder={t("review.searchCatalogue")}
        aria-label={t("review.findFor", { text: line.raw_text })}
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
