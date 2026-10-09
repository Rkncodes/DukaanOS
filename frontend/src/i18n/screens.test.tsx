// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../app/router";
import { LOW_STOCK } from "../features/catalogue/api";
import { orderNumber } from "../lib/format";
import { reloadAppLanguage, setAppLanguage, translateIn, type AppLanguage, type MessageKey } from "./index";

/**
 * Shop Orders, Khata and Catalogue Categories, as the app really renders them (the whole route tree, with
 * an in-memory stand-in for the backend), read in English and in Malayalam: the headings, labels, buttons
 * and statuses are the language's; what the merchant and their customers entered is left exactly as it is.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refuse = (status: number, code: string, message: string) => json({ error: { code, message, details: null } }, status);

const order = (id: string, status: string, product_name: string, extra: object = {}) => ({
  id,
  customer_id: null,
  cart_id: `cart-${id}`,
  customer_name: null,
  customer_phone: null,
  channel: "shop",
  status,
  subtotal: "28.00",
  discount: "0.00",
  total: "28.00",
  tax_summary: { taxable_value: "0.00", cgst: "0.00", sgst: "0.00", total_tax: "0.00" },
  payment_status: "unpaid",
  items: [{ id: `${id}-i`, product_id: "p-1", product_name, quantity: "2.000", unit_price: "14.00", tax_rate: "0.00", line_total: "28.00", source: "manual" }],
  created_at: "2026-10-03T10:00:00Z",
  updated_at: "2026-10-03T10:00:00Z",
  ...extra,
});

const ORDERS = [
  order("10240000-aaaa", "pending", "Maggi Masala", { customer_name: "Sunita Devi", customer_phone: "98765 43210" }),
  order("20480000-bbbb", "confirmed", "Tata Tea Gold"),
  order("30720000-cccc", "ready", "Amul Butter"),
  order("40960000-dddd", "completed", "Tata Salt", { payment_status: "paid" }),
  order("51200000-eeee", "cancelled", "Parle Biscuit"),
];
const BALANCES = [
  { customer_id: "c-rahul", customer_name: "Rahul Sharma", phone: "9810010001", balance: "850.00", last_entry_at: "2026-10-03T06:00:00Z" },
  { customer_id: "c-aman", customer_name: "Aman Verma", phone: null, balance: "-40.00", last_entry_at: null },
  { customer_id: "c-priya", customer_name: "Priya Nair", phone: "9810010003", balance: "0.00", last_entry_at: "2026-10-01T06:00:00Z" },
];
const CATEGORIES = [{ id: "cat-snacks", name: "Namkeen" }, { id: "cat-dairy", name: "Doodh Dahi" }]; // prettier-ignore
const product = (id: string, name: string, stock: string, category_id: string | null) => ({
  id, name, price: "14.00", tax_rate: "0.00", stock_quantity: stock, unit: "pcs", barcode: null, sku: null, category_id,
  cost_price: null, image_url: null, is_active: true, created_at: "", updated_at: "",
}); // prettier-ignore
const PRODUCTS = [product("p-1", "Maggi Masala", "60.000", "cat-snacks"), product("p-2", "Amul Butter", "0.000", null)];
const OFF_SALE = { ...product("p-3", "Fortune Oil", "5.000", null), is_active: false };
const RAHUL = { id: "c-rahul", name: "Rahul Sharma", phone: "9810010001", created_at: "2026-09-01T06:00:00Z" };
const entry = (id: string, type: "credit" | "payment", amount: string, after: string, description: string, created_at: string) => ({
  id, customer_id: RAHUL.id, type, amount, description, balance_after: after, created_at, order_id: null, payment_id: null, source: "manual",
}); // prettier-ignore
const LEDGER = {
  customer: RAHUL,
  balance: "850.00",
  entries: [entry("e-2", "payment", "150.00", "850.00", "Part payment", "2026-10-03T06:00:00Z"), entry("e-1", "credit", "1000.00", "1000.00", "Monthly rashan", "2026-09-20T06:00:00Z")],
};

/** Everything on these screens that is data, not interface: it must appear unchanged in every language. */
const DATA = [
  "Ramesh General Store", "Ramesh", "DukaanOS",
  ...ORDERS.flatMap((o) => [orderNumber(o.id), o.customer_name ?? "", o.customer_phone ?? "", ...o.items.map((i) => i.product_name)]),
  ...BALANCES.flatMap((b) => [b.customer_name, b.phone ?? ""]),
  ...CATEGORIES.map((c) => c.name),
  "Fortune Oil", "pcs", "Part payment", "Monthly rashan",
].filter(Boolean); // prettier-ignore

const insight = (kind: string, id: string, title: string, detail: string, tone = "amber") => ({
  key: `${kind}:${id}`, kind, title, detail, tone, link: kind.startsWith("customer") || kind.startsWith("khata") ? `/khata/${id}` : "/catalogue/stock",
  product_id: null, customer_id: null, metrics: {}, action: null,
}); // prettier-ignore
/** The backend's own sentences (backend/app/modules/insights/service.py), with this store's names in them. */
const INSIGHTS = [
  insight("stockout_risk", "p-1", "Maggi Masala may run out in 2 days", "18 pcs sold in the last 14 days (climbing), only 3 pcs left", "red"),
  insight("dead_stock", "p-2", "Amul Butter hasn't sold in 30+ days", "4 pcs still on the shelf"),
  insight("customer_winback", "c-priya", "Priya Nair hasn't come back in 21 days", "Usually buys every 7 days"),
  insight("khata_risk", "c-rahul", "Rahul Sharma owes ₹850.00 with no recent payment", "Last paid 40 days ago", "red"),
];

let failing: Record<string, Response>;

beforeEach(() => {
  localStorage.clear();
  reloadAppLanguage();
  failing = {};
  server.handle = async (req) => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    if (failing[route]) return failing[route].clone();
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store", gstin: null } });
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "GET /api/v1/assistant/status") return json({ available: false, reason: "", capabilities: [] });
    if (route === "GET /api/v1/insights/summary")
      return json({ sales_today: "420.00", sales_trend_pct: 12.4, orders_today: 1, orders_trend_pct: null, khata_outstanding: "850.00", open_insight_count: 4 });
    if (route === "GET /api/v1/insights") return json(INSIGHTS);
    if (route === "GET /api/v1/analytics/sales-trend")
      return json([{ date: "2026-10-01", revenue: "100.00", orders: 2 }, { date: "2026-10-02", revenue: "300.00", orders: 3 }]);
    if (route === "GET /api/v1/analytics/top-products") return json([{ product_id: "p-1", name: "Maggi Masala", revenue: "280.00", quantity: "20" }]);
    if (route === "GET /api/v1/analytics/category-breakdown") return json([{ category_id: "cat-snacks", name: "Namkeen", revenue: "280.00" }]);
    if (route === "GET /api/v1/orders") return json(ORDERS);
    if (route === "GET /api/v1/khata/balances")
      return json(url.searchParams.get("outstanding_only") === "true" ? BALANCES.filter((b) => Number(b.balance) > 0) : BALANCES);
    if (route === "GET /api/v1/customers/c-rahul/khata") return json(LEDGER);
    if (route.startsWith("GET /api/v1/customers/") && route.endsWith("/khata")) return refuse(404, "not_found", "Customer not found");
    if (route === "GET /api/v1/categories") return json(CATEGORIES);
    if (route === "GET /api/v1/public/stores/ramesh-general-store") return json({ store_name: "Ramesh General Store", store_slug: "ramesh-general-store", categories: CATEGORIES });
    if (route === "GET /api/v1/public/stores/ramesh-general-store/products")
      return json(PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: p.price, unit: p.unit, image_url: null, category_id: p.category_id, in_stock: Number(p.stock_quantity) > 0 })));
    if (route === `GET /api/v1/public/stores/ramesh-general-store/orders/${ORDERS[2].id}`) return json(ORDERS[2]);
    if (route.startsWith("GET /api/v1/public/")) return refuse(404, "not_found", "Not found");
    if (route === "GET /api/v1/products") return json(url.searchParams.get("include_inactive") === "true" ? [...PRODUCTS, OFF_SALE] : PRODUCTS);
    if (req.method === "GET") return json([]);
    return refuse(404, "not_found", `No fake for ${route}`);
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  reloadAppLanguage();
});

function load(path: string, language: AppLanguage) {
  act(() => setAppLanguage(language));
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
  const say = (key: MessageKey, values?: Record<string, string | number>) => translateIn(language, key, values);
  return { user, say };
}

/**
 * English left on the screen: every piece of visible text and every label read out, with the data taken
 * out. What remains should have no Latin words in a language that is not written in Latin letters.
 */
function latinWordsOnScreen(identifiers: string[] = []): string[] {
  const pieces: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? "");
  for (const el of document.body.querySelectorAll("*"))
    for (const name of ["aria-label", "placeholder", "title", "alt"]) pieces.push(el.getAttribute(name) ?? "");
  // The language picker's own names, and abbreviations every language here writes in Latin letters.
  const same = new Set(["UPI", "QR", "AI", "AM", "PM", "am", "pm"]);
  const words = new Set<string>();
  for (let piece of pieces) {
    for (const value of [...DATA, ...identifiers].sort((a, b) => b.length - a.length)) piece = piece.split(value).join(" ");
    for (const word of piece.match(/[A-Za-z]{2,}/g) ?? []) if (!same.has(word)) words.add(word);
  }
  return [...words].sort();
}

const HEADINGS = {
  en: { shop: "Shop", khata: "Khata", categories: "Categories" },
  ml: { shop: "കട", khata: "കണക്ക്", categories: "വിഭാഗങ്ങൾ" },
} as const;

describe.each(["en", "ml"] as const)("the three screens in %s", (language) => {
  it("Shop Orders: headings, counts, statuses, order details and every action", async () => {
    const { user, say } = load("/shop/orders", language);
    expect(await screen.findByRole("heading", { name: HEADINGS[language].shop, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("shop.subtitle"))).toBeTruthy();

    const fresh = await screen.findByRole("region", { name: say("orders.sectionNew") });
    const active = screen.getByRole("region", { name: say("orders.sectionActive") });
    const done = screen.getByRole("region", { name: say("orders.sectionDone") });
    expect(within(fresh).getByRole("heading").textContent).toBe(`${say("orders.sectionNew")} (1)`);
    expect(within(active).getByRole("heading").textContent).toBe(`${say("orders.sectionActive")} (2)`);
    expect(within(done).getByRole("heading").textContent).toBe(`${say("orders.sectionDone")} (2)`);

    // The three figures at the top, with their lines of context.
    for (const key of ["orders.pending", "orders.pendingWaiting", "orders.today", "orders.todayHint"] as const)
      expect(screen.getAllByText(say(key)).length, key).toBeGreaterThan(0);
    expect(screen.getByText(say("orders.completedHint", { count: 5 }))).toBeTruthy();

    // A new order: the customer's own details and the product name are not translated.
    const first = within(fresh).getByRole("listitem", { name: say("orders.order", { number: orderNumber(ORDERS[0].id) }) });
    expect(within(first).getByText(say("orders.status.pending"))).toBeTruthy();
    expect(within(first).getByText(say("cart.customer"))).toBeTruthy();
    expect(within(first).getByText("Sunita Devi · 98765 43210")).toBeTruthy();
    expect(first.textContent).toContain("Maggi Masala");
    expect(within(first).getByText(say("orders.payment"))).toBeTruthy();
    expect(within(first).getByText(say("orders.unpaid"))).toBeTruthy();
    expect(within(first).getByText(say("cart.total"))).toBeTruthy();
    expect(within(first).getByRole("button", { name: say("orders.accept") })).toBeTruthy();
    expect(within(first).getByRole("button", { name: say("orders.reject") })).toBeTruthy();

    // Accepted and ready orders.
    expect(within(active).getByText(say("orders.status.confirmed"))).toBeTruthy();
    expect(within(active).getByText(say("orders.status.ready"))).toBeTruthy();
    expect(within(active).getAllByText(say("orders.notGiven"))).toHaveLength(2);
    expect(within(active).getByRole("button", { name: say("orders.markReady") })).toBeTruthy();
    expect(within(active).getAllByRole("button", { name: say("orders.cancel") })).toHaveLength(2);
    const paidBy = within(active).getByLabelText(say("orders.paidByOrder", { number: orderNumber(ORDERS[2].id) })) as HTMLSelectElement;
    expect([...paidBy.options].map((o) => [o.value, o.textContent])).toEqual([
      ["cash", say("cart.method.cash")],
      ["upi", "UPI"],
      ["card", say("cart.method.card")],
    ]);
    expect(within(active).getByRole("button", { name: say("orders.complete", { amount: "₹28.00" }) })).toBeTruthy();

    // Finished orders.
    expect(within(done).getByText(say("orders.status.completed"))).toBeTruthy();
    expect(within(done).getByText(say("orders.status.cancelled"))).toBeTruthy();
    expect(within(done).getByText(say("orders.paid"))).toBeTruthy();

    // A refused change: the backend's own words in English, a translated line for its code otherwise.
    failing["PATCH /api/v1/orders/20480000-bbbb/status"] = refuse(409, "conflict", "An order that is cancelled cannot become ready");
    await user.click(within(active).getByRole("button", { name: say("orders.markReady") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(language === "en" ? "An order that is cancelled cannot become ready" : say("error.conflict"));

    if (language === "en") {
      expect(screen.getByText("New order")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Complete · collect ₹28.00" })).toBeTruthy();
      expect(screen.getByText("Ready for pickup")).toBeTruthy();
    } else {
      expect(screen.getByText("പുതിയ ഓർഡർ")).toBeTruthy();
      expect(screen.getByRole("button", { name: "പൂർത്തിയാക്കുക · ₹28.00 വാങ്ങുക" })).toBeTruthy();
      expect(screen.getByText("എടുക്കാൻ തയ്യാർ")).toBeTruthy();
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("Shop Orders with no orders: the figures and the empty message", async () => {
    failing["GET /api/v1/orders"] = json([]);
    const { say } = load("/shop/orders", language);
    expect(await screen.findByText(say("orders.empty"))).toBeTruthy();
    expect(screen.getByText(say("orders.pendingNone"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Khata: the figures, the customer table, its actions and the add-customer form", async () => {
    const { user, say } = load("/khata", language);
    expect(await screen.findByRole("heading", { name: HEADINGS[language].khata, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("khata.subtitle"))).toBeTruthy();

    const table = await screen.findByRole("table");
    expect(screen.getByText(say("khata.totalOutstanding"))).toBeTruthy();
    expect(screen.getByText(say("khata.oweYou", { owing: 1, total: 3 }))).toBeTruthy();
    expect(screen.getByText(say("khata.customersOwing"))).toBeTruthy();
    expect(screen.getByText(say("khata.largest", { name: "Rahul Sharma" }))).toBeTruthy();

    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      say("cart.customer"), say("khata.col.phone"), say("khata.col.lastEntry"), say("nav.outstanding"), say("khata.col.action"),
    ]); // prettier-ignore
    const [rahul, aman, priya] = within(table).getAllByRole("row").slice(1);
    expect(within(rahul).getByRole("link", { name: "Rahul Sharma" })).toBeTruthy(); // a name is never translated
    expect(rahul.textContent).toContain("9810010001");
    expect(rahul.textContent).toContain(`₹850.00 ${say("khata.balance.outstanding")}`);
    expect(within(rahul).getByRole("link", { name: say("khata.recordPaymentFrom", { name: "Rahul Sharma" }) }).textContent).toBe(say("khata.takePayment"));
    expect(aman.textContent).toContain(say("customer.noPhone"));
    expect(aman.textContent).toContain(say("khata.none"));
    expect(aman.textContent).toContain(`₹40.00 ${say("khata.balance.advance")}`);
    expect(within(aman).getByRole("link", { name: say("khata.recordCreditFor", { name: "Aman Verma" }) }).textContent).toBe(say("khata.giveCredit"));
    expect(priya.textContent).toContain(say("khata.balance.settled"));

    // Adding a customer, and what a refusal looks like.
    expect(screen.getByRole("heading", { name: say("khata.addCustomer") })).toBeTruthy();
    expect((screen.getByLabelText(say("khata.customerPhone")) as HTMLInputElement).placeholder).toBe(say("khata.phonePlaceholder"));
    const name = screen.getByLabelText(say("khata.customerName")) as HTMLInputElement;
    expect(name.placeholder).toBe(say("khata.namePlaceholder"));
    failing["POST /api/v1/customers"] = refuse(409, "conflict", "A record with these values already exists");
    await user.type(name, "Rahul Sharma");
    await user.click(screen.getByRole("button", { name: say("khata.addCustomer") }));
    expect((await screen.findByRole("alert")).textContent).toBe(language === "en" ? "A record with these values already exists" : say("error.conflict"));
    await user.clear(name);

    // A search that finds no one: what was typed is shown back as typed.
    const search = screen.getByLabelText(say("khata.searchCustomers")) as HTMLInputElement;
    expect(search.placeholder).toBe(say("khata.searchPlaceholder"));
    await user.type(search, "Zoya");
    expect(screen.getByText(say("khata.noCustomerMatches", { text: "Zoya" }))).toBeTruthy();
    await user.clear(search);

    if (language === "en") {
      expect(screen.getByText("Total outstanding")).toBeTruthy();
      expect(screen.getByText("1 of 3 customers owe you")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Record payment from Rahul Sharma" }).textContent).toBe("Take payment");
    } else {
      expect(screen.getByText("ആകെ കുടിശ്ശിക")).toBeTruthy();
      expect(screen.getByText("3 പേരിൽ 1 ഉപഭോക്താക്കൾ നിങ്ങൾക്ക് തരാനുണ്ട്")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Rahul Sharma നൽകിയ പണം രേഖപ്പെടുത്തുക" }).textContent).toBe("പണം വാങ്ങുക");
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("Khata with no customers: the empty message and the settled hint", async () => {
    failing["GET /api/v1/khata/balances"] = json([]);
    const { say } = load("/khata", language);
    expect(await screen.findByText(say("khata.noCustomers"))).toBeTruthy();
    expect(screen.getByText(say("khata.everyoneSettled"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Categories: the stock figures, the add form, renaming and deleting", async () => {
    const { user, say } = load("/catalogue/categories", language);
    expect(await screen.findByRole("heading", { name: HEADINGS[language].categories, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("categories.subtitle"))).toBeTruthy();
    for (const key of ["catalogue.onSale", "catalogue.outOfStock"] as const) expect(screen.getByText(say(key)), key).toBeTruthy();
    expect(screen.getByText(say("catalogue.low", { count: LOW_STOCK }))).toBeTruthy();

    expect(screen.getByRole("heading", { name: say("categories.add") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("categories.yours") })).toBeTruthy();
    const box = screen.getByLabelText(say("categories.name")) as HTMLInputElement;
    expect(box.placeholder).toBe(say("categories.placeholder"));

    // The merchant's category names are theirs; only the count beside them is worded by the app.
    const snacks = await screen.findByRole("listitem", { name: "Namkeen" });
    const dairy = screen.getByRole("listitem", { name: "Doodh Dahi" });
    expect(snacks.textContent).toContain(say("categories.productCount.one", { count: 1 }));
    expect(dairy.textContent).toContain(say("categories.productCount.other", { count: 0 }));

    await user.click(within(snacks).getByRole("button", { name: say("categories.rename") }));
    expect((within(snacks).getByLabelText(say("categories.newNameFor", { name: "Namkeen" })) as HTMLInputElement).value).toBe("Namkeen");
    expect(within(snacks).getByRole("button", { name: say("common.save") })).toBeTruthy();
    await user.click(within(snacks).getByRole("button", { name: say("common.cancel") }));

    await user.click(within(dairy).getByRole("button", { name: say("categories.delete") }));
    expect(within(dairy).getByText(say("categories.confirmDelete"))).toBeTruthy();
    expect(within(dairy).getByRole("button", { name: say("categories.yesDelete") })).toBeTruthy();
    await user.click(within(dairy).getByRole("button", { name: say("categories.keep") }));

    // A duplicate name is refused by the backend.
    failing["POST /api/v1/categories"] = refuse(409, "conflict", "A record with these values already exists");
    await user.type(box, "Namkeen");
    await user.click(screen.getByRole("button", { name: say("categories.add") }));
    expect((await screen.findByRole("alert")).textContent).toBe(language === "en" ? "A record with these values already exists" : say("error.conflict"));
    await user.clear(box);

    if (language === "en") {
      expect(screen.getByText("Products on sale")).toBeTruthy();
      expect(snacks.textContent).toContain("1 product");
      expect(within(dairy).getByRole("button", { name: "Delete" })).toBeTruthy();
    } else {
      expect(screen.getByText("വിൽപ്പനയിലുള്ള ഉൽപ്പന്നങ്ങൾ")).toBeTruthy();
      expect(snacks.textContent).toContain("1 ഉൽപ്പന്നം");
      expect(within(dairy).getByRole("button", { name: "ഇല്ലാതാക്കുക" })).toBeTruthy();
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("Categories with none yet: the empty message", async () => {
    failing["GET /api/v1/categories"] = json([]);
    const { say } = load("/catalogue/categories", language);
    expect(await screen.findByText(say("categories.none"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });
});

const HEADINGS_MORE = {
  en: { ledger: "Ledger", outstanding: "Outstanding", payments: "Payments", products: "Products", stock: "Stock" },
  ml: { ledger: "ലെഡ്ജർ", outstanding: "കുടിശ്ശിക", payments: "പേയ്‌മെന്റുകൾ", products: "ഉൽപ്പന്നങ്ങൾ", stock: "സ്റ്റോക്ക്" },
} as const;

describe.each(["en", "ml"] as const)("the Khata ledger and views, Products and Stock in %s", (language) => {
  it("a customer's own khata: balance, entries, recording a payment and a credit", async () => {
    const { user, say } = load("/khata/c-rahul", language);
    expect(await screen.findByRole("heading", { name: "Rahul Sharma", level: 1 })).toBeTruthy(); // a name is never translated
    expect(screen.getByRole("link", { name: `← ${say("khata.allCustomers")}` })).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("nav.outstanding") })).toBeTruthy();
    expect(screen.getByLabelText(say("khata.col.balance")).textContent).toBe("₹850.00");
    expect(screen.getByText(say("khata.owedToYou"))).toBeTruthy();

    const ledger = screen.getByRole("table");
    expect(within(ledger).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      say("khata.col.date"), say("khata.col.entry"), say("khata.col.note"), say("khata.col.amount"), say("khata.col.balance"),
    ]); // prettier-ignore
    const [payment, credit] = within(ledger).getAllByRole("row").slice(1);
    expect(within(payment).getByText(say("khata.entry.payment"))).toBeTruthy();
    expect(within(payment).getByText("Part payment")).toBeTruthy(); // the merchant's own note, as written
    expect(within(credit).getByText(say("khata.entry.credit"))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: say("khata.recordPayment") }));
    const form = screen.getByRole("form", { name: say("khata.recordPayment") });
    const amount = within(form).getByLabelText(`${say("khata.amountReceived")} (₹)`);
    const paidBy = within(form).getByLabelText(say("orders.paidBy")) as HTMLSelectElement;
    expect([...paidBy.options].map((o) => o.textContent)).toEqual([say("cart.method.cash"), "UPI", say("cart.method.card")]);
    expect(within(form).getByLabelText(say("khata.noteOptional"))).toBeTruthy();
    await user.type(amount, "900");
    expect(within(form).getByRole("note").textContent).toBe(say("khata.overpay", { amount: "₹50.00" }));
    failing["POST /api/v1/customers/c-rahul/khata/payments"] = refuse(422, "validation_error", "Amount must be greater than zero");
    await user.click(within(form).getByRole("button", { name: say("khata.savePayment") }));
    expect((await within(form).findByRole("alert")).textContent).toBe(language === "en" ? "Amount must be greater than zero" : say("error.validation_error"));
    expect(within(form).getByRole("button", { name: say("common.cancel") })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: say("khata.recordCredit") }));
    const creditForm = screen.getByRole("form", { name: say("khata.recordCredit") });
    expect(within(creditForm).getByLabelText(`${say("khata.amountCredit")} (₹)`)).toBeTruthy();
    expect(within(creditForm).getByRole("button", { name: say("khata.saveCredit") })).toBeTruthy();

    if (language === "en") {
      expect(screen.getByText("owed to you")).toBeTruthy();
      expect(within(creditForm).getByLabelText("Amount given on udhaar (₹)")).toBeTruthy();
    } else {
      expect(screen.getByText("നിങ്ങൾക്ക് കിട്ടാനുള്ളത്")).toBeTruthy();
      expect(within(creditForm).getByLabelText("കടമായി നൽകിയ തുക (₹)")).toBeTruthy();
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("a customer who is not in the khata", async () => {
    const { say } = load("/khata/c-nobody", language);
    expect((await screen.findByRole("alert")).textContent).toBe(say("khata.notFound"));
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Khata > Ledger, Outstanding and Payments", async () => {
    const { say } = load("/khata/ledger", language);
    expect(await screen.findByRole("heading", { name: HEADINGS_MORE[language].ledger, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("khata.ledgerSubtitle"))).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      say("cart.customer"), say("khata.col.phone"), say("khata.col.lastEntry"), say("khata.col.balance"), say("khata.col.action"),
    ]); // prettier-ignore
    expect(screen.getByRole("link", { name: say("khata.openLedgerOf", { name: "Rahul Sharma" }) }).textContent).toBe(say("khata.openLedger"));
    expect(table.textContent).toContain(`₹850.00 ${say("khata.balance.outstanding")}`);
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
    cleanup();

    load("/khata/outstanding", language);
    expect(await screen.findByRole("heading", { name: HEADINGS_MORE[language].outstanding, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("khata.outstandingSubtitle"))).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("khata.totalOutstanding") })).toBeTruthy();
    expect(await screen.findByText(say("khata.fromCustomers.one", { count: 1 }))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
    cleanup();

    load("/khata/payments", language);
    expect(await screen.findByRole("heading", { name: HEADINGS_MORE[language].payments, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("khata.paymentsSubtitle"))).toBeTruthy();
    expect((await screen.findByRole("link", { name: say("khata.recordPaymentFrom", { name: "Rahul Sharma" }) })).textContent).toBe(say("khata.recordPayment"));
    expect(screen.getByRole("note").textContent).toBe(say("khata.paymentsNote"));
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Khata > Outstanding and Payments when nobody owes anything", async () => {
    failing["GET /api/v1/khata/balances"] = json([]);
    const { say } = load("/khata/outstanding", language);
    expect(await screen.findByText(say("khata.nobodyOwes"))).toBeTruthy();
    expect(screen.getByText(say("khata.fromCustomers.other", { count: 0 }))).toBeTruthy();
    cleanup();
    load("/khata/payments", language);
    expect(await screen.findByText(say("khata.nobodyOwesPayment"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Products: the table, stock statuses, taking off sale, and the product form", async () => {
    const { user, say } = load("/catalogue/products", language);
    expect(await screen.findByRole("heading", { name: HEADINGS_MORE[language].products, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("products.subtitle"))).toBeTruthy();
    expect((screen.getByLabelText(say("products.search")) as HTMLInputElement).placeholder).toBe(say("products.searchPlaceholder"));

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      say("products.col.product"), say("products.col.category"), say("products.col.barcode"), say("products.col.price"),
      say("products.col.gst"), say("products.col.inStock"), say("products.col.status"), say("products.col.actions"),
    ]); // prettier-ignore
    const maggi = within(table).getByRole("row", { name: "Maggi Masala" });
    expect(within(maggi).getByText(say("stock.level.ok"))).toBeTruthy();
    expect(within(maggi).getByText("Namkeen")).toBeTruthy(); // the merchant's category name
    expect(within(maggi).getByRole("button", { name: say("products.takeOffSale") })).toBeTruthy();
    expect(within(within(table).getByRole("row", { name: "Amul Butter" })).getByText(say("catalogue.outOfStock"))).toBeTruthy();

    // Products taken off sale are shown on request.
    await user.click(screen.getByLabelText(say("products.showOffSale")));
    const oil = within(table).getByRole("row", { name: "Fortune Oil" });
    expect(within(oil).getByText(say("products.offSale"))).toBeTruthy();
    expect(within(oil).getByText(say("stock.level.low"))).toBeTruthy();
    expect(within(oil).getByRole("button", { name: say("products.putOnSale") })).toBeTruthy();

    // Editing: the form's own words; the product's name stays as entered.
    await user.click(within(maggi).getByRole("button", { name: say("products.edit") }));
    const form = screen.getByRole("form", { name: say("products.editTitle", { name: "Maggi Masala" }) });
    expect((within(form).getByLabelText(say("products.name")) as HTMLInputElement).value).toBe("Maggi Masala");
    expect(within(form).getByLabelText(`${say("products.price")} (₹)`)).toBeTruthy();
    expect((within(form).getByLabelText(say("products.unit")) as HTMLInputElement).placeholder).toBe(say("products.unitPlaceholder"));
    expect(within(form).getByLabelText(say("products.gstRate"))).toBeTruthy();
    const category = within(form).getByLabelText(say("products.col.category")) as HTMLSelectElement;
    expect([...category.options].map((o) => o.textContent)).toEqual([say("products.noCategory"), "Namkeen", "Doodh Dahi"]);
    expect(within(form).getByLabelText(say("products.barcodeOptional"))).toBeTruthy();
    expect(within(form).queryByLabelText(say("products.openingStock"))).toBeNull(); // only when adding
    failing["PATCH /api/v1/products/p-1"] = refuse(409, "conflict", "A product with this barcode already exists");
    await user.click(within(form).getByRole("button", { name: say("products.saveChanges") }));
    expect((await within(form).findByRole("alert")).textContent).toBe(language === "en" ? "A product with this barcode already exists" : say("error.conflict"));
    await user.click(within(form).getByRole("button", { name: say("common.cancel") }));

    await user.click(screen.getByRole("button", { name: say("products.add") }));
    const adding = screen.getByRole("form", { name: say("products.add") });
    expect(within(adding).getByLabelText(say("products.openingStock"))).toBeTruthy();
    expect(within(adding).getByRole("button", { name: say("products.save") })).toBeTruthy();

    if (language === "en") {
      expect(within(maggi).getByText("In stock")).toBeTruthy();
      expect(within(oil).getByRole("button", { name: "Put on sale" })).toBeTruthy();
    } else {
      expect(within(maggi).getByText("സ്റ്റോക്കുണ്ട്")).toBeTruthy();
      expect(within(oil).getByRole("button", { name: "വിൽപ്പനയിലാക്കുക" })).toBeTruthy();
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("Products: the empty and no-match messages", async () => {
    failing["GET /api/v1/products"] = json([]);
    const { say } = load("/catalogue/products", language);
    expect(await screen.findByText(say("products.none"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Stock: levels, the low-stock filter and adjusting a count", async () => {
    const { user, say } = load("/catalogue/stock", language);
    expect(await screen.findByRole("heading", { name: HEADINGS_MORE[language].stock, level: 1 })).toBeTruthy();
    expect(screen.getByText(say("stock.subtitle"))).toBeTruthy();
    const butter = await screen.findByRole("listitem", { name: "Amul Butter" });
    expect(within(butter).getByText(say("catalogue.outOfStock"))).toBeTruthy();
    const maggi = screen.getByRole("listitem", { name: "Maggi Masala" });
    expect(within(maggi).getByText(say("stock.level.ok"))).toBeTruthy();

    await user.click(within(butter).getByRole("button", { name: say("stock.adjust") }));
    const form = within(butter).getByRole("form", { name: say("stock.adjustOf", { name: "Amul Butter" }) });
    const quantity = within(form).getByLabelText(say("stock.quantityUnit", { unit: "pcs" })) as HTMLInputElement;
    expect(quantity.placeholder).toBe(say("stock.quantityIn", { unit: "pcs" }));
    expect(within(form).getByRole("button", { name: say("stock.add") })).toBeTruthy();
    expect(within(form).getByRole("button", { name: say("common.cancel") })).toBeTruthy();
    await user.type(quantity, "3");
    failing["POST /api/v1/inventory/adjustments"] = refuse(409, "insufficient_stock", "Stock cannot go below zero");
    await user.click(within(form).getByRole("button", { name: say("stock.remove") }));
    expect((await within(form).findByRole("alert")).textContent).toBe(language === "en" ? "Stock cannot go below zero" : say("error.insufficient_stock"));

    await user.click(screen.getByLabelText(say("stock.onlyLow")));
    expect(screen.queryByRole("listitem", { name: "Maggi Masala" })).toBeNull();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Stock: nothing low", async () => {
    failing["GET /api/v1/products"] = json([PRODUCTS[0]]);
    const { user, say } = load("/catalogue/stock", language);
    await user.click(await screen.findByLabelText(say("stock.onlyLow")));
    expect(screen.getByText(say("stock.nothingLow"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });
});

describe.each(["en", "ml"] as const)("the customer storefront and the Shop's Storefront and QR pages in %s", (language) => {
  const STORE_PATH = "/store/ramesh-general-store";

  it("browsing, the cart and checkout, including a refused order", async () => {
    localStorage.setItem("dukaanos.store.ramesh-general-store.lastOrder", ORDERS[2].id);
    const { user, say } = load(STORE_PATH, language);
    expect(await screen.findByRole("link", { name: `${say("store.trackLast")} →` })).toBeTruthy();
    const search = screen.getByLabelText(say("products.search")) as HTMLInputElement;
    expect(search.placeholder).toBe(say("store.searchPlaceholder"));
    const categories = screen.getByRole("group", { name: say("nav.categories") });
    expect(within(categories).getAllByRole("button").map((b) => b.textContent)).toEqual([say("store.all"), "Namkeen", "Doodh Dahi"]);
    const list = screen.getByRole("list", { name: say("nav.products") });
    expect(within(within(list).getByRole("listitem", { name: "Amul Butter" })).getByText(say("catalogue.outOfStock"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("store.cartCount.other", { count: 0 }) }).textContent).toBe(say("store.cart"));

    await user.click(screen.getByRole("button", { name: say("store.addName", { name: "Maggi Masala" }) }));
    expect(screen.getByRole("button", { name: say("cart.increase", { name: "Maggi Masala" }) })).toBeTruthy();
    expect(screen.getByLabelText(say("cart.quantityOf", { name: "Maggi Masala" })).textContent).toBe("1");
    const header = screen.getByRole("link", { name: say("store.cartCount.one", { count: 1 }) });
    expect(header.textContent).toBe(`${say("store.cart")} · 1 · ₹14.00`);
    await user.type(search, "zzz");
    expect(screen.getByText(say("picker.noMatch"))).toBeTruthy();
    await user.clear(search);

    await user.click(screen.getByRole("link", { name: say("store.viewCart.one", { count: 1, amount: "₹14.00" }) }));
    expect(await screen.findByRole("heading", { name: say("store.yourCart") })).toBeTruthy();
    const items = screen.getByRole("list", { name: say("store.cartItems") });
    expect(within(items).getByRole("button", { name: say("store.removeName", { name: "Maggi Masala" }) }).textContent).toBe(say("common.remove"));
    expect(screen.getByText(say("cart.subtotal"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("store.continue") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);

    await user.click(screen.getByRole("link", { name: say("store.toCheckout") }));
    expect(await screen.findByRole("heading", { name: say("store.checkout"), level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("store.yourOrderFrom", { store: "Ramesh General Store" }) })).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("store.yourDetails") })).toBeTruthy();
    expect(screen.getByRole("list", { name: say("store.orderSummary") }).textContent).toContain("Maggi Masala");
    expect(screen.getByLabelText(say("store.name"))).toBeTruthy();
    const phone = screen.getByLabelText(say("store.phone"));
    await user.type(phone, "abc");
    expect(screen.getByText(say("store.phoneDigits"))).toBeTruthy();
    await user.clear(phone);
    expect(screen.getByText(say("store.payAtStore"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("store.backToCart") })).toBeTruthy();

    failing["POST /api/v1/public/stores/ramesh-general-store/orders"] = refuse(409, "insufficient_stock", "Only 0 left of Maggi Masala");
    await user.click(screen.getByRole("button", { name: say("store.place", { amount: "₹14.00" }) }));
    const reason = language === "en" ? "Only 0 left of Maggi Masala" : say("error.insufficient_stock");
    expect((await screen.findByRole("alert")).textContent).toBe(say("store.notPlaced", { reason }));
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("an empty cart, with a product the store no longer sells", async () => {
    localStorage.setItem("dukaanos.store.ramesh-general-store.cart", JSON.stringify({ "p-gone": 2 }));
    const { say } = load(`${STORE_PATH}/cart`, language);
    expect(await screen.findByText(say("store.cartEmpty"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("store.browse") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("following an order, and an order or store that does not exist", async () => {
    const { say } = load(`${STORE_PATH}/order/${ORDERS[2].id}`, language);
    expect((await screen.findByRole("status")).textContent).toBe(
      say("orders.order", { number: orderNumber(ORDERS[2].id) }) + say("store.headline.ready"),
    );
    const steps = screen.getByRole("list", { name: say("store.orderProgress") });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      (["pending", "confirmed", "ready", "completed"] as const).map((s) => say(`store.step.${s}`)),
    );
    expect(screen.getByRole("list", { name: say("store.orderedItems") }).textContent).toContain("Amul Butter");
    expect(screen.getByText(say("store.notPaid"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("store.back") })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
    cleanup();

    load(`${STORE_PATH}/order/nope`, language);
    expect((await screen.findByRole("alert")).textContent).toBe(say("store.orderNotFound"));
    cleanup();
    load("/store/no-such-store", language);
    expect(await screen.findByText(say("store.notFound"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("the merchant's Storefront and QR pages", async () => {
    const { say } = load("/shop/storefront", language);
    const mine = await screen.findByRole("region", { name: say("storefront.yours") });
    const url = within(mine).getByText(/\/store\/ramesh-general-store$/).textContent!;
    expect(within(mine).getByRole("link", { name: say("storefront.open") })).toBeTruthy();
    expect(within(mine).getByRole("button", { name: say("qr.copy") })).toBeTruthy();
    expect(within(mine).getByRole("link", { name: say("storefront.getQr") })).toBeTruthy();
    // The sentence keeps its link to Orders, in the language's own word order.
    expect(within(mine).getByRole("link", { name: say("nav.orders") }).parentElement!.textContent).toBe(
      say("storefront.opensAs", { orders: say("nav.orders") }),
    );
    expect(screen.getByRole("heading", { name: say("storefront.whatCustomersSee") })).toBeTruthy();
    expect(await screen.findByText(say("storefront.onSale", { count: 2 }))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("storefront.editProducts") })).toBeTruthy();
    // Identifiers a merchant or developer types exactly: the address, and the setting's name.
    const identifiers = [url, "VITE_STOREFRONT_ORIGIN", "localhost"];
    if (language === "ml") expect(latinWordsOnScreen(identifiers)).toEqual([]);
    cleanup();

    load("/shop/qr", language);
    const qr = await screen.findByRole("region", { name: say("qr.yourQr") });
    expect(within(qr).getByRole("img", { name: say("qr.codeFor", { url }) })).toBeTruthy();
    expect(within(qr).getByText(say("qr.scanToShop"))).toBeTruthy();
    expect(within(qr).getByRole("button", { name: say("qr.print") })).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("qr.howTo") })).toBeTruthy();
    for (const key of ["qr.step1", "qr.step2", "qr.step3", "qr.step4"] as const) expect(screen.getByText(say(key)), key).toBeTruthy();
    expect(screen.getByRole("heading", { name: say("qr.link") })).toBeTruthy();
    expect(await screen.findByText(say("qr.customersSee", { count: 2 }))).toBeTruthy();
    if (url.includes("localhost")) expect(screen.getByRole("note").textContent).toBe(say("qr.localhost"));
    if (language === "ml") expect(latinWordsOnScreen(identifiers)).toEqual([]);
  });
});

describe.each(["en", "ml"] as const)("Dashboard, Opportunities and Analytics in %s", (language) => {
  /** Each insight as the merchant should read it: the backend's words in English, the language's otherwise. */
  function insightLines(say: (key: MessageKey, values?: Record<string, string | number>) => string) {
    if (language === "en") return INSIGHTS.map((i) => [i.title, i.detail]);
    return [
      [say("insight.stockout.title", { name: "Maggi Masala", days: 2 }), say("insight.stockout.detail", { sold: 18, unit: "pcs", window: 14, trend: say("insight.trend.climbing"), left: 3 })],
      [say("insight.dead.title", { name: "Amul Butter", days: 30 }), say("insight.dead.detail", { stock: 4, unit: "pcs" })],
      [say("insight.winback.title", { name: "Priya Nair", days: 21 }), say("insight.winback.detail", { days: 7 })],
      [say("insight.khata.title", { name: "Rahul Sharma", amount: "₹850.00" }), say("insight.khata.lastPaid", { days: 40 })],
    ]; // prettier-ignore
  }

  it("Dashboard: today's figures, activity, what needs attention and Salaahkaar", async () => {
    const now = new Date().toISOString();
    failing["GET /api/v1/orders"] = json([{ ...ORDERS[3], id: "60000000-ffff", channel: "counter", created_at: now }, ...ORDERS]);
    const { say } = load("/", language);
    expect(await screen.findByRole("heading", { name: say("nav.dashboard"), level: 1 })).toBeTruthy();
    expect(screen.getByText(say("dash.subtitle"))).toBeTruthy();
    for (const key of ["dash.salesToday", "dash.bills", "dash.online", "dash.khataOutstanding"] as const)
      expect(screen.getByText(say(key)), key).toBeTruthy();
    expect(
      await screen.findByText(`${say("dash.completedSales.one", { count: 1 })} · ${say("dash.trend.above", { pct: 12 })}`),
    ).toBeTruthy();
    expect(screen.getByText(say("dash.waiting", { count: 1 }))).toBeTruthy();
    expect(screen.getByText(say("dash.billsHint"))).toBeTruthy();
    expect(await screen.findByText(say("dash.owe.one", { count: 1 }))).toBeTruthy();

    // Today's activity: one counter bill, its time in the language's own format.
    const activity = screen.getByRole("heading", { name: say("dash.activity") }).closest("section")!;
    expect(within(activity).getByText(say("dash.activityCount.one", { count: 1 }))).toBeTruthy();
    expect(within(activity).getByText(say("dash.counterBill", { number: orderNumber("60000000-ffff") }))).toBeTruthy();
    expect(within(activity).getByText(say("dash.standing.paid"))).toBeTruthy();
    expect(activity.textContent).toContain(` · ${say("dash.items.one", { count: 1 })}`);

    // What needs attention: the pending online order, and every insight in the app's language.
    const attention = screen.getByRole("heading", { name: say("dash.attention") }).closest("section")!;
    expect(within(attention).getByText(say("dash.newOnline.one", { count: 1 }))).toBeTruthy();
    expect(within(attention).getByText(say("dash.acceptOrReject"))).toBeTruthy();
    for (const [title, detail] of insightLines(say)) {
      expect(await within(attention).findByText(title)).toBeTruthy();
      expect(within(attention).getByText(detail)).toBeTruthy();
    }
    expect(within(attention).getAllByRole("button", { name: say("common.dismiss") })).toHaveLength(4);
    expect(within(attention).getByRole("link", { name: say("dash.seeAll") })).toBeTruthy();

    const salaahkaar = screen.getByRole("region", { name: say("dash.salaahkaar") });
    expect(within(salaahkaar).getByRole("heading", { name: say("dash.askAnything") })).toBeTruthy();
    expect(within(salaahkaar).getByText(say("dash.askTopics"))).toBeTruthy();
    expect(within(salaahkaar).getByRole("button", { name: say("shell.askSalaahkaar") })).toBeTruthy();

    if (language === "ml") {
      expect(within(attention).getByText("Maggi Masala 2 ദിവസത്തിനകം തീർന്നേക്കാം")).toBeTruthy();
      expect(latinWordsOnScreen()).toEqual([]);
    }
  });

  it("Dashboard with nothing today: the empty activity and the earlier orders", async () => {
    failing["GET /api/v1/insights"] = json([]);
    const { say } = load("/", language);
    expect(await screen.findByText(say("dash.noneToday"))).toBeTruthy();
    expect(screen.getByRole("link", { name: say("dash.startBill") })).toBeTruthy();
    expect(screen.getByText(say("dash.earlier"))).toBeTruthy();
    expect(screen.getByText(say("dash.onlineOrder", { number: orderNumber(ORDERS[0].id) }))).toBeTruthy();
    for (const key of ["pending", "confirmed", "ready", "paid", "cancelled"] as const) expect(screen.getByText(say(`dash.standing.${key}`)), key).toBeTruthy();
    expect(await screen.findByText(say("dash.newOnline.one", { count: 1 }))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Opportunities: filters, every insight in the language, and the actions", async () => {
    const { user, say } = load("/insights", language);
    expect(await screen.findByRole("heading", { name: say("nav.opportunities"), level: 1 })).toBeTruthy();
    expect(screen.getByText(say("insights.subtitle"))).toBeTruthy();
    expect(await screen.findByRole("button", { name: say("insights.all", { count: 4 }) })).toBeTruthy();
    for (const [title, detail] of insightLines(say)) {
      expect(screen.getByRole("link", { name: title })).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
    }
    expect(screen.getAllByRole("button", { name: say("insights.snooze") })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: say("common.dismiss") })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: say("insights.handled") })).toHaveLength(4);

    await user.click(screen.getByRole("button", { name: `${say("insights.kind.khata_risk")} (1)` }));
    const [stockout, , , khata] = insightLines(say);
    expect(screen.getByRole("link", { name: khata[0] })).toBeTruthy();
    expect(screen.queryByRole("link", { name: stockout[0] })).toBeNull();
    expect(screen.getByText(say("insights.kind.khata_risk"), { selector: "span" })).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("an insight sentence the app does not know is shown as the backend wrote it", async () => {
    failing["GET /api/v1/insights"] = json([insight("dead_stock", "p-9", "Fortune Oil has a new kind of problem", "Ask the store owner")]);
    const { say } = load("/insights", language);
    expect(await screen.findByRole("link", { name: "Fortune Oil has a new kind of problem" })).toBeTruthy();
    expect(screen.getByText("Ask the store owner")).toBeTruthy();
    expect(screen.getByText(say("insights.kind.dead_stock"), { selector: "span" })).toBeTruthy();
  });

  it("Opportunities with nothing to do", async () => {
    failing["GET /api/v1/insights"] = json([]);
    const { say } = load("/insights", language);
    expect(await screen.findByText(say("dash.nothing"))).toBeTruthy();
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });

  it("Analytics: ranges, charts, their table view and an empty chart", async () => {
    const { user, say } = load("/analytics", language);
    expect(await screen.findByRole("heading", { name: say("nav.analytics"), level: 1 })).toBeTruthy();
    expect(screen.getByText(say("analytics.subtitle"))).toBeTruthy();
    const ranges = screen.getByRole("group", { name: say("analytics.range") });
    expect(within(ranges).getAllByRole("button").map((b) => b.textContent)).toEqual([7, 14, 30].map((days) => say("analytics.last", { days })));
    for (const key of ["analytics.revenueTrend", "analytics.topProducts", "analytics.topCustomers", "analytics.byCategory"] as const)
      expect(screen.getByRole("heading", { name: say(key) }), key).toBeTruthy();
    expect(await screen.findByText(say("analytics.total", { amount: "₹400.00" }))).toBeTruthy();
    expect(screen.getByRole("img", { name: say("charts.trend") })).toBeTruthy();
    expect(await screen.findByText(say("charts.noData"))).toBeTruthy(); // no top customers in this period

    const trend = screen.getByRole("heading", { name: say("analytics.revenueTrend") }).closest("section")!;
    await user.click(within(trend).getByRole("button", { name: say("charts.viewTable") }));
    expect(within(trend).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([say("charts.name"), say("charts.value")]);
    expect(within(trend).getByRole("button", { name: say("charts.hideTable") })).toBeTruthy();
    expect(screen.getAllByText("Maggi Masala").length).toBeGreaterThan(0); // a product's name, as entered
    if (language === "ml") expect(latinWordsOnScreen()).toEqual([]);
  });
});

describe.each(["en", "ml"] as const)("Salaahkaar in %s", (language) => {
  /** The example questions are the ways a merchant may type to Salaahkaar; they stay as written in every language. */
  const EXAMPLE_QUESTIONS = ["Aaj kitni bikri hui?", "Rahul Sharma ka kitna udhaar hai?", "Maggi ka stock kitna hai?", "Which products are low in stock?"];

  it("the panel's words, an answer and where it was read from, and a failed question", async () => {
    failing["GET /api/v1/assistant/status"] = json({ available: true, reason: null, capabilities: [] });
    const { user, say } = load("/khata", language);
    await user.click(await screen.findByRole("button", { name: say("shell.askSalaahkaar") }));
    const panel = within(await screen.findByRole("dialog", { name: say("dash.salaahkaar") }));
    expect(panel.getByRole("heading", { name: say("dash.salaahkaar") })).toBeTruthy();
    expect(panel.getByText(say("salaahkaar.tagline"))).toBeTruthy();
    expect(panel.getByText(say("salaahkaar.hello"))).toBeTruthy();
    expect(panel.getByText(say("salaahkaar.hello")).parentElement!.textContent).toBe(`${say("salaahkaar.hello")}, Ramesh!`);
    expect(panel.getByText((_, el) => el?.tagName === "P" && el.textContent === say("salaahkaar.intro", { hindi: "हिंदी" }))).toBeTruthy();
    const tryAsking = panel.getByRole("heading", { name: language === "en" ? "Try asking · ऐसे पूछिए" : say("salaahkaar.tryAsking") });
    expect(tryAsking).toBeTruthy();
    expect(within(panel.getByRole("list", { name: say("salaahkaar.examples") })).getAllByRole("button")).toHaveLength(8);
    if (language === "ml") expect(latinWordsOnScreen(EXAMPLE_QUESTIONS)).toEqual([]);

    let reply: Response = json({ answer: "Aaj ₹420 ki bikri hui.", tools_used: ["get_today_sales", "get_product_stock", "mystery_tool"] });
    server.handle = ((handle) => async (req: Request) =>
      req.method === "POST" && new URL(req.url).pathname === "/api/v1/assistant/ask" ? reply.clone() : handle(req))(server.handle);
    await user.type(panel.getByLabelText(say("salaahkaar.yourQuestion")), "How much did I sell today?");
    await user.click(panel.getByRole("button", { name: say("salaahkaar.ask") }));
    const conversation = await panel.findByRole("list", { name: say("salaahkaar.conversation") });
    expect(conversation.textContent).toContain("Aaj ₹420 ki bikri hui."); // the answer is the assistant's own words
    // Where it came from, in the app's words; a tool the app does not know keeps the backend's name.
    expect(within(conversation).getByText(say("salaahkaar.fromRecords", {
      sources: [say("salaahkaar.source.sales"), say("salaahkaar.source.stock"), "mystery_tool"].join(", "),
    }))).toBeTruthy(); // prettier-ignore
    expect(panel.getByRole("button", { name: say("salaahkaar.clear") })).toBeTruthy();

    reply = refuse(503, "assistant_unavailable", "Salaahkaar could not answer right now. Groq could not be reached (ConnectTimeout)");
    await user.type(panel.getByLabelText(say("salaahkaar.yourQuestion")), "And yesterday?");
    await user.click(panel.getByRole("button", { name: say("salaahkaar.ask") }));
    const alert = await panel.findByRole("alert");
    expect(within(alert).getByText(say("salaahkaar.noAnswer"))).toBeTruthy();
    expect(alert.textContent).toContain(language === "en" ? "Groq could not be reached (ConnectTimeout)" : say("error.assistant_unavailable"));
    expect(within(alert).getByText(say("salaahkaar.stillInBox"))).toBeTruthy();
    expect(panel.getByRole("button", { name: say("salaahkaar.close") })).toBeTruthy();
  });

  it("when Salaahkaar is unavailable, a question is not sent and the panel says so", async () => {
    failing["GET /api/v1/assistant/status"] = json({ available: false, reason: null, capabilities: [] });
    const { user, say } = load("/khata", language);
    await user.click(await screen.findByRole("button", { name: say("shell.askSalaahkaar") }));
    const panel = within(await screen.findByRole("dialog", { name: say("dash.salaahkaar") }));
    // The backend gave no reason, so the app's own line is shown, then that nothing was sent.
    expect((await panel.findByRole("status")).textContent).toBe(say("salaahkaar.unavailable"));
    await user.click(panel.getByRole("button", { name: "Aaj kitni bikri hui?" }));
    expect(panel.getByRole("alert").textContent).toBe(`${say("salaahkaar.unavailable")} ${say("salaahkaar.notSent")}`);
    if (language === "ml") expect(latinWordsOnScreen(EXAMPLE_QUESTIONS)).toEqual([]);
  });
});

describe("no English is written into these screens", () => {
  const sources = import.meta.glob(
    [
      "../features/shop/ShopPage.tsx",
      "../features/shop/ShopOrdersPage.tsx",
      "../features/khata/KhataPage.tsx",
      "../features/catalogue/CategoriesPage.tsx",
      "../features/catalogue/CatalogueSummary.tsx",
      "../features/khata/KhataCustomerPage.tsx",
      "../features/khata/KhataViews.tsx",
      "../features/catalogue/ProductsPage.tsx",
      "../features/catalogue/StockPage.tsx",
      "../features/catalogue/api.ts",
      "../features/store/StoreLayout.tsx",
      "../features/store/StorefrontPage.tsx",
      "../features/store/QuantityStepper.tsx",
      "../features/store/CartPage.tsx",
      "../features/store/CheckoutPage.tsx",
      "../features/store/OrderPage.tsx",
      "../features/shop/ShopQrPage.tsx",
      "../features/shop/ShopStorefrontPage.tsx",
      "../features/dashboard/DashboardPage.tsx",
      "../features/insights/InsightsPage.tsx",
      "../features/analytics/AnalyticsPage.tsx",
      "../app/charts.tsx",
      "../features/salaahkaar/SalaahkaarPanel.tsx",
      "../features/auth/AuthPage.tsx",
      "../features/counter/Receipt.tsx",
      "../features/counter/paytm/PaytmPay.tsx",
      "../features/counter/barcode/BarcodeScan.tsx",
      "../features/counter/barcode/CameraScan.tsx",
      "../features/counter/vision/LiveVision.tsx",
      "../features/counter/vision/DetectionOverlay.tsx",
      "../features/counter/vision/DetectionReview.tsx",
      "../features/counter/vision/PhotoReview.tsx",
      "../features/counter/vision/camera.ts",
      "../features/counter/vision/review.ts",
      "../features/counter/parchi/ParchiReview.tsx",
      "../features/counter/voice/VoiceReview.tsx",
      "../features/counter/voice/speech.ts",
    ],
    { query: "?raw", eager: true, import: "default" },
  ) as Record<string, string>;

  /**
   * Text a person would read that is typed straight into a component instead of coming from a dictionary:
   * words between tags, a line of words on its own inside JSX, a worded attribute, or a quoted phrase.
   * Class names, routes, query keys and stored values (lower-case single words, or anything with a
   * hyphen, slash or digit) are not text and are not reported.
   */
  function writtenInEnglish(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/^import .*$/gm, "");
    const found = [
      // A tag's own ">" is never after a space; "a > b && <p" is a comparison, not text.
      ...[...code.matchAll(/(?<![=\-\s])>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)].map((m) => m[1]),
      ...[...code.matchAll(/^\s*([A-Z][A-Za-z ,.'’?:·-]*[a-z.?!])\s*$/gm)].map((m) => m[1]),
      ...[...code.matchAll(/\b(?:placeholder|aria-label|title|alt|label|hint|subtitle)=(?:"([^"]*[A-Za-z]{2}[^"]*)"|\{`([^`]*[A-Za-z]{2}[^`]*)`\})/g)].map((m) => m[1] ?? m[2]),
      // A quoted phrase, unless it is compared against (a key name, as in e.key === "Enter").
      ...[...code.matchAll(/(?<!===? )"([A-Z][a-z]+(?: [A-Za-z:.,'’?]+)*|[a-z]+(?: [A-Za-z:.,'’?]+)+)"/g)].map((m) => m[1]),
    ];
    return [...new Set(found.map((s) => s.trim()))];
  }

  it("the check itself notices hardcoded text and ignores what is not text", () => {
    const sample = `
      const tone = "amber"; const cls = "rounded-md bg-emerald-600 px-3";
      <Stat label="Pending" hint={ok ? "nothing waiting" : t("orders.pendingNone")} icon="clock" />
      <th className="py-1.5 font-medium">Phone</th>
      <button type="button" aria-label={\`Order \${number}\`} onClick={() => go("ready")}>
        Mark ready
      </button>
      <p>{t("orders.empty")}</p> <dd>{customer || "Not given"}</dd>`;
    expect(writtenInEnglish(sample).sort()).toEqual(["Mark ready", "Not given", "Order ${number}", "Pending", "Phone", "nothing waiting"]);
  });

  /**
   * Text kept as written on purpose: Salaahkaar's example questions (the ways a merchant may type to it), the
   * product's name, the tax names printed on every Indian bill, the names Voice's languages are known by, and
   * a type name from the API schema (not text at all).
   */
  const KEPT: Record<string, string[]> = {
    "../features/salaahkaar/SalaahkaarPanel.tsx": ["Aaj kitni bikri hui?", "Rahul Sharma ka kitna udhaar hai?", "Maggi ka stock kitna hai?", "Which products are low in stock?"],
    "../features/auth/AuthPage.tsx": ["DukaanOS"],
    "../features/counter/Receipt.tsx": ["CGST", "SGST"],
    "../features/counter/voice/speech.ts": ["English", "Hinglish"],
    "../features/counter/vision/review.ts": ["Detection"],
  };

  it.each(Object.keys(sources))("%s", (path) => {
    expect(writtenInEnglish(sources[path]).filter((text) => !KEPT[path]?.includes(text))).toEqual([]);
  });

  it("covers every converted file", () => {
    expect(Object.keys(sources)).toHaveLength(37);
  });
});
