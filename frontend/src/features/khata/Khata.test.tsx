// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../../app/router";

/**
 * Renders the app's real routes (/khata, /khata/:customerId) against an in-memory stand-in for the backend.
 * Like the backend, the stand-in keeps only ledger entries and computes every balance from them: the pages
 * can show a new balance only by reading it back.
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

type Customer = { id: string; name: string; phone: string | null; created_at: string; updated_at: string };
type Entry = { id: string; customer_id: string; type: "credit" | "payment"; amount: number; description: string | null; created_at: string };

let customers: Customer[];
let entries: Entry[];
let calls: { route: string; body: unknown }[];
/** Set by a test to make the stand-in fail a route, the way a real backend sometimes does. */
let fail: Record<string, Response | (() => Promise<Response>)>;

const customer = (id: string, name: string, phone: string | null): Customer => ({
  id,
  name,
  phone,
  created_at: "2026-09-01T06:00:00Z",
  updated_at: "2026-09-01T06:00:00Z",
});
const entry = (customer_id: string, type: Entry["type"], amount: number, day: number, description: string | null = null): Entry => ({
  id: `e-${customer_id}-${day}-${type}`,
  customer_id,
  type,
  amount,
  description,
  created_at: `2026-10-0${day}T06:00:00Z`,
});

const signed = (e: Entry) => (e.type === "credit" ? e.amount : -e.amount);
const balanceOf = (id: string) => entries.filter((e) => e.customer_id === id).reduce((sum, e) => sum + signed(e), 0);

function ledgerOf(found: Customer) {
  let running = 0;
  const rows = entries
    .filter((e) => e.customer_id === found.id)
    .map((e) => {
      running += signed(e);
      return { ...e, amount: e.amount.toFixed(2), balance_after: running.toFixed(2), order_id: null, payment_id: null, source: "manual" };
    });
  return { customer: found, balance: balanceOf(found.id).toFixed(2), entries: rows.reverse() };
}

beforeEach(() => {
  customers = [customer("c-rahul", "Rahul", "9810010001"), customer("c-aman", "Aman", "9810010002"), customer("c-priya", "Priya", null)];
  entries = [
    entry("c-rahul", "credit", 550, 1, "Purana hisaab"),
    entry("c-rahul", "payment", 200, 2),
    entry("c-rahul", "credit", 500, 3, "Bill 1a2b3c4d"),
    entry("c-aman", "credit", 420, 2),
  ];
  calls = [];
  fail = {};
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    const body = req.method === "POST" ? await req.clone().json() : null;
    calls.push({ route, body });
    const failure = fail[route];
    if (failure) return typeof failure === "function" ? failure() : failure.clone();

    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store" } });
    if (route === "GET /api/v1/khata/balances") {
      const lastEntry = (id: string) => entries.filter((e) => e.customer_id === id).map((e) => e.created_at).sort().at(-1) ?? null; // prettier-ignore
      return json(
        customers
          .map((c) => ({ customer_id: c.id, customer_name: c.name, phone: c.phone, balance: balanceOf(c.id).toFixed(2), last_entry_at: lastEntry(c.id) }))
          .filter((b) => new URL(req.url).searchParams.get("outstanding_only") !== "true" || Number(b.balance) > 0)
          .sort((a, b) => Number(b.balance) - Number(a.balance)),
      );
    }
    if (route === "POST /api/v1/customers") {
      const { name, phone } = body as { name: string; phone: string | null };
      if (phone && customers.some((c) => c.phone === phone)) return refuse(409, "conflict", "A record with these values already exists");
      const created = customer(`c-${name.toLowerCase()}`, name, phone);
      customers.push(created);
      return json(created, 201);
    }
    const khata = /^(GET|POST) \/api\/v1\/customers\/([^/]+)\/khata(?:\/(credits|payments))?$/.exec(route);
    if (khata) {
      const found = customers.find((c) => c.id === khata[2]);
      if (!found) return refuse(404, "not_found", "Customer not found");
      if (khata[1] === "GET") return json(ledgerOf(found));
      const amount = Number((body as { amount: string }).amount);
      if (!(amount > 0)) return refuse(422, "validation_error", "Request validation failed");
      const type = khata[3] === "credits" ? "credit" : "payment";
      const created = { ...entry(found.id, type, amount, 4, (body as { description: string | null }).description), id: `e-${entries.length}` };
      entries.push(created);
      return json({ ...created, amount: amount.toFixed(2), order_id: null, payment_id: null, source: "manual" }, 201);
    }
    return json([]);
  };
});

afterEach(cleanup);

function open(path: string) {
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

/** The text of every body row of the one table on the page, cell by cell. */
const rows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
const posts = () => calls.filter((c) => c.route.startsWith("POST"));
/** Holds a route's answer back until the test lets it through, so the waiting state can be looked at. */
function hold(route: string, answer?: Response) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  fail[route] = async () => {
    await held;
    if (answer) return answer;
    delete fail[route];
    return server.handle(new Request(`http://test${route.split(" ")[1]}`));
  };
  const asked = () => waitFor(() => expect(calls.some((c) => c.route === route)).toBe(true));
  return { release, asked };
}
const outstanding = () => screen.getByLabelText("Balance").textContent;

describe("Khata: customer list", () => {
  it("lists this merchant's customers with what each owes, and the total outstanding", async () => {
    const balances = hold("GET /api/v1/khata/balances");
    open("/khata");
    await balances.asked();
    // Nothing is shown as a balance before the backend answers.
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Total outstanding").parentElement!.textContent).toContain("–");

    balances.release();
    await screen.findByRole("link", { name: "Rahul" });

    // Who, when they last had an entry, what they owe, and the action that fits.
    expect(rows()).toEqual([
      ["Rahul", "9810010001", "03 Oct 2026", "₹850.00 outstanding", "Take payment"],
      ["Aman", "9810010002", "02 Oct 2026", "₹420.00 outstanding", "Take payment"],
      ["Priya", "No phone", "None", "₹0.00 settled", "Give credit"],
    ]);
    expect(screen.getByText("Customers owing").parentElement!.textContent).toContain("2");
    const total = screen.getByText("Total outstanding").parentElement!;
    expect(total.textContent).toContain("₹1,270.00");
    expect(total.textContent).toContain("2 of 3 customers owe you");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("searches by name or phone", async () => {
    const { user } = open("/khata");
    await screen.findByRole("link", { name: "Rahul" });
    const search = screen.getByLabelText("Search customers");

    await user.type(search, "am");
    expect(rows().map((r) => r[0])).toEqual(["Aman"]);
    await user.clear(search);
    await user.type(search, "0001");
    expect(rows().map((r) => r[0])).toEqual(["Rahul"]);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No customer matches “zzz”.")).toBeTruthy();
    // The total is the whole khata's, not the search's.
    expect(screen.getByText("Total outstanding").parentElement!.textContent).toContain("₹1,270.00");
  });

  it("shows the backend's error instead of balances when the list cannot be read", async () => {
    fail["GET /api/v1/khata/balances"] = refuse(500, "internal_error", "Something went wrong");
    open("/khata");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Total outstanding").parentElement!.textContent).toContain("–");
  });

  it("says so when there are no customers, and adds one", async () => {
    customers = [];
    entries = [];
    const { user, router } = open("/khata");
    expect(await screen.findByText("No customers yet. Add one to start their khata.")).toBeTruthy();

    await user.type(screen.getByLabelText("Customer name"), "Sunita");
    await user.type(screen.getByLabelText("Customer phone"), "9810010009");
    await user.click(screen.getByRole("button", { name: "Add customer" }));

    // The new customer's khata opens, empty.
    expect(await screen.findByRole("heading", { name: "Sunita" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/khata/c-sunita");
    expect(posts()).toEqual([{ route: "POST /api/v1/customers", body: { name: "Sunita", phone: "9810010009" } }]);
    expect(outstanding()).toBe("₹0.00");
    expect(screen.getByText("No entries yet.")).toBeTruthy();
  });

  it("shows the backend's refusal when a customer cannot be added", async () => {
    const { user, router } = open("/khata");
    await screen.findByRole("link", { name: "Rahul" });
    await user.type(screen.getByLabelText("Customer name"), "Rahul again");
    await user.type(screen.getByLabelText("Customer phone"), "9810010001");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A record with these values already exists");
    expect(router.state.location.pathname).toBe("/khata");
  });
});

describe("Khata: ledger, outstanding and payments views", () => {
  it("Outstanding lists only customers who owe, largest first, with the total", async () => {
    const { user, router } = open("/khata/outstanding");
    await screen.findByRole("link", { name: "Open Rahul's ledger" });
    expect(rows().map((r) => r.slice(0, 4))).toEqual([
      ["Rahul", "9810010001", "03 Oct 2026", "₹850.00 outstanding"],
      ["Aman", "9810010002", "02 Oct 2026", "₹420.00 outstanding"],
    ]);
    const total = screen.getByText("Total outstanding").parentElement!;
    expect(total.textContent).toContain("₹1,270.00");
    expect(total.textContent).toContain("from 2 customers");

    await user.click(screen.getByRole("link", { name: "Open Aman's ledger" }));
    expect(router.state.location.pathname).toBe("/khata/c-aman");
    expect(await screen.findByRole("heading", { name: "Aman" })).toBeTruthy();
  });

  it("Ledger lists customers with entries, most recent first", async () => {
    entries.push(entry("c-priya", "payment", 50, 5));
    open("/khata/ledger");
    await screen.findByRole("link", { name: "Open Priya's ledger" });
    expect(rows().map((r) => [r[0], r[2], r[3]])).toEqual([
      ["Priya", "05 Oct 2026", "₹50.00 advance"],
      ["Rahul", "03 Oct 2026", "₹850.00 outstanding"],
      ["Aman", "02 Oct 2026", "₹420.00 outstanding"],
    ]);
  });

  it("Ledger says so when there are no entries", async () => {
    entries = [];
    open("/khata/ledger");
    expect(await screen.findByText("No khata entries yet.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("Payments opens the customer's page ready to record the payment, using the existing payment API", async () => {
    const { user, router } = open("/khata/payments");
    await user.click(await screen.findByRole("link", { name: "Record payment from Aman" }).then((link) => {
      expect(rows().map((r) => r[0])).toEqual(["Rahul", "Aman"]); // only customers who owe
      expect(screen.getByRole("note").textContent).toContain("One list of all payments is not available yet.");
      return link;
    })); // prettier-ignore
    expect(router.state.location.pathname).toBe("/khata/c-aman");
    const form = within(await screen.findByRole("form", { name: "Record payment" }));
    await user.type(form.getByLabelText("Amount received (₹)"), "420");
    await user.click(form.getByRole("button", { name: "Save payment" }));
    await waitFor(() => expect(outstanding()).toBe("₹0.00"));
    expect(posts()).toEqual([
      { route: "POST /api/v1/customers/c-aman/khata/payments", body: { amount: "420", description: null, method: "cash" } },
    ]);

    // Paid up: Aman is no longer on the payments list.
    cleanup();
    open("/khata/payments");
    await screen.findByRole("link", { name: "Record payment from Rahul" });
    expect(rows().map((r) => r[0])).toEqual(["Rahul"]);
  });

  it("shows the backend's error when balances cannot be read", async () => {
    fail["GET /api/v1/khata/balances"] = refuse(500, "internal_error", "Something went wrong");
    open("/khata/outstanding");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Total outstanding").parentElement!.textContent).toContain("–");
  });
});

describe("Khata: customer ledger", () => {
  it("opens a customer with their details, outstanding amount and ledger", async () => {
    const { user, router } = open("/khata");
    await user.click(await screen.findByRole("link", { name: "Rahul" }));

    expect(await screen.findByRole("heading", { name: "Rahul" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/khata/c-rahul");
    expect(screen.getByText("9810010001")).toBeTruthy();
    expect(outstanding()).toBe("₹850.00");

    // Newest first, each entry with the balance that stood after it; the footer is the outstanding amount.
    expect(rows()).toEqual([
      ["03 Oct 2026", "Credit", "Bill 1a2b3c4d", "₹500.00", "₹850.00"],
      ["02 Oct 2026", "Payment", "", "₹200.00", "₹350.00"],
      ["01 Oct 2026", "Credit", "Purana hisaab", "₹550.00", "₹550.00"],
      ["Outstanding", "₹850.00"],
    ]);
    expect(screen.getAllByRole("time").map((t) => t.getAttribute("datetime"))).toEqual([
      "2026-10-03T06:00:00Z",
      "2026-10-02T06:00:00Z",
      "2026-10-01T06:00:00Z",
    ]);
    await user.click(screen.getByRole("link", { name: "← All customers" }));
    expect(router.state.location.pathname).toBe("/khata");
  });

  it("records udhaar of ₹850 and then a payment of ₹500, leaving ₹350 outstanding", async () => {
    const { user } = open("/khata/c-priya");
    await screen.findByRole("heading", { name: "Priya" });
    expect(outstanding()).toBe("₹0.00");
    expect(screen.getByText("No entries yet.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Record credit" }));
    let form = within(screen.getByRole("form", { name: "Record credit" }));
    await user.type(form.getByLabelText("Amount given on udhaar (₹)"), "850");
    await user.type(form.getByLabelText("Note (optional)"), "Ration");
    await user.click(form.getByRole("button", { name: "Save credit" }));

    await waitFor(() => expect(outstanding()).toBe("₹850.00"));
    expect(screen.queryByRole("form")).toBeNull(); // saved: the form closes
    expect(rows()).toEqual([
      ["04 Oct 2026", "Credit", "Ration", "₹850.00", "₹850.00"],
      ["Outstanding", "₹850.00"],
    ]);

    await user.click(screen.getByRole("button", { name: "Record payment" }));
    form = within(screen.getByRole("form", { name: "Record payment" }));
    await user.type(form.getByLabelText("Amount received (₹)"), "500");
    await user.selectOptions(form.getByLabelText("Paid by"), "upi");
    expect(form.queryByRole("note")).toBeNull(); // within what is owed
    await user.click(form.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(outstanding()).toBe("₹350.00"));
    expect(rows().map((r) => [r[1], r.at(-2), r.at(-1)])).toEqual([
      ["Payment", "₹500.00", "₹350.00"],
      ["Credit", "₹850.00", "₹850.00"],
      ["₹350.00", "Outstanding", "₹350.00"],
    ]);
    expect(posts()).toEqual([
      { route: "POST /api/v1/customers/c-priya/khata/credits", body: { amount: "850", description: "Ration" } },
      { route: "POST /api/v1/customers/c-priya/khata/payments", body: { amount: "500", description: null, method: "upi" } },
    ]);

    // The customer list reads the same ledger.
    await user.click(screen.getByRole("link", { name: "← All customers" }));
    await screen.findByRole("link", { name: "Priya" });
    await waitFor(() =>
      expect(rows().find((r) => r[0] === "Priya")).toEqual(["Priya", "No phone", "04 Oct 2026", "₹350.00 outstanding", "Take payment"]),
    );
    expect(screen.getByText("Total outstanding").parentElement!.textContent).toContain("₹1,620.00");
  });

  it("shows the backend's refusal and changes nothing", async () => {
    const { user } = open("/khata/c-rahul");
    await screen.findByRole("heading", { name: "Rahul" });
    fail["POST /api/v1/customers/c-rahul/khata/payments"] = refuse(422, "validation_error", "Amount must be positive");

    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const form = within(screen.getByRole("form", { name: "Record payment" }));
    await user.type(form.getByLabelText("Amount received (₹)"), "100");
    await user.click(form.getByRole("button", { name: "Save payment" }));

    expect((await form.findByRole("alert")).textContent).toBe("Amount must be positive");
    expect((form.getByLabelText("Amount received (₹)") as HTMLInputElement).value).toBe("100"); // still there to correct
    expect(outstanding()).toBe("₹850.00");
    expect(rows()).toHaveLength(4);
  });

  it("does not send an empty, zero or negative amount", async () => {
    const { user } = open("/khata/c-rahul");
    await screen.findByRole("heading", { name: "Rahul" });
    await user.click(screen.getByRole("button", { name: "Record credit" }));
    const form = within(screen.getByRole("form", { name: "Record credit" }));
    const amount = form.getByLabelText("Amount given on udhaar (₹)") as HTMLInputElement;

    await user.click(form.getByRole("button", { name: "Save credit" }));
    for (const bad of ["0", "-5"]) {
      await user.clear(amount);
      await user.type(amount, bad);
      expect(amount.validity.valid).toBe(false);
      await user.click(form.getByRole("button", { name: "Save credit" }));
    }
    expect(posts()).toEqual([]);
    expect(outstanding()).toBe("₹850.00");

    await user.click(form.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("warns that a payment above the outstanding amount becomes advance, and shows it as advance", async () => {
    const { user } = open("/khata/c-aman");
    await screen.findByRole("heading", { name: "Aman" });
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const form = within(screen.getByRole("form", { name: "Record payment" }));
    await user.type(form.getByLabelText("Amount received (₹)"), "500");
    expect(form.getByRole("note").textContent).toContain("₹80.00 more than is owed");
    await user.click(form.getByRole("button", { name: "Save payment" }));

    await waitFor(() => expect(outstanding()).toBe("₹80.00"));
    expect(screen.getByText("paid ahead by the customer")).toBeTruthy();
    expect(rows().at(-1)).toEqual(["Advance", "₹80.00"]);
  });

  it("shows a loading state, then an error for a customer that is not this merchant's", async () => {
    const ledger = hold("GET /api/v1/customers/c-other/khata", refuse(404, "not_found", "Customer not found"));
    open("/khata/c-other");
    await ledger.asked();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();

    ledger.release();
    expect((await screen.findByRole("alert")).textContent).toBe("This customer was not found in your khata.");
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
    expect(screen.getByRole("link", { name: "← All customers" })).toBeTruthy();
  });

  it("shows the backend's error when the ledger cannot be read", async () => {
    fail["GET /api/v1/customers/c-rahul/khata"] = refuse(500, "internal_error", "Something went wrong");
    open("/khata/c-rahul");
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByLabelText("Balance")).toBeNull();
  });
});
