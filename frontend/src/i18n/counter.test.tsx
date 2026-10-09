// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../app/router";
import { PaytmPay } from "../features/counter/paytm/PaytmPay";
import { CHECKOUT_UNAVAILABLE } from "../features/counter/paytm/checkout";
import type { usePaytm } from "../features/counter/paytm/usePaytm";
import { Receipt } from "../features/counter/Receipt";
import { LIVE, PRODUCTS, REAL_PROVIDER, VISION_RESULT, coke, colgate, createFakeBackend, json, maggi, parle, pepsi } from "../features/counter/vision/testing";
import { ApiError, type Schemas } from "../lib/api/client";
import { formatINR, formatQuantity } from "../lib/format";
import { dateLocaleOf, reloadAppLanguage, setAppLanguage, translateIn, type AppLanguage, type MessageKey } from "./index";

/**
 * Login and registration, and every Counter mode (Voice, Vision, Photo, Parchi, Barcode, Paytm and the
 * receipt), as the app renders them, in English and in Malayalam. The interface is the chosen language's;
 * product names, what the merchant said or wrote, codes and the backend's own identifiers stay exactly as
 * they are; and Voice keeps listening in its own language whatever the app is shown in.
 *
 * These are component tests in jsdom: the camera, the barcode decoder and the browser's speech recogniser
 * are stand-ins. They prove what each screen says and does, not that a real camera or microphone works.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

vi.mock("../features/counter/vision/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../features/counter/vision/camera")>()),
  captureFrame: vi.fn(async () => new Blob(["frame"], { type: "image/jpeg" })),
  captureRegion: vi.fn(async () => new Blob(["packet"], { type: "image/jpeg" })),
}));

const decoder = vi.hoisted(() => ({
  reading: { kind: "none" } as { kind: "none" } | { kind: "one"; code: string } | { kind: "several"; codes: string[] },
}));

vi.mock("../features/counter/barcode/scanner", () => ({ createDecoder: () => async () => decoder.reading }));

const refuse = (status: number, code: string, message: string) => json({ error: { code, message, details: null } }, status);

const LANGUAGES = ["en", "ml"] as const;
const MAGGI_CODE = "8901058000017";
const SESSION = { user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store", gstin: null } };

/** The browser's speech recogniser, as the tests drive it: what is heard, and when it ends or fails. */
class Recognition {
  static made: Recognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    Recognition.made.push(this);
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}
  hear(transcript: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript } }] });
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

const voiceLine = (id: string, raw_text: string, quantity: string | null, match: Schemas["MatchState"], extra: Partial<Schemas["VoiceLine"]> = {}): Schemas["VoiceLine"] => ({
  id, raw_text, description: raw_text, quantity, match, product: null, candidates: [], match_confidence: match === "unmatched" ? null : 1,
  matched_words: [], unmatched_words: [], ...extra,
}); // prettier-ignore

const SAID = "add two Maggi three cold drink Parle G one basmati rice and two colgat";
const LINES = [
  voiceLine("v0", "2 Maggi", "2.000", "matched", { product: maggi, matched_words: ["maggi"] }),
  voiceLine("v1", "3 cold drink", "3.000", "ambiguous", { candidates: [coke, pepsi] }),
  voiceLine("v2", "Parle G", null, "matched", { product: parle, matched_words: ["parle", "g"] }),
  voiceLine("v3", "1 basmati rice", "1.000", "unmatched", { unmatched_words: ["basmati", "rice"] }),
  voiceLine("v4", "2 colgat", "2.000", "low_confidence", { candidates: [colgate] }),
];
const PARCHI: Schemas["ParchiResult"] = {
  provider: "local-ocr (rapidocr)",
  text: "2 Maggi\n3 cold drink\nParle G\n1 basmati rice\n2 colgat",
  lines: LINES.map((line) => ({ ...line, read_confidence: null })),
};

/** What is data on these screens, not interface: it is shown as it is in every language. */
const DATA = [
  "DukaanOS", "Ramesh General Store", "Ramesh", "pcs", "UPI", "Paytm", "GST",
  ...PRODUCTS.map((p) => p.name), ...LINES.map((l) => l.raw_text), SAID,
]; // prettier-ignore

let backend: ReturnType<typeof createFakeBackend>;
let loggedIn: boolean;
let login: () => Response;
let register: () => Response;
let parseVoice: () => Response;
let readParchi: () => Response;
const speechWindow = window as unknown as { webkitSpeechRecognition?: unknown };

beforeEach(() => {
  localStorage.clear();
  reloadAppLanguage();
  backend = createFakeBackend();
  loggedIn = true;
  login = () => json(SESSION);
  register = () => json(SESSION, 201);
  parseVoice = () => json({ transcript: SAID, intent: "add", lines: LINES } satisfies Schemas["VoiceResult"]);
  readParchi = () => json(PARCHI);
  decoder.reading = { kind: "none" };
  Recognition.made = [];
  speechWindow.webkitSpeechRecognition = Recognition;
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`;
    if (route === "GET /api/v1/auth/me") return loggedIn ? json(SESSION) : refuse(401, "unauthorized", "Not authenticated");
    if (route === "POST /api/v1/auth/login") return login();
    if (route === "POST /api/v1/auth/register") return register();
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "GET /api/v1/assistant/status") return json({ available: false, reason: "", capabilities: [] });
    if (route === "GET /api/v1/insights/summary") return json({ open_insight_count: 0 });
    if (route === "POST /api/v1/voice/parse") return parseVoice();
    if (route === "POST /api/v1/parchi/read") return readParchi();
    if (route === "GET /api/v1/products") return json(PRODUCTS.map((p) => (p.id === maggi.id ? { ...p, barcode: MAGGI_CODE } : p)));
    if (route === "POST /api/v1/carts/cart-1/items") {
      // A scanned barcode: the shared fake only knows the recognized-items path, which does the same to the bill.
      const body = (await req.clone().json()) as Schemas["CartItemAdd"];
      if (body.barcode !== MAGGI_CODE) return refuse(404, "not_found", `Barcode not found: ${body.barcode}`);
      return backend.handle(
        new Request("http://test/api/v1/carts/cart-1/recognized-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "barcode", items: [{ product_id: maggi.id, quantity: "1" }] }),
        }),
      );
    }
    if (req.method === "GET" && !/^\/api\/v1\/(products|carts|customers|khata)/.test(path)) return json([]);
    return backend.handle(req);
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete speechWindow.webkitSpeechRecognition;
  localStorage.clear();
  reloadAppLanguage();
});

function sayIn(language: AppLanguage) {
  return (key: MessageKey, values?: Record<string, string | number>) => translateIn(language, key, values);
}

function load(path: string, language: AppLanguage) {
  act(() => setAppLanguage(language));
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
  return { user, say: sayIn(language) };
}

function show(node: ReactNode, language: AppLanguage) {
  act(() => setAppLanguage(language));
  render(node);
  return sayIn(language);
}

/** Latin words left on the screen once the data is taken out: in Malayalam there should be none. */
function latinWordsOnScreen(identifiers: string[] = []): string[] {
  const pieces: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? "");
  for (const el of document.body.querySelectorAll("*"))
    for (const name of ["aria-label", "placeholder", "title", "alt"]) pieces.push(el.getAttribute(name) ?? "");
  const same = new Set(["AI", "AM", "PM", "am", "pm", "MB"]);
  const words = new Set<string>();
  for (let piece of pieces) {
    for (const value of [...DATA, ...identifiers].sort((a, b) => b.length - a.length)) piece = piece.split(value).join(" ");
    for (const word of piece.match(/[A-Za-z]{2,}/g) ?? []) if (!same.has(word)) words.add(word);
  }
  return [...words].sort();
}

/** Puts a working (or refusing) webcam behind navigator.mediaDevices. */
function fakeCamera(refusal?: DOMException) {
  const track = { stop: vi.fn(), addEventListener: () => {} };
  const getUserMedia = vi.fn(async () => {
    if (refusal) throw refusal;
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  let attached: unknown = null;
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { get: () => attached, set: (v) => (attached = v), configurable: true });
}

/** What the Counter sent to the bill from a review (the confirmed items), newest last. */
const added = () => backend.cartCalls().filter((c) => c.path.endsWith("/recognized-items"));

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" });

describe.each(LANGUAGES)("Login and registration in %s", (language) => {
  it("the forms and the demo hint; a wrong password and a taken email are said plainly", async () => {
    loggedIn = false;
    login = () => refuse(401, "unauthorized", "Invalid email or password");
    register = () => refuse(409, "conflict", "An account with this email already exists");
    const { user, say } = load("/login", language);

    expect(await screen.findByText(say("auth.loginTitle"))).toBeTruthy();
    expect(screen.getByRole("heading", { name: "DukaanOS" })).toBeTruthy(); // the product's name, in every language
    expect(screen.getByText(say("app.productLine"))).toBeTruthy();
    expect((screen.getByPlaceholderText(say("auth.email")) as HTMLInputElement).value).toBe("ramesh@dukaanos.dev");
    expect(screen.getByPlaceholderText(say("auth.password"))).toBeTruthy();
    expect(screen.getByText(say("auth.demo", { email: "ramesh@dukaanos.dev", password: "demo1234" }))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(["ramesh@dukaanos.dev", "demo1234"])).toEqual([]);

    await user.click(screen.getByRole("button", { name: say("auth.logIn") }));
    // English shows the backend's own message; elsewhere, a line that says what went wrong (not "you are logged out").
    expect(await screen.findByText(language === "en" ? "Invalid email or password" : say("auth.wrongLogin"))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: say("auth.toRegister") }));
    expect(screen.getByText(say("auth.registerTitle"))).toBeTruthy();
    await user.type(screen.getByPlaceholderText(say("auth.yourName")), "Sunita");
    await user.type(screen.getByPlaceholderText(say("auth.storeName")), "Sunita Kirana");
    await user.clear(screen.getByPlaceholderText(say("auth.email")));
    await user.type(screen.getByPlaceholderText(say("auth.email")), "sunita@example.com");
    await user.type(screen.getByPlaceholderText(say("auth.password")), "longenough");
    await user.click(screen.getByRole("button", { name: say("auth.createAccount") }));
    expect(await screen.findByText(language === "en" ? "An account with this email already exists" : say("auth.emailTaken"))).toBeTruthy();
    expect(screen.getByRole("button", { name: say("auth.toLogin") })).toBeTruthy();
    expect(screen.queryByText(say("auth.demo", { email: "ramesh@dukaanos.dev", password: "demo1234" }))).toBeNull();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("a server that cannot be reached is said in the language; a right password opens the app", async () => {
    loggedIn = false;
    login = () => {
      throw new TypeError("Failed to fetch");
    };
    const { user, say } = load("/login", language);
    await user.click(await screen.findByRole("button", { name: say("auth.logIn") }));
    expect(await screen.findByText(language === "en" ? "Failed to fetch" : say("error.network"))).toBeTruthy();

    login = () => json(SESSION);
    await user.click(screen.getByRole("button", { name: say("auth.logIn") }));
    expect(await screen.findByRole("button", { name: say("shell.logout") })).toBeTruthy();
  });
});

describe.each(LANGUAGES)("Voice billing in %s", (language) => {
  const SPOKEN = ["English", "हिंदी", "Hinglish", "தமிழ்", "বাংলা", "తెలుగు", "मराठी", "മലയാളം", "ಕನ್ನಡ", "ગુજરાતી"];

  it("listening, what was heard and its review; Voice still listens in its own language", async () => {
    const { user, say } = load("/counter/voice", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.voice.name") }));
    expect(panel.getByRole("heading", { name: say("counter.mode.voice.name") })).toBeTruthy();
    expect(panel.getByText(say("voice.say"))).toBeTruthy();
    const spoken = panel.getByLabelText(say("voice.language")) as HTMLSelectElement;
    expect(spoken.value).toBe("en"); // the app's language did not choose it
    expect([...spoken.options].map((o) => o.textContent)).toEqual(SPOKEN); // each language by its own name
    if (language === "ml") expect(latinWordsOnScreen(SPOKEN)).toEqual([]);

    await user.click(panel.getByRole("button", { name: say("voice.tapToSpeak") }));
    expect(Recognition.made.at(-1)!.lang).toBe("en-IN");
    expect(panel.getByRole("status").textContent).toBe(say("voice.listening"));
    act(() => Recognition.made.at(-1)!.hear(SAID));
    await user.click(panel.getByRole("button", { name: say("voice.stop") }));

    expect(await panel.findByRole("heading", { name: say("voice.detected") })).toBeTruthy();
    expect((panel.getByLabelText(say("voice.transcript")) as HTMLInputElement).value).toBe(SAID); // what was said, as said
    for (const header of [say("voice.heard"), say("review.quantity"), say("review.catalogueMatch")])
      expect(panel.getByRole("columnheader", { name: header })).toBeTruthy();
    const row = (text: string) => within(panel.getByRole("row", { name: say("voice.item", { text }) }));
    expect(row("1 basmati rice").getByText(say("review.notFound"))).toBeTruthy();
    expect(row("2 colgat").getByText(say("review.notSure"))).toBeTruthy();
    expect(row("3 cold drink").getByText(say("review.which"))).toBeTruthy();
    expect(row("Parle G").getByText(say("voice.notSaid"))).toBeTruthy();
    expect(row("2 Maggi").getByText(maggi.name)).toBeTruthy();
    expect(row("2 Maggi").getByRole("button", { name: say("review.changeFor", { text: "2 Maggi" }) }).textContent).toBe(say("review.change"));
    expect(row("2 Maggi").getByRole("button", { name: say("review.removeNamed", { name: "2 Maggi" }) }).textContent).toBe(say("common.remove"));
    expect(row("1 basmati rice").getByLabelText(say("review.findFor", { text: "1 basmati rice" }))).toBeTruthy();
    expect(panel.getAllByPlaceholderText(say("review.searchCatalogue"))).toHaveLength(3);
    const waiting = panel.getByText(say("review.enterQuantity.one", { count: 1 }));
    expect(waiting.parentElement!.textContent).toBe(`${say("review.enterQuantity.one", { count: 1 })} ${say("review.skipped", { count: 3 })}`);
    const add = panel.getByRole("button", { name: say("review.addToBill", { count: 2 }) }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // nothing is added while a chosen item has no quantity
    if (language === "ml") expect(latinWordsOnScreen(SPOKEN)).toEqual([]);

    await user.type(panel.getByLabelText(say("review.quantityFor", { text: "Parle G" })), "1");
    await user.click(add);
    expect(added().at(-1)!.body).toEqual({ source: "voice", items: [{ product_id: maggi.id, quantity: "2" }, { product_id: parle.id, quantity: "1" }] });
  });

  it("a blocked microphone, typing instead, and a spoken question about the bill", async () => {
    const { user, say } = load("/counter/voice", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.voice.name") }));
    await user.click(panel.getByRole("button", { name: say("voice.tapToSpeak") }));
    act(() => Recognition.made.at(-1)!.fail("not-allowed"));
    expect(panel.getByRole("alert").textContent).toBe(say("voice.error.blocked"));
    expect(panel.getByRole("button", { name: say("voice.speakAgain") })).toBeTruthy();

    await user.click(panel.getByRole("button", { name: say("voice.typeInstead") }));
    parseVoice = () => json({ transcript: "bill kitna hua", intent: "total", lines: [] } satisfies Schemas["VoiceResult"]);
    await user.type(panel.getByLabelText(say("voice.transcript")), "bill kitna hua");
    await user.click(panel.getByRole("button", { name: say("voice.findItems") }));
    expect((await panel.findByRole("status", { name: say("voice.billTotal") })).textContent).toBe(say("voice.billEmpty"));
    if (language === "ml") expect(latinWordsOnScreen(SPOKEN)).toEqual([]);

    parseVoice = () => refuse(422, "validation_error", "Say at least one word");
    await user.type(panel.getByLabelText(say("voice.transcript")), " please");
    await user.click(panel.getByRole("button", { name: say("voice.findItems") }));
    // The microphone's alert stays; the failed request has its own.
    expect(await panel.findByText(language === "en" ? "Say at least one word" : say("error.validation_error"))).toBeTruthy();
  });
});

describe.each(LANGUAGES)("Add from photo in %s", (language) => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("a file that is not a photo, the detections to check, and the boxes over the picture", async () => {
    const { user, say } = load("/counter/photo", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.photo.name") }));
    expect(panel.getByRole("button", { name: say("photo.choose") })).toBeTruthy();
    const input = panel.getByLabelText(say("photo.input"));

    fireEvent.change(input, { target: { files: [new File(["x"], "list.gif", { type: "image/gif" })] } });
    expect(panel.getByRole("alert").textContent).toBe(say("image.wrongType"));

    fireEvent.change(input, { target: { files: [png()] } });
    expect(await panel.findByRole("heading", { name: say("vision.detected") })).toBeTruthy();
    expect(panel.getByRole("img", { name: say("photo.uploaded") })).toBeTruthy();
    expect(panel.getByRole("button", { name: say("review.chooseAnother") })).toBeTruthy();
    const item = (index: number, label: string) => within(panel.getByRole("listitem", { name: say("vision.detection", { index, label }) }));
    const first = VISION_RESULT.detections[0];
    expect(item(1, first.label!).getByText(`${say("vision.seenAs", { index: 1, label: first.label! })} · ${say("vision.percentSure", { percent: 94 })}`)).toBeTruthy();
    expect((item(1, first.label!).getByLabelText(say("vision.qty")) as HTMLInputElement).value).toBe("2");
    expect(item(3, "Cold drink 750ml").getByText(say("review.which"))).toBeTruthy();
    expect(item(4, "Parle-G Biscuits").getByText(say("review.notSure"))).toBeTruthy();
    expect(item(5, "Red toothpaste tube").getByText(say("vision.notMatched"))).toBeTruthy();
    expect(item(5, "Red toothpaste tube").getByLabelText(say("review.findFor", { text: "Red toothpaste tube" }))).toBeTruthy();
    expect(panel.getAllByPlaceholderText(say("vision.searchCatalog"))).toHaveLength(3);
    expect(panel.getAllByRole("button", { name: say("common.remove") })).toHaveLength(5);
    expect(panel.getByText(say("vision.skipped", { count: 3 }))).toBeTruthy();
    const boxes = within(panel.getByRole("list", { name: say("vision.detections") }));
    expect(boxes.getByRole("listitem", { name: say("vision.box", { index: 1, title: maggi.name }) })).toBeTruthy();
    expect(boxes.getByRole("listitem", { name: say("vision.box", { index: 5, title: "Red toothpaste tube" }) })).toBeTruthy();
    const labels = VISION_RESULT.detections.map((d) => d.label!);
    if (language === "ml") expect(latinWordsOnScreen(labels)).toEqual([]);

    // Saying which one it is: the row can be changed back, and the count to add follows.
    await user.click(item(4, "Parle-G Biscuits").getByRole("button", { name: new RegExp(parle.name) }));
    expect(item(4, "Parle-G Biscuits").getByRole("button", { name: say("review.change") })).toBeTruthy();
    await user.click(panel.getByRole("button", { name: say("review.addToBill", { count: 3 }) }));
    await vi.waitFor(() => expect(added().at(-1)!.body).toMatchObject({ source: "vision" }));
  });

  it("a test provider says so, and a recognition failure is said in the language", async () => {
    const { say } = load("/counter/photo", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.photo.name") }));
    backend.state.recognize = async () => json({ ...VISION_RESULT, provider: "mock", is_mock: true, detections: [] });
    fireEvent.change(panel.getByLabelText(say("photo.input")), { target: { files: [png()] } });
    expect((await panel.findByRole("note")).textContent).toBe(say("photo.mock", { provider: "mock" }));
    expect(panel.getByText(say("photo.nothing"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(["mock"])).toEqual([]);

    backend.state.recognize = async () => refuse(503, "vision_unavailable", "Vision provider is disabled (VISION_PROVIDER=none)");
    fireEvent.change(panel.getByLabelText(say("photo.input")), { target: { files: [png()] } });
    expect((await panel.findByRole("alert")).textContent).toBe(
      language === "en" ? "Vision provider is disabled (VISION_PROVIDER=none)" : say("error.vision_unavailable"),
    );
  });
});

describe.each(LANGUAGES)("Add from Parchi in %s", (language) => {
  it("the lines read from the parchi, why each was matched, and what still needs the merchant", async () => {
    const { user, say } = load("/counter/parchi", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.parchi.name") }));
    expect(panel.getByRole("button", { name: say("parchi.choose") })).toBeTruthy();
    fireEvent.change(panel.getByLabelText(say("parchi.photo")), { target: { files: [png()] } });

    expect(await panel.findByRole("heading", { name: say("parchi.items") })).toBeTruthy();
    expect(panel.getByRole("button", { name: say("review.chooseAnother") })).toBeTruthy();
    expect(panel.getByRole("columnheader", { name: say("parchi.item") })).toBeTruthy();
    const row = (text: string) => within(panel.getByRole("row", { name: say("parchi.itemNamed", { text }) }));
    expect(row("2 Maggi").getByText(say("parchi.matchedOn", { words: "maggi" }))).toBeTruthy(); // the parchi's own words
    expect(row("Parle G").getByText(say("parchi.notOnParchi"))).toBeTruthy();
    expect(row("1 basmati rice").getByText(say("review.notFound"))).toBeTruthy();
    expect(row("2 colgat").getByText(say("review.notSure"))).toBeTruthy();
    expect(panel.getByText(say("parchi.textRead", { provider: PARCHI.provider }))).toBeTruthy();
    const waiting = panel.getByText(say("review.enterQuantity.one", { count: 1 }));
    expect(waiting.parentElement!.textContent).toBe(`${say("review.enterQuantity.one", { count: 1 })} ${say("review.skipped", { count: 3 })}`);
    if (language === "ml") expect(latinWordsOnScreen(["maggi", "parle", PARCHI.provider, PARCHI.text, "photo.png"])).toEqual([]);

    // Every line removed: nothing is left to add.
    for (const text of LINES.map((l) => l.raw_text)) await user.click(panel.getByRole("button", { name: say("review.removeNamed", { name: text }) }));
    expect(panel.getByText(say("review.allRemoved"))).toBeTruthy();
    expect((panel.getByRole("button", { name: say("review.addToBill", { count: 0 }) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a parchi that cannot be read is said in the language", async () => {
    readParchi = () => refuse(422, "parchi_failed", "OCR found no text (rapidocr)");
    const { say } = load("/counter/parchi", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.parchi.name") }));
    fireEvent.change(panel.getByLabelText(say("parchi.photo")), { target: { files: [png()] } });
    expect((await panel.findByRole("alert")).textContent).toBe(language === "en" ? "OCR found no text (rapidocr)" : say("error.parchi_failed"));
  });
});

describe.each(LANGUAGES)("The live Vision counter in %s", (language) => {
  it("what is on the counter, what is unsure or unknown, and adding it to the bill", async () => {
    fakeCamera();
    backend.showScene([LIVE.maggi, LIVE.parle, LIVE.unknown]);
    const { user, say } = load("/counter/vision", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.live.name") }));
    expect(await panel.findByText(`● ${say("live.live")}`)).toBeTruthy();
    expect(panel.getByRole("button", { name: say("camera.stop") })).toBeTruthy();
    const counter = within(await panel.findByRole("list", { name: say("live.onCounter") }));
    expect(panel.getByText(say("live.onCounterNow"))).toBeTruthy();
    expect(panel.getByText(say("live.nothingBilled"))).toBeTruthy();
    expect(panel.getByRole("note", { name: say("live.provider") }).textContent).toBe(`${say("live.model")} ${REAL_PROVIDER} · ${say("live.fromCamera")}`);

    const row = (name: string) => within(counter.getByRole("listitem", { name }));
    const addMaggi = row(maggi.name).getByRole("button", { name: say("live.addQuantity", { quantity: formatQuantity("1"), name: maggi.name }) });
    expect(addMaggi.textContent).toBe(say("live.addTimes", { count: 1 }));
    expect(row(parle.name).getByText(say("live.unsureConfirm"))).toBeTruthy();
    expect(row("Red toothpaste tube").getByText(say("live.unknown", { title: "Red toothpaste tube" }))).toBeTruthy();
    expect(row("Red toothpaste tube").getByText(say("live.notInCatalog"))).toBeTruthy();
    expect(panel.getByRole("button", { name: say("live.addAllReady", { count: 1 }) })).toBeTruthy();
    const boxes = within(panel.getByRole("list", { name: say("vision.detections") }));
    expect(boxes.getByRole("listitem", { name: say("vision.box", { index: 2, title: parle.name }) }).textContent).toContain(say("vision.unsure"));
    const identifiers = [REAL_PROVIDER, ...Object.values(LIVE).map((d) => d.label!)];
    if (language === "ml") expect(latinWordsOnScreen(identifiers)).toEqual([]);

    // The merchant says what the unsure one is; it can be taken back, or remembered for next time.
    await user.click(row(parle.name).getByRole("button", { name: say("live.yesIts", { name: parle.name }) }));
    expect(row(parle.name).getByRole("button", { name: say("live.change") })).toBeTruthy();
    const remember = row(parle.name).getByRole("button", { name: say("live.remember", { name: parle.name }) });
    expect(remember.textContent).toBe(say("live.rememberThis"));
    expect(remember.getAttribute("title")).toBe(say("live.rememberHelp"));

    await user.click(addMaggi);
    expect(await row(maggi.name).findByText(`✓ ${say("live.added")}`)).toBeTruthy();
    expect(await row(maggi.name).findByText(`· ${say("live.inBill", { count: 1 })}`)).toBeTruthy();
    expect(added().at(-1)!.body).toEqual({ source: "vision", items: [{ product_id: maggi.id, quantity: "1" }] });
    if (language === "ml") expect(latinWordsOnScreen(identifiers)).toEqual([]);
  });

  it("a camera the browser refuses is said in the language, with a way to try again", async () => {
    fakeCamera(new DOMException("denied", "NotAllowedError"));
    const { say } = load("/counter/vision", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.live.name") }));
    const alert = within(await panel.findByRole("alert"));
    expect(alert.getByText(say("camera.denied"))).toBeTruthy();
    expect(alert.getByRole("button", { name: say("common.tryAgain") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });
});

describe.each(LANGUAGES)("Scanning barcodes in %s", (language) => {
  it("typed codes: one that is not in the catalogue, and one that is", async () => {
    const { user, say } = load("/counter/barcode", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.barcode.name") }));
    expect(panel.getByText(say("barcode.waiting"))).toBeTruthy();
    expect(panel.getByText(say("barcode.or"))).toBeTruthy();
    expect(panel.getByRole("note").textContent).toBe(say("barcode.note"));
    expect(panel.getByRole("button", { name: say("barcode.startCamera") })).toBeTruthy();
    expect(panel.getByText(say("barcode.cameraNote"))).toBeTruthy();
    const box = panel.getByLabelText(say("barcode.label"));
    expect(box.getAttribute("placeholder")).toBe(say("barcode.placeholder"));
    if (language === "ml") expect(latinWordsOnScreen(["USB", "Enter"])).toEqual([]);

    await user.type(box, "1234567890123{Enter}");
    const problem = within(await panel.findByRole("alert"));
    expect(problem.getByText(say("barcode.notFound"))).toBeTruthy();
    expect(problem.getByText(say("barcode.notFoundDetail"), { exact: false }).textContent).toBe(`1234567890123 · ${say("barcode.notFoundDetail")}`);
    expect(problem.getByRole("button", { name: say("barcode.searchInstead") })).toBeTruthy();

    await user.type(box, `${MAGGI_CODE}{Enter}`);
    const added = within(await panel.findByRole("status"));
    expect(added.getByText(say("barcode.added"))).toBeTruthy();
    expect(added.getByText(maggi.name)).toBeTruthy();
    expect(added.getByText(say("barcode.inThisBill", { quantity: "1" }), { exact: false }).textContent).toBe(`${MAGGI_CODE} · ${say("barcode.inThisBill", { quantity: "1" })}`);
    expect(added.getByText(say("barcode.per", { unit: "pcs" }))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(["USB", "Enter"])).toEqual([]);
  });

  it("the camera scanner's own words, and a refused camera", async () => {
    fakeCamera();
    const { user, say } = load("/counter/barcode", language);
    const panel = within(await screen.findByRole("region", { name: say("counter.mode.barcode.name") }));
    expect(panel.getByRole("group", { name: say("barcode.cameraScanner") })).toBeTruthy();
    await user.click(panel.getByRole("button", { name: say("barcode.startCamera") }));
    const status = await panel.findByLabelText(say("barcode.cameraStatus"));
    await vi.waitFor(() => expect(status.textContent).toBe(say("barcode.hold")));
    decoder.reading = { kind: "several", codes: [MAGGI_CODE, "8900000000015"] };
    await vi.waitFor(() => expect(status.textContent).toBe(say("barcode.severalInView")));
    expect(panel.getByLabelText(say("barcode.camera"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(["USB", "Enter"])).toEqual([]);
    await user.click(panel.getByRole("button", { name: say("camera.stop") }));

    fakeCamera(new DOMException("denied", "NotAllowedError"));
    await user.click(panel.getByRole("button", { name: say("barcode.startCamera") }));
    expect((await panel.findByRole("alert")).textContent).toBe(say("barcode.cameraProblem", { message: say("camera.denied") }));
    expect(panel.getByRole("button", { name: say("barcode.tryCamera") })).toBeTruthy();
  });
});

describe.each(LANGUAGES)("The receipt in %s", (language) => {
  const ZERO_TAX = { taxable_value: "0.00", cgst: "0.00", sgst: "0.00", total_tax: "0.00" };
  const order = (extra: Partial<Schemas["OrderRead"]> = {}): Schemas["OrderRead"] => ({
    id: "a1b2c3d4-0000-0000-0000-000000000000", customer_id: null, cart_id: "cart-1", customer_name: null, customer_phone: null,
    channel: "counter", status: "completed", subtotal: "128.00", discount: "8.00", total: "120.00", payment_status: "paid",
    tax_summary: { taxable_value: "114.29", cgst: "2.86", sgst: "2.86", total_tax: "5.71" },
    created_at: "2026-10-03T10:00:00Z", updated_at: "2026-10-03T10:00:00Z",
    items: [{ id: "o-1", product_id: maggi.id, product_name: maggi.name, quantity: "2.000", unit_price: "64.00", tax_rate: "5.00", line_total: "128.00", source: "voice" }],
    ...extra,
  }); // prettier-ignore
  const payment = (method: string, amount: string, provider: string, reference: string | null): Schemas["PaymentRead"] => ({
    id: `pay-${method}`, order_id: "a1b2c3d4", customer_id: null, amount, method, status: "succeeded", provider, external_reference: reference, created_at: "",
  }) as Schemas["PaymentRead"]; // prettier-ignore
  const RAHUL = { id: "c-rahul", name: "Rahul Sharma", phone: "9810010001", created_at: "", updated_at: "" };
  const receipt = (bill: Schemas["BillRead"]) => <Receipt bill={bill} storeName="Ramesh General Store" storeGstin="07ABCDE1234F1Z5" onNext={() => {}} />;
  const SAME = ["GSTIN", "07ABCDE1234F1Z5", "CGST", "SGST", "A1B2C3D4", "T2026100312345", "Rahul Sharma"];

  it("a bill paid by Paytm and cash: how it was settled, the GST, and the bill's number and time", () => {
    const say = show(receipt({
      order: order(), customer: null, khata_entry: null, customer_balance: null,
      payments: [payment("paytm", "100.00", "paytm", "T2026100312345"), payment("cash", "20.00", "manual", null)],
    }), language); // prettier-ignore
    expect(screen.getByText(`${say("receipt.paymentSuccessful")} ✓ ${say("receipt.verifiedByPaytm")}`)).toBeTruthy();
    expect(screen.getByText(say("paytm.reference", { reference: "T2026100312345" }))).toBeTruthy();
    expect(screen.getByText("GSTIN: 07ABCDE1234F1Z5")).toBeTruthy();
    const when = new Date("2026-10-03T10:00:00Z").toLocaleString(dateLocaleOf(language), { dateStyle: "medium", timeStyle: "short" });
    expect(screen.getByText(`${say("receipt.billNumber", { number: "A1B2C3D4" })} · ${when}`)).toBeTruthy();
    const terms = screen.getAllByRole("term").map((dt) => dt.textContent);
    expect(terms).toEqual([
      say("cart.subtotal"), say("cart.discount"), say("cart.total"),
      say("receipt.paid", { method: say("cart.method.paytm") }), say("receipt.paid", { method: say("cart.method.cash") }),
      say("receipt.taxableValue"), "CGST", "SGST", say("receipt.totalGst"),
    ]); // prettier-ignore
    expect(screen.getByRole("button", { name: say("receipt.newBill") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
  });

  it("a bill on khata, a bill saved unpaid, and one paid in cash", () => {
    const say = show(receipt({
      order: order({ payment_status: "unpaid", tax_summary: ZERO_TAX }), customer: RAHUL, payments: [], customer_balance: "850.00",
      khata_entry: { id: "k-1", customer_id: RAHUL.id, type: "credit", amount: "120.00", description: "Counter bill", order_id: "a1b2c3d4", payment_id: null, source: "manual", created_at: "" },
    } as Schemas["BillRead"]), language); // prettier-ignore
    expect(screen.getByText(say("receipt.addedToKhata"))).toBeTruthy();
    expect(screen.getByText(say("receipt.onKhata"))).toBeTruthy();
    expect(screen.getByText(say("receipt.khataBalance", { name: "Rahul Sharma" }), { exact: false }).textContent).toBe(
      `${say("receipt.khataBalance", { name: "Rahul Sharma" })} ${formatINR("850.00")}`,
    );
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
    cleanup();

    show(receipt({ order: order({ payment_status: "unpaid" }), customer: null, payments: [], khata_entry: null, customer_balance: null }), language);
    expect(screen.getByText(say("receipt.billSaved"))).toBeTruthy();
    cleanup();
    show(receipt({ order: order(), customer: null, payments: [payment("upi", "120.00", "manual", null)], khata_entry: null, customer_balance: null }), language);
    expect(screen.getByText(say("receipt.paymentReceived"))).toBeTruthy();
    expect(screen.getByText(say("receipt.paid", { method: say("cart.method.upi") }))).toBeTruthy();
  });
});

describe.each(LANGUAGES)("Paying with Paytm in %s", (language) => {
  const mutation = () => ({ isPending: false, mutate: vi.fn(), reset: vi.fn() });
  const BASE = {
    id: "ptm-1", cart_id: "cart-1", order_id: null, environment: "sandbox", amount: "120.00", discount: "0.00", paytm_order_id: "DKN-1",
    txn_id: null, bank_txn_id: null, payment_mode: null, result_code: null, result_msg: null, detail: null, verified_at: null, created_at: "", updated_at: "",
  }; // prettier-ignore
  const paytm = (payment: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    ({
      enabled: true, environment: "sandbox", payment: payment && { ...BASE, ...payment },
      live: payment?.status === "pending" || payment?.status === "needs_review", busy: false, error: null, checkoutError: null,
      start: mutation(), verify: mutation(), cancel: mutation(), ...extra,
    }) as unknown as ReturnType<typeof usePaytm>; // prettier-ignore
  const pay = (state: ReturnType<typeof usePaytm>) => <PaytmPay paytm={state} total="120.00" discount="0" ready />;
  const amount = formatINR("120.00");
  const SAME = ["Paytm", "Txn Pending", "Insufficient balance.", "T2026100312345"];

  it("before paying, while pending, and when Paytm holds money for a bill that was not completed", () => {
    let say = show(pay(paytm(null)), language);
    expect(screen.getByText(say("paytm.sandbox"))).toBeTruthy();
    expect(screen.getByRole("button", { name: say("paytm.pay", { amount }) })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
    cleanup();

    say = show(pay(paytm({ status: "pending", result_msg: "Txn Pending" })), language);
    expect(screen.getByRole("status").textContent).toBe(`${say("paytm.pending", { amount })}Paytm: Txn Pending`); // Paytm's own words
    for (const name of [say("paytm.checkStatus"), say("paytm.continue"), say("paytm.cancelPayment")]) expect(screen.getByRole("button", { name })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
    cleanup();

    say = show(pay(paytm({ status: "needs_review", txn_id: "T2026100312345" })), language);
    expect(screen.getByRole("alert").textContent).toBe(`${say("paytm.needsReview")}${say("paytm.reference", { reference: "T2026100312345" })}`);
    expect(screen.getByRole("button", { name: say("paytm.checkAgain") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
  });

  it("failed, cancelled, a payment page that would not open, and the backend refusing", () => {
    let say = show(pay(paytm({ status: "failed", result_msg: "Insufficient balance." })), language);
    expect(screen.getByRole("alert").textContent).toBe(say("paytm.failedBecause", { reason: "Insufficient balance." }));
    cleanup();
    say = show(pay(paytm({ status: "failed" })), language);
    expect(screen.getByRole("alert").textContent).toBe(say("paytm.failed"));
    cleanup();
    say = show(pay(paytm({ status: "cancelled" })), language);
    expect(screen.getByRole("status").textContent).toBe(say("paytm.cancelled"));
    cleanup();
    say = show(pay(paytm(null, { checkoutError: CHECKOUT_UNAVAILABLE })), language);
    expect(screen.getByRole("alert").textContent).toBe(say("paytm.checkoutUnavailable"));
    cleanup();
    const refused = new ApiError(503, "paytm_unavailable", "Paytm is not configured (PAYTM_ENABLED=false)");
    say = show(pay(paytm(null, { error: refused })), language);
    expect(screen.getByRole("alert").textContent).toBe(language === "en" ? refused.message : say("error.paytm_unavailable"));
    if (language === "ml") expect(latinWordsOnScreen(SAME)).toEqual([]);
  });
});
