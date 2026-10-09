// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../app/router";
import { createFakeBackend, json, maggi } from "../features/counter/vision/testing";
import { APP_LANGUAGES, MESSAGES, getAppLanguage, missingKeys, reloadAppLanguage, setAppLanguage, translateIn, type AppLanguage } from "./index";
import { APP_LANGUAGE_KEY } from "./languages";
import { en } from "./locales/en";

/**
 * The app's display language, on the real route tree with an in-memory stand-in for the backend:
 * choosing it, that it applies at once and survives a reload, what happens to a missing key, that it
 * is separate from the language Voice Billing listens for, and that every dictionary is complete.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

let backend: ReturnType<typeof createFakeBackend>;

beforeEach(() => {
  localStorage.clear();
  reloadAppLanguage(); // nothing saved: English
  backend = createFakeBackend();
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`;
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store", gstin: null } });
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "GET /api/v1/assistant/status") return json({ available: false, reason: "Salaahkaar is not available yet.", capabilities: [] });
    if (route === "GET /api/v1/insights/summary") return json({ open_insight_count: 2 });
    if (route === "POST /api/v1/carts/cart-1/items") {
      // The manual add: the shared fake only knows the recognized-items path, which does the same to the bill.
      const body = (await req.clone().json()) as { product_id: string };
      return backend.handle(
        new Request("http://test/api/v1/carts/cart-1/recognized-items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "manual", items: [{ product_id: body.product_id, quantity: "1" }] }),
        }),
      );
    }
    if (req.method === "GET" && !path.startsWith("/api/v1/products") && !path.startsWith("/api/v1/carts") && !path.startsWith("/api/v1/customers") && !path.startsWith("/api/v1/khata"))
      return json([]);
    return backend.handle(req);
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  reloadAppLanguage();
});

function load(path: string) {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router };
}

const topBar = () => screen.getAllByRole("navigation")[0];
const sections = () => within(topBar()).getAllByRole("link").map((a) => a.textContent);
const languageBox = () => screen.getByRole("combobox") as HTMLSelectElement;

describe("choosing the app language", () => {
  it("is English until chosen, and offers ten languages, each in its own script", async () => {
    load("/settings");
    expect(await screen.findByRole("heading", { name: "Store settings" })).toBeTruthy();
    expect(languageBox().value).toBe("en");
    expect([...languageBox().options].map((o) => [o.value, o.textContent])).toEqual([
      ["en", "English"],
      ["hi", "हिंदी"],
      ["hinglish", "Hinglish"],
      ["ta", "தமிழ்"],
      ["bn", "বাংলা"],
      ["te", "తెలుగు"],
      ["mr", "मराठी"],
      ["ml", "മലയാളം"],
      ["kn", "ಕನ್ನಡ"],
      ["gu", "ગુજરાતી"],
    ]);
    expect(document.documentElement.lang).toBe("en");
    expect(sections()).toEqual(["Counter", "Shop", "Khata"]);
  });

  it("changes the whole screen at once, without a reload, and stays on every route", async () => {
    const { user, router } = load("/settings");
    await screen.findByRole("heading", { name: "Store settings" });

    await user.selectOptions(languageBox(), "hi");
    // Nothing was reloaded or re-requested: the same mounted page now reads in Hindi.
    expect(screen.getByRole("heading", { name: "दुकान की सेटिंग" })).toBeTruthy();
    expect(sections()).toEqual(["काउंटर", "दुकान", "खाता"]);
    expect(screen.getByRole("button", { name: "लॉग आउट" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "अवसर, 2 खुले" })).toBeTruthy(); // the number is the app's, the words are Hindi
    expect(document.documentElement.lang).toBe("hi");
    expect(screen.queryByText("Store settings")).toBeNull();
    // What the merchant entered is not translated.
    expect(screen.getAllByText("Ramesh General Store").length).toBeGreaterThan(0);

    await act(() => router.navigate("/counter"));
    expect(await screen.findByRole("heading", { name: "काउंटर", level: 1 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "बोलकर जोड़ें" })).toBeTruthy();
    await act(() => router.navigate("/counter/returns"));
    expect(await screen.findByText("जल्द आ रहा है")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "मैनुअल बिलिंग" })).toHaveLength(2); // in the sidebar and on the page

    await act(() => router.navigate("/settings"));
    await user.selectOptions(languageBox(), "ta");
    expect(screen.getByRole("heading", { name: "கடை அமைப்புகள்" })).toBeTruthy();
    expect(sections()).toEqual(["கவுண்டர்", "கடை", "கணக்கு"]);
    await user.selectOptions(languageBox(), "en");
    expect(screen.getByRole("heading", { name: "Store settings" })).toBeTruthy();
  });

  it("is remembered on this device and is in place before the first render after a reload", async () => {
    const { user } = load("/settings");
    await screen.findByRole("heading", { name: "Store settings" });
    await user.selectOptions(languageBox(), "bn");
    expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBe("bn");

    // A reload: everything is torn down and the saved choice is read again before anything renders.
    cleanup();
    reloadAppLanguage();
    expect(getAppLanguage()).toBe("bn");
    load("/settings");
    expect(await screen.findByRole("heading", { name: "দোকানের সেটিংস" })).toBeTruthy();
    expect(screen.queryByText("Store settings")).toBeNull(); // never shown in English on the way
    expect(languageBox().value).toBe("bn");

    // A saved value that is not a language (an old or tampered one) means English, not a broken app.
    cleanup();
    localStorage.setItem(APP_LANGUAGE_KEY, "klingon");
    reloadAppLanguage();
    expect(getAppLanguage()).toBe("en");
  });
});

describe("a missing translation", () => {
  it("falls back to English, then to readable words, and is reported once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hindi = MESSAGES.hi as Record<string, string>;
    const kept = hindi["cart.total"];
    delete hindi["cart.total"];
    try {
      expect(translateIn("hi", "cart.total")).toBe("Total"); // English, not a blank and not the key
      expect(translateIn("hi", "cart.subtotal")).toBe("उप-योग"); // its neighbours are unaffected
      expect(missingKeys.has("hi:cart.total")).toBe(true);
      translateIn("hi", "cart.total");
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('"cart.total"'))).toHaveLength(1);

      // A key that exists nowhere: readable words rather than "billing.amountDue" on the screen.
      expect(translateIn("ta", "billing.amountDue")).toBe("Amount due");
      expect(missingKeys.has("ta:billing.amountDue")).toBe(true);
      // A value that was not supplied is left visible rather than silently dropped.
      expect(translateIn("en", "cart.collect", {})).toBe("Collect {{amount}}");
    } finally {
      hindi["cart.total"] = kept;
      warn.mockRestore();
    }
  });
});

describe("app language and Voice Billing's language", () => {
  const VOICE_KEY = "dukaanos.voice.language";

  it("are two separate choices: neither changes the other", async () => {
    class Recognition {
      static made: Recognition[] = [];
      lang = "";
      continuous = false;
      interimResults = false;
      onresult = null;
      onerror = null;
      onend: (() => void) | null = null;
      constructor() {
        Recognition.made.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = Recognition;
    try {
      const { user, router } = load("/settings");
      await screen.findByRole("heading", { name: "Store settings" });
      await user.selectOptions(languageBox(), "ta");
      expect(localStorage.getItem(VOICE_KEY)).toBeNull(); // choosing the app language set nothing for Voice

      await act(() => router.navigate("/counter/voice"));
      // The app is in Tamil, Voice's own controls too; Voice still listens in its own default, English.
      const voice = (await screen.findByLabelText(translateIn("ta", "voice.language"))) as HTMLSelectElement;
      expect(voice.value).toBe("en");
      await user.click(screen.getByRole("button", { name: translateIn("ta", "voice.tapToSpeak") }));
      expect(Recognition.made.at(-1)!.lang).toBe("en-IN");
      await user.click(screen.getByRole("button", { name: translateIn("ta", "voice.stop") }));

      // Choosing Hindi for Voice does not change the app's language.
      await user.selectOptions(voice, "hi");
      expect(localStorage.getItem(VOICE_KEY)).toBe("hi");
      expect(localStorage.getItem(APP_LANGUAGE_KEY)).toBe("ta");
      expect(getAppLanguage()).toBe("ta");
      expect(sections()).toEqual(["கவுண்டர்", "கடை", "கணக்கு"]);

      // And changing the app's language back does not change what Voice listens for.
      act(() => setAppLanguage("en"));
      expect(sections()).toEqual(["Counter", "Shop", "Khata"]);
      expect(voice.value).toBe("hi");
      await user.click(screen.getByRole("button", { name: "Speak again" }));
      expect(Recognition.made.at(-1)!.lang).toBe("hi-IN");
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
  });
});

describe("billing at the Counter, in English and in Hindi", () => {
  const WORDS = {
    en: {
      nav: ["Counter", "Shop", "Khata"],
      search: "Scan barcode or search product",
      none: "No products match.",
      noMatch: "No product matches “zzz”",
      many: "2 products match. Pick one from the list.",
      empty: "Scan or tap a product to start the bill.",
      left: "left",
      collect: "Collect ₹14.00",
      total: "Total",
      badDiscount: "Enter a valid discount, e.g. 10 or 2.50",
      bigDiscount: "Discount cannot exceed the subtotal",
      khata: "Khata",
      needsCustomer: "Select a customer to put this bill on khata.",
      toKhata: "Add ₹14.00 to khata",
      increase: `Increase ${maggi.name}`,
    },
    hi: {
      nav: ["काउंटर", "दुकान", "खाता"],
      search: "बारकोड स्कैन करें या प्रोडक्ट खोजें",
      none: "कोई प्रोडक्ट नहीं मिला।",
      noMatch: "“zzz” से कोई प्रोडक्ट नहीं मिला",
      many: "2 प्रोडक्ट मिले। सूची में से एक चुनें।",
      empty: "बिल शुरू करने के लिए प्रोडक्ट स्कैन करें या उस पर टैप करें।",
      left: "बचे",
      collect: "₹14.00 लें",
      total: "कुल",
      badDiscount: "सही छूट भरें, जैसे 10 या 2.50",
      bigDiscount: "छूट उप-योग से ज़्यादा नहीं हो सकती",
      khata: "खाता",
      needsCustomer: "इस बिल को खाते में डालने के लिए ग्राहक चुनें।",
      toKhata: "₹14.00 खाते में जोड़ें",
      increase: `${maggi.name} बढ़ाएँ`,
    },
  } as const;

  it.each(["en", "hi"] as const)("navigation, product search, the bill and its messages read in %s", async (language) => {
    const w = WORDS[language];
    act(() => setAppLanguage(language));
    const { user } = load("/counter");

    expect(await screen.findByLabelText(w.search)).toBeTruthy();
    expect(sections()).toEqual(w.nav);
    expect(screen.getByText(w.empty)).toBeTruthy();

    // Product search: the words around it are translated; the merchant's product names and prices are not.
    const box = screen.getByLabelText(w.search);
    await user.type(box, "zzz");
    expect(screen.getByText(w.none)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe(w.noMatch);
    await user.clear(box);
    await user.type(box, "750ml"); // Coke 750ml and Pepsi 750ml
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe(w.many);
    await user.clear(box);
    await user.type(box, "maggi");
    const product = screen.getByRole("button", { name: new RegExp(maggi.name) });
    expect(product.textContent).toContain("₹14.00");
    expect(product.textContent).toContain(w.left);

    // Billing: one tap adds it; the amount is the same number in either language.
    await user.click(product);
    const collect = await screen.findByRole("button", { name: w.collect });
    expect(screen.getByText(w.total)).toBeTruthy();
    expect(screen.getByRole("button", { name: w.increase })).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: language === "en" ? "Bill" : "बिल" }).parentElement!).getByText(maggi.name)).toBeTruthy();
    expect(backend.state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/recognized-items"))).toHaveLength(1);

    // Validation and confirmation messages.
    const discount = document.getElementById("counter-discount") as HTMLInputElement;
    await user.type(discount, "abc");
    expect(screen.getByText(w.badDiscount)).toBeTruthy();
    await user.clear(discount);
    await user.type(discount, "999");
    expect(screen.getByText(w.bigDiscount)).toBeTruthy();
    await user.clear(discount);
    await waitFor(() => expect((collect as HTMLButtonElement).disabled).toBe(false));

    await user.click(screen.getByRole("radio", { name: w.khata }));
    expect(screen.getByText(w.needsCustomer)).toBeTruthy();
    expect((screen.getByRole("button", { name: w.toKhata }) as HTMLButtonElement).disabled).toBe(true); // no customer: not billed
  });
});

describe("every dictionary is complete", () => {
  const KEYS = Object.keys(en).sort();
  const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;
  const code = Object.entries(sources).filter(([path]) => !path.includes(".test.") && !path.includes("/i18n/locales/"));
  const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

  /** Every key the frontend asks for: literal keys, and the families built from a stored value. */
  function usedKeys(): Set<string> {
    const used = new Set<string>();
    for (const [, text] of code) {
      for (const m of text.matchAll(/\b(?:t|translate)\(\s*"(\w+\.[\w.]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/\b(?:key|titleKey): "(\w+\.[\w.]+)"/g)) used.add(m[1]);
      // One of two keys, chosen by a condition: t(n === 1 ? "x.one" : "x.other")
      for (const m of text.matchAll(/\bt\([^"`()]*\? "(\w+\.[\w.]+)" : "(\w+\.[\w.]+)"/g)) used.add(m[1]).add(m[2]);
    }
    const built = code.map(([, text]) => text).join("\n");
    if (built.includes("`counter.mode.${id}.${part}`"))
      for (const id of ["live", "barcode", "photo", "parchi", "voice", "manual"])
        for (const part of ["name", "label", "hint", "how"]) used.add(`counter.mode.${id}.${part}`);
    if (built.includes("`cart.method.${m}`")) for (const m of ["cash", "upi", "card", "khata", "paytm"]) used.add(`cart.method.${m}`);
    if (built.includes('label("source", item.source)'))
      for (const source of ["manual", "barcode", "vision", "voice", "parchi", "assistant"]) used.add(`source.${source}`);
    if (built.includes("`orders.status.${order.status}`"))
      for (const status of ["pending", "confirmed", "ready", "completed", "cancelled"]) used.add(`orders.status.${status}`);
    if (built.includes("`khata.balance.${label}`")) for (const label of ["outstanding", "advance", "settled"]) used.add(`khata.balance.${label}`);
    if (built.includes("`khata.entry.${entry.type}`")) for (const type of ["credit", "payment"]) used.add(`khata.entry.${type}`);
    if (built.includes("`store.headline.${order.status}`"))
      for (const status of ["pending", "confirmed", "ready", "completed", "cancelled"]) used.add(`store.headline.${status}`);
    if (built.includes("`store.step.${step}`")) for (const step of ["pending", "confirmed", "ready", "completed"]) used.add(`store.step.${step}`);
    const kinds = ["stockout_risk", "dead_stock", "customer_winback", "khata_risk"];
    if (built.includes("`insights.kind.${kind}`") || built.includes("`insights.kind.${i.kind}`")) for (const kind of kinds) used.add(`insights.kind.${kind}`);
    if (built.includes("`salaahkaar.source.${SOURCES[tool]}`"))
      for (const source of ["sales", "orders", "khata", "customers", "stock", "prices", "products"]) used.add(`salaahkaar.source.${source}`);
    // The trend word inside an insight's detail, looked up from the backend's own word for it.
    for (const m of built.matchAll(/\b\w+: "(insight\.trend\.\w+)"/g)) used.add(m[1]);
    // The backend's error codes that have a translated line (see problemIn), and the browser's own failure.
    if (built.includes("`error.${code}`"))
      for (const code of [
        "not_found", "conflict", "validation_error", "insufficient_stock", "unauthorized", "domain_error", "http_error",
        "assistant_unavailable", "vision_unavailable", "vision_failed", "parchi_unavailable", "parchi_failed",
        "paytm_unavailable", "paytm_failed", "invalid_image", "image_too_large",
      ]) used.add(`error.${code}`); // prettier-ignore
    if (built.includes('"error.network"')) used.add("error.network");
    return used;
  }

  it("every key the frontend uses is defined, and every defined key is used", () => {
    const used = usedKeys();
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((key) => !(key in en)).sort()).toEqual([]); // asked for, but in no dictionary
    expect(KEYS.filter((key) => !used.has(key))).toEqual([]); // translated ten times for nothing
  });

  it.each(APP_LANGUAGES.map((l) => l.code))("%s has every key, with the same values to fill in", (language: AppLanguage) => {
    const messages = MESSAGES[language] as Record<string, string>;
    expect(Object.keys(messages).sort()).toEqual(KEYS);
    for (const key of KEYS) {
      expect(messages[key].trim(), `${language} ${key}`).not.toBe("");
      expect(placeholders(messages[key]), `${language} ${key}`).toEqual(placeholders((en as Record<string, string>)[key]));
    }
  });

  it("is written in the language's own script, not copied from English", () => {
    const script: Partial<Record<AppLanguage, RegExp>> = {
      hi: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, ta: /[஀-௿]/, bn: /[ঀ-৿]/, te: /[ఀ-౿]/,
      ml: /[ഀ-ൿ]/, kn: /[ಀ-೿]/, gu: /[઀-૿]/,
    }; // prettier-ignore
    // Names that are the same everywhere, and the examples typed in Roman letters and digits.
    const sameEverywhere = new Set(["nav.qr", "cart.method.upi", "cart.method.paytm"]);
    for (const [language, letters] of Object.entries(script) as [AppLanguage, RegExp][]) {
      const messages = MESSAGES[language] as Record<string, string>;
      const untranslated = KEYS.filter((key) => !sameEverywhere.has(key) && !letters.test(messages[key]));
      expect(untranslated, language).toEqual([]);
    }
    // Hinglish is Roman script, and is its own text: not English, and not Devanagari.
    const hinglish = MESSAGES.hinglish as Record<string, string>;
    expect(KEYS.filter((key) => /[^\u0000-ɏ -⁯]/.test(hinglish[key]))).toEqual([]);
    expect(KEYS.filter((key) => hinglish[key] !== (en as Record<string, string>)[key]).length).toBeGreaterThan(KEYS.length / 2);
  });
});
