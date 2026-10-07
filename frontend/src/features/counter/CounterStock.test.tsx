// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../lib/api/client";
import { CounterPage } from "./CounterPage";

/**
 * Renders the real Counter page against an in-memory stand-in for the backend that keeps its own
 * "database" of products and one cart. Like the real backend, its stock only changes at checkout.
 * So the tests can show both sides: the picker's "N left" follows the bill, and the stock in the
 * database does not move until a sale is completed.
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

type Product = Schemas["ProductRead"];
type Line = Schemas["CartItemRead"];

const product = (id: string, name: string, price: string, stock: string, barcode: string | null = null): Product => ({
  id, name, price, stock_quantity: stock, unit: "pcs", barcode, sku: null, category_id: null, cost_price: null,
  image_url: null, is_active: true, created_at: "", updated_at: "",
}); // prettier-ignore

let db: { products: Product[]; lines: Line[]; cartOpen: boolean };
let calls: { route: string; body: unknown }[];

const stockInDb = (id: string) => db.products.find((p) => p.id === id)!.stock_quantity;

function cart(): Schemas["CartRead"] {
  const subtotal = db.lines.reduce((sum, l) => sum + Number(l.line_total), 0).toFixed(2);
  return {
    id: "cart-1", customer_id: null, channel: "counter", status: db.cartOpen ? "open" : "checked_out",
    items: db.lines, subtotal, created_at: "", updated_at: "",
  }; // prettier-ignore
}

function setLine(p: Product, quantity: number) {
  const line: Line = {
    id: `line-${p.id}`, product_id: p.id, product_name: p.name, quantity: quantity.toFixed(3), unit_price: p.price,
    line_total: (quantity * Number(p.price)).toFixed(2), source: "manual",
  }; // prettier-ignore
  db.lines = db.lines.some((l) => l.product_id === p.id)
    ? db.lines.map((l) => (l.product_id === p.id ? line : l))
    : [...db.lines, line];
}

beforeEach(() => {
  localStorage.clear();
  db = {
    products: [
      product("p-atta", "Aashirvaad Atta 5kg", "295.00", "15.000", "8900000000015"),
      product("p-maggi", "Maggi 70g", "14.00", "3.000"),
      product("p-salt", "Tata Salt 1kg", "28.00", "0.000", "8900000000022"),
    ],
    lines: [],
    cartOpen: true,
  };
  calls = [];
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`;
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.clone().json() : null;
    calls.push({ route, body });

    if (route === "GET /api/v1/auth/me") return json({ user: { name: "Ramesh" }, merchant: { store_name: "Test Store" } });
    if (route === "GET /api/v1/products") return json(db.products);
    if (route === "GET /api/v1/customers" || route === "GET /api/v1/khata/balances") return json([]);
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "POST /api/v1/carts") {
      db.lines = [];
      db.cartOpen = true;
      return json(cart(), 201);
    }
    if (route === "GET /api/v1/carts/cart-1") return json(cart());
    if (route === "POST /api/v1/carts/cart-1/items") {
      const add = body as Schemas["CartItemAdd"];
      const p = db.products.find((x) => (add.product_id ? x.id === add.product_id : x.barcode === add.barcode));
      if (!p) return json({ error: { code: "not_found", message: "No product", details: null } }, 404);
      const existing = db.lines.find((l) => l.product_id === p.id);
      setLine(p, Number(existing?.quantity ?? 0) + Number(add.quantity ?? 1)); // the cart changes; stock does not
      return json(cart());
    }
    const item = /^(PATCH|DELETE) \/api\/v1\/carts\/cart-1\/items\/line-(.+)$/.exec(route);
    if (item) {
      const p = db.products.find((x) => x.id === item[2])!;
      if (item[1] === "DELETE") db.lines = db.lines.filter((l) => l.product_id !== p.id);
      else setLine(p, Number((body as Schemas["CartItemUpdate"]).quantity));
      return json(cart());
    }
    if (route === "POST /api/v1/carts/cart-1/checkout") {
      // The backend's rule, kept authoritative: all lines must be in stock, and only then is stock taken.
      for (const l of db.lines) {
        const p = db.products.find((x) => x.id === l.product_id)!;
        if (Number(l.quantity) > Number(p.stock_quantity))
          return json({ error: { code: "insufficient_stock", message: `Only ${Number(p.stock_quantity)} pcs of ${p.name} in stock`, details: null } }, 409);
      }
      db.products = db.products.map((p) => {
        const l = db.lines.find((x) => x.product_id === p.id);
        return l ? { ...p, stock_quantity: (Number(p.stock_quantity) - Number(l.quantity)).toFixed(3) } : p;
      });
      db.cartOpen = false;
      return json({ id: "order-1" }, 201);
    }
    if (route === "GET /api/v1/orders/order-1/bill") {
      const total = cart().subtotal;
      return json({
        order: {
          id: "order-1", customer_id: null, cart_id: "cart-1", customer_name: null, customer_phone: null, channel: "counter",
          status: "completed", subtotal: total, discount: "0.00", total, payment_status: "paid", created_at: "2026-10-03T10:00:00Z",
          updated_at: "2026-10-03T10:00:00Z", items: db.lines.map((l) => ({ ...l, id: `o-${l.id}` })),
        },
        customer: null, payments: [], khata_entry: null, customer_balance: null,
      } satisfies Schemas["BillRead"]); // prettier-ignore
    }
    return json({ error: { code: "not_found", message: `No fake for ${route}`, details: null } }, 404);
  };
});

afterEach(cleanup);

async function openCounter() {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
  await screen.findByRole("list", { name: "Products" });
  return user;
}

const card = (name: string) =>
  within(screen.getByRole("list", { name: "Products" })).getByRole("button", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
/** The "N left" shown on a product card. */
const left = (name: string) => /([\d.]+ left)$/.exec(card(name).textContent ?? "")?.[1];
const showsLeft = (name: string, text: string) => waitFor(() => expect(left(name)).toBe(text));
const plus = (name: string) => screen.getByRole("button", { name: `Increase ${name}` }) as HTMLButtonElement;
const minus = (name: string) => screen.getByRole("button", { name: `Decrease ${name}` }) as HTMLButtonElement;
const billQuantity = (name: string) => (screen.getByLabelText(`Quantity of ${name}`) as HTMLInputElement).value;
const stockChanging = () =>
  calls.filter((c) => /inventory|\/products\//.test(c.route) || (c.route.includes("/products") && !c.route.startsWith("GET")));

describe("Counter: stock left on the product cards", () => {
  it("shows the database stock while the bill is empty", async () => {
    await openCounter();
    expect([left("Aashirvaad Atta 5kg"), left("Maggi 70g"), left("Tata Salt 1kg")]).toEqual(["15 left", "3 left", "0 left"]);
  });

  it("goes down as units are added and back up as they are removed, without touching the database", async () => {
    const user = await openCounter();
    const atta = "Aashirvaad Atta 5kg";

    await user.click(card(atta));
    await showsLeft(atta, "14 left");
    await user.click(card(atta));
    await showsLeft(atta, "13 left");
    await user.click(plus(atta)); // + on the bill counts just the same
    await showsLeft(atta, "12 left");
    expect(billQuantity(atta)).toBe("3");

    await user.click(minus(atta));
    await showsLeft(atta, "13 left");
    await user.click(minus(atta));
    await showsLeft(atta, "14 left");

    // Removing the product from the bill gives every unit back.
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await showsLeft(atta, "15 left");
    expect(screen.getByText("Scan or tap a product to start the bill.")).toBeTruthy();

    // Through all of that the stock in the database never moved, and nothing asked it to.
    expect(stockInDb("p-atta")).toBe("15.000");
    expect(stockChanging()).toEqual([]);
  });

  it("works each product out on its own", async () => {
    const user = await openCounter();
    await user.click(card("Aashirvaad Atta 5kg"));
    await user.click(card("Maggi 70g"));
    await showsLeft("Maggi 70g", "2 left");
    await user.click(card("Maggi 70g"));
    await showsLeft("Maggi 70g", "1 left");
    expect([left("Aashirvaad Atta 5kg"), left("Maggi 70g"), left("Tata Salt 1kg")]).toEqual(["14 left", "1 left", "0 left"]);

    // Taking one product off the bill restores that product only.
    await user.click(within(screen.getByText("Aashirvaad Atta 5kg", { selector: "div" }).closest("li")!).getByRole("button", { name: "Remove" }));
    await showsLeft("Aashirvaad Atta 5kg", "15 left");
    expect(left("Maggi 70g")).toBe("1 left");
    expect([stockInDb("p-atta"), stockInDb("p-maggi")]).toEqual(["15.000", "3.000"]);
  });

  it("does not let a product with no stock be added", async () => {
    const user = await openCounter();
    expect(left("Tata Salt 1kg")).toBe("0 left");
    expect(card("Tata Salt 1kg").disabled).toBe(true);
    await user.click(card("Tata Salt 1kg"));

    // Nor by scanning its barcode or searching and pressing Enter.
    await user.type(screen.getByLabelText("Scan barcode or search product"), "8900000000022{Enter}");
    expect(screen.getByText("No more Tata Salt 1kg in stock")).toBeTruthy();
    await user.clear(screen.getByLabelText("Scan barcode or search product"));
    await user.type(screen.getByLabelText("Scan barcode or search product"), "tata salt{Enter}");
    expect(screen.getByText("No more Tata Salt 1kg in stock")).toBeTruthy();

    expect(calls.filter((c) => c.route.startsWith("POST"))).toEqual([]); // nothing was added, no cart was even made
  });

  it("stops at the stock: the last unit can be added, one more cannot", async () => {
    const user = await openCounter();
    const maggi = "Maggi 70g";
    await user.click(card(maggi));
    await user.click(plus(maggi));
    await showsLeft(maggi, "1 left");
    expect(plus(maggi).disabled).toBe(false); // one is left, so + still works
    expect(card(maggi).disabled).toBe(false);

    await user.click(plus(maggi));
    await showsLeft(maggi, "0 left");
    expect(billQuantity(maggi)).toBe("3");
    expect(plus(maggi).disabled).toBe(true);
    expect(card(maggi).disabled).toBe(true);

    // Every way of asking for a fourth is refused on screen.
    const requests = calls.length;
    await user.click(plus(maggi));
    await user.click(card(maggi));
    await user.clear(screen.getByLabelText("Scan barcode or search product"));
    await user.type(screen.getByLabelText("Scan barcode or search product"), "maggi{Enter}");
    expect(screen.getByText("No more Maggi 70g in stock")).toBeTruthy();
    expect(calls.length).toBe(requests);
    // Typing a larger number into the bill is brought back to what there is.
    await user.clear(screen.getByLabelText(`Quantity of ${maggi}`));
    await user.type(screen.getByLabelText(`Quantity of ${maggi}`), "16{Enter}");
    await waitFor(() => expect(billQuantity(maggi)).toBe("3"));
    expect(db.lines[0].quantity).toBe("3.000");

    // Taking one off makes room again.
    await user.click(minus(maggi));
    await showsLeft(maggi, "1 left");
    expect(plus(maggi).disabled).toBe(false);
    expect(stockInDb("p-maggi")).toBe("3.000");
  });

  it("caps a typed quantity at the stock and scanning a barcode counts too", async () => {
    const user = await openCounter();
    const atta = "Aashirvaad Atta 5kg";
    await user.type(screen.getByLabelText("Scan barcode or search product"), "8900000000015{Enter}");
    await showsLeft(atta, "14 left");
    await user.clear(screen.getByLabelText(`Quantity of ${atta}`));
    await user.type(screen.getByLabelText(`Quantity of ${atta}`), "7{Enter}");
    await showsLeft(atta, "8 left"); // stock 15, 7 on the bill
    await user.clear(screen.getByLabelText(`Quantity of ${atta}`));
    await user.type(screen.getByLabelText(`Quantity of ${atta}`), "40{Enter}");
    await showsLeft(atta, "0 left");
    expect(billQuantity(atta)).toBe("15");
    expect(stockInDb("p-atta")).toBe("15.000");
  });

  it("shows the real stock after a completed sale, which is the only thing that reduces it", async () => {
    const user = await openCounter();
    const atta = "Aashirvaad Atta 5kg";
    for (let i = 0; i < 7; i++) await user.click(card(atta));
    await showsLeft(atta, "8 left");
    expect(stockInDb("p-atta")).toBe("15.000"); // still the full stock before the sale

    await user.click(screen.getByRole("button", { name: /Collect/ }));
    await user.click(await screen.findByRole("button", { name: "New bill" }));
    expect(stockInDb("p-atta")).toBe("8.000"); // the sale took the 7
    await screen.findByRole("list", { name: "Products" });
    await showsLeft(atta, "8 left"); // the new bill is empty: this is the database's figure
    await user.click(card(atta));
    await showsLeft(atta, "7 left");
  });

  it("follows stock that changed elsewhere, and leaves the last word to the backend at checkout", async () => {
    const user = await openCounter();
    const atta = "Aashirvaad Atta 5kg";
    await user.click(card(atta));
    await user.click(plus(atta));
    await user.click(plus(atta));
    await showsLeft(atta, "12 left");

    // A storefront order takes 14 of the 15 while this bill is open. This screen has not reloaded yet.
    db.products = db.products.map((p) => (p.id === "p-atta" ? { ...p, stock_quantity: "1.000" } : p));
    await user.click(screen.getByRole("button", { name: /Collect/ }));

    // The backend refuses the sale; nothing is shown as sold and its stock is untouched.
    expect(await screen.findByText("Only 1 pcs of Aashirvaad Atta 5kg in stock")).toBeTruthy();
    expect(screen.queryByText("Bill complete")).toBeNull();
    expect(stockInDb("p-atta")).toBe("1.000");
    // The catalogue was re-read: the card and the bill now show the shortfall.
    await showsLeft(atta, "0 left");
    expect(screen.getByText("Only 1 in stock")).toBeTruthy();
    expect(plus(atta).disabled).toBe(true);
  });
});
