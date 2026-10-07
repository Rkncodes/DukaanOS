import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon } from "../../app/icons";
import { api, unwrap, type Schemas } from "../../lib/api/client";
import { useSession } from "../auth/session";

/** Whether the assistant can answer, and what it is built to do: the backend's word, never the page's. */
export function useAssistantStatus(enabled = true) {
  return useQuery({
    queryKey: ["assistant", "status"],
    queryFn: () => unwrap(api.GET("/api/v1/assistant/status")),
    enabled,
  });
}

/** Questions a merchant might ask, in the three ways they might write them. Tapping one asks it. */
const EXAMPLES: { text: string; lang: "hi" | "en" }[] = [
  { text: "आज कितनी बिक्री हुई?", lang: "hi" },
  { text: "Aaj kitni bikri hui?", lang: "en" },
  { text: "राहुल शर्मा का कितना उधार है?", lang: "hi" },
  { text: "Rahul Sharma ka kitna udhaar hai?", lang: "en" },
  { text: "मैगी का कितना स्टॉक बचा है?", lang: "hi" },
  { text: "Maggi ka stock kitna hai?", lang: "en" },
  { text: "आज कितने ऑर्डर आए?", lang: "hi" },
  { text: "Which products are low in stock?", lang: "en" },
];

/** Which of the store's records an answer was read from, in the merchant's words. */
const SOURCES: Record<string, string> = {
  get_today_sales: "today's sales",
  get_today_orders: "today's orders",
  get_total_outstanding: "khata",
  get_customer_outstanding: "khata",
  get_customer_balance: "khata",
  get_customer_list: "customers",
  get_product_stock: "stock",
  get_low_stock_products: "stock",
  get_product_price: "prices",
  search_products: "products",
};

type Turn = { question: string; answer: Schemas["AssistantAnswer"] };

/** How many earlier question/answer pairs go with a new question, so a follow-up keeps its meaning. */
const REMEMBERED = 5;

/**
 * Salaahkaar: the store's own assistant. A question goes to the backend, which lets the model look things
 * up only through DukaanOS's tools and returns the answer. Nothing shown here as an answer is made in the
 * browser, and while the assistant is unavailable a question is never sent.
 */
export function SalaahkaarPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: session } = useSession();
  const status = useAssistantStatus(open);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [refused, setRefused] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (asked: string) =>
      unwrap(
        api.POST("/api/v1/assistant/ask", {
          body: {
            question: asked,
            history: turns.slice(-REMEMBERED).flatMap((t) => [
              { role: "user" as const, content: t.question },
              { role: "assistant" as const, content: t.answer.answer },
            ]),
          },
        }),
      ),
    onSuccess: (answer, asked) => {
      setTurns((earlier) => [...earlier, { question: asked, answer }]);
      setQuestion("");
    },
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, ask.isPending, ask.error]);

  if (!open) return null;

  const available = status.data?.available === true;
  const unavailable = status.error
    ? `Salaahkaar is not available: its status could not be read (${status.error.message}).`
    : (status.data?.reason ?? "Salaahkaar is not available.");

  function send(asked: string) {
    const text = asked.trim();
    if (!text || ask.isPending) return;
    if (!available) {
      // Nothing can answer: the question stays in the box and no answer is made up.
      setQuestion(text);
      setRefused(true);
      return;
    }
    setQuestion(text);
    ask.mutate(text);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(question);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(question);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Salaahkaar"
        className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 bg-emerald-700 px-4 py-3 text-white">
          <div className="flex items-center gap-2.5">
            <span className="rounded-lg bg-emerald-600 p-1.5">
              <Icon name="sparkle" className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <h2 className="font-semibold">Salaahkaar</h2>
              <p lang="hi" className="text-xs text-emerald-100">
                आपकी दुकान का सलाहकार
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setTurns([]);
                  ask.reset();
                }}
                className="text-emerald-100 hover:text-white"
              >
                Clear
              </button>
            )}
            <button type="button" onClick={onClose} className="text-emerald-100 hover:text-white">
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <div>
            <p className="text-base font-semibold text-slate-900">
              <span lang="hi">नमस्ते</span>
              {session?.user.name ? `, ${session.user.name}` : ""}!
            </p>
            <p className="mt-1 text-slate-600">
              Ask about your store in English, <span lang="hi">हिंदी</span> or Hinglish. I answer only from your shop's own
              data: today's sales and orders, stock, prices, customers and khata.
            </p>
          </div>

          {status.isPending ? (
            <p className="text-slate-500">Checking Salaahkaar…</p>
          ) : (
            !available && (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
                {unavailable}
              </p>
            )
          )}

          {turns.length === 0 && !ask.isPending && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Try asking · <span lang="hi">ऐसे पूछिए</span>
              </h3>
              <ul aria-label="Example questions" className="flex flex-wrap gap-2">
                {EXAMPLES.map((example) => (
                  <li key={example.text}>
                    <button
                      type="button"
                      lang={example.lang}
                      onClick={() => send(example.text)}
                      className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-slate-700 hover:border-emerald-400 hover:bg-emerald-50"
                    >
                      {example.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {turns.length > 0 && (
            <ol aria-label="Conversation" className="space-y-3">
              {turns.map((turn, i) => (
                <li key={i} className="space-y-2">
                  <p className="ml-8 rounded-xl rounded-br-sm bg-emerald-600 px-3 py-2 text-white">{turn.question}</p>
                  <Answer answer={turn.answer} />
                </li>
              ))}
            </ol>
          )}

          {ask.isPending && (
            <div className="space-y-2">
              <p className="ml-8 rounded-xl rounded-br-sm bg-emerald-600 px-3 py-2 text-white">{ask.variables}</p>
              <p role="status" className="mr-8 rounded-xl rounded-bl-sm bg-slate-100 px-3 py-2 text-slate-500">
                Checking your records… <span lang="hi">आपके रिकॉर्ड देख रहा हूँ…</span>
              </p>
            </div>
          )}
          {ask.error && !ask.isPending && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
              <p className="font-medium">No answer this time.</p>
              <p>{ask.error.message}</p>
              <p className="mt-1 text-red-700">Your question is still in the box: press Ask to try again.</p>
            </div>
          )}
          <div ref={threadEnd} />
        </div>

        <form onSubmit={onSubmit} className="border-t border-slate-200 bg-slate-50 p-3">
          {refused && (
            <p role="alert" className="mb-2 text-sm text-red-600">
              {unavailable} Your question was not sent.
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              aria-label="Your question"
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setRefused(false);
              }}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={500}
              placeholder="Aaj kitni bikri hui?"
              className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!question.trim() || ask.isPending}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {ask.isPending ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function Answer({ answer }: { answer: Schemas["AssistantAnswer"] }) {
  const sources = [...new Set(answer.tools_used.map((tool) => SOURCES[tool] ?? tool))];
  return (
    <div className="mr-8 rounded-xl rounded-bl-sm bg-slate-100 px-3 py-2 text-slate-900">
      <p className="whitespace-pre-wrap">{answer.answer}</p>
      <p className="mt-1 text-xs text-slate-500">
        {sources.length > 0 ? `From your records: ${sources.join(", ")}` : "Not read from your records"}
      </p>
    </div>
  );
}
