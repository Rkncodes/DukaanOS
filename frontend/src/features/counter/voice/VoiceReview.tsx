import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Schemas } from "../../../lib/api/client";
import { formatINR } from "../../../lib/format";
import { searchProducts } from "../bill";
import { isValidQuantity } from "../vision/review";
import { initialRows, parseVoice, voicePlan, type Product, type VoiceRow } from "./review";
import { SPEECH_LANGUAGE, speechErrorMessage, speechRecognition, type Recognizer } from "./speech";

type Props = {
  products: Product[];
  /** Adds the confirmed items to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Speak the items -> transcript -> items matched to the catalogue -> merchant review. Nothing reaches
 * the bill until "Add to bill"; items that are not found, not chosen or removed are never added.
 */
export function VoiceReview({ products, onConfirm, onClose }: Props) {
  const [Recognition] = useState(speechRecognition);
  const recognizer = useRef<Recognizer | null>(null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [rows, setRows] = useState<VoiceRow[]>([]);

  const parse = useMutation({ mutationFn: parseVoice, onSuccess: (result) => setRows(initialRows(result.lines)) });
  const confirm = useMutation({ mutationFn: onConfirm, onSuccess: onClose });

  function listen() {
    if (!Recognition) return;
    parse.reset();
    confirm.reset();
    setRows([]);
    setTranscript("");
    setSpeechError(null);

    const session = new Recognition();
    session.lang = SPEECH_LANGUAGE;
    session.continuous = true; // keep listening through pauses until Stop
    session.interimResults = true; // show the words as they are heard
    let settled = "";
    let heard = "";
    let failed = false;
    session.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) settled += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      heard = `${settled}${interim}`.replace(/\s+/g, " ").trim();
      setTranscript(heard);
    };
    session.onerror = (event) => {
      if (event.error === "aborted") return;
      failed = true;
      setSpeechError(speechErrorMessage(event.error));
    };
    session.onend = () => {
      recognizer.current = null;
      setListening(false);
      if (heard) parse.mutate(heard);
      else if (!failed) setSpeechError(speechErrorMessage("no-speech"));
    };
    try {
      session.start();
    } catch {
      setSpeechError(speechErrorMessage("start-failed"));
      return;
    }
    recognizer.current = session;
    setListening(true);
  }

  // Listening starts when the panel opens and the microphone is released when it closes.
  useEffect(() => {
    listen();
    return () => {
      const session = recognizer.current;
      recognizer.current = null;
      if (!session) return;
      session.onresult = session.onerror = session.onend = null;
      session.abort();
    };
  }, []);

  const update = (id: string, patch: Partial<VoiceRow>) =>
    setRows((current) => current.map((r) => (r.line.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((current) => current.filter((r) => r.line.id !== id));
  const plan = voicePlan(rows);
  const result = parse.data;

  return (
    <section aria-label="Add by Voice" className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-slate-900">Add by Voice</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          Cancel
        </button>
      </div>

      {!Recognition && (
        <p role="alert" className="text-sm text-red-600">
          Voice input is not supported in this browser. Open DukaanOS in Chrome or Edge to add items by voice.
        </p>
      )}
      {listening && (
        <div className="flex items-center gap-3">
          <p role="status" className="text-sm font-medium text-emerald-700">
            Listening… Speak your items.
          </p>
          <button
            type="button"
            onClick={() => recognizer.current?.stop()}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Stop
          </button>
        </div>
      )}
      {Recognition && !listening && (
        <button
          type="button"
          onClick={listen}
          disabled={parse.isPending}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          Speak again
        </button>
      )}
      {speechError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {speechError}
        </p>
      )}

      {transcript && (
        <div className="mt-3">
          <h3 className="text-sm font-medium text-slate-500">Transcript</h3>
          <p aria-label="Transcript" className="mt-1 rounded bg-slate-50 p-2 text-sm text-slate-900">
            {transcript}
          </p>
        </div>
      )}
      {parse.isPending && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Finding items…
        </p>
      )}
      {parse.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {parse.error.message}
        </p>
      )}

      {result && !listening && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-slate-500">Detected items</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              {result.lines.length === 0 ? "No items could be found in what was heard." : "All items removed."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">Heard</th>
                  <th className="w-20 py-1 pr-2 font-medium">Quantity</th>
                  <th className="py-1 pr-2 font-medium">Catalogue match</th>
                  <th className="w-14 py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <VoiceRowView
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
        </div>
      )}
    </section>
  );
}

function VoiceRowView({
  row,
  products,
  onChange,
  onRemove,
}: {
  row: VoiceRow;
  products: Product[];
  onChange: (patch: Partial<VoiceRow>) => void;
  onRemove: () => void;
}) {
  const { line, product, quantity } = row;
  const quantityOk = isValidQuantity(quantity);

  return (
    <tr aria-label={`Voice item: ${line.raw_text}`} className="align-top">
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
        {line.quantity === null && quantity === "" && <div className="mt-0.5 text-[11px] text-amber-700">not said</div>}
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

/** Undecided item: pick a candidate, or search the catalogue. Left alone, it is not added. */
function Resolve({ row, products, onPick }: { row: VoiceRow; products: Product[]; onPick: (p: Product) => void }) {
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
