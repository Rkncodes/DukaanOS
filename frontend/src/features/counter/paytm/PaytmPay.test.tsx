// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { CounterPage } from "../CounterPage";
import { createFakeBackend, json, maggi } from "../vision/testing";
import { checkoutScriptUrl, openPaytmCheckout, type CheckoutHandlers } from "./checkout";

/**
 * Renders the real Counter page with a bill already open. The backend is an in-memory fake whose
 * Paytm endpoints answer what each test tells them to, and Paytm's JS Checkout is replaced by a
 * stand-in (no script is loaded). So the tests show what the Counter does with the *backend's*
 * verdict: nothing in the browser can make a bill paid.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));
const paytmPage = vi.hoisted(() => ({
  opened: [] as { checkout: unknown; handlers: { onResult: () => void; onError: (message: string) => void } }[],
  fail: null as string | null,
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});
vi.mock("./checkout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./checkout")>();
  return {
    ...mod,
    openPaytmCheckout: vi.fn(async (checkout: unknown, handlers: CheckoutHandlers) => {
      if (paytmPage.fail) throw new Error(paytmPage.fail);
      paytmPage.opened.push({ checkout, handlers });
    }),
  };
});

const CART: Schemas["CartRead"] = {
  id: "cart-1",
  customer_id: null,
  channel: "counter",
  status: "open",
  subtotal: "140.00",
  created_at: "",
  updated_at: "",
  items: [
    {
      id: "line-1",
      product_id: maggi.id,
      product_name: maggi.name,
      quantity: "10.000",
      unit_price: "14.00",
      line_total: "140.00",
      source: "manual",
    },
  ],
};

const payment = (status: Schemas["PaytmPaymentStatus"], extra: Partial<Schemas["PaytmPaymentRead"]> = {}) =>
  ({
    id: "pay-1",
    cart_id: "cart-1",
    order_id: null,
    status,
    environment: "sandbox",
    amount: "130.00",
    discount: "10.00",
    paytm_order_id: "DKNpay1",
    txn_id: null,
    bank_txn_id: null,
    payment_mode: null,
    result_code: null,
    result_msg: null,
    detail: null,
    verified_at: null,
    created_at: "",
    updated_at: "",
    ...extra,
  }) satisfies Schemas["PaytmPaymentRead"];

const CHECKOUT: Schemas["PaytmCheckout"] = {
  host: "https://securestage.paytmpayments.com",
  mid: "TESTMID0000000000001",
  order_id: "DKNpay1",
  txn_token: "token-1",
  amount: "130.00",
};
const PAID = payment("paid", { order_id: "order-1", txn_id: "20261003111212800110168470101509706", payment_mode: "UPI" });

const BILL: Schemas["BillRead"] = {
  order: {
    id: "order-1",
    customer_id: null,
    cart_id: "cart-1",
    customer_name: null,
    customer_phone: null,
    channel: "counter",
    status: "completed",
    subtotal: "140.00",
    discount: "10.00",
    total: "130.00",
    payment_status: "paid",
    created_at: "2026-10-03T10:00:00Z",
    updated_at: "2026-10-03T10:00:00Z",
    items: [{ ...CART.items[0], id: "oi-1" }],
  },
  customer: null,
  payments: [
    {
      id: "money-1",
      order_id: "order-1",
      customer_id: null,
      amount: "130.00",
      method: "paytm",
      status: "succeeded",
      provider: "paytm",
      external_reference: "20261003111212800110168470101509706",
      created_at: "",
    },
  ],
  khata_entry: null,
  customer_balance: null,
};

type Answer = () => Response | Promise<Response>;
let backend: ReturnType<typeof createFakeBackend>;
let paytm: { config: Answer; current: Answer; start: Answer; verify: Answer; cancel: Answer };
let calls: { route: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dukaanos.counter.cartId", "cart-1"); // a bill is already open
  backend = createFakeBackend();
  calls = [];
  paytmPage.opened = [];
  paytmPage.fail = null;
  vi.mocked(openPaytmCheckout).mockClear();
  paytm = {
    config: () => json({ enabled: true, environment: "sandbox" }),
    current: () => json(null),
    start: () => json({ payment: payment("pending"), checkout: CHECKOUT }),
    verify: () => json(payment("pending")),
    cancel: () => json(payment("cancelled")),
  };
  server.handle = async (req) => {
    const path = new URL(req.url).pathname;
    const route = `${req.method} ${path}`;
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.clone().json() : null;
    if (path.includes("/payments/paytm") || path.endsWith("/checkout")) calls.push({ route, body });
    if (route === "GET /api/v1/carts/cart-1") return json(CART);
    if (route === "GET /api/v1/payments/paytm/config") return paytm.config();
    if (route === "GET /api/v1/payments/paytm/current") return paytm.current();
    if (route === "POST /api/v1/payments/paytm") return paytm.start();
    if (route === "POST /api/v1/payments/paytm/pay-1/verify") return paytm.verify();
    if (route === "POST /api/v1/payments/paytm/pay-1/cancel") return paytm.cancel();
    if (route === "GET /api/v1/orders/order-1/bill") return json(BILL);
    return backend.handle(req);
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
  await screen.findByText(maggi.name, { selector: "div" }); // the open bill has loaded
  return user;
}

/** Enter a ₹10 discount and choose Paytm. */
async function choosePaytm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Discount"), "10");
  await user.click(await screen.findByRole("radio", { name: "Paytm" }));
}

/** The pending notice (the product picker has a status line of its own, so it is found by its text). */
const pending = () => screen.findByText(/^Payment pending/);
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const posts = (suffix: string) => calls.filter((c) => c.route.startsWith("POST") && c.route.endsWith(suffix));
const paidNowhere = () => {
  expect(screen.queryByText(/Payment successful/)).toBeNull();
  expect(screen.queryByText("Bill complete")).toBeNull();
};

describe("Counter: pay with Paytm", () => {
  it("offers Paytm only when the backend says it is set up, and leaves the other methods as they were", async () => {
    paytm.config = () => json({ enabled: false, environment: null });
    await openCounter();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Cash", "UPI", "Card", "Khata"]);
    expect(button(/Collect/).textContent).toContain("₹140.00");
    cleanup();

    paytm.config = () => json({ enabled: true, environment: "sandbox" });
    const user = await openCounter();
    expect((await screen.findByRole("radio", { name: "Paytm" })).getAttribute("aria-checked")).toBe("false");
    expect(button(/Collect/)).toBeTruthy(); // cash is still the default
    await choosePaytm(user);
    expect(button("Pay ₹130.00 with Paytm").disabled).toBe(false);
    expect(screen.getByText("Paytm sandbox: test payments only, no real money.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Collect/ })).toBeNull();
    expect(calls.filter((c) => c.route.startsWith("POST"))).toEqual([]); // choosing Paytm charges nothing
  });

  it("starts the payment with the bill only (no amount), shows loading, opens Paytm, then waits as pending", async () => {
    let release!: () => void;
    paytm.start = () =>
      new Promise((resolve) => (release = () => resolve(json({ payment: payment("pending"), checkout: CHECKOUT }))));
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));

    expect(button("Starting Paytm…").disabled).toBe(true); // a second press is not possible
    expect(posts("/payments/paytm")).toEqual([
      { route: "POST /api/v1/payments/paytm", body: { cart_id: "cart-1", discount: "10.00" } },
    ]);
    expect(paytmPage.opened).toHaveLength(0);
    release();

    expect((await pending()).textContent).toContain(
      "Payment pending: waiting for ₹130.00 in Paytm. The bill is not paid yet.",
    );
    expect(paytmPage.opened).toHaveLength(1);
    expect(paytmPage.opened[0].checkout).toEqual(CHECKOUT); // exactly what the backend handed over
    // While Paytm is collecting, the bill cannot be changed or settled another way.
    expect((screen.getByLabelText("Discount") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(`Quantity of ${maggi.name}`) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByRole("radio").every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: /Collect/ })).toBeNull();
    expect(posts("/verify")).toHaveLength(0);
    paidNowhere();
  });

  it("shows success only after the backend has verified the payment, with the Paytm reference", async () => {
    paytm.verify = () => json(PAID);
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));
    await pending();
    paidNowhere(); // Paytm's page being open proves nothing

    // Paytm's page reports that it is done: the Counter asks the backend, sending no status of its own.
    act(() => paytmPage.opened[0].handlers.onResult());
    expect(await screen.findByText("Payment successful ✓ Verified by Paytm")).toBeTruthy();
    expect(posts("/verify")).toEqual([{ route: "POST /api/v1/payments/paytm/pay-1/verify", body: null }]);
    expect(screen.getByText("Paytm reference: 20261003111212800110168470101509706")).toBeTruthy();
    expect(screen.getByText("Paid · Paytm")).toBeTruthy();
    expect(screen.getByText("Bill complete")).toBeTruthy();
    expect(posts("/checkout")).toHaveLength(0); // the browser never completes the bill itself

    // The bill is finished: "New bill" starts an empty one.
    await user.click(button("New bill"));
    expect(await screen.findByText("Scan or tap a product to start the bill.")).toBeTruthy();
    expect(localStorage.getItem("dukaanos.counter.cartId")).toBeNull();
  });

  it("keeps the bill unpaid while Paytm reports pending, and lets the cashier check again", async () => {
    paytm.verify = () => json(payment("pending", { result_code: "402", result_msg: "Looks like the payment is not complete." }));
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));
    await pending();
    act(() => paytmPage.opened[0].handlers.onResult());

    expect(await screen.findByText("Paytm: Looks like the payment is not complete.")).toBeTruthy();
    expect((await pending()).textContent).toContain("The bill is not paid yet.");
    paidNowhere();

    let release!: () => void;
    paytm.verify = () => new Promise((resolve) => (release = () => resolve(json(PAID))));
    await user.click(button("Check payment status"));
    expect(screen.getByText("Checking with Paytm…")).toBeTruthy();
    expect(button("Check payment status").disabled).toBe(true);
    release();
    expect(await screen.findByText("Payment successful ✓ Verified by Paytm")).toBeTruthy();
    expect(posts("/verify")).toHaveLength(2);
  });

  it("shows a failed payment as failed and lets the cashier try again or take cash", async () => {
    paytm.verify = () => json(payment("failed", { result_code: "227", result_msg: "Your payment has been declined by your bank." }));
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));
    await pending();
    act(() => paytmPage.opened[0].handlers.onResult());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Paytm payment failed: Your payment has been declined by your bank. The bill is not paid.",
    );
    paidNowhere();
    // The bill is free again: another attempt, or another method.
    expect(button("Pay ₹130.00 with Paytm").disabled).toBe(false);
    expect((screen.getByLabelText("Discount") as HTMLInputElement).disabled).toBe(false);
    await user.click(screen.getByRole("radio", { name: "Cash" }));
    expect(button(/Collect/).textContent).toContain("₹130.00");
    await user.click(screen.getByRole("radio", { name: "Paytm" }));
    await user.click(button("Pay ₹130.00 with Paytm"));
    await waitFor(() => expect(posts("/payments/paytm")).toHaveLength(2));
  });

  it("cancels only through the backend, and completes the bill if Paytm had the money after all", async () => {
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));
    await pending();

    await user.click(button("Cancel payment"));
    expect(await screen.findByText("Paytm payment cancelled. The bill is not paid.")).toBeTruthy();
    expect(posts("/cancel")).toHaveLength(1);
    expect(button("Pay ₹130.00 with Paytm").disabled).toBe(false);
    paidNowhere();

    // A second attempt: the bank is still deciding, so the backend refuses to cancel it.
    await user.click(button("Pay ₹130.00 with Paytm"));
    await screen.findByText(/Payment pending/);
    paytm.cancel = () =>
      json({ error: { code: "conflict", message: "Paytm is still confirming a payment for this bill with the bank, so it cannot be cancelled yet.", details: null } }, 409);
    await user.click(button("Cancel payment"));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be cancelled yet");
    expect(screen.getByText(/Payment pending/)).toBeTruthy();

    // The money had arrived: cancelling ends on the receipt instead.
    paytm.cancel = () => json(PAID);
    await user.click(button("Cancel payment"));
    expect(await screen.findByText("Payment successful ✓ Verified by Paytm")).toBeTruthy();
  });

  it("picks a payment in progress up again after a page refresh and can reopen Paytm for it", async () => {
    paytm.current = () => json(payment("pending"));
    const user = await openCounter();

    expect((await pending()).textContent).toContain("Payment pending: waiting for ₹130.00 in Paytm");
    expect(screen.getByRole("radio", { name: "Paytm" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Discount") as HTMLInputElement).value).toBe("10.00"); // as it was charged
    expect(paytmPage.opened).toHaveLength(0); // nothing is reopened or re-charged on its own
    paidNowhere();

    await user.click(button("Continue in Paytm"));
    await waitFor(() => expect(paytmPage.opened).toHaveLength(1));
    expect(posts("/payments/paytm")).toEqual([
      { route: "POST /api/v1/payments/paytm", body: { cart_id: "cart-1", discount: "10.00" } },
    ]);

    paytm.verify = () => json(PAID);
    await user.click(button("Check payment status"));
    expect(await screen.findByText("Payment successful ✓ Verified by Paytm")).toBeTruthy();
  });

  it("shows money Paytm received for a bill that could not be completed, and retries completing it", async () => {
    const detail = "Paytm received ₹130.00 but the bill was not completed: The bill changed after the payment started";
    paytm.current = () => json(payment("needs_review", { detail, txn_id: "TXN-77" }));
    const user = await openCounter();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(detail);
    expect(alert.textContent).toContain("Paytm reference: TXN-77");
    expect(screen.queryByRole("button", { name: /with Paytm/ })).toBeNull(); // no second charge on top
    expect(screen.queryByRole("button", { name: /Collect/ })).toBeNull();
    paidNowhere();

    paytm.verify = () => json(PAID);
    await user.click(button("Check again and complete the bill"));
    expect(await screen.findByText("Payment successful ✓ Verified by Paytm")).toBeTruthy();
  });

  it("explains backend and Paytm errors without ever showing a payment as successful", async () => {
    paytm.start = () =>
      json({ error: { code: "paytm_failed", message: "The Paytm payment could not be started: Paytm did not answer in time. Nothing was charged.", details: null } }, 502);
    const user = await openCounter();
    await choosePaytm(user);
    await user.click(button("Pay ₹130.00 with Paytm"));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was charged");
    expect(paytmPage.opened).toHaveLength(0);
    expect(button("Pay ₹130.00 with Paytm").disabled).toBe(false); // can be tried again

    // Paytm's page cannot be loaded: the payment stays pending and can be continued.
    paytm.start = () => json({ payment: payment("pending"), checkout: CHECKOUT });
    paytmPage.fail = "Paytm's payment page could not be opened. Check the internet connection, then continue the payment.";
    await user.click(button("Pay ₹130.00 with Paytm"));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be opened");
    expect(screen.getByText(/Payment pending/)).toBeTruthy();

    // The status check fails (network): nothing changes, and it can be repeated.
    paytm.verify = () =>
      json({ error: { code: "paytm_failed", message: "The payment status could not be checked: Paytm could not be reached. Nothing was changed; check again.", details: null } }, 502);
    await user.click(button("Check payment status"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be checked"));
    expect(screen.getByText(/Payment pending/)).toBeTruthy();
    expect(button("Check payment status").disabled).toBe(false);
    paidNowhere();
  });
});

describe("Paytm JS Checkout", () => {
  it("loads Paytm's script for the backend's host and MID", () => {
    expect(checkoutScriptUrl(CHECKOUT)).toBe(
      "https://securestage.paytmpayments.com/merchantpgpui/checkoutjs/merchants/TESTMID0000000000001.js",
    );
  });
});
