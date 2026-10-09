// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../../app/router";

/**
 * The Dashboard inside the real app, against an in-memory stand-in for the backend. Every figure on it must
 * be countable from what the stand-in holds: bills, orders, products and khata balances.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const now = new Date().toISOString();
const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

const order = (id: string, channel: string, status: string, payment_status: string, total: string, created_at: string, items = 1) => ({
  id, channel, status, payment_status, total, created_at, customer_name: channel === "shop" ? "Sunita" : null,
  items: Array.from({ length: items }, (_, i) => ({ id: `${id}-${i}` })),
}); // prettier-ignore
const product = (name: string, stock: string) => ({ id: name, name, stock_quantity: stock, price: "10.00", unit: "pcs" });

const insight = (key: string, kind: string, tone: string, link: string, title: string, detail: string) => ({
  key, kind, title, detail, tone, link, product_id: null, customer_id: null, metrics: {}, action: null,
}); // prettier-ignore

let orders: ReturnType<typeof order>[];
let products: ReturnType<typeof product>[];
let balances: { customer_id: string; customer_name: string; balance: string }[];
let insights: ReturnType<typeof insight>[];
let summary: { sales_today: string; sales_trend_pct: number | null; orders_today: number; orders_trend_pct: number | null; khata_outstanding: string; open_insight_count: number };
let calls: string[];

beforeEach(() => {
  calls = [];
  orders = [
    order("aaaa1111-0", "counter", "completed", "paid", "120.00", now, 2),
    order("bbbb2222-0", "counter", "completed", "credit", "80.00", now),
    order("cccc3333-0", "shop", "pending", "unpaid", "50.00", now, 3),
    order("dddd4444-0", "counter", "completed", "paid", "999.00", lastWeek),
    order("eeee5555-0", "shop", "pending", "unpaid", "40.00", lastWeek),
  ];
  products = [product("Maggi", "60.000"), product("Milk", "4.000"), product("Salt", "0.000")];
  balances = [
    { customer_id: "c1", customer_name: "Rahul", balance: "850.00" },
    { customer_id: "c2", customer_name: "Aman", balance: "420.00" },
    { customer_id: "c3", customer_name: "Priya", balance: "-50.00" },
  ];
  insights = [
    insight("stockout_risk:p1", "stockout_risk", "amber", "/catalogue/stock", "Milk may run out in 2 days", "20 pcs sold in the last 14 days, only 4 pcs left"),
    insight("khata_risk:c1", "khata_risk", "red", "/khata/c1", "Rahul owes ₹850.00 with no recent payment", "Never paid back"),
  ];
  summary = { sales_today: "200.00", sales_trend_pct: 12.5, orders_today: 2, orders_trend_pct: 0, khata_outstanding: "1270.00", open_insight_count: insights.length };
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(route);
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store" } });
    if (route === "GET /api/v1/orders") return json(orders);
    if (route === "GET /api/v1/products") return json(products);
    if (route === "GET /api/v1/khata/balances") return json(balances);
    if (route === "GET /api/v1/insights") return json(insights);
    if (route === "GET /api/v1/insights/summary") return json(summary);
    if (route.startsWith("POST /api/v1/insights/") && route.endsWith("/actions"))
      return json({ status: "dismissed", note: null, snoozed_until: null, resolved_by: null, updated_at: now });
    if (route === "GET /api/v1/assistant/status") return json({ available: false, reason: "Salaahkaar is not available yet.", capabilities: [] });
    return json([]);
  };
});

afterEach(cleanup);

function load() {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router };
}

const stat = (label: string) => screen.getByText(label).parentElement!.textContent;
const page = () => within(screen.getByRole("main"));
/** The dashboard with its orders loaded. */
const ready = () => screen.findByText("Counter bill #AAAA1111");

describe("Dashboard", () => {
  it("counts today's sales, bills, online orders and khata from the real records", async () => {
    load();
    await ready();

    // Today: two completed counter bills (one on khata) and one online order still pending. Last week's do not count.
    // The sales figure and its trend come from the insights summary; the completed-sale count still comes from today's orders.
    expect(stat("Today's sales")).toBe("Today's sales₹200.002 completed sales · 13% above last week's daily average");
    expect(stat("Bills")).toBe("Bills2made at the counter today");
    expect(stat("Online orders")).toBe("Online orders12 waiting for you"); // both pending orders wait, old or new
    expect(stat("Khata outstanding")).toBe("Khata outstanding₹1,270.002 customers owe you"); // advance is not owed

    const activity = page().getByText("Today's activity").closest("section")!;
    const rows = within(activity).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Counter bill #AAAA1111");
    expect(rows[0]).toContain("2 items");
    expect(rows[0]).toContain("Paid₹120.00");
    expect(rows[1]).toContain("On khata₹80.00");
    expect(rows[2]).toContain("Online order #CCCC3333");
    expect(rows[2]).toContain("3 items · Sunita");
    expect(rows[2]).toContain("New order₹50.00");
    expect(activity.textContent).not.toContain("₹999.00"); // last week's bill is not today's activity
  });

  it("lists pending online orders alongside proactive insights, each leading to where it is handled", async () => {
    const { user, router } = load();
    await ready();
    const attention = within(page().getByText("Needs attention").closest("section")!);
    expect(attention.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["See all", "/insights"],
      ["2 new online ordersAccept or reject them", "/shop/orders"],
      ["Milk may run out in 2 days20 pcs sold in the last 14 days, only 4 pcs left", "/catalogue/stock"],
      ["Rahul owes ₹850.00 with no recent paymentNever paid back", "/khata/c1"],
    ]);
    await user.click(attention.getByRole("link", { name: /may run out/ }));
    expect(router.state.location.pathname).toBe("/catalogue/stock");
  });

  it("dismisses an insight from the dashboard, which any staff member's action should reflect", async () => {
    const { user } = load();
    await ready();
    const attention = within(page().getByText("Needs attention").closest("section")!);
    const row = attention.getByRole("link", { name: /may run out/ }).closest("li")!;
    calls.length = 0;
    await user.click(within(row).getByRole("button", { name: "Dismiss" }));
    // The insight key is a path segment, so openapi-fetch percent-encodes its colon.
    await waitFor(() => expect(calls).toContain("POST /api/v1/insights/stockout_risk%3Ap1/actions"));
  });

  it("says so when nothing needs attention and nothing happened today, without inventing anything", async () => {
    orders = orders.filter((o) => o.created_at === lastWeek && o.channel === "counter");
    products = [product("Maggi", "60.000")];
    balances = [];
    insights = [];
    summary = { sales_today: "0.00", sales_trend_pct: null, orders_today: 0, orders_trend_pct: null, khata_outstanding: "0.00", open_insight_count: 0 };
    load();
    expect(await screen.findByText("Nothing needs your attention right now.")).toBeTruthy();
    expect(page().getByText(/No bills or orders yet today/)).toBeTruthy();
    expect(stat("Today's sales")).toBe("Today's sales₹0.000 completed sales · no sales last week to compare");
    expect(stat("Online orders")).toBe("Online orders0today · none waiting");
    // The last bill is shown as what it is: earlier, not today.
    const earlier = page().getByText("Earlier").nextElementSibling!;
    expect(earlier.textContent).toContain("Counter bill #DDDD4444");
  });

  it("offers Salaahkaar as part of the product, and stays honest that it cannot answer yet", async () => {
    const { user } = load();
    const card = within(await screen.findByRole("region", { name: "Salaahkaar" }));
    expect(card.getByRole("heading", { name: "Ask your store anything" })).toBeTruthy();
    expect(card.getByText("Sales, stock, customers, Khata and bills.")).toBeTruthy();
    expect((await card.findByRole("note")).textContent).toBe("Not answering yet. Salaahkaar is not available yet.");

    // The card opens the same panel as the top bar. It still sends nothing and answers nothing.
    await user.click(card.getByRole("button", { name: "Ask Salaahkaar" }));
    const panel = within(await screen.findByRole("dialog", { name: "Salaahkaar" }));
    expect((await panel.findByRole("status")).textContent).toContain("Salaahkaar is not available yet.");
    await user.type(panel.getByLabelText("Your question"), "What sold most today?");
    await user.click(panel.getByRole("button", { name: "Ask" }));
    expect(panel.getByRole("alert").textContent).toContain("Your question was not sent.");
  });
});
