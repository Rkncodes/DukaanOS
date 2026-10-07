// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter, matchRoutes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTIONS, locate } from "./navigation";
import { routes } from "./router";

/**
 * The merchant app's navigation, on the app's real route tree with an in-memory stand-in for the backend:
 * the top bar's sections, the sidebar of the section a page belongs to, and the pages for what is not built.
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

let calls: string[];

beforeEach(() => {
  localStorage.clear();
  calls = [];
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(route);
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh-general-store" } });
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "GET /api/v1/assistant/status") return json({ available: false, reason: "Salaahkaar is not available yet.", capabilities: [] });
    if (req.method !== "GET") return json({ error: { code: "not_found", message: `No fake for ${route}`, details: null } }, 404);
    return json([]);
  };
});

afterEach(cleanup);

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

const main = () => within(screen.getByRole("navigation", { name: "Main" }));
const logo = () => screen.getByRole("link", { name: "DukaanOS, go to Dashboard" });
/** The sidebar's groups, each with its links (a not-yet-built one reads "… Soon"). */
const sidebar = () =>
  Object.fromEntries(
    within(document.getElementById("section-nav")!)
      .getAllByRole("navigation")
      .map((nav) => [nav.getAttribute("aria-label"), within(nav).getAllByRole("link").map((a) => a.textContent)]),
  );
const side = () => within(document.getElementById("section-nav")!);
/** What is marked as the current page: [top bar section, sidebar item]. */
const current = () => [
  main().getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent),
  side().getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent),
]; // prettier-ignore

describe("top bar", () => {
  it("lists Counter, Shop and Khata, with the logo as the way home to the Dashboard", async () => {
    load("/");
    await screen.findByRole("heading", { name: "Dashboard", level: 1 }); // "/" is still the Dashboard
    // The Dashboard has no item of its own among the sections: the logo is its link.
    expect(main().getAllByRole("link").map((a) => a.textContent)).toEqual(["Counter", "Shop", "Khata"]);
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(logo().getAttribute("href")).toBe("/");
    expect(logo().getAttribute("aria-current")).toBe("page");
    expect(sidebar()).toEqual({ Dashboard: ["Overview"] });
    expect(current()).toEqual([[], ["Overview"]]);
    // The merchant, the assistant and the way out are always there.
    const bar = within(screen.getAllByRole("banner")[0]); // the app's top bar (page headers come after it)
    expect(bar.getByText("DukaanOS")).toBeTruthy();
    expect(bar.getByText("The AI operating system for your kirana store.")).toBeTruthy();
    expect(bar.getByText("Ramesh General Store")).toBeTruthy();
    expect(bar.getByRole("button", { name: "Ask Salaahkaar" })).toBeTruthy();
    expect(bar.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("moves between sections, each bringing its own sidebar", async () => {
    const { user, router } = load("/");
    await screen.findByRole("heading", { name: "Dashboard", level: 1 });

    await user.click(main().getByRole("link", { name: "Counter" }));
    expect(router.state.location.pathname).toBe("/counter");
    expect(sidebar()).toEqual({
      Counter: ["Vision Counter", "By Code", "Parchi", "Voice Billing", "Manual Billing", "ReturnsSoon"],
      Catalogue: ["Products", "Categories", "Stock", "OffersSoon"],
    });
    expect(current()).toEqual([["Counter"], ["Manual Billing"]]);

    await user.click(main().getByRole("link", { name: "Shop" }));
    expect(router.state.location.pathname).toBe("/shop/orders");
    expect(sidebar()).toEqual({ Shop: ["Orders", "Storefront", "QR"] });
    expect(current()).toEqual([["Shop"], ["Orders"]]);

    await user.click(main().getByRole("link", { name: "Khata" }));
    expect(router.state.location.pathname).toBe("/khata");
    expect(sidebar()).toEqual({ Khata: ["Customers", "Ledger", "Outstanding", "Payments"] });
    expect(current()).toEqual([["Khata"], ["Customers"]]);

    // The logo is not current away from home, and clicking it opens the Dashboard.
    expect(logo().getAttribute("aria-current")).toBeNull();
    await user.click(logo());
    expect(router.state.location.pathname).toBe("/");
    expect(await screen.findByRole("heading", { name: "Dashboard", level: 1 })).toBeTruthy();
    expect(current()).toEqual([[], ["Overview"]]);

    // It is an ordinary link: reachable and usable from the keyboard.
    await user.click(main().getByRole("link", { name: "Khata" }));
    logo().focus();
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("Counter navigation", () => {
  it("opens each billing input of the one Counter page, keeping the bill panel on screen", async () => {
    const { user, router } = load("/counter");
    expect(await screen.findByLabelText("Scan barcode or search product")).toBeTruthy(); // manual billing
    const bill = screen.getByRole("heading", { name: "Bill" });

    await user.click(side().getByRole("link", { name: "Parchi" }));
    expect(router.state.location.pathname).toBe("/counter/parchi");
    expect(await screen.findByRole("region", { name: "Add from Parchi" })).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["Parchi"]]);
    expect(screen.getByRole("heading", { name: "Bill" })).toBe(bill); // the same bill, not a new page

    // By Code is the barcode input of the same page, with the same bill beside it.
    await user.click(side().getByRole("link", { name: "By Code" }));
    expect(router.state.location.pathname).toBe("/counter/barcode");
    expect(await screen.findByRole("region", { name: "Scan barcode" })).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["By Code"]]);
    expect(screen.getByRole("heading", { name: "Bill" })).toBe(bill);

    await user.click(side().getByRole("link", { name: "Voice Billing" }));
    expect(router.state.location.pathname).toBe("/counter/voice");
    expect(await screen.findByRole("heading", { name: "Add by Voice" })).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["Voice Billing"]]);

    // Closing an input from inside the page returns to manual billing, in the URL too.
    await user.click(within(screen.getByRole("region", { name: "Add by Voice" })).getByRole("button", { name: "Cancel" }));
    expect(router.state.location.pathname).toBe("/counter");
    expect(await screen.findByLabelText("Scan barcode or search product")).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["Manual Billing"]]);

    // The page's own buttons and the sidebar lead to the same places.
    await user.click(screen.getByRole("button", { name: "Add from photo" }));
    expect(router.state.location.pathname).toBe("/counter/photo");
    expect(await screen.findByRole("heading", { name: "Add from photo" })).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["Vision Counter"]]);
    expect(screen.getByRole("heading", { name: "Bill" })).toBe(bill);

    await user.click(side().getByRole("link", { name: "Vision Counter" }));
    expect(router.state.location.pathname).toBe("/counter/vision");
    expect(await screen.findByRole("heading", { name: /Vision counter/ })).toBeTruthy();
    expect(current()).toEqual([["Counter"], ["Vision Counter"]]);
  });

  it("keeps Counter current, and its sidebar, across the Catalogue pages", async () => {
    const { user, router } = load("/counter");
    await screen.findByLabelText("Scan barcode or search product");

    for (const [label, path, heading] of [
      ["Products", "/catalogue/products", "Products"],
      ["Categories", "/catalogue/categories", "Categories"],
      ["Stock", "/catalogue/stock", "Stock"],
    ]) {
      await user.click(side().getByRole("link", { name: label }));
      expect(router.state.location.pathname).toBe(path);
      expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
      expect(current()).toEqual([["Counter"], [label]]);
      expect(Object.keys(sidebar())).toEqual(["Counter", "Catalogue"]);
    }
    expect(calls).toContain("GET /api/v1/categories");
  });

  it("sends /catalogue to Products", async () => {
    const { router } = load("/catalogue");
    await screen.findByRole("heading", { name: "Products", level: 1 });
    expect(router.state.location.pathname).toBe("/catalogue/products");
    expect(current()).toEqual([["Counter"], ["Products"]]);
  });
});

describe("Shop navigation", () => {
  it("reaches Orders, Storefront and QR from the sidebar", async () => {
    const { user, router } = load("/shop");
    expect(await screen.findByText(/No orders yet/)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/shop/orders");
    expect(current()).toEqual([["Shop"], ["Orders"]]);

    await user.click(side().getByRole("link", { name: "Storefront" }));
    expect(router.state.location.pathname).toBe("/shop/storefront");
    const url = `${window.location.origin}/store/ramesh-general-store`;
    expect((await screen.findByRole("link", { name: "Open storefront" })).getAttribute("href")).toBe(url);
    expect(current()).toEqual([["Shop"], ["Storefront"]]);

    await user.click(side().getByRole("link", { name: "QR" }));
    expect(router.state.location.pathname).toBe("/shop/qr");
    expect(await screen.findByRole("img", { name: `QR code for ${url}` })).toBeTruthy();
    expect(current()).toEqual([["Shop"], ["QR"]]);
  });
});

describe("Khata navigation", () => {
  it("reaches Customers, Ledger, Outstanding and Payments, and keeps Customers current on a customer's page", async () => {
    const { user, router } = load("/khata");
    await screen.findByRole("heading", { name: "Khata", level: 1 });

    for (const [label, path] of [
      ["Ledger", "/khata/ledger"],
      ["Outstanding", "/khata/outstanding"],
      ["Payments", "/khata/payments"],
    ]) {
      await user.click(side().getByRole("link", { name: label }));
      expect(router.state.location.pathname).toBe(path);
      expect(await screen.findByRole("heading", { name: label, level: 1 })).toBeTruthy();
      expect(current()).toEqual([["Khata"], [label]]);
    }

    await user.click(side().getByRole("link", { name: "Customers" }));
    expect(router.state.location.pathname).toBe("/khata");

    cleanup();
    load("/khata/8f3c2a10-0000-4000-8000-000000000001");
    await screen.findByRole("link", { name: "← All customers" });
    expect(current()).toEqual([["Khata"], ["Customers"]]);
  });
});

describe("pages for what is not built yet", () => {
  it.each([
    ["/counter/returns", "Returns", "Taking back sold items is coming soon.", ["Manual Billing"], "Counter"],
    ["/catalogue/offers", "Offers", "Offers and automatic discounts are coming soon.", ["Products"], "Counter"],
  ])("%s says it is coming soon and offers nothing that looks like the feature", async (path, title, message, available, section) => {
    const before = calls.length;
    const { user, router } = load(path);
    expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeTruthy();
    const page = within(screen.getByRole("main"));
    expect(page.getByText("Coming soon")).toBeTruthy();
    expect(page.getByText(message)).toBeTruthy();
    expect(current()).toEqual([[section], [`${title}Soon`]]);

    // Nothing to press or fill in: only links to what works today.
    expect(page.queryAllByRole("button")).toEqual([]);
    expect(page.queryAllByRole("textbox")).toEqual([]);
    expect(page.getAllByRole("link").map((a) => a.textContent)).toEqual(available);
    // And nothing was asked of the backend beyond the session.
    expect(calls.slice(before)).toEqual(["GET /api/v1/auth/me"]);

    await user.click(page.getByRole("link", { name: available.at(-1)! }));
    expect(router.state.location.pathname).not.toBe(path);
  });

  it("the sidebar marks exactly those pages as Soon", () => {
    const soon = SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.items)).filter((i) => i.soon).map((i) => i.to); // prettier-ignore
    expect(soon).toEqual(["/counter/returns", "/catalogue/offers"]);
  });
});

describe("small screens: the sidebar as a drawer", () => {
  it("opens from the Menu button and closes on choosing a page, on Escape and on the backdrop", async () => {
    const { user, router } = load("/khata");
    await screen.findByRole("heading", { name: "Khata", level: 1 });
    const menu = screen.getByRole("button", { name: "Menu" });
    const drawer = document.getElementById("section-nav")!;
    expect(menu.getAttribute("aria-controls")).toBe("section-nav");
    // Closed, it is hidden below the lg breakpoint and a plain sidebar from lg up.
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.className).toContain("hidden");
    expect(drawer.className).toContain("lg:flex");
    expect(menu.className).toContain("lg:hidden");

    await user.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.className).toContain("fixed");
    expect(drawer.className.split(" ")).not.toContain("hidden");

    await user.click(side().getByRole("link", { name: "Outstanding" }));
    expect(router.state.location.pathname).toBe("/khata/outstanding");
    await waitFor(() => expect(menu.getAttribute("aria-expanded")).toBe("false"));

    await user.click(menu);
    await user.keyboard("{Escape}");
    expect(menu.getAttribute("aria-expanded")).toBe("false");

    await user.click(menu);
    await user.click(document.querySelector(".bg-slate-900\\/30")!);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(router.state.location.pathname).toBe("/khata/outstanding");
  });
});

describe("navigation data", () => {
  it("finds the section and item of any merchant page", () => {
    const at = (path: string) => {
      const { section, item } = locate(path);
      return [section.id, item?.label ?? null];
    };
    expect(at("/")).toEqual(["dashboard", "Overview"]);
    expect(at("/counter")).toEqual(["counter", "Manual Billing"]);
    expect(at("/counter/")).toEqual(["counter", "Manual Billing"]);
    expect(at("/counter/vision")).toEqual(["counter", "Vision Counter"]);
    expect(at("/counter/photo")).toEqual(["counter", "Vision Counter"]);
    expect(at("/catalogue/stock")).toEqual(["counter", "Stock"]);
    expect(at("/shop")).toEqual(["shop", "Orders"]);
    expect(at("/shop/qr")).toEqual(["shop", "QR"]);
    expect(at("/khata/outstanding")).toEqual(["khata", "Outstanding"]);
    expect(at("/khata/some-customer-id")).toEqual(["khata", "Customers"]);
    expect(at("/nowhere")).toEqual(["dashboard", null]);
  });

  it("only links to routes that exist, each once", () => {
    const links = SECTIONS.flatMap((s) => [s.to, ...s.groups.flatMap((g) => g.items.map((i) => i.to))]);
    for (const to of links) {
      const matched = matchRoutes(routes, to);
      expect(matched?.at(-1)?.route.path, to).not.toBe("*"); // not the catch-all
    }
    const items = SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.to)));
    expect(new Set(items).size).toBe(items.length);
  });
});
