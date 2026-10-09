// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import qrcode from "qrcode-generator";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shopRoutes, storeRoutes } from "../../app/router";
import type { Schemas } from "../../lib/api/client";
import { ShopOrdersPage } from "./ShopOrdersPage";
import { storefrontUrl } from "./storefront";

/**
 * Renders the merchant's real Shop routes (/shop/orders, /shop/qr) against an in-memory stand-in for the
 * backend. The stand-in enforces the order lifecycle itself, like the backend: the screen can only ask.
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

type Order = Schemas["OrderRead"];

const ZERO_TAX: Schemas["TaxSummary"] = { taxable_value: "0.00", cgst: "0.00", sgst: "0.00", total_tax: "0.00" };

const order = (id: string, status: Order["status"], lines: [string, string, string][], extra: Partial<Order> = {}): Order => {
  const items = lines.map(([product_name, quantity, unit_price], i) => ({
    id: `${id}-i${i}`,
    product_id: `p-${i}`,
    product_name,
    quantity,
    unit_price,
    tax_rate: "0.00",
    line_total: (Number(quantity) * Number(unit_price)).toFixed(2),
    source: "manual" as const,
  }));
  const total = items.reduce((sum, i) => sum + Number(i.line_total), 0).toFixed(2);
  return {
    id,
    customer_id: null,
    cart_id: `cart-${id}`,
    customer_name: null,
    customer_phone: null,
    channel: "shop",
    status,
    subtotal: total,
    discount: "0.00",
    total,
    tax_summary: ZERO_TAX,
    payment_status: "unpaid",
    items,
    created_at: "2026-10-03T10:00:00Z",
    updated_at: "2026-10-03T10:00:00Z",
    ...extra,
  };
};

const NEXT: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
};

let orders: Order[];
let calls: { route: string; query: string; body: unknown }[];
/** Runs as a status change arrives, before it is judged: lets a test change the order "elsewhere" at that instant. */
let beforeMove: (() => void) | null;

beforeEach(() => {
  localStorage.clear();
  orders = [
    order("10240000-aaaa", "pending", [["Maggi", "2.000", "14.00"], ["Kurkure", "1.000", "20.00"], ["Milk", "1.000", "32.00"]], {
      customer_name: "Sunita",
      customer_phone: "98765 43210",
    }),
    order("20480000-bbbb", "confirmed", [["Tea 250g", "1.000", "50.00"]]),
    order("30720000-cccc", "completed", [["Salt 1kg", "1.000", "28.00"]], { payment_status: "paid" }),
  ]; // prettier-ignore
  calls = [];
  beforeMove = null;
  server.handle = async (req) => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === "PATCH" ? await req.clone().json() : null;
    calls.push({ route, query: url.search, body });
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store" } });
    if (route === "GET /api/v1/products") return json([{ id: "p-1" }, { id: "p-2" }]);
    if (route === "GET /api/v1/orders") return json(orders);
    const moved = /^PATCH \/api\/v1\/orders\/([^/]+)\/status$/.exec(route);
    if (moved) {
      beforeMove?.();
      const target = orders.find((o) => o.id === moved[1]);
      const { status, payment_method } = body as Schemas["OrderStatusUpdate"];
      if (!target) return json({ error: { code: "not_found", message: "Order not found", details: null } }, 404);
      if (!NEXT[target.status]?.includes(status))
        return json({ error: { code: "conflict", message: `An order that is ${target.status} cannot become ${status}`, details: null } }, 409);
      const updated = { ...target, status, payment_status: status === "completed" && payment_method ? ("paid" as const) : target.payment_status };
      orders = orders.map((o) => (o.id === target.id ? updated : o));
      return json(updated);
    }
    return json({ error: { code: "not_found", message: `No fake for ${route}`, details: null } }, 404);
  };
});

afterEach(cleanup);

function openShop(path: string) {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // The app's own Shop routes; only the list's poll is shortened so new orders show within a test.
  const children = shopRoutes.children.map((route) =>
    route.path === "orders" ? { ...route, element: <ShopOrdersPage pollMs={20} /> } : route,
  );
  const router = createMemoryRouter([{ path: "/", children: [{ ...shopRoutes, children }] }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router };
}

const card = (number: string) => screen.getByRole("listitem", { name: `Order ${number}` });
const inSection = (title: string) =>
  within(screen.getByRole("region", { name: title }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("aria-label"))
    .filter(Boolean);
const patches = () => calls.filter((c) => c.route.startsWith("PATCH"));

describe("merchant Shop: orders", () => {
  it("opens on Orders and shows each order with its items, total, customer, payment and status", async () => {
    const { router } = openShop("/shop");
    const incoming = await screen.findByRole("listitem", { name: "Order #10240000" });
    expect(router.state.location.pathname).toBe("/shop/orders");
    expect(calls.find((c) => c.route === "GET /api/v1/orders")?.query).toContain("channel=shop"); // storefront orders only

    expect(incoming.textContent).toContain("New order");
    for (const line of ["2 × Maggi", "1 × Kurkure", "1 × Milk"]) expect(incoming.textContent).toContain(line);
    expect(within(incoming).getByText("Total").parentElement?.textContent).toContain("₹80.00");
    expect(within(incoming).getByText("Customer").parentElement?.textContent).toContain("Sunita · 98765 43210");
    expect(within(incoming).getByText("Payment").parentElement?.textContent).toContain("Unpaid: collect at pickup");
    expect(within(incoming).getByRole("time").getAttribute("datetime")).toBe("2026-10-03T10:00:00Z");
    expect(within(incoming).getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(within(incoming).getByRole("button", { name: "Reject" })).toBeTruthy();

    expect(inSection("New orders")).toEqual(["Order #10240000"]);
    expect(inSection("In progress")).toEqual(["Order #20480000"]);
    expect(inSection("Finished")).toEqual(["Order #30720000"]);
    expect(within(card("#20480000")).getByText("Customer").parentElement?.textContent).toContain("Not given");
    expect(within(card("#30720000")).getByText("Payment").parentElement?.textContent).toContain("Paid");
    expect(within(card("#30720000")).queryByRole("button")).toBeNull(); // a finished order has no moves
  });

  it("takes an order through accept, ready and complete, asking the backend for each step", async () => {
    const { user } = openShop("/shop/orders");
    await user.click(within(await screen.findByRole("listitem", { name: "Order #10240000" })).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(inSection("In progress")).toContain("Order #10240000"));
    expect(card("#10240000").textContent).toContain("Accepted");

    await user.click(within(card("#10240000")).getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(card("#10240000").textContent).toContain("Ready for pickup"));

    // Completing records how the customer paid.
    await user.selectOptions(screen.getByLabelText("Paid by, order #10240000"), "upi");
    await user.click(within(card("#10240000")).getByRole("button", { name: "Complete · collect ₹80.00" }));
    await waitFor(() => expect(inSection("Finished")).toContain("Order #10240000"));
    expect(within(card("#10240000")).getByText("Payment").parentElement?.textContent).toContain("Paid");

    expect(patches().map((c) => [c.route, c.body])).toEqual([
      ["PATCH /api/v1/orders/10240000-aaaa/status", { status: "confirmed" }],
      ["PATCH /api/v1/orders/10240000-aaaa/status", { status: "ready" }],
      ["PATCH /api/v1/orders/10240000-aaaa/status", { status: "completed", payment_method: "upi" }],
    ]);
    // The screen never offers a jump: an accepted order can only be readied or cancelled.
    expect(within(card("#20480000")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Mark ready", "Cancel order"]);
  });

  it("rejects a new order and cancels an accepted one", async () => {
    const { user } = openShop("/shop/orders");
    await user.click(within(await screen.findByRole("listitem", { name: "Order #10240000" })).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(card("#10240000").textContent).toContain("Cancelled"));
    await user.click(within(card("#20480000")).getByRole("button", { name: "Cancel order" }));
    await waitFor(() => expect(inSection("Finished")).toHaveLength(3));
    expect(patches().map((c) => c.body)).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    expect(screen.queryByRole("region", { name: "New orders" })).toBeNull();
  });

  it("shows the backend's refusal when a step is no longer valid", async () => {
    const { user } = openShop("/shop/orders");
    const incoming = await screen.findByRole("listitem", { name: "Order #10240000" });
    // The order is cancelled elsewhere just before this merchant's Accept reaches the backend.
    beforeMove = () => {
      orders = orders.map((o) => (o.id === "10240000-aaaa" ? { ...o, status: "cancelled" } : o));
    };
    await user.click(within(incoming).getByRole("button", { name: "Accept" }));
    // The refusal is shown on the order, and the list then reflects what the backend holds.
    await waitFor(() => expect(inSection("Finished")).toContain("Order #10240000"));
    expect(within(card("#10240000")).getByRole("alert").textContent).toBe("An order that is cancelled cannot become confirmed");
  });

  it("discovers a new order by itself, and says so when there are none", async () => {
    orders = [];
    openShop("/shop/orders");
    expect(await screen.findByText(/No orders yet/)).toBeTruthy();

    orders = [order("40960000-dddd", "pending", [["Milk", "3.000", "32.00"]])]; // a customer just ordered
    const arrived = await screen.findByRole("listitem", { name: "Order #40960000" });
    expect(arrived.textContent).toContain("3 × Milk");
    expect(screen.queryByText(/No orders yet/)).toBeNull();
  });
});

describe("merchant Shop: store QR", () => {
  it("builds the storefront URL from the merchant's slug", () => {
    expect(storefrontUrl("ramesh-general-store", "https://shop.example")).toBe("https://shop.example/store/ramesh-general-store");
    expect(storefrontUrl("ramesh-general-store", "http://192.168.1.20:5173/")).toBe("http://192.168.1.20:5173/store/ramesh-general-store");
    expect(storefrontUrl("ramesh-general-store")).toBe(`${window.location.origin}/store/ramesh-general-store`);
    // It is a route this app really serves, publicly.
    expect(storeRoutes.path).toBe("/store/:storeSlug");
  });

  it("shows a real QR code of the storefront link", async () => {
    openShop("/shop/qr"); // the app's navigation leads here: see app/Navigation.test.tsx

    const url = `${window.location.origin}/store/ramesh-general-store`;
    const code = await screen.findByRole("img", { name: `QR code for ${url}` });
    expect(screen.getByText("Scan to shop")).toBeTruthy();
    expect(screen.getByText("Ramesh General Store")).toBeTruthy();
    expect(screen.getByRole("link", { name: url }).getAttribute("href")).toBe(url);

    // The drawing is the QR encoding of exactly that URL: one dark square per dark module, nothing decorative.
    const expected = qrcode(0, "M");
    expected.addData(url);
    expected.make();
    const size = expected.getModuleCount();
    let dark = 0;
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (expected.isDark(row, col)) dark++;
    const drawn = code.querySelector("path")!.getAttribute("d")!;
    expect(drawn.match(/M/g)).toHaveLength(dark);
    expect(drawn.startsWith("M4 4h1v1h-1z")).toBe(true); // the top-left finder pattern, after the quiet zone
    expect(code.getAttribute("viewBox")).toBe(`0 0 ${size + 8} ${size + 8}`);

    // On localhost the merchant is told a phone cannot open this address.
    expect(screen.getByRole("note").textContent).toContain("a phone cannot open it");
  });
});
