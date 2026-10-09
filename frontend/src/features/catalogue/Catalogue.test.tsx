// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogueRoutes } from "../../app/router";
import type { Schemas } from "../../lib/api/client";

/**
 * The Catalogue pages on their real routes, against an in-memory stand-in for the existing catalog and
 * inventory APIs. Like the backend, the stand-in owns the data and the rules (no stock below zero, no
 * duplicate barcode): the pages only ask and then read back.
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
const refuse = (status: number, code: string, message: string) => json({ error: { code, message, details: null } }, status);

type Product = Schemas["ProductRead"];
type Category = Schemas["CategoryRead"];

const product = (id: string, name: string, price: string, stock: string, extra: Partial<Product> = {}): Product => ({
  id, name, price, tax_rate: "0.00", stock_quantity: stock, unit: "pcs", barcode: null, sku: null, category_id: null,
  cost_price: null, image_url: null, is_active: true, created_at: "", updated_at: "", ...extra,
}); // prettier-ignore

let products: Product[];
let categories: Category[];
let calls: { route: string; query: string; body: unknown }[];

beforeEach(() => {
  categories = [{ id: "cat-snacks", name: "Snacks" }, { id: "cat-dairy", name: "Dairy" }]; // prettier-ignore
  products = [
    product("p-maggi", "Maggi 70g", "14.00", "60.000", { category_id: "cat-snacks", barcode: "8901058000017" }),
    product("p-milk", "Amul Milk 500ml", "32.00", "4.000", { category_id: "cat-dairy" }),
    product("p-salt", "Tata Salt 1kg", "28.00", "0.000", { unit: "kg" }),
    product("p-old", "Old Biscuit", "10.00", "2.000", { is_active: false }),
  ];
  calls = [];
  server.handle = async (req) => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.clone().json() : null;
    calls.push({ route, query: url.search, body });

    if (route === "GET /api/v1/products")
      return json(products.filter((p) => p.is_active || url.searchParams.get("include_inactive") === "true"));
    if (route === "GET /api/v1/categories") return json(categories);
    if (route === "POST /api/v1/products") {
      const data = body as Schemas["ProductCreate"];
      if (data.barcode && products.some((p) => p.barcode === data.barcode)) return refuse(409, "conflict", "A record with these values already exists");
      const created = product(`p-${products.length}`, data.name, Number(data.price).toFixed(2), Number(data.stock_quantity ?? 0).toFixed(3), {
        unit: data.unit, category_id: data.category_id ?? null, barcode: data.barcode ?? null,
      }); // prettier-ignore
      products.push(created);
      return json(created, 201);
    }
    const one = /^(PATCH|DELETE) \/api\/v1\/products\/(.+)$/.exec(route);
    if (one) {
      const found = products.find((p) => p.id === one[2]);
      if (!found) return refuse(404, "not_found", "Product not found");
      const changes = one[1] === "DELETE" ? { is_active: false } : { ...(body as Partial<Product>) };
      if (changes.price !== undefined) changes.price = Number(changes.price).toFixed(2);
      products = products.map((p) => (p.id === found.id ? { ...p, ...changes } : p));
      return one[1] === "DELETE" ? new Response(null, { status: 204 }) : json(products.find((p) => p.id === found.id));
    }
    if (route === "POST /api/v1/categories") {
      const { name } = body as { name: string };
      if (categories.some((c) => c.name === name)) return refuse(409, "conflict", "A record with these values already exists");
      const created = { id: `cat-${name.toLowerCase()}`, name };
      categories.push(created);
      return json(created, 201);
    }
    const category = /^(PATCH|DELETE) \/api\/v1\/categories\/(.+)$/.exec(route);
    if (category) {
      if (category[1] === "DELETE") {
        categories = categories.filter((c) => c.id !== category[2]);
        products = products.map((p) => (p.category_id === category[2] ? { ...p, category_id: null } : p));
        return new Response(null, { status: 204 });
      }
      categories = categories.map((c) => (c.id === category[2] ? { ...c, name: (body as { name: string }).name } : c));
      return json(categories.find((c) => c.id === category[2]));
    }
    if (route === "POST /api/v1/inventory/adjustments") {
      const { product_id, delta } = body as Schemas["StockAdjustment"];
      const found = products.find((p) => p.id === product_id)!;
      const next = Number(found.stock_quantity) + Number(delta);
      if (next < 0) return refuse(409, "insufficient_stock", `Stock for ${found.name} cannot go below zero`);
      products = products.map((p) => (p.id === product_id ? { ...p, stock_quantity: next.toFixed(3) } : p));
      return json(products.find((p) => p.id === product_id));
    }
    return refuse(404, "not_found", `No fake for ${route}`);
  };
});

afterEach(cleanup);

function open(path: string) {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: "/", children: [catalogueRoutes] }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user, router };
}

const writes = () => calls.filter((c) => !c.route.startsWith("GET")).map((c) => [c.route, c.body]);
// Columns are Product, Category, Barcode, Price, GST, Stock, ...; GST (index 4) isn't this suite's concern.
const productRows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const cells = within(row).getAllByRole("cell");
      return [0, 1, 2, 3, 5].map((i) => cells[i].textContent);
    });

describe("Catalogue: products", () => {
  it("lists the products on sale with category, barcode, price and stock, and can show the ones off sale", async () => {
    const { user } = open("/catalogue/products");
    await screen.findByRole("row", { name: "Maggi 70g" });
    expect(productRows()).toEqual([
      ["Maggi 70g", "Snacks", "8901058000017", "₹14.00 / pcs", "60"],
      ["Amul Milk 500ml", "Dairy", "", "₹32.00 / pcs", "4"],
      ["Tata Salt 1kg", "", "", "₹28.00 / kg", "0"],
    ]);

    await user.type(screen.getByLabelText("Search products"), "890105");
    expect(productRows().map((r) => r[0])).toEqual(["Maggi 70g"]);
    await user.clear(screen.getByLabelText("Search products"));

    await user.click(screen.getByLabelText("Show products taken off sale"));
    expect(productRows().at(-1)![0]).toBe("Old BiscuitOff sale");
  });

  it("adds a product through the existing products API", async () => {
    const { user } = open("/catalogue/products");
    await screen.findByRole("row", { name: "Maggi 70g" });
    await user.click(screen.getByRole("button", { name: "Add product" }));
    const form = within(screen.getByRole("form", { name: "Add product" }));
    await user.type(form.getByLabelText("Name"), "Parle-G 80g");
    await user.type(form.getByLabelText("Price (₹)"), "10");
    await user.selectOptions(form.getByLabelText("Category"), "cat-snacks");
    await user.clear(form.getByLabelText("Opening stock"));
    await user.type(form.getByLabelText("Opening stock"), "24");
    await user.click(form.getByRole("button", { name: "Save product" }));

    await screen.findByRole("row", { name: "Parle-G 80g" });
    expect(productRows().at(-1)).toEqual(["Parle-G 80g", "Snacks", "", "₹10.00 / pcs", "24"]);
    expect(screen.queryByRole("form")).toBeNull();
    expect(writes()).toEqual([
      ["POST /api/v1/products", { name: "Parle-G 80g", price: "10", tax_rate: "0", unit: "pcs", category_id: "cat-snacks", barcode: null, stock_quantity: "24" }],
    ]);
  });

  it("edits a product without touching its stock, and shows the backend's refusal", async () => {
    const { user } = open("/catalogue/products");
    await user.click(within(await screen.findByRole("row", { name: "Amul Milk 500ml" })).getByRole("button", { name: "Edit" }));
    const form = within(screen.getByRole("form", { name: "Edit Amul Milk 500ml" }));
    expect(form.queryByLabelText("Opening stock")).toBeNull(); // stock changes under Stock
    await user.clear(form.getByLabelText("Price (₹)"));
    await user.type(form.getByLabelText("Price (₹)"), "34");
    await user.click(form.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(productRows()[1]).toEqual(["Amul Milk 500ml", "Dairy", "", "₹34.00 / pcs", "4"]));
    expect(writes()).toEqual([
      ["PATCH /api/v1/products/p-milk", { name: "Amul Milk 500ml", price: "34", tax_rate: "0", unit: "pcs", category_id: "cat-dairy", barcode: null }],
    ]);

    // A barcode another product already has is refused by the backend; the form stays open with the reason.
    await user.click(screen.getByRole("button", { name: "Add product" }));
    const add = within(screen.getByRole("form", { name: "Add product" }));
    await user.type(add.getByLabelText("Name"), "Copy");
    await user.type(add.getByLabelText("Price (₹)"), "5");
    await user.type(add.getByLabelText("Barcode (optional)"), "8901058000017");
    await user.click(add.getByRole("button", { name: "Save product" }));
    expect((await add.findByRole("alert")).textContent).toBe("A record with these values already exists");
    expect(screen.queryByRole("row", { name: "Copy" })).toBeNull();
  });

  it("takes a product off sale and puts it back", async () => {
    const { user } = open("/catalogue/products");
    await user.click(within(await screen.findByRole("row", { name: "Tata Salt 1kg" })).getByRole("button", { name: "Take off sale" }));
    await waitFor(() => expect(screen.queryByRole("row", { name: "Tata Salt 1kg" })).toBeNull());

    await user.click(screen.getByLabelText("Show products taken off sale"));
    await user.click(within(screen.getByRole("row", { name: "Tata Salt 1kg" })).getByRole("button", { name: "Put on sale" }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: "Tata Salt 1kg" })).getByRole("button", { name: "Take off sale" })).toBeTruthy());
    expect(writes()).toEqual([
      ["DELETE /api/v1/products/p-salt", null],
      ["PATCH /api/v1/products/p-salt", { is_active: true }],
    ]);
  });

  it("shows the backend's error when products cannot be read", async () => {
    server.handle = async () => refuse(500, "internal_error", "Something went wrong");
    open("/catalogue/products");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Catalogue: categories", () => {
  it("lists categories with their product counts, and adds, renames and deletes one", async () => {
    const { user } = open("/catalogue/categories");
    const snacks = await screen.findByRole("listitem", { name: "Snacks" });
    await waitFor(() => expect(snacks.textContent).toContain("1 product"));

    await user.type(screen.getByLabelText("Category name"), "Staples");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    const staples = await screen.findByRole("listitem", { name: "Staples" });
    expect(staples.textContent).toContain("0 products");
    expect((screen.getByLabelText("Category name") as HTMLInputElement).value).toBe("");

    await user.click(within(staples).getByRole("button", { name: "Rename" }));
    const rename = within(staples).getByLabelText("New name for Staples");
    await user.clear(rename);
    await user.type(rename, "Grocery");
    await user.click(within(staples).getByRole("button", { name: "Save" }));
    const grocery = await screen.findByRole("listitem", { name: "Grocery" });

    // Deleting asks first, and says what happens to the products in it.
    await user.click(within(grocery).getByRole("button", { name: "Delete" }));
    expect(grocery.textContent).toContain("Its products stay, without a category.");
    expect(writes().some(([route]) => String(route).startsWith("DELETE"))).toBe(false);
    await user.click(within(grocery).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Grocery" })).toBeNull());

    expect(writes()).toEqual([
      ["POST /api/v1/categories", { name: "Staples" }],
      ["PATCH /api/v1/categories/cat-staples", { name: "Grocery" }],
      ["DELETE /api/v1/categories/cat-staples", null],
    ]);
  });

  it("shows the backend's refusal for a duplicate name", async () => {
    const { user } = open("/catalogue/categories");
    await screen.findByRole("listitem", { name: "Snacks" });
    await user.type(screen.getByLabelText("Category name"), "Snacks");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A record with these values already exists");
  });
});

describe("Catalogue: stock", () => {
  const row = (name: string) => screen.getByRole("listitem", { name });

  it("shows what is on the shelf for the products on sale, flagging low and out of stock", async () => {
    const { user } = open("/catalogue/stock");
    await screen.findByRole("listitem", { name: "Maggi 70g" });
    expect(row("Maggi 70g").textContent).toContain("In stock60 pcs");
    expect(row("Amul Milk 500ml").textContent).toContain("Low4 pcs");
    expect(row("Tata Salt 1kg").textContent).toContain("Out of stock0 kg");
    expect(screen.queryByRole("listitem", { name: "Old Biscuit" })).toBeNull(); // off sale
    const stat = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!.textContent;
    expect([stat("Products on sale"), stat("Low (under 10)"), stat("Out of stock")]).toEqual([
      "Products on sale3",
      "Low (under 10)1",
      "Out of stock1",
    ]);

    await user.click(screen.getByLabelText("Only low or out of stock"));
    expect(screen.queryByRole("listitem", { name: "Maggi 70g" })).toBeNull();
    expect(row("Amul Milk 500ml")).toBeTruthy();
  });

  it("records a delivery and a correction through the inventory API, and shows a refusal", async () => {
    const { user } = open("/catalogue/stock");
    await user.click(within(await screen.findByRole("listitem", { name: "Tata Salt 1kg" })).getByRole("button", { name: "Adjust" }));
    let form = within(screen.getByRole("form", { name: "Adjust stock of Tata Salt 1kg" }));
    await user.type(form.getByLabelText("Quantity (kg)"), "25");
    await user.click(form.getByRole("button", { name: "Add to stock" }));
    await waitFor(() => expect(row("Tata Salt 1kg").textContent).toContain("In stock25 kg"));
    expect(screen.queryByRole("form")).toBeNull();

    await user.click(within(row("Amul Milk 500ml")).getByRole("button", { name: "Adjust" }));
    form = within(screen.getByRole("form", { name: "Adjust stock of Amul Milk 500ml" }));
    await user.type(form.getByLabelText("Quantity (pcs)"), "1");
    await user.click(form.getByRole("button", { name: "Remove from stock" }));
    await waitFor(() => expect(row("Amul Milk 500ml").textContent).toContain("Low3 pcs"));

    // More than there is: the backend refuses and the stock stays.
    await user.click(within(row("Amul Milk 500ml")).getByRole("button", { name: "Adjust" }));
    form = within(screen.getByRole("form", { name: "Adjust stock of Amul Milk 500ml" }));
    await user.type(form.getByLabelText("Quantity (pcs)"), "9");
    await user.click(form.getByRole("button", { name: "Remove from stock" }));
    expect((await form.findByRole("alert")).textContent).toBe("Stock for Amul Milk 500ml cannot go below zero");
    expect(row("Amul Milk 500ml").textContent).toContain("Low3 pcs");

    expect(writes()).toEqual([
      ["POST /api/v1/inventory/adjustments", { product_id: "p-salt", delta: "25" }],
      ["POST /api/v1/inventory/adjustments", { product_id: "p-milk", delta: "-1" }],
      ["POST /api/v1/inventory/adjustments", { product_id: "p-milk", delta: "-9" }],
    ]);
  });
});
