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
    if (req.method === "POST" && new URL(req.url).pathname === "/api/v1/voice/parse") {
      parseCalls.push(await req.clone().json());
      return parseVoice();
    }
    return backend.handle(req);
  };
});

afterEach(() => {
  cleanup();
  delete speechWindow.webkitSpeechRecognition;
  delete speechWindow.SpeechRecognition;
});

async function openVoice(user = userEvent.setup()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Add by Voice" }));
  return user;
}

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
  it("listens as soon as it opens, shows the words as they are heard, and parses only after Stop", async () => {
    const user = await openVoice();

    expect(screen.getByRole("status").textContent).toContain("Listening… Speak your items.");
    expect(FakeRecognition.sessions).toHaveLength(1);
    expect([session().started, session().lang, session().continuous, session().interimResults]).toEqual([
      true,
      "en-IN",
      true,
      true,
    ]);

    act(() => session().hear("add two", false)); // still speaking
    expect(screen.getByLabelText("Transcript").textContent).toBe("add two");
    act(() => session().hear("add two Maggi"));
    act(() => session().hear("three cold drink", false));
    expect(screen.getByLabelText("Transcript").textContent).toBe("add two Maggi three cold drink");
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

    expect(screen.getByLabelText("Transcript").textContent).toBe(SAID);
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
    await openVoice();
    expect(screen.getByRole("alert").textContent).toContain("Voice input is not supported in this browser");
    expect(screen.queryByText("Listening… Speak your items.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Speak again" })).toBeNull();
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
