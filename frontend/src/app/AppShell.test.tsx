// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "./router";

/**
 * Renders the app's real route tree against an in-memory stand-in for the backend. The stand-in holds the
 * session the way the backend's cookie does: once logged out, /auth/me answers 401 to every new page load.
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

let loggedIn: boolean;
let logoutFails: boolean;
let assistant: unknown;
let calls: string[];

beforeEach(() => {
  loggedIn = true;
  logoutFails = false;
  assistant = {
    available: false,
    reason: "Salaahkaar is not available yet.",
    capabilities: [
      { name: "search_products", description: "Search the store's products by name", needs_confirmation: false },
      { name: "record_khata_payment", description: "Record a customer paying back udhaar", needs_confirmation: true },
    ],
  };
  calls = [];
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(route);
    if (route === "POST /api/v1/auth/logout") {
      if (logoutFails) return refuse(500, "internal_error", "Something went wrong");
      loggedIn = false;
      return new Response(null, { status: 204 });
    }
    if (route.startsWith("GET /api/v1/public/")) return refuse(404, "not_found", "Store not found");
    if (!loggedIn) return refuse(401, "unauthorized", "Not authenticated");
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store" } });
    if (route === "GET /api/v1/assistant/status") return assistant ? json(assistant) : refuse(500, "internal_error", "Something went wrong");
    return json([]);
  };
});

afterEach(cleanup);

/** A fresh page load: new router, new query cache. Only the stand-in backend's session carries over. */
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

const PROTECTED = [
  "/",
  ...["/counter", "/counter/vision", "/counter/barcode", "/counter/parchi", "/counter/voice", "/counter/returns"],
  ...["/catalogue", "/catalogue/products", "/catalogue/categories", "/catalogue/stock", "/catalogue/offers"],
  ...["/shop", "/shop/orders", "/shop/storefront", "/shop/qr"],
  ...["/khata", "/khata/ledger", "/khata/outstanding", "/khata/payments", "/khata/c-1"],
];

describe("log out", () => {
  it("ends the session and shows the login page", async () => {
    const { user, router } = load("/khata");
    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("button", { name: "Log in" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls).toContain("POST /api/v1/auth/logout");
    expect(screen.queryByText("Ramesh General Store")).toBeNull();
  });

  it("stays logged out after a refresh, on every merchant page", async () => {
    const first = load("/counter");
    await first.user.click(await screen.findByRole("button", { name: "Log out" }));
    await screen.findByRole("button", { name: "Log in" });

    for (const path of PROTECTED) {
      cleanup();
      const { router } = load(path);
      expect(await screen.findByRole("button", { name: "Log in" })).toBeTruthy();
      expect(router.state.location.pathname).toBe("/login");
      expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    }
  });

  it("leaves the public storefront reachable without a session", async () => {
    loggedIn = false;
    const { router } = load("/store/ramesh-general-store");
    await waitFor(() => expect(calls.some((c) => c.startsWith("GET /api/v1/public/stores/ramesh-general-store"))).toBe(true));
    expect(router.state.location.pathname).toBe("/store/ramesh-general-store");
    expect(calls).not.toContain("GET /api/v1/auth/me");
    // It is the customer's page: none of the merchant app's navigation is on it.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask Salaahkaar" })).toBeNull();
  });

  it("keeps the merchant logged in, and says so, when the backend could not end the session", async () => {
    logoutFails = true;
    const { user, router } = load("/khata");
    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Could not log out");
    expect(router.state.location.pathname).toBe("/khata");
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });
});

describe("Ask Salaahkaar", () => {
  async function openPanel() {
    const loaded = load("/khata");
    await loaded.user.click(await screen.findByRole("button", { name: "Ask Salaahkaar" }));
    return { ...loaded, panel: await screen.findByRole("dialog", { name: "Salaahkaar" }) };
  }

  it("opens the assistant panel, says what it works on and that it is not available yet", async () => {
    const { panel } = await openPanel();
    expect(panel.textContent).toContain("your shop's own data");
    expect((await within(panel).findByRole("status")).textContent).toContain("Salaahkaar is not available yet.");
    // Whether it can answer is the backend's word. (The panel itself is tested in features/salaahkaar.)
    expect(calls).toContain("GET /api/v1/assistant/status");
    expect(within(panel).getByRole("list", { name: "Example questions" })).toBeTruthy();
  });

  it("takes a question but never invents an answer while the assistant is unavailable", async () => {
    const { user, panel } = await openPanel();
    await within(panel).findByRole("status");
    const before = calls.length;

    const input = within(panel).getByLabelText("Your question");
    await user.type(input, "Who owes me the most?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));

    expect(within(panel).getByRole("alert").textContent).toBe("Salaahkaar is not available yet. Your question was not sent.");
    expect((input as HTMLTextAreaElement).value).toBe("Who owes me the most?"); // nothing is lost
    expect(calls.length).toBe(before); // no request was made, so no answer exists to show
  });

  it("says so when the assistant's status cannot be read", async () => {
    assistant = null;
    const { panel } = await openPanel();
    expect((await within(panel).findByRole("status")).textContent).toContain("Salaahkaar is not available");
  });

  it("closes with the Close button and with Escape", async () => {
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ask Salaahkaar" }));
    await screen.findByRole("dialog", { name: "Salaahkaar" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
