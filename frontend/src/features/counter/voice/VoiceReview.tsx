import { useMutation } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../../../app/icons";
import { useTranslation } from "../../../i18n";
import type { Schemas } from "../../../lib/api/client";
import { formatINR } from "../../../lib/format";
import { searchProducts } from "../bill";
import { isValidQuantity } from "../vision/review";
import { billChanges, initialRows, parseVoice, voicePlan, type BillChange, type Product, type VoiceRow } from "./review";
import {
  SPEECH_LANGUAGES,
  loadSpeechLanguage,
  saveSpeechLanguage,
  speechErrorMessage,
  speechRecognition,
  type Recognizer,
  type SpeechLanguage,
} from "./speech";

type CartItem = Schemas["CartItemRead"];

type Props = {
  products: Product[];
  /** The Counter's open bill, if it has one: spoken commands are about it. */
  cart: Schemas["CartRead"] | null;
  /** Adds the confirmed items to the existing Counter cart. */
  onConfirm: (items: Schemas["ConfirmedItem"][]) => Promise<unknown>;
  /** The bill's own line operations: a spoken "change the quantity" or "remove", once the merchant confirms it. */
  onSetQuantity: (itemId: string, quantity: string) => Promise<unknown>;
  onRemoveItem: (itemId: string) => Promise<unknown>;
  onClose: () => void;
};

/**
 * Tap, speak the items -> transcript -> items matched to the catalogue -> merchant review. Nothing reaches
 * the bill until "Add to bill"; items that are not found, not chosen or removed are never added. The
 * microphone is only ever on between a tap and Stop.
 */
export function VoiceReview({ products, cart, onConfirm, onSetQuantity, onRemoveItem, onClose }: Props) {
  // The app's display language (t) and the language listened for (`language` below) are separate choices.
  const { t, problem } = useTranslation();
  const [Recognition] = useState(speechRecognition);
  const recognizer = useRef<Recognizer | null>(null);
  const [language, setLanguage] = useState<SpeechLanguage>(loadSpeechLanguage);
  const [listening, setListening] = useState(false);
  const [tried, setTried] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState(""); // the transcript the review below was made from
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false); // the transcript box opened by hand, after speech failed
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const cartId = cart?.id ?? null;

  const parse = useMutation({ mutationFn: parseVoice, onSuccess: (result) => setRows(initialRows(result.lines)) });
  const confirm = useMutation({ mutationFn: onConfirm, onSuccess: onClose });

  function find(text: string) {
    setParsed(text);
    parse.mutate({ transcript: text, cartId });
  }

  function listen() {
    if (!Recognition) return;
    parse.reset();
    confirm.reset();
    setRows([]);
    setTranscript("");
    setParsed("");
    setSpeechError(null);
    setTyping(false);
    setTried(true);

    const session = new Recognition();
    session.lang = SPEECH_LANGUAGES.find((l) => l.id === language)!.lang;
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
      if (heard) find(heard);
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

  // The microphone is released when the panel closes. It is never opened here: only by a tap.
  useEffect(
    () => () => {
      const session = recognizer.current;
      recognizer.current = null;
      if (!session) return;
      session.onresult = session.onerror = session.onend = null;
      session.abort();
    },
    [],
  );

  const update = (id: string, patch: Partial<VoiceRow>) =>
    setRows((current) => current.map((r) => (r.line.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((current) => current.filter((r) => r.line.id !== id));
  const plan = voicePlan(rows);
  const result = parse.data;
  const intent = result?.intent ?? "add";
  const edited = transcript.trim() !== "" && transcript.trim() !== parsed;

  return (
    <section aria-label={t("counter.mode.voice.name")} className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium text-slate-900">{t("counter.mode.voice.name")}</h2>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800">
          {t("common.cancel")}
        </button>
      </div>

      {!Recognition && (
        <p role="alert" className="text-sm text-red-600">
          {t("voice.unsupported")}
        </p>
      )}
      {Recognition && (
        <div className="flex flex-wrap items-center gap-3">
          {listening ? (
            <button
              type="button"
              onClick={() => recognizer.current?.stop()}
              className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
            >
              <Icon name="mic" className="h-5 w-5" />
              {t("voice.stop")}
            </button>
          ) : (
            <button
              type="button"
              onClick={listen}
              disabled={parse.isPending}
              className="flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Icon name="mic" className="h-5 w-5" />
              {tried ? t("voice.speakAgain") : t("voice.tapToSpeak")}
            </button>
          )}
          <select
            aria-label={t("voice.language")}
            value={language}
            disabled={listening}
            onChange={(e) => {
              const next = e.target.value as SpeechLanguage;
              setLanguage(next);
              saveSpeechLanguage(next);
            }}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm disabled:opacity-50"
          >
            {SPEECH_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {listening ? (
            <p role="status" className="text-sm font-medium text-emerald-700">
              {t("voice.listening")}
            </p>
          ) : (
            !tried && <p className="text-sm text-slate-500">{t("voice.say")}</p>
          )}
        </div>
      )}
      {speechError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {speechError}
        </p>
      )}
      {speechError && !listening && !typing && !transcript && (
        // Speech did not work out (a blocked microphone, a language this browser cannot recognise):
        // the items can still be typed and are read exactly like a spoken transcript.
        <button
          type="button"
          onClick={() => setTyping(true)}
          className="mt-2 text-sm font-medium text-emerald-700 underline hover:text-emerald-900"
        >
          {t("voice.typeInstead")}
        </button>
      )}

      {(transcript || parsed || typing) && (
        <div className="mt-3">
          <label htmlFor="voice-transcript" className="text-sm font-medium text-slate-500">
            {t("voice.transcript")}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="voice-transcript"
              aria-label={t("voice.transcript")}
              value={transcript}
              readOnly={listening}
              onChange={(e) => setTranscript(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && edited && !listening) find(transcript.trim());
              }}
              className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-900"
            />
            {edited && !listening && (
              <button
                type="button"
                onClick={() => find(transcript.trim())}
                disabled={parse.isPending}
                className="shrink-0 rounded-md border border-slate-300 px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                {t("voice.findItems")}
              </button>
            )}
          </div>
        </div>
      )}
      {parse.isPending && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          {t("voice.finding")}
        </p>
      )}
      {parse.error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {problem(parse.error)}
        </p>
      )}

      {result && !listening && !parse.isPending && intent !== "add" && (
        <BillCommand result={result} cart={cart} onSetQuantity={onSetQuantity} onRemoveItem={onRemoveItem} />
      )}

      {result && !listening && intent === "add" && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-slate-500">{t("voice.detected")}</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">
              {result.lines.length === 0 ? t("voice.nothingFound") : t("review.allRemoved")}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="py-1 pr-2 font-medium">{t("voice.heard")}</th>
                  <th className="w-20 py-1 pr-2 font-medium">{t("review.quantity")}</th>
                  <th className="py-1 pr-2 font-medium">{t("review.catalogueMatch")}</th>
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
        </div>
      )}
    </section>
  );
}

/**
 * A spoken command about the open bill: the total, removing a line, changing a quantity, clearing it.
 * The total is only read out. Everything else is shown as what it would do and waits for a tap; it is
 * then done by the bill's own line operations, exactly as tapping in the bill panel would.
 */
function BillCommand({
  result,
  cart,
  onSetQuantity,
  onRemoveItem,
}: {
  result: Schemas["VoiceResult"];
  cart: Schemas["CartRead"] | null;
  onSetQuantity: Props["onSetQuantity"];
  onRemoveItem: Props["onRemoveItem"];
}) {
  const { t, problem } = useTranslation();
  const [done, setDone] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState(false);
  const apply = useMutation({
    mutationFn: async ({ key, said, run }: { key: string; said: string; run: () => Promise<unknown> }) => {
      await run();
      return { key, said };
    },
    onSuccess: ({ key, said }) => setDone((current) => ({ ...current, [key]: said })),
  });
  const items = cart?.items ?? [];
  const intent = result.intent ?? "add";

  if (intent === "total") {
    return (
      <p role="status" aria-label={t("voice.billTotal")} className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-900">
        {items.length === 0
          ? t("voice.billEmpty")
          : t(items.length === 1 ? "voice.totalSoFar.one" : "voice.totalSoFar.other", { count: items.length })
              .split("{{amount}}")
              .map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="font-semibold">{formatINR(cart!.subtotal)}</span>}
                  {part}
                </Fragment>
              ))}
      </p>
    );
  }

  if (intent === "clear") {
    const cleared = done.clear;
    return (
      <div aria-label={t("voice.clearTheBill")} className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
        {cleared ? (
          <p role="status">{cleared}</p>
        ) : items.length === 0 ? (
          <p role="status">{t("voice.alreadyEmpty")}</p>
        ) : dismissed ? (
          <p role="status">{t("voice.kept")}</p>
        ) : (
          <>
            <p className="font-medium text-slate-900">
              {t(items.length === 1 ? "voice.removeAll.one" : "voice.removeAll.other", { count: items.length })}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={apply.isPending}
                onClick={() =>
                  apply.mutate({
                    key: "clear",
                    said: t("voice.cleared"),
                    run: async () => {
                      for (const item of items) await onRemoveItem(item.id);
                    },
                  })
                }
                className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {t("voice.clearBill")}
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-50"
              >
                {t("voice.keepBill")}
              </button>
            </div>
          </>
        )}
        {apply.error && <p role="alert" className="mt-2 text-red-600">{problem(apply.error)}</p>}
      </div>
    );
  }

  const changes = billChanges(result, items);
  const removing = intent === "remove";
  return (
    <div aria-label={removing ? t("voice.removeFromBill") : t("voice.changeQuantity")} className="mt-4 space-y-2 text-sm">
      {changes.length === 0 && <p className="text-slate-500">{t("voice.noItemFound")}</p>}
      {changes.map((change) => (
        <BillChangeView
          key={change.line.id}
          change={change}
          removing={removing}
          done={done[change.line.id]}
          busy={apply.isPending}
          onApply={(item: CartItem) =>
            apply.mutate(
              removing
                ? { key: change.line.id, said: t("voice.removed", { name: item.product_name }), run: () => onRemoveItem(item.id) }
                : {
                    key: change.line.id,
                    said: t("voice.nowQuantity", { name: item.product_name, quantity: change.quantity! }),
                    run: () => onSetQuantity(item.id, change.quantity!),
                  },
            )
          }
        />
      ))}
      {apply.error && <p role="alert" className="text-red-600">{problem(apply.error)}</p>}
    </div>
  );
}

function BillChangeView({
  change,
  removing,
  done,
  busy,
  onApply,
}: {
  change: BillChange;
  removing: boolean;
  done: string | undefined;
  busy: boolean;
  onApply: (item: CartItem) => void;
}) {
  const { t } = useTranslation();
  const { line, items, quantity } = change;
  if (done) return <p role="status">{done}</p>;
  if (items.length === 0) {
    return (
      <p role="status" className="text-amber-700">
        {t("voice.notOnBill", { text: line.description })}
      </p>
    );
  }
  if (!removing && (quantity === null || !isValidQuantity(quantity))) {
    return (
      <p role="status" className="text-amber-700">
        {t("voice.noNewQuantity", { text: line.description })}
      </p>
    );
  }
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <p className="font-medium text-slate-900">
        {items.length > 1
          ? t("voice.whichOnBill", { text: line.description })
          : removing
            ? t("voice.removeQuestion")
            : t("voice.changeQuestion")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={busy}
            onClick={() => onApply(item)}
            className={`rounded-md px-3 py-1.5 font-medium disabled:opacity-50 ${
              removing ? "bg-red-600 text-white hover:bg-red-700" : "bg-emerald-600 text-white hover:bg-emerald-700"
            }`}
          >
            {removing ? t("review.removeNamed", { name: item.product_name }) : t("voice.setTo", { name: item.product_name, quantity: quantity! })}
          </button>
        ))}
      </div>
    </div>
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
  const { t } = useTranslation();
  const { line, product, quantity } = row;
  const quantityOk = isValidQuantity(quantity);

  return (
    <tr aria-label={t("voice.item", { text: line.raw_text })} className="align-top">
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
        {line.quantity === null && quantity === "" && <div className="mt-0.5 text-[11px] text-amber-700">{t("voice.notSaid")}</div>}
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

/** Undecided item: pick a candidate, or search the catalogue. Left alone, it is not added. */
function Resolve({ row, products, onPick }: { row: VoiceRow; products: Product[]; onPick: (p: Product) => void }) {
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
