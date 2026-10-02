// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { CounterPage } from "../CounterPage";
import { coke, colgate, createFakeBackend, json, lays, maggi, parle, pepsi } from "../vision/testing";
import { initialRows, parchiPlan } from "./review";

/**
 * Renders the real Counter page against the in-memory fake backend, so the flow
 * parchi photo -> review -> confirm -> *existing* Counter cart is exercised end to end in the UI.
 * Only POST /parchi/read is added here; carts, products and recognized-items are the shared fake.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

const line = (
  id: string,
  raw_text: string,
  quantity: string | null,
  match: Schemas["MatchState"],
  extra: Partial<Schemas["ParchiLine"]> = {},
): Schemas["ParchiLine"] => ({
  id,
  raw_text,
  description: raw_text,
  quantity,
  read_confidence: 0.9,
  match,
  product: null,
  candidates: [],
  match_confidence: match === "unmatched" ? null : 1,
  matched_words: [],
  unmatched_words: [],
  ...extra,
});

/** What the backend returns for a parchi, already matched to the fake catalogue (test data only). */
const PARCHI: Schemas["ParchiResult"] = {
  provider: "local-ocr (rapidocr)",
  text: "2 Maggi\n3 cold drink\nParle-G\n1 basmati rice\ncolgat x2",
  lines: [
    line("l0", "2 Maggi", "2.000", "matched", { product: maggi, matched_words: ["maggi"] }),
    line("l1", "3 cold drink", "3.000", "ambiguous", { candidates: [coke, pepsi] }),
    line("l2", "Parle-G", null, "matched", { product: parle, matched_words: ["parle", "g"] }), // no quantity written
    line("l3", "1 basmati rice", "1.000", "unmatched", { unmatched_words: ["basmati", "rice"] }),
    line("l4", "colgat x2", "2.000", "low_confidence", { candidates: [colgate] }),
  ],
};

let backend: ReturnType<typeof createFakeBackend>;
let readCalls: Request[];
let readParchi: () => Promise<Response>;

beforeEach(() => {
  localStorage.clear();
  backend = createFakeBackend();
  readCalls = [];
  readParchi = async () => json(PARCHI);
  server.handle = async (req) => {
    if (req.method === "POST" && new URL(req.url).pathname === "/api/v1/parchi/read") {
      readCalls.push(req.clone());
      return readParchi();
    }
    return backend.handle(req);
  };
});

afterEach(cleanup);

const photo = () => new File([new Uint8Array([137, 80, 78, 71])], "parchi.png", { type: "image/png" });

async function openAndUpload(user = userEvent.setup(), file = photo()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Add from Parchi" }));
  await user.upload(screen.getByLabelText("Photo of parchi"), file);
  return user;
}

const row = (text: string) => screen.getByRole("row", { name: `Parchi item: ${text}` });
const qty = (text: string) => screen.getByLabelText(`Quantity for ${text}`) as HTMLInputElement;
const confirmCalls = () => backend.state.calls.filter((c) => c.path.endsWith("/recognized-items"));
const addButton = (n: number) => screen.getByRole("button", { name: `Add ${n} to bill` }) as HTMLButtonElement;
const billPanel = () => screen.getByRole("heading", { name: "Bill" }).parentElement!;

describe("Counter: add from parchi", () => {
  it("uploads the photo, shows a loading state, then the extracted items for review", async () => {
    let release!: () => void;
    readParchi = () => new Promise((resolve) => (release = () => resolve(json(PARCHI))));
    await openAndUpload();

    expect(screen.getByRole("status").textContent).toContain("Reading parchi…");
    expect(readCalls).toHaveLength(1);
    const sent = (await readCalls[0].formData()).get("image") as File; // the photo itself was sent
    expect([sent.size, sent.type]).toEqual([4, "image/png"]);
    release();

    expect(await screen.findByText("Parchi items")).toBeTruthy();
    expect(screen.queryByText("Reading parchi…")).toBeNull();

    // Confident match: catalogue name and catalogue price, quantity from the parchi.
    expect(within(row("2 Maggi")).getByText(maggi.name)).toBeTruthy();
    expect(row("2 Maggi").textContent).toContain("₹14.00");
    expect(row("2 Maggi").textContent).toContain("matched on: maggi");
    expect(qty("2 Maggi").value).toBe("2");
    // Ambiguous, unsure and unknown lines wait for the merchant.
    expect(within(row("3 cold drink")).getByText("Which product is it?")).toBeTruthy();
    expect(within(row("colgat x2")).getByText("Not sure. Is it this?")).toBeTruthy();
    expect(within(row("1 basmati rice")).getByText("Not found in catalogue")).toBeTruthy();
    // A quantity that was not written is asked for, never assumed.
    expect(qty("Parle-G").value).toBe("");
    expect(row("Parle-G").textContent).toContain("not on parchi");

    expect(screen.getByText("Enter the quantity for 1 item.", { exact: false })).toBeTruthy();
    expect(screen.getByText("3 not found or not chosen: will not be added.", { exact: false })).toBeTruthy();
    expect(addButton(2).disabled).toBe(true);
    expect(backend.cartCalls()).toHaveLength(0); // reading a parchi never touches the bill
  });

  it("edits quantity, resolves an ambiguous line, removes a line, then adds only confirmed items to the existing bill", async () => {
    const user = await openAndUpload();
    await screen.findByText("Parchi items");

    // Edit a quantity; enter the one the parchi did not give.
    await user.clear(qty("2 Maggi"));
    await user.type(qty("2 Maggi"), "4");
    await user.type(qty("Parle-G"), "3");
    // Ambiguous: the merchant chooses.
    await user.click(within(row("3 cold drink")).getByRole("button", { name: /Pepsi 750ml/ }));
    expect(within(row("3 cold drink")).getByText(pepsi.name)).toBeTruthy();
    // Remove a line; leave the unknown and the unsure lines alone.
    await user.click(screen.getByRole("button", { name: "Remove 1 basmati rice" }));
    expect(screen.queryByRole("row", { name: "Parchi item: 1 basmati rice" })).toBeNull();

    expect(confirmCalls()).toHaveLength(0); // nothing is added before confirmation
    await user.click(addButton(3));

    // The review closes and the items are in the Counter's own bill, through the shared cart path.
    expect(await screen.findByRole("button", { name: "Add from Parchi" })).toBeTruthy();
    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].body).toEqual({
      source: "parchi",
      items: [
        { product_id: maggi.id, quantity: "4" },
        { product_id: pepsi.id, quantity: "3" },
        { product_id: parle.id, quantity: "3" },
      ],
    });
    const bill = billPanel();
    for (const name of [maggi.name, pepsi.name, parle.name]) expect(within(bill).getByText(name)).toBeTruthy();
    expect(within(bill).queryByText(colgate.name)).toBeNull(); // unsure and never confirmed
    expect(within(bill).getAllByText("parchi")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹251.00"); // 4×14 + 3×40 + 3×25
  });

  it("lets the merchant accept an unsure match, change a matched product, and find an unknown one", async () => {
    const user = await openAndUpload();
    await screen.findByText("Parchi items");

    await user.click(within(row("colgat x2")).getByRole("button", { name: /Colgate Strong Teeth/ }));
    // Change the product the system matched.
    await user.click(screen.getByRole("button", { name: "Change product for 2 Maggi" }));
    await user.type(screen.getByLabelText("Find product for 2 Maggi"), "lays");
    await user.click(within(row("2 Maggi")).getByRole("button", { name: /Lays Classic Salted/ }));
    // Find the unknown line in the catalogue by hand.
    await user.type(screen.getByLabelText("Find product for 1 basmati rice"), "coke");
    await user.click(within(row("1 basmati rice")).getByRole("button", { name: /Coke 750ml/ }));
    await user.click(screen.getByRole("button", { name: "Remove Parle-G" }));
    await user.click(screen.getByRole("button", { name: "Remove 3 cold drink" }));

    await user.click(addButton(3));
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect((confirmCalls()[0].body as Schemas["ConfirmedItemsAdd"]).items).toEqual([
      { product_id: lays.id, quantity: "2" },
      { product_id: coke.id, quantity: "1" },
      { product_id: colgate.id, quantity: "2" },
    ]);
  });

  it("joins a bill that already has items instead of starting a new one", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CounterPage />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Add from Parchi" }));
    await user.upload(screen.getByLabelText("Photo of parchi"), photo());
    await screen.findByText("Parchi items");
    await user.click(screen.getByRole("button", { name: "Remove Parle-G" }));
    await user.click(addButton(1));
    await screen.findByRole("button", { name: "Add from Parchi" });

    // A second parchi goes into the same cart.
    await user.click(screen.getByRole("button", { name: "Add from Parchi" }));
    await user.upload(screen.getByLabelText("Photo of parchi"), photo());
    await screen.findByText("Parchi items");
    await user.click(screen.getByRole("button", { name: "Remove Parle-G" }));
    await user.click(addButton(1));
    await waitFor(() => expect(confirmCalls()).toHaveLength(2));
    expect(backend.state.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/carts")).toHaveLength(1);
    expect(new Set(confirmCalls().map((c) => c.path)).size).toBe(1);
  });

  it("blocks 'Add to bill' while a chosen line has no valid quantity", async () => {
    const user = await openAndUpload();
    await screen.findByText("Parchi items");
    expect(addButton(2).disabled).toBe(true); // Parle-G has no quantity yet
    await user.type(qty("Parle-G"), "0");
    expect(addButton(2).disabled).toBe(true);
    await user.clear(qty("Parle-G"));
    await user.type(qty("Parle-G"), "2");
    expect(addButton(2).disabled).toBe(false);
    await user.clear(qty("2 Maggi"));
    expect(addButton(2).disabled).toBe(true);
    expect(confirmCalls()).toHaveLength(0);
  });

  it("says so when nothing could be read, and shows backend errors", async () => {
    readParchi = async () => json({ provider: "local-ocr (rapidocr)", text: "", lines: [] });
    await openAndUpload();
    expect(await screen.findByText("No items could be read from this photo.")).toBeTruthy();
    expect(addButton(0).disabled).toBe(true);
    cleanup();

    readParchi = async () =>
      json({ error: { code: "parchi_unavailable", message: "Parchi reading is not set up for this store", details: null } }, 503);
    await openAndUpload();
    expect((await screen.findByRole("alert")).textContent).toContain("Parchi reading is not set up for this store");
    expect(screen.queryByText("Parchi items")).toBeNull();
  });

  it("rejects unsupported files before uploading, and Cancel leaves the bill untouched", async () => {
    const user = userEvent.setup({ applyAccept: false });
    await openAndUpload(user, new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByRole("alert").textContent).toContain("Choose a JPEG, PNG or WebP photo.");
    expect(readCalls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Add from Parchi" })).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0);
  });
});

describe("parchi review plan", () => {
  it("preselects only confident matches and never assumes a quantity", () => {
    const rows = initialRows(PARCHI.lines);
    expect(rows.map((r) => [r.product?.id ?? null, r.quantity])).toEqual([
      [maggi.id, "2"],
      [null, "3"],
      [parle.id, ""],
      [null, "1"],
      [null, "2"],
    ]);
    expect(parchiPlan(rows)).toEqual({
      items: [
        { product_id: maggi.id, quantity: "2" },
        { product_id: parle.id, quantity: "" },
      ],
      skipped: 3,
      missingQuantity: 1,
    });
    expect(parchiPlan([])).toEqual({ items: [], skipped: 0, missingQuantity: 0 });
  });
});
