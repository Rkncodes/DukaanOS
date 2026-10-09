// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { CounterPage } from "../CounterPage";
import { coke, colgate, createFakeBackend, json, lays, maggi, parle, pepsi } from "../vision/testing";
import { initialRows, voicePlan } from "./review";
import type { Recognizer } from "./speech";

/**
 * Renders the real Counter page against the in-memory fake backend, so the flow
 * speak -> transcript -> review -> confirm -> *existing* Counter cart is exercised end to end in the UI.
 * The browser's speech recognition is replaced by FakeRecognition (jsdom has none); only
 * POST /voice/parse is added here: carts, products and recognized-items are the shared fake.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

/** Test double for the browser's SpeechRecognition: the test says what is heard and when it ends. */
class FakeRecognition implements Recognizer {
  static sessions: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: Recognizer["onresult"] = null;
  onerror: Recognizer["onerror"] = null;
  onend: Recognizer["onend"] = null;
  started = false;
  aborted = false;
  private results: { isFinal: boolean; 0: { transcript: string } }[] = [];

  constructor() {
    FakeRecognition.sessions.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  /** The recognizer reports a phrase: interim while still being spoken, final once settled. */
  hear(transcript: string, isFinal = true) {
    const last = this.results.at(-1);
    if (last && !last.isFinal) this.results.pop();
    this.results.push({ isFinal, 0: { transcript } });
    this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

const line = (
  id: string,
  raw_text: string,
  quantity: string | null,
  match: Schemas["MatchState"],
  extra: Partial<Schemas["VoiceLine"]> = {},
): Schemas["VoiceLine"] => ({
  id,
  raw_text,
  description: raw_text,
  quantity,
  match,
  product: null,
  candidates: [],
  match_confidence: match === "unmatched" ? null : 1,
  matched_words: [],
  unmatched_words: [],
  ...extra,
});

const SAID = "add two Maggi three cold drink Parle G one basmati rice and two colgat";

/** What the backend returns for SAID, already matched to the fake catalogue (test data only). */
const VOICE: Schemas["VoiceResult"] = {
  transcript: SAID,
  lines: [
    line("v0", "2 Maggi", "2.000", "matched", { product: maggi, matched_words: ["maggi"] }),
    line("v1", "3 cold drink", "3.000", "ambiguous", { candidates: [coke, pepsi] }),
    line("v2", "Parle G", null, "matched", { product: parle, matched_words: ["parle", "g"] }), // no quantity said
    line("v3", "1 basmati rice", "1.000", "unmatched", { unmatched_words: ["basmati", "rice"] }),
    line("v4", "2 colgat", "2.000", "low_confidence", { candidates: [colgate] }),
  ],
};

let backend: ReturnType<typeof createFakeBackend>;
let parseCalls: unknown[];
let parseVoice: () => Promise<Response>;
const speechWindow = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

beforeEach(() => {
  localStorage.clear();
  backend = createFakeBackend();
  parseCalls = [];
  parseVoice = async () => json(VOICE);
  FakeRecognition.sessions = [];
  speechWindow.webkitSpeechRecognition = FakeRecognition; // as Chrome exposes it
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/api/v1/voice/parse") {
      parseCalls.push(await req.clone().json());
      return parseVoice();
    }
    // The bill's own line operations (the shared fake has no need of them): change a quantity, remove a line.
    const item = /^\/api\/v1\/carts\/cart-1\/items\/(.+)$/.exec(path);
    if (item && (req.method === "PATCH" || req.method === "DELETE")) {
      const body = req.method === "PATCH" ? await req.clone().json() : null;
      backend.state.calls.push({ method: req.method, path, body });
      const cart = backend.state.cart as { items: Record<string, string>[]; subtotal: string };
      if (req.method === "DELETE") cart.items = cart.items.filter((l) => l.id !== item[1]);
      for (const l of cart.items) {
        if (l.id === item[1] && body) l.quantity = Number(body.quantity).toFixed(3);
        l.line_total = (Number(l.quantity) * Number(l.unit_price)).toFixed(2);
      }
      cart.subtotal = cart.items.reduce((s, l) => s + Number(l.line_total), 0).toFixed(2);
      return json(cart);
    }
    return backend.handle(req);
  };
});

afterEach(() => {
  cleanup();
  delete speechWindow.webkitSpeechRecognition;
  delete speechWindow.SpeechRecognition;
});

async function openVoice(user = userEvent.setup(), { tap = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Add by Voice" }));
  if (tap) await user.click(screen.getByRole("button", { name: "Tap to speak" })); // the microphone only opens on a tap
  return user;
}

const transcript = () => (screen.getByLabelText("Transcript") as HTMLInputElement).value;

const session = () => FakeRecognition.sessions.at(-1)!;

/** Speak SAID, press Stop, and wait for the review. */
async function speak(user: ReturnType<typeof userEvent.setup>, said = SAID) {
  act(() => session().hear(said));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await screen.findByText("Detected items");
}

const row = (text: string) => screen.getByRole("row", { name: `Voice item: ${text}` });
const qty = (text: string) => screen.getByLabelText(`Quantity for ${text}`) as HTMLInputElement;
const confirmCalls = () => backend.state.calls.filter((c) => c.path.endsWith("/recognized-items"));
const addButton = (n: number) => screen.getByRole("button", { name: `Add ${n} to bill` }) as HTMLButtonElement;
const billPanel = () => screen.getByRole("heading", { name: "Bill" }).parentElement!;

describe("Counter: add by voice", () => {
  it("listens only after a tap, shows the words as they are heard, and parses only after Stop", async () => {
    const user = await openVoice(undefined, { tap: false });

    // Opening Voice mode does not open the microphone.
    expect(FakeRecognition.sessions).toHaveLength(0);
    expect(screen.queryByText("Listening… Speak your items.")).toBeNull();
    expect(screen.getByText("Say the products you want to add to the bill.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));

    expect(screen.getByRole("status").textContent).toContain("Listening… Speak your items.");
    expect(FakeRecognition.sessions).toHaveLength(1);
    expect([session().started, session().lang, session().continuous, session().interimResults]).toEqual([
      true,
      "en-IN",
      true,
      true,
    ]);

    act(() => session().hear("add two", false)); // still speaking
    expect(transcript()).toBe("add two");
    act(() => session().hear("add two Maggi"));
    act(() => session().hear("three cold drink", false));
    expect(transcript()).toBe("add two Maggi three cold drink");
    expect(parseCalls).toHaveLength(0); // nothing is sent while listening

    let release!: () => void;
    parseVoice = () => new Promise((resolve) => (release = () => resolve(json(VOICE))));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByText("Listening… Speak your items.")).toBeNull();
    expect((await screen.findByRole("status")).textContent).toContain("Finding items…");
    expect(parseCalls).toEqual([{ transcript: "add two Maggi three cold drink" }]); // only the transcript is sent
    release();
    expect(await screen.findByText("Detected items")).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0); // hearing and parsing never touch the bill
  });

  it("shows the parsed items for review: matches, ambiguity, unknowns and missing quantities", async () => {
    const user = await openVoice();
    await speak(user);

    expect(transcript()).toBe(SAID);
    // Confident match: catalogue name and catalogue price, quantity as spoken.
    expect(within(row("2 Maggi")).getByText(maggi.name)).toBeTruthy();
    expect(row("2 Maggi").textContent).toContain("₹14.00");
    expect(qty("2 Maggi").value).toBe("2");
    // Ambiguous, unsure and unknown items wait for the merchant.
    expect(within(row("3 cold drink")).getByText("Which product is it?")).toBeTruthy();
    expect(within(row("2 colgat")).getByText("Not sure. Is it this?")).toBeTruthy();
    expect(within(row("1 basmati rice")).getByText("Not found in catalogue")).toBeTruthy();
    // A quantity that was not said is asked for, never assumed.
    expect(qty("Parle G").value).toBe("");
    expect(row("Parle G").textContent).toContain("not said");

    expect(screen.getByText("Enter the quantity for 1 item.", { exact: false })).toBeTruthy();
    expect(screen.getByText("3 not found or not chosen: will not be added.", { exact: false })).toBeTruthy();
    expect(addButton(2).disabled).toBe(true);
  });

  it("resolves an ambiguous item, edits and removes items, then adds only confirmed ones to the existing bill", async () => {
    const user = await openVoice();
    await speak(user);

    await user.clear(qty("2 Maggi"));
    await user.type(qty("2 Maggi"), "4");
    await user.type(qty("Parle G"), "3");
    // Ambiguous: the merchant chooses.
    await user.click(within(row("3 cold drink")).getByRole("button", { name: /Pepsi 750ml/ }));
    expect(within(row("3 cold drink")).getByText(pepsi.name)).toBeTruthy();
    // Remove an item; leave the unsure one alone.
    await user.click(screen.getByRole("button", { name: "Remove 1 basmati rice" }));
    expect(screen.queryByRole("row", { name: "Voice item: 1 basmati rice" })).toBeNull();

    expect(confirmCalls()).toHaveLength(0); // nothing is added before confirmation
    await user.click(addButton(3));

    // The review closes and the items are in the Counter's own bill, through the shared cart path.
    expect(await screen.findByRole("button", { name: "Add by Voice" })).toBeTruthy();
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({
      source: "voice",
      items: [
        { product_id: maggi.id, quantity: "4" },
        { product_id: pepsi.id, quantity: "3" },
        { product_id: parle.id, quantity: "3" },
      ],
    });
    const bill = billPanel();
    for (const name of [maggi.name, pepsi.name, parle.name]) expect(within(bill).getByText(name)).toBeTruthy();
    expect(within(bill).queryByText(colgate.name)).toBeNull(); // unsure and never confirmed
    expect(within(bill).getAllByText("voice")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹251.00"); // 4×14 + 3×40 + 3×25
  });

  it("lets the merchant accept an unsure match, change a matched product, and find an unknown one", async () => {
    const user = await openVoice();
    await speak(user);

    await user.click(within(row("2 colgat")).getByRole("button", { name: /Colgate Strong Teeth/ }));
    await user.click(screen.getByRole("button", { name: "Change product for 2 Maggi" }));
    await user.type(screen.getByLabelText("Find product for 2 Maggi"), "lays");
    await user.click(within(row("2 Maggi")).getByRole("button", { name: /Lays Classic Salted/ }));
    await user.type(screen.getByLabelText("Find product for 1 basmati rice"), "coke");
    await user.click(within(row("1 basmati rice")).getByRole("button", { name: /Coke 750ml/ }));
    await user.click(screen.getByRole("button", { name: "Remove Parle G" }));
    await user.click(screen.getByRole("button", { name: "Remove 3 cold drink" }));

    await user.click(addButton(3));
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect((confirmCalls()[0].body as Schemas["ConfirmedItemsAdd"]).items).toEqual([
      { product_id: lays.id, quantity: "2" },
      { product_id: coke.id, quantity: "1" },
      { product_id: colgate.id, quantity: "2" },
    ]);
  });

  it("joins a bill that already has items, and 'Speak again' starts a fresh recording", async () => {
    const user = await openVoice();
    await speak(user);
    await user.click(screen.getByRole("button", { name: "Remove Parle G" }));
    await user.click(addButton(1));

    await user.click(await screen.findByRole("button", { name: "Add by Voice" }));
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    await speak(user);
    // Speaking again discards the previous transcript and items.
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    expect(FakeRecognition.sessions).toHaveLength(3);
    expect(screen.queryByText("Detected items")).toBeNull();
    expect(screen.queryByLabelText("Transcript")).toBeNull();
    await speak(user);
    await user.click(screen.getByRole("button", { name: "Remove Parle G" }));
    await user.click(addButton(1));

    await waitFor(() => expect(confirmCalls()).toHaveLength(2));
    expect(backend.state.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/carts")).toHaveLength(1);
    expect(new Set(confirmCalls().map((c) => c.path)).size).toBe(1);
  });

  it("blocks 'Add to bill' while a chosen item has no valid quantity", async () => {
    const user = await openVoice();
    await speak(user);
    expect(addButton(2).disabled).toBe(true); // Parle G has no quantity yet
    await user.type(qty("Parle G"), "0");
    expect(addButton(2).disabled).toBe(true);
    await user.clear(qty("Parle G"));
    await user.type(qty("Parle G"), "2");
    expect(addButton(2).disabled).toBe(false);
    await user.clear(qty("2 Maggi"));
    expect(addButton(2).disabled).toBe(true);
    expect(confirmCalls()).toHaveLength(0);
  });

  it("says so when the browser has no speech recognition, and never pretends to listen", async () => {
    delete speechWindow.webkitSpeechRecognition;
    await openVoice(undefined, { tap: false });
    expect(screen.getByRole("alert").textContent).toContain("Voice input is not supported in this browser");
    expect(screen.queryByText("Listening… Speak your items.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Speak again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
    expect(FakeRecognition.sessions).toHaveLength(0);
  });

  it("explains a blocked microphone, a recognition error and silence, and sends nothing", async () => {
    const user = await openVoice();
    act(() => session().fail("not-allowed"));
    expect(screen.getByRole("alert").textContent).toContain("Microphone access was blocked");
    expect(screen.queryByText("Listening… Speak your items.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Speak again" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => session().fail("network"));
    expect(screen.getByRole("alert").textContent).toContain("could not reach the browser's speech service");

    // Stop without having said anything: an empty transcript is not sent.
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("alert").textContent).toContain("Nothing was heard");
    expect(screen.queryByLabelText("Transcript")).toBeNull();
    expect(parseCalls).toHaveLength(0);
    expect(screen.queryByText("Detected items")).toBeNull();
  });

  it("says so when no items are found in the transcript, and shows backend errors", async () => {
    parseVoice = async () => json({ transcript: "hello there", lines: [] });
    const user = await openVoice();
    await speak(user, "hello there");
    expect(screen.getByText("No items could be found in what was heard.")).toBeTruthy();
    expect(addButton(0).disabled).toBe(true);

    parseVoice = async () => json({ error: { code: "internal_error", message: "Something went wrong", details: null } }, 500);
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    act(() => session().hear("two Maggi"));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    expect(screen.queryByText("Detected items")).toBeNull();
  });

  it("Cancel releases the microphone and leaves the bill untouched", async () => {
    const user = await openVoice();
    act(() => session().hear("two Maggi", false));
    const listeningSession = session();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Add by Voice" })).toBeTruthy();
    expect(listeningSession.aborted).toBe(true);
    expect(parseCalls).toHaveLength(0);
    expect(backend.cartCalls()).toHaveLength(0);
  });
});

describe("voice review plan", () => {
  it("preselects only confident matches and never assumes a quantity", () => {
    const rows = initialRows(VOICE.lines);
    expect(rows.map((r) => [r.product?.id ?? null, r.quantity])).toEqual([
      [maggi.id, "2"],
      [null, "3"],
      [parle.id, ""],
      [null, "1"],
      [null, "2"],
    ]);
    expect(voicePlan(rows)).toEqual({
      items: [
        { product_id: maggi.id, quantity: "2" },
        { product_id: parle.id, quantity: "" },
      ],
      skipped: 3,
      missingQuantity: 1,
    });
    expect(voicePlan([])).toEqual({ items: [], skipped: 0, missingQuantity: 0 });
  });
});

describe("Counter: voice mode controls", () => {
  it("asks the recogniser for the chosen language, remembers it, and has no way to listen in the background", async () => {
    const user = await openVoice(undefined, { tap: false });
    const language = screen.getByLabelText("Language") as HTMLSelectElement;
    expect([...language.options].map((o) => o.textContent)).toEqual([
      "English",
      "हिंदी",
      "Hinglish",
      "தமிழ்",
      "বাংলা",
      "తెలుగు",
      "मराठी",
      "മലയാളം",
      "ಕನ್ನಡ",
      "ગુજરાતી",
    ]); // no auto-detect
    expect(language.value).toBe("en");

    await user.selectOptions(language, "hi");
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    expect([session().lang, session().started]).toEqual(["hi-IN", true]);
    expect(language.disabled).toBe(true); // not mid-sentence
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(FakeRecognition.sessions).toHaveLength(1); // stopping does not start another

    await user.selectOptions(language, "hinglish");
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    expect(session().lang).toBe("hi-IN"); // Hindi mixed with English: the browser's Hindi recogniser
    expect(localStorage.getItem("dukaanos.voice.language")).toBe("hinglish");

    cleanup();
    await openVoice(undefined, { tap: false });
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("hinglish");
    expect(FakeRecognition.sessions).toHaveLength(2);
  });

  it("lets the merchant correct what was heard and look again, without speaking again", async () => {
    const user = await openVoice();
    await speak(user, "add two Maggy");
    expect(parseCalls).toEqual([{ transcript: "add two Maggy" }]);
    expect(screen.queryByRole("button", { name: "Find items" })).toBeNull(); // nothing changed yet

    const box = screen.getByLabelText("Transcript");
    await user.clear(box);
    await user.type(box, "add two Maggi");
    await user.click(screen.getByRole("button", { name: "Find items" }));
    await waitFor(() => expect(parseCalls).toHaveLength(2));
    expect(parseCalls[1]).toEqual({ transcript: "add two Maggi" });
    expect(FakeRecognition.sessions).toHaveLength(1);
    expect(backend.cartCalls()).toHaveLength(0);
  });
});

describe("Counter: voice in Tamil, Bengali, Telugu, Marathi, Malayalam, Kannada and Gujarati", () => {
  it.each([
    ["ta", "ta-IN"],
    ["bn", "bn-IN"],
    ["te", "te-IN"],
    ["mr", "mr-IN"],
    ["ml", "ml-IN"],
    ["kn", "kn-IN"],
    ["gu", "gu-IN"],
  ])("asks the browser's recogniser for %s as %s, and for nothing else", async (id, locale) => {
    const user = await openVoice(undefined, { tap: false });
    await user.selectOptions(screen.getByLabelText("Language"), id);
    expect(FakeRecognition.sessions).toHaveLength(0); // choosing a language does not open the microphone
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    expect(FakeRecognition.sessions).toHaveLength(1);
    expect([session().lang, session().started]).toEqual([locale, true]);
    expect(localStorage.getItem("dukaanos.voice.language")).toBe(id);
  });

  it("sends what was heard as it was heard, whatever the script", async () => {
    const user = await openVoice(undefined, { tap: false });
    await user.selectOptions(screen.getByLabelText("Language"), "ta");
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    await speak(user, "இரண்டு மேகி சேர்க்கவும்");
    expect(parseCalls).toEqual([{ transcript: "இரண்டு மேகி சேர்க்கவும்" }]); // no language is sent: the backend reads the words
    expect(transcript()).toBe("இரண்டு மேகி சேர்க்கவும்");
  });

  it("says so when the browser cannot recognise the language, keeps the choice, and lets the items be typed", async () => {
    const user = await openVoice(undefined, { tap: false });
    const language = screen.getByLabelText("Language") as HTMLSelectElement;
    await user.selectOptions(language, "te");
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    act(() => session().fail("language-not-supported"));

    expect(screen.getByRole("alert").textContent).toContain("cannot recognise speech in the chosen language");
    expect(language.value).toBe("te"); // not switched to another language behind the merchant's back
    expect(FakeRecognition.sessions).toHaveLength(1); // and not retried in one
    expect(parseCalls).toHaveLength(0);

    // Retry is one tap away; so is typing.
    expect(screen.getByRole("button", { name: "Speak again" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Type the items instead" }));
    await user.type(screen.getByLabelText("Transcript"), "రెండు మ్యాగీ");
    await user.click(screen.getByRole("button", { name: "Find items" }));
    await waitFor(() => expect(parseCalls).toEqual([{ transcript: "రెండు మ్యాగీ" }]));
    expect(await screen.findByText("Detected items")).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0); // typed or spoken, nothing reaches the bill before review
  });
});

describe("Counter: spoken commands about the open bill", () => {
  const command = (intent: Schemas["VoiceResult"]["intent"], lines: Schemas["VoiceLine"][] = []) => {
    parseVoice = async () => json({ transcript: "said", intent, lines });
  };
  const lineCalls = () => backend.state.calls.filter((c) => /\/items\//.test(c.path));

  /** A bill with 2 Maggi and 3 Pepsi on it (added by voice), and Voice mode open again. */
  async function billThenVoice() {
    const user = await openVoice();
    await speak(user);
    await user.click(within(row("3 cold drink")).getByRole("button", { name: /Pepsi 750ml/ }));
    await user.click(screen.getByRole("button", { name: "Remove Parle G" }));
    await user.click(addButton(2));
    await user.click(await screen.findByRole("button", { name: "Add by Voice" }));
    await user.click(screen.getByRole("button", { name: "Tap to speak" }));
    return user;
  }
  async function say(user: ReturnType<typeof userEvent.setup>, said: string) {
    act(() => session().hear(said));
    await user.click(screen.getByRole("button", { name: "Stop" }));
  }

  it("reads the total from the bill itself and changes nothing", async () => {
    const user = await billThenVoice();
    command("total");
    await say(user, "what is the total");
    const total = await screen.findByRole("status", { name: "Bill total" });
    expect(total.textContent).toBe("Bill total so far: ₹148.00 for 2 items."); // 2×14 + 3×40
    expect(parseCalls.at(-1)).toEqual({ transcript: "what is the total", cart_id: "cart-1" }); // the open bill is named
    expect(lineCalls()).toHaveLength(0);
    expect(screen.queryByText("Detected items")).toBeNull();
  });

  it("removes a line only after the merchant confirms, through the bill's own operation", async () => {
    const user = await billThenVoice();
    command("remove", [line("v0", "Maggi", null, "matched", { product: maggi })]);
    await say(user, "remove Maggi from the bill");

    const remove = await screen.findByRole("button", { name: `Remove ${maggi.name}` });
    expect(lineCalls()).toHaveLength(0); // understanding the command is not doing it
    expect(within(billPanel()).getByText(maggi.name)).toBeTruthy();
    await user.click(remove);

    expect((await screen.findByText(`Removed ${maggi.name} from the bill.`)).textContent).toBeTruthy();
    expect(lineCalls().map((c) => [c.method, c.path])).toEqual([["DELETE", `/api/v1/carts/cart-1/items/line-${maggi.id}`]]);
    expect(within(billPanel()).queryByText(maggi.name)).toBeNull();
    expect(within(billPanel()).getByText(pepsi.name)).toBeTruthy(); // nothing else was touched
  });

  it("changes a quantity only after the merchant confirms, and never without a number", async () => {
    const user = await billThenVoice();
    command("set_quantity", [line("v0", "Maggi x 4", "4.000", "matched", { product: maggi, description: "Maggi" })]);
    await say(user, "change Maggi quantity to four");
    await user.click(await screen.findByRole("button", { name: `Set ${maggi.name} to 4` }));
    expect((await screen.findByText(`${maggi.name} is now 4.`)).textContent).toBeTruthy();
    expect(lineCalls().map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", `/api/v1/carts/cart-1/items/line-${maggi.id}`, { quantity: "4" }],
    ]);
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹176.00"); // 4×14 + 3×40

    command("set_quantity", [line("v0", "Pepsi", null, "matched", { product: pepsi, description: "Pepsi" })]);
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    await say(user, "change Pepsi quantity");
    expect((await screen.findByText(/No new quantity was heard for "Pepsi"/)).textContent).toBeTruthy();
    expect(lineCalls()).toHaveLength(1);
  });

  it("offers a choice when several lines could be meant, and says so when the item is not on the bill", async () => {
    const user = await billThenVoice();
    command("remove", [line("v0", "cold drink", null, "ambiguous", { candidates: [coke, pepsi, maggi] })]);
    await say(user, "remove the cold drink");
    // Only lines that are on the bill are offered: Coke is in the catalogue but not on this bill.
    expect(await screen.findByRole("button", { name: `Remove ${pepsi.name}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Remove ${maggi.name}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Remove ${coke.name}` })).toBeNull();
    expect(screen.getByText('Which "cold drink" on the bill?')).toBeTruthy();

    command("remove", [line("v0", "basmati rice", null, "unmatched", { description: "basmati rice" })]);
    await user.click(screen.getByRole("button", { name: "Speak again" }));
    await say(user, "remove basmati rice");
    expect((await screen.findByText('"basmati rice" is not on the bill.')).textContent).toBeTruthy();
    expect(lineCalls()).toHaveLength(0);
  });

  it("clears the bill only on an explicit confirmation", async () => {
    const user = await billThenVoice();
    command("clear");
    await say(user, "clear the bill");
    expect((await screen.findByText("Remove all 2 items from the bill?")).textContent).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep bill" }));
    expect(screen.getByText("The bill was kept as it is.")).toBeTruthy();
    expect(lineCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Speak again" }));
    await say(user, "clear the bill");
    await user.click(await screen.findByRole("button", { name: "Clear bill" }));
    expect((await screen.findByText("The bill was cleared.")).textContent).toBeTruthy();
    expect(lineCalls().map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    expect(within(billPanel()).queryByText(maggi.name)).toBeNull();
    expect(within(billPanel()).queryByText(pepsi.name)).toBeNull();
  });
});