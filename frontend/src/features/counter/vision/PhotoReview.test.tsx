// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CounterPage } from "../CounterPage";
import { VISION_RESULT, coke, colgate, createFakeBackend, json, maggi, parle, pepsi } from "./testing";

/**
 * Renders the real Counter page against an in-memory fake of the backend, so the flow
 * photo -> review -> confirm -> *existing* Counter cart is exercised end to end in the UI.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

let backend: ReturnType<typeof createFakeBackend>;

beforeEach(() => {
  localStorage.clear();
  backend = createFakeBackend();
  server.handle = backend.handle;
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

function renderCounter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
}

const photo = () => new File([new Uint8Array([137, 80, 78, 71])], "shelf.png", { type: "image/png" });

async function openAndUpload(user = userEvent.setup(), file = photo()) {
  renderCounter();
  await user.click(await screen.findByRole("button", { name: "Add from photo" }));
  await user.upload(screen.getByLabelText("Photo of products"), file);
  return user;
}

const row = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Detection ${n}:`) });
const recognizeCalls = () => backend.state.calls.filter((c) => c.path === "/api/v1/vision/recognize");
const confirmCalls = () => backend.state.calls.filter((c) => c.path.endsWith("/recognized-items"));

describe("Counter: add from photo", () => {
  it("uploads the photo, shows a loading state, then the detections", async () => {
    let release!: () => void;
    backend.state.recognize = () => new Promise((resolve) => (release = () => resolve(json(VISION_RESULT))));
    await openAndUpload();

    expect(screen.getByRole("status").textContent).toContain("Recognizing products…");
    expect(recognizeCalls()).toHaveLength(1);
    release();

    expect(await screen.findByText("Detected products")).toBeTruthy();
    expect(screen.queryByText("Recognizing products…")).toBeNull();
    expect(screen.getByText(/not real AI/)).toBeTruthy();

    expect(within(row(1)).getByText(maggi.name)).toBeTruthy();
    expect((within(row(1)).getByLabelText("Qty") as HTMLInputElement).value).toBe("2");
    expect(within(row(2)).getByText(coke.name)).toBeTruthy();
    expect(within(row(3)).getByText("Which product is it?")).toBeTruthy();
    expect(within(row(4)).getByText("Not sure. Is it this?")).toBeTruthy();
    expect(within(row(5)).getByText("Not matched to your catalog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add 2 to bill" })).toBeTruthy();
    expect(screen.getByText("3 not matched or not chosen: will not be added.")).toBeTruthy();
  });

  it("lets the merchant edit, remove and resolve, then adds only confirmed items to the existing cart", async () => {
    const user = await openAndUpload();
    await screen.findByText("Detected products");

    // Quantity edit on a matched item.
    const qty = within(row(1)).getByLabelText("Qty");
    await user.clear(qty);
    await user.type(qty, "3");

    // Remove a detection entirely.
    await user.click(within(row(2)).getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("#2 seen as “Coke 750ml”", { exact: false })).toBeNull();

    // Ambiguous: pick one of the candidates (now row 2 after the removal).
    await user.click(within(row(2)).getByRole("button", { name: /Pepsi 750ml/ }));
    // Unmatched: search the catalog and resolve it.
    await user.type(within(row(4)).getByPlaceholderText("Search catalog…"), "colgate");
    await user.click(within(row(4)).getByRole("button", { name: /Colgate Strong Teeth/ }));
    // Low confidence (row 3) is left undecided: it must not be sent.

    expect(confirmCalls()).toHaveLength(0); // nothing added before confirmation
    await user.click(screen.getByRole("button", { name: "Add 3 to bill" }));

    // The review closes and the items are in the Counter's own cart panel.
    expect(await screen.findByRole("button", { name: "Add from photo" })).toBeTruthy();
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({
      source: "vision",
      items: [
        { product_id: maggi.id, quantity: "3" },
        { product_id: pepsi.id, quantity: "1" },
        { product_id: colgate.id, quantity: "1" },
      ],
    });
    const bill = screen.getByRole("heading", { name: "Bill" }).parentElement!;
    for (const name of [maggi.name, pepsi.name, colgate.name]) expect(within(bill).getByText(name)).toBeTruthy();
    expect(within(bill).queryByText(parle.name)).toBeNull();
    expect(within(bill).getAllByText("vision")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹192.00"); // 3 × 14 + 40 + 110
  });

  it("blocks confirmation while a chosen quantity is invalid", async () => {
    const user = await openAndUpload();
    await screen.findByText("Detected products");
    await user.clear(within(row(1)).getByLabelText("Qty"));
    expect((screen.getByRole("button", { name: "Add 2 to bill" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the backend error for an unreadable image", async () => {
    backend.state.recognize = async () =>
      json({ error: { code: "invalid_image", message: "The file is not a readable image", details: null } }, 422);
    await openAndUpload();
    expect((await screen.findByRole("alert")).textContent).toContain("The file is not a readable image");
    expect(screen.queryByText("Detected products")).toBeNull();
  });

  it("rejects unsupported files before uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    await openAndUpload(user, new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByRole("alert").textContent).toContain("Choose a JPEG, PNG or WebP photo.");
    expect(recognizeCalls()).toHaveLength(0);
  });
});
