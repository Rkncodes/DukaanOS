// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeRoutes } from "../../app/router";
import type { Schemas } from "../../lib/api/client";
import { cartView, loadCart, orderItems, withQuantity } from "./cart";
import { OrderPage } from "./OrderPage";

/**
 * Renders the real public storefront routes (/store/:storeSlug/...) against an in-memory stand-in for
 * the public store API. The stand-in prices orders itself from its own catalogue, like the backend,
 * so the tests show the customer is shown the server's order, not the browser's arithmetic.
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

const product = (id: string, name: string, price: string, extra: Partial<Schemas["StoreProduct"]> = {}) =>
  ({ id, name, price, unit: "pcs", image_url: null, category_id: null, in_stock: true, ...extra }) satisfies Schemas["StoreProduct"];

const STORE: Schemas["StoreRead"] = {
  store_name: "Ramesh General Store",
  store_slug: "ramesh-general-store",
  categories: [
    { id: "c-snacks", name: "Snacks" },
    { id: "c-dairy", name: "Dairy" },
  ],
};
const kurkure = product("p-kurkure", "Kurkure", "20.00", { category_id: "c-snacks", image_url: "https://img.example/k.png" });
const maggi = product("p-maggi", "Maggi", "14.00", { category_id: "c-snacks" });
const milk = product("p-milk", "Milk", "32.00", { category_id: "c-dairy", unit: "pkt" });
const ghee = product("p-ghee", "Ghee 1L", "600.00", { category_id: "c-dairy", in_stock: false });

let catalogue: Schemas["StoreProduct"][];
let orders: Map<string, Schemas["StoreOrderRead"]>;
let calls: { route: string; body: unknown }[];
let refuse: Response | null;

beforeEach(() => {
  localStorage.clear();
  catalogue = [ghee, kurkure, maggi, milk];
  orders = new Map();
  calls = [];
  refuse = null;
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`;
    const body = req.method === "POST" ? await req.clone().json() : null;
    calls.push({ route, body });
    const base = "/api/v1/public/stores/ramesh-general-store";
    if (!path.startsWith(base)) return json({ error: { code: "not_found", message: "Store not found", details: null } }, 404);
    if (route === `GET ${base}`) return json(STORE);
    if (route === `GET ${base}/products`) return json(catalogue);
    if (route === `POST ${base}/orders`) {
      if (refuse) return refuse;
      // Like the backend: lines are priced from the catalogue, whatever the browser thinks they cost.
      const sent = body as Schemas["StoreOrderCreate"];
      const items = sent.items.map((item) => {
        const p = catalogue.find((c) => c.id === item.product_id)!;
        const quantity = Number(item.quantity);
        return {
          product_id: p.id,
          product_name: p.name,
          quantity: quantity.toFixed(3),
          unit_price: p.price,
          line_total: (quantity * Number(p.price)).toFixed(2),
        };
      });
      const total = items.reduce((sum, i) => sum + Number(i.line_total), 0).toFixed(2);
      const order: Schemas["StoreOrderRead"] = {
        id: "0a1b2c3d-0000-4000-8000-000000000001",
        status: "pending",
        payment_status: "unpaid",
        items,
        subtotal: total,
        total,
        customer_name: sent.customer_name ?? null,
        customer_phone: sent.customer_phone ?? null,
        created_at: "2026-10-03T10:00:00Z",
        updated_at: "2026-10-03T10:00:00Z",
      };
      orders.set(order.id, order);
      return json(order, 201);
    }
    const found = orders.get(path.slice(`${base}/orders/`.length));
    if (req.method === "GET" && found) return json(found);
    return json({ error: { code: "not_found", message: "Order not found", details: null } }, 404);
  };
});

afterEach(cleanup);

function openStore(path = "/store/ramesh-general-store") {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // The app's own routes; only the order page's poll is shortened so status changes show within a test.
  const children = storeRoutes.children.map((route) =>
    route.path === "order/:orderId" ? { ...route, element: <OrderPage pollMs={20} /> } : route,
  );
  const router = createMemoryRouter([{ ...storeRoutes, children }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router };
}

const card = (name: string) => within(screen.getByRole("list", { name: "Products" })).getByRole("listitem", { name });
const names = () =>
  within(screen.getByRole("list", { name: "Products" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("aria-label"));
const posts = () => calls.filter((c) => c.route.startsWith("POST"));

describe("public storefront", () => {
  it("shows the store and its real catalogue without any login", async () => {
    openStore();
    expect(await screen.findByRole("link", { name: "Ramesh General Store" })).toBeTruthy();
    expect(names()).toEqual(["Ghee 1L", "Kurkure", "Maggi", "Milk"]);

    expect(card("Kurkure").textContent).toContain("₹20.00");
    expect(card("Kurkure").textContent).toContain("Snacks");
    expect(card("Kurkure").querySelector("img")?.getAttribute("src")).toBe("https://img.example/k.png");
    expect(card("Milk").textContent).toContain("₹32.00 / pkt");
    // Out of stock is shown and cannot be added.
    expect(card("Ghee 1L").textContent).toContain("Out of stock");
    expect(within(card("Ghee 1L")).queryByRole("button")).toBeNull();

    // Only the public store API was used: no session, no merchant endpoints.
    expect(calls.map((c) => c.route).sort()).toEqual([
      "GET /api/v1/public/stores/ramesh-general-store",
      "GET /api/v1/public/stores/ramesh-general-store/products",
    ]);
  });

  it("searches and filters by category", async () => {
    const { user } = openStore();
    await screen.findByRole("list", { name: "Products" });

    await user.type(screen.getByLabelText("Search products"), "mag");
    expect(names()).toEqual(["Maggi"]);
    await user.clear(screen.getByLabelText("Search products"));
    await user.click(within(screen.getByRole("group", { name: "Categories" })).getByRole("button", { name: "Dairy" }));
    expect(names()).toEqual(["Ghee 1L", "Milk"]);
    await user.type(screen.getByLabelText("Search products"), "soap");
    expect(screen.getByText("No products match.")).toBeTruthy();
    await user.clear(screen.getByLabelText("Search products"));
    await user.click(within(screen.getByRole("group", { name: "Categories" })).getByRole("button", { name: "All" }));
    expect(names()).toHaveLength(4);
  });

  it("says so when the store does not exist", async () => {
    openStore("/store/no-such-store");
    expect(await screen.findByText(/This store could not be found/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Products" })).toBeNull();
  });

  it("adds, increases, decreases and removes products, and keeps the cart across a reload", async () => {
    const { user } = openStore();
    await screen.findByRole("list", { name: "Products" });

    await user.click(screen.getByRole("button", { name: "Add Maggi" }));
    await user.click(screen.getByRole("button", { name: "Increase Maggi" }));
    await user.click(screen.getByRole("button", { name: "Add Kurkure" }));
    await user.click(screen.getByRole("button", { name: "Add Milk" }));
    expect(screen.getByLabelText("Quantity of Maggi").textContent).toBe("2");
    expect(screen.getByRole("link", { name: "Cart, 4 items" }).textContent).toContain("₹80.00"); // 2×14 + 20 + 32
    await user.click(screen.getByRole("button", { name: "Decrease Milk" })); // down to nothing: removed
    expect(screen.getByRole("button", { name: "Add Milk" })).toBeTruthy();
    expect(loadCart("ramesh-general-store")).toEqual({ "p-maggi": 2, "p-kurkure": 1 });

    await user.click(screen.getByRole("link", { name: /View cart · 3 items · ₹48.00/ }));
    const items = await screen.findByRole("list", { name: "Cart items" });
    expect(within(items).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Kurkure", "Maggi"]);
    await user.click(screen.getByRole("button", { name: "Increase Kurkure" }));
    await user.click(screen.getByRole("button", { name: "Remove Maggi" }));
    expect(within(items).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Total").parentElement?.textContent).toContain("₹40.00");
    expect(posts()).toHaveLength(0); // a cart is not an order

    // Reload: the cart is still there. Continue shopping goes back to the products.
    cleanup();
    const again = openStore("/store/ramesh-general-store/cart");
    expect((await screen.findByLabelText("Quantity of Kurkure")).textContent).toBe("2");
    await again.user.click(screen.getByRole("link", { name: "Continue shopping" }));
    expect(await screen.findByRole("list", { name: "Products" })).toBeTruthy();

    // Emptying the cart.
    await again.user.click(screen.getByRole("link", { name: /^Cart/ }));
    await again.user.click(await screen.findByRole("button", { name: "Remove Kurkure" }));
    expect(screen.getByText("Your cart is empty.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
  });

  it("places a real order with ids and quantities only, then shows the order the backend returned", async () => {
    const { user, router } = openStore();
    await screen.findByRole("list", { name: "Products" });
    await user.click(screen.getByRole("button", { name: "Add Maggi" }));
    await user.click(screen.getByRole("button", { name: "Increase Maggi" }));
    await user.click(screen.getByRole("button", { name: "Add Kurkure" }));
    await user.click(screen.getByRole("link", { name: /View cart/ }));
    await user.click(await screen.findByRole("link", { name: "Proceed to checkout" }));

    const summary = await screen.findByRole("list", { name: "Order summary" });
    expect(summary.textContent).toContain("2 × Maggi");
    expect(screen.getByText(/Pay at the store when you collect your order/)).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), " Sunita ");
    await user.type(screen.getByLabelText("Phone"), "abc");
    expect((screen.getByRole("button", { name: /Place order/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText("Phone"));
    await user.type(screen.getByLabelText("Phone"), "98765 43210");

    // The catalogue price changes on the server after the page loaded: the server's price is what counts.
    catalogue = catalogue.map((p) => (p.id === "p-maggi" ? { ...p, price: "15.00" } : p));
    await user.click(screen.getByRole("button", { name: "Place order · ₹48.00" }));

    expect((await screen.findByRole("status")).textContent).toContain("Order #0A1B2C3D");
    expect(posts()).toEqual([
      {
        route: "POST /api/v1/public/stores/ramesh-general-store/orders",
        body: {
          items: [
            { product_id: "p-kurkure", quantity: "1" },
            { product_id: "p-maggi", quantity: "2" },
          ],
          customer_name: "Sunita",
          customer_phone: "98765 43210",
        },
      },
    ]); // no prices, no totals, no merchant id
    expect(router.state.location.pathname).toBe("/store/ramesh-general-store/order/0a1b2c3d-0000-4000-8000-000000000001");
    expect(screen.getByText("Order placed. Waiting for the store to accept it.")).toBeTruthy();
    const ordered = screen.getByRole("list", { name: "Ordered items" });
    expect(ordered.textContent).toContain("2 × Maggi");
    expect(ordered.textContent).toContain("₹30.00"); // 2 × the server's ₹15
    expect(screen.getByText("Total").parentElement?.textContent).toContain("₹50.00");
    expect(screen.getByText("Not paid yet: pay at the store when you collect it.")).toBeTruthy();
    expect(loadCart("ramesh-general-store")).toEqual({}); // the cart is spent
  });

  it("follows the order as the merchant moves it, without a refresh", async () => {
    const { user } = openStore();
    await screen.findByRole("list", { name: "Products" });
    await user.click(screen.getByRole("button", { name: "Add Milk" }));
    await user.click(screen.getByRole("link", { name: /View cart/ }));
    await user.click(await screen.findByRole("link", { name: "Proceed to checkout" }));
    await user.click(await screen.findByRole("button", { name: /Place order/ }));
    await screen.findByText("Order placed. Waiting for the store to accept it.");
    const [id] = [...orders.keys()];
    const step = () => within(screen.getByRole("list", { name: "Order progress" })).getByRole("listitem", { current: "step" });
    expect(step().textContent).toBe("Placed");

    orders.set(id, { ...orders.get(id)!, status: "confirmed" });
    expect(await screen.findByText("The store accepted your order and is getting it ready.")).toBeTruthy();
    expect(step().textContent).toBe("Accepted");
    orders.set(id, { ...orders.get(id)!, status: "ready" });
    expect(await screen.findByText("Your order is ready to collect.")).toBeTruthy();
    orders.set(id, { ...orders.get(id)!, status: "completed", payment_status: "paid" });
    expect(await screen.findByText("Order collected. Thank you!")).toBeTruthy();
    expect(screen.getByText("Paid.")).toBeTruthy();

    // The storefront remembers the order for this customer.
    await user.click(screen.getByRole("link", { name: "Back to the store" }));
    expect(await screen.findByRole("link", { name: "Track your last order →" })).toBeTruthy();
  });

  it("shows a cancelled order as cancelled, and an unknown order as not found", async () => {
    orders.set("o-1", {
      id: "o-1", status: "cancelled", payment_status: "unpaid", subtotal: "32.00", total: "32.00",
      customer_name: null, customer_phone: null, created_at: "2026-10-03T10:00:00Z", updated_at: "2026-10-03T10:05:00Z",
      items: [{ product_id: "p-milk", product_name: "Milk", quantity: "1.000", unit_price: "32.00", line_total: "32.00" }],
    }); // prettier-ignore
    openStore("/store/ramesh-general-store/order/o-1");
    expect(await screen.findByText("The store cancelled this order.")).toBeTruthy();
    expect(screen.getByText("Nothing was charged.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Order progress" })).toBeNull();
    cleanup();

    openStore("/store/ramesh-general-store/order/someone-elses");
    expect((await screen.findByRole("alert")).textContent).toBe("This order could not be found at this store.");
  });

  it("does not pretend an order was placed when the store refuses it", async () => {
    const { user, router } = openStore();
    await screen.findByRole("list", { name: "Products" });
    await user.click(screen.getByRole("button", { name: "Add Maggi" }));
    await user.click(screen.getByRole("link", { name: /View cart/ }));
    await user.click(await screen.findByRole("link", { name: "Proceed to checkout" }));

    refuse = json({ error: { code: "insufficient_stock", message: "Only 0 pcs of Maggi in stock", details: null } }, 409);
    catalogue = catalogue.map((p) => (p.id === "p-maggi" ? { ...p, in_stock: false } : p)); // sold out meanwhile
    await user.click(await screen.findByRole("button", { name: /Place order/ }));

    expect((await screen.findByRole("alert")).textContent).toBe("Your order was not placed: Only 0 pcs of Maggi in stock");
    expect(router.state.location.pathname).toBe("/store/ramesh-general-store/checkout");
    expect(orders.size).toBe(0);
    expect(loadCart("ramesh-general-store")).toEqual({ "p-maggi": 1 }); // the cart is kept

    // The catalogue was re-read: the cart now shows the product as out of stock and blocks checkout.
    await user.click(screen.getByRole("link", { name: "Back to cart" }));
    await waitFor(() => expect(screen.getByText("Out of stock. Remove it to order.")).toBeTruthy());
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
    expect(screen.getByText("Remove the out-of-stock products to continue.")).toBeTruthy();
  });

  it("sends an empty-handed customer from checkout back to the cart", async () => {
    const { router } = openStore("/store/ramesh-general-store/checkout");
    expect(await screen.findByText("Your cart is empty.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/store/ramesh-general-store/cart");
  });
});

describe("storefront cart", () => {
  const products = [kurkure, maggi, milk];

  it("adds, changes and removes quantities", () => {
    let cart = withQuantity({}, "p-maggi", 1);
    cart = withQuantity(cart, "p-maggi", 3);
    cart = withQuantity(cart, "p-milk", 2);
    expect(cart).toEqual({ "p-maggi": 3, "p-milk": 2 });
    expect(withQuantity(cart, "p-milk", 0)).toEqual({ "p-maggi": 3 });
    expect(withQuantity(cart, "p-milk", -1)).toEqual({ "p-maggi": 3 });
    expect(withQuantity(cart, "p-maggi", 5000)).toEqual({ "p-maggi": 999, "p-milk": 2 }); // capped like the backend
  });

  it("prices lines from the catalogue and never orders what the store no longer sells", () => {
    const view = cartView({ "p-maggi": 3, "p-milk": 2, "p-gone": 4 }, products);
    expect(view.lines.map((l) => [l.product.name, l.quantity, l.lineTotal])).toEqual([
      ["Maggi", 3, "42.00"],
      ["Milk", 2, "64.00"],
    ]);
    expect([view.count, view.total, view.unavailable]).toEqual([5, "106.00", ["p-gone"]]);
    expect(orderItems(view)).toEqual([
      { product_id: "p-maggi", quantity: "3" },
      { product_id: "p-milk", quantity: "2" },
    ]);
    expect(cartView({}, products)).toEqual({ lines: [], unavailable: [], count: 0, total: "0.00" });
  });

  it("ignores a damaged stored cart", () => {
    localStorage.setItem("dukaanos.store.s.cart", "{not json");
    expect(loadCart("s")).toEqual({});
    localStorage.setItem("dukaanos.store.s.cart", JSON.stringify({ a: 2, b: -1, c: "3", d: 1.5, e: 5000 }));
    expect(loadCart("s")).toEqual({ a: 2, e: 999 });
  });
});
