import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "../../../i18n";
import { ApiError, type Schemas } from "../../../lib/api/client";
import { formatINR, formatQuantity } from "../../../lib/format";
import { availableStock, findByBarcode } from "../bill";
import { CameraScan } from "./CameraScan";

type Product = Schemas["ProductRead"];

type Props = {
  products: Product[];
  /** The open bill's lines: a product cannot be scanned past its stock. */
  cartItems: Schemas["CartItemRead"][];
  /** Adds the product with this barcode to the existing bill (the backend resolves it again, exactly). */
  onAdd: (barcode: string) => Promise<unknown>;
  /** Reads the catalogue again: a code not known here may belong to a product added a moment ago. */
  onRefresh: () => Promise<Product[]>;
  onClose: () => void;
  /** How often the camera looks for a barcode (tests shorten it). */
  scanEveryMs?: number;
};

type Outcome =
  | { kind: "added"; product: Product; code: string }
  | { kind: "problem"; title: string; detail: string; code: string };

/**
 * Billing by barcode. The code comes from the device's camera (CameraScan) or from a text box kept in
 * focus, which is what a USB scanner types into. Either way each code is looked up exactly in the
 * merchant's catalogue and, when it is one product with stock left, added to the same bill as every other
 * input. An unknown code adds nothing.
 */
export function BarcodeScan({ products, cartItems, onAdd, onRefresh, onClose, scanEveryMs }: Props) {
  const { t, problem } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const inBill = (product: Product) =>
    cartItems.filter((item) => item.product_id === product.id).reduce((sum, item) => sum + Number(item.quantity), 0);

  /** One barcode, however it arrived (typed, USB scanner or camera): the same exact lookup, the same bill. */
  async function submit(scanned: string) {
    setBusy(true);
    try {
      setOutcome(await resolve(scanned));
    } finally {
      setBusy(false);
    }
  }

  async function scan(e: FormEvent) {
    e.preventDefault();
    const scanned = code.trim();
    if (!scanned || busy) return;
    setCode("");
    await submit(scanned);
    inputRef.current?.focus(); // ready for the next scan
  }

  async function resolve(scanned: string): Promise<Outcome> {
    const unknown: Outcome = {
      kind: "problem",
      code: scanned,
      title: t("barcode.notFound"),
      detail: t("barcode.notFoundDetail"),
    };
    let known = products;
    let found = findByBarcode(scanned, known);
    if (found.kind === "unknown") {
      known = await onRefresh();
      found = findByBarcode(scanned, known);
    }
    if (found.kind === "unknown") return unknown;
    if (found.kind === "ambiguous")
      return {
        kind: "problem",
        code: scanned,
        title: t("barcode.several"),
        detail: t("barcode.severalDetail", { names: found.products.map((p) => p.name).join(", ") }),
      };

    const product = found.product;
    if ((availableStock(known, cartItems).get(product.id) ?? 0) < 1)
      return { kind: "problem", code: scanned, title: t("picker.noMoreInStock", { name: product.name }), detail: t("barcode.nothingAdded") };
    try {
      await onAdd(scanned);
      return { kind: "added", product, code: scanned };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return unknown;
      return {
        kind: "problem",
        code: scanned,
        title: t("barcode.couldNotAdd"),
        detail: error instanceof Error ? problem(error) : t("barcode.nothingAdded"),
      };
    }
  }

  return (
    <section aria-label={t("counter.mode.barcode.name")} className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
      <div className="order-1 mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{t("counter.mode.barcode.name")}</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          {t("common.cancel")}
        </button>
      </div>

      <div className="order-2">
        <CameraScan onDetected={(detected) => submit(detected.trim())} scanEveryMs={scanEveryMs} />
      </div>

      <div className="order-4 my-4 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        {t("barcode.or")}
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <form onSubmit={scan} className="order-5">
        <label htmlFor="counter-barcode" className="mb-1 block text-sm font-medium text-slate-600">
          {t("barcode.label")}
        </label>
        <div className="flex gap-2">
          <input
            id="counter-barcode"
            ref={inputRef}
            autoFocus
            autoComplete="off"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("barcode.placeholder")}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 font-mono text-lg tracking-wider focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
          />
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="whitespace-nowrap rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? t("review.adding") : t("barcode.addToBill")}
          </button>
        </div>
      </form>

      {/* Shown directly under the camera, above the manual box: the result is in view whichever way the code came. */}
      <div className="order-3 mt-3 min-h-20">
        {outcome === null && (
          <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            {t("barcode.waiting")}
          </p>
        )}
        {outcome?.kind === "added" && (
          <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-emerald-700">{t("barcode.added")}</div>
              <div className="truncate text-lg font-semibold text-slate-900">{outcome.product.name}</div>
              <div className="text-sm text-slate-600">
                <span className="font-mono">{outcome.code}</span> · {t("barcode.inThisBill", { quantity: formatQuantity(String(inBill(outcome.product))) })}
              </div>
            </div>
            <div className="whitespace-nowrap text-right">
              <div className="text-xl font-semibold tabular-nums text-slate-900">{formatINR(outcome.product.price)}</div>
              <div className="text-xs text-slate-500">{t("barcode.per", { unit: outcome.product.unit })}</div>
            </div>
          </div>
        )}
        {outcome?.kind === "problem" && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <div className="text-lg font-semibold text-red-800">{outcome.title}</div>
            <div className="mt-0.5 text-sm text-red-800">
              <span className="font-mono">{outcome.code}</span> · {outcome.detail}
            </div>
            <button type="button" onClick={onClose} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-50">
              {t("barcode.searchInstead")}
            </button>
          </div>
        )}
      </div>

      <p role="note" className="order-6 mt-3 text-xs text-slate-500">
        {t("barcode.note")}
      </p>
    </section>
  );
}
