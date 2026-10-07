// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { findByBarcode } from "../bill";
import { CounterPage } from "../CounterPage";
import { RETAIL_FORMATS, isAcceptable } from "./formats";

/**
 * Billing by barcode on the real Counter page (and its one bill), against an in-memory stand-in for the
 * backend. Like the backend, the stand-in resolves a barcode exactly, among products on sale, and answers
 * 404 for anything else. A USB scanner is a keyboard: the tests type the code and press Enter.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

/**
 * The camera tests below are COMPONENT tests with a mocked camera and a mocked decoder: jsdom has no webcam
 * and cannot decode video. They prove what the page does around a reading (permission, lifecycle, cleanup,
 * and that a code the camera reports goes down the same lookup path into the same bill). They do not prove
 * that a real barcode in front of a real camera is read: that is the decoder library's job, checked in a
 * real browser.
 */
const camera = vi.hoisted(() => ({
  /** What the "decoder" sees on each look at the video. */
  reading: { kind: "none" } as { kind: "none" } | { kind: "one"; code: string } | { kind: "several"; codes: string[] },
  looks: 0,
  broken: false,
}));

vi.mock("./scanner", () => ({
  createDecoder: () => async () => {
    camera.looks += 1;
    if (camera.broken) throw new Error("decoder crashed");
    return camera.reading;
  },
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Product = Schemas["ProductRead"];
type Line = Schemas["CartItemRead"];

const product = (id: string, name: string, price: string, stock: string, barcode: string | null, active = true): Product => ({
  id, name, price, stock_quantity: stock, unit: "pcs", barcode, sku: null, category_id: null, cost_price: null,
  image_url: null, is_active: active, created_at: "", updated_at: "",
}); // prettier-ignore

const MAGGI = "8901058000017";
const ATTA = "8900000000015";
const SALT = "8900000000022";

let products: Product[];
let lines: Line[];
let calls: { route: string; body: unknown }[];

const cart = (): Schemas["CartRead"] => ({
  id: "cart-1", customer_id: null, channel: "counter", status: "open", items: lines,
  subtotal: lines.reduce((sum, l) => sum + Number(l.line_total), 0).toFixed(2), created_at: "", updated_at: "",
}); // prettier-ignore

function setLine(p: Product, quantity: number, source: Line["source"]) {
  const line: Line = {
    id: `line-${p.id}`, product_id: p.id, product_name: p.name, quantity: quantity.toFixed(3), unit_price: p.price,
    line_total: (quantity * Number(p.price)).toFixed(2), source,
  }; // prettier-ignore
  lines = lines.some((l) => l.product_id === p.id) ? lines.map((l) => (l.product_id === p.id ? line : l)) : [...lines, line];
}

beforeEach(() => {
  localStorage.clear();
  products = [
    product("p-maggi", "Maggi 70g", "14.00", "3.000", MAGGI),
    product("p-atta", "Aashirvaad Atta 5kg", "295.00", "15.000", ATTA),
    product("p-salt", "Tata Salt 1kg", "28.00", "0.000", SALT),
    product("p-loose", "Loose Sugar", "45.00", "20.000", null),
  ];
  lines = [];
  calls = [];
  camera.reading = { kind: "none" };
  camera.looks = 0;
  camera.broken = false;
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.clone().json() : null;
    calls.push({ route, body });
    if (route === "GET /api/v1/auth/me") return json({ user: { name: "Ramesh" }, merchant: { store_name: "Test Store" } });
    if (route === "GET /api/v1/products") return json(products.filter((p) => p.is_active));
    if (route === "GET /api/v1/customers" || route === "GET /api/v1/khata/balances") return json([]);
    if (route === "GET /api/v1/payments/paytm/config") return json({ enabled: false, environment: null });
    if (route === "POST /api/v1/carts") return json(cart(), 201);
    if (route === "GET /api/v1/carts/cart-1") return json(cart());
    if (route === "POST /api/v1/carts/cart-1/items") {
      const add = body as Schemas["CartItemAdd"];
      // The backend's rule: this exact barcode, among products on sale. Nothing else.
      const p = products.find((x) => x.is_active && (add.barcode ? x.barcode === add.barcode : x.id === add.product_id));
      if (!p) return json({ error: { code: "not_found", message: `Barcode not found: ${add.barcode}`, details: null } }, 404);
      const existing = lines.find((l) => l.product_id === p.id);
      setLine(p, Number(existing?.quantity ?? 0) + 1, existing?.source ?? add.source ?? "manual");
      return json(cart());
    }
    const item = /^PATCH \/api\/v1\/carts\/cart-1\/items\/line-(.+)$/.exec(route);
    if (item) {
      const p = products.find((x) => x.id === item[1])!;
      setLine(p, Number((body as Schemas["CartItemUpdate"]).quantity), "barcode");
      return json(cart());
    }
    return json({ error: { code: "not_found", message: `No fake for ${route}`, details: null } }, 404);
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type FakeTrack = { stop: ReturnType<typeof vi.fn>; addEventListener: (event: string, listener: () => void) => void; end: () => void };

/** Puts a fake webcam behind navigator.mediaDevices, the level the page really calls. Returns what was handed out. */
function fakeCamera(behaviour: "works" | DOMException | "missing" = "works") {
  const tracks: FakeTrack[] = [];
  const getUserMedia = vi.fn(async () => {
    if (behaviour instanceof DOMException) throw behaviour;
    let ended = () => {};
    const track: FakeTrack = {
      stop: vi.fn(),
      addEventListener: (event, listener) => {
        if (event === "ended") ended = listener;
      },
      end: () => ended(),
    };
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: behaviour === "missing" ? undefined : { getUserMedia }, configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  // jsdom has no media pipeline: let the page attach the stream to the video element.
  let attached: unknown = null;
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { get: () => attached, set: (v) => (attached = v), configurable: true });
  return { getUserMedia, tracks, attached: () => attached };
}

async function openBarcode() {
  const user = userEvent.setup();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Scan barcode" }));
  const panel = within(screen.getByRole("region", { name: "Scan barcode" }));
  return { user, panel };
}

const input = () => screen.getByLabelText("Barcode") as HTMLInputElement;
/** What a USB scanner does: types the code, then Enter. */
const scan = (user: ReturnType<typeof userEvent.setup>, code: string) => user.type(input(), `${code}{Enter}`);
const added = () => calls.filter((c) => c.route === "POST /api/v1/carts/cart-1/items").map((c) => c.body);
const catalogueReads = () => calls.filter((c) => c.route === "GET /api/v1/products").length;
const bill = () => screen.getByRole("heading", { name: "Bill" }).parentElement!;

describe("exact barcode lookup", () => {
  it("finds the one product with exactly this code, and nothing for anything else", () => {
    expect(findByBarcode(MAGGI, products)).toEqual({ kind: "found", product: products[0] });
    expect(findByBarcode(`  ${MAGGI}\n`, products)).toEqual({ kind: "found", product: products[0] }); // scanners add whitespace
    for (const near of [MAGGI.slice(0, 12), `${MAGGI}0`, "890105800001x", "maggi", "Maggi 70g", "", "   "])
      expect(findByBarcode(near, products)).toEqual({ kind: "unknown" });
    // A product without a barcode is never matched by an empty scan.
    expect(findByBarcode("null", products)).toEqual({ kind: "unknown" });
    const twin = product("p-twin", "Maggi Twin", "15.00", "5.000", MAGGI);
    expect(findByBarcode(MAGGI, [...products, twin])).toEqual({ kind: "ambiguous", products: [products[0], twin] });
  });
});

describe("barcode formats the camera accepts", () => {
  it("reads retail symbols as they are, and ITF only as a full 14-digit code", () => {
    expect([...RETAIL_FORMATS]).toEqual(["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "itf"]);
    expect(isAcceptable("ean_13", "8901058017687")).toBe(true);
    expect(isAcceptable("code_128", "ABC-123")).toBe(true);
    expect(isAcceptable("itf", "89011223001948")).toBe(true);
    // A partly seen ITF symbol reads as a shorter number: that is never passed on as a barcode.
    for (const partial of ["890112230019", "8901122300", "890112", "8901122300194", "890112230019480"])
      expect(isAcceptable("itf", partial)).toBe(false);
  });

  it("a 14-digit code is matched exactly as stored, never shortened to 13", () => {
    const lotte = product("p-lotte", "Lotte Choco Pie 28g", "10.00", "65.000", "89011223001948");
    expect(findByBarcode("89011223001948", [...products, lotte])).toEqual({ kind: "found", product: lotte });
    for (const altered of ["8901122300194", "9011223001948", "089011223001948"])
      expect(findByBarcode(altered, [...products, lotte])).toEqual({ kind: "unknown" });
  });
});

describe("Counter: scan barcode", () => {
  it("adds the scanned product to the existing bill at its catalogue price, scan after scan", async () => {
    const { user, panel } = await openBarcode();
    expect(input()).toBe(document.activeElement); // ready for the scanner at once
    expect(panel.getByText(/Waiting for a scan/)).toBeTruthy();

    await scan(user, MAGGI);
    const status = await panel.findByRole("status");
    expect(status.textContent).toContain("Added to bill");
    expect(status.textContent).toContain("Maggi 70g");
    expect(status.textContent).toContain("₹14.00");
    expect(status.textContent).toContain(`${MAGGI} · 1 in this bill`);
    expect(input().value).toBe("");
    expect(input()).toBe(document.activeElement); // and ready for the next one

    await scan(user, MAGGI);
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("2 in this bill"));
    await scan(user, ATTA);
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("Aashirvaad Atta 5kg"));

    // It is the Counter's one bill: the same lines, the same total, the same checkout button.
    expect((within(bill()).getByLabelText("Quantity of Maggi 70g") as HTMLInputElement).value).toBe("2");
    expect(within(bill()).getByText("Aashirvaad Atta 5kg")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹323.00"); // 2 × 14 + 295
    expect(added()).toEqual([
      { barcode: MAGGI, source: "barcode" },
      { barcode: MAGGI, source: "barcode" },
      { barcode: ATTA, source: "barcode" },
    ]);

    // Quantity changes happen in the bill, as for any other line.
    await user.click(screen.getByRole("button", { name: "Increase Maggi 70g" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹337.00"));
  });

  it("says 'Barcode not found' for an unknown code and adds nothing", async () => {
    const { user, panel } = await openBarcode();
    const readsBefore = catalogueReads();

    for (const code of ["8999999999999", MAGGI.slice(0, 12), "maggi"]) {
      await scan(user, code);
      const alert = await panel.findByRole("alert");
      await waitFor(() => expect(alert.textContent).toContain(code));
      expect(within(alert).getByText("Barcode not found")).toBeTruthy();
      expect(alert.textContent).toContain("Nothing was added.");
    }
    expect(added()).toEqual([]); // no guess was sent
    expect(calls.some((c) => c.route === "POST /api/v1/carts")).toBe(false); // and no empty bill was opened
    expect(within(bill()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();
    expect(catalogueReads()).toBe(readsBefore + 3); // each time the catalogue was read again before giving up

    // The merchant can fall back to searching.
    await user.click(panel.getByRole("button", { name: "Search products instead" }));
    expect(await screen.findByLabelText("Scan barcode or search product")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Scan barcode" })).toBeNull();
  });

  it("finds a product that was added to the catalogue after the Counter was opened", async () => {
    const { user, panel } = await openBarcode();
    products.push(product("p-new", "Parle-G 80g", "10.00", "24.000", "8901719100017"));
    await scan(user, "8901719100017");
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("Parle-G 80g"));
    expect(added()).toEqual([{ barcode: "8901719100017", source: "barcode" }]);
  });

  it("respects stock: nothing out of stock is added, and scanning stops at the last unit", async () => {
    const { user, panel } = await openBarcode();
    await scan(user, SALT); // none in stock
    expect((await panel.findByRole("alert")).textContent).toContain("No more Tata Salt 1kg in stock");
    expect(added()).toEqual([]);

    for (let i = 0; i < 3; i++) await scan(user, MAGGI); // three in stock
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("3 in this bill"));
    await scan(user, MAGGI);
    expect((await panel.findByRole("alert")).textContent).toContain("No more Maggi 70g in stock");
    expect(added()).toHaveLength(3);
  });

  it("refuses a code that two products carry instead of picking one", async () => {
    products.push(product("p-twin", "Maggi Twin Pack", "27.00", "9.000", MAGGI));
    const { user, panel } = await openBarcode();
    await scan(user, MAGGI);
    const alert = await panel.findByRole("alert");
    expect(alert.textContent).toContain("This barcode is on more than one product");
    expect(alert.textContent).toContain("Maggi 70g, Maggi Twin Pack");
    expect(added()).toEqual([]);
  });

  it("shows 'Barcode not found' when the backend no longer knows the code", async () => {
    const { user, panel } = await openBarcode();
    products = products.map((p) => (p.id === "p-atta" ? { ...p, is_active: false } : p)); // taken off sale elsewhere
    await scan(user, ATTA);
    expect(within(await panel.findByRole("alert")).getByText("Barcode not found")).toBeTruthy();
    expect(within(bill()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();
  });
});

describe("Counter: scan barcode with the camera (mocked camera and decoder)", () => {
  const cameraStatus = () => screen.getByLabelText("Camera status").textContent;
  const startCamera = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Start camera" }));

  it("does not touch the camera until Start camera is pressed, and keeps the manual input", async () => {
    const cam = fakeCamera();
    const { user, panel } = await openBarcode();
    expect(panel.getByRole("button", { name: "Start camera" })).toBeTruthy();
    expect(panel.queryByLabelText("Camera status")).toBeNull();
    expect(cam.getUserMedia).not.toHaveBeenCalled(); // no permission prompt just for opening the page

    // The manual path works with the camera off.
    await scan(user, MAGGI);
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("Maggi 70g"));
    expect(cam.getUserMedia).not.toHaveBeenCalled();
    expect(camera.looks).toBe(0);
  });

  it("sends a barcode the camera reads down the same lookup path into the same bill, one read per product", async () => {
    const cam = fakeCamera();
    const { user, panel } = await openBarcode();
    await startCamera(user);
    await waitFor(() => expect(cameraStatus()).toBe("Hold the product's barcode inside the frame."));
    expect(cam.getUserMedia).toHaveBeenCalledTimes(1);
    expect(cam.getUserMedia.mock.calls[0]).toEqual([{ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }]);
    expect(cam.attached()).not.toBeNull(); // the preview shows the stream
    await waitFor(() => expect(camera.looks).toBeGreaterThan(1)); // it keeps looking
    expect(added()).toEqual([]);

    camera.reading = { kind: "one", code: MAGGI }; // a product is held up
    await waitFor(() => expect(cameraStatus()).toBe(`Read ${MAGGI}`));
    const status = await panel.findByRole("status");
    expect(status.textContent).toContain("Added to bill");
    expect(status.textContent).toContain("Maggi 70g");
    expect(status.textContent).toContain("₹14.00"); // the catalogue's price
    expect(added()).toEqual([{ barcode: MAGGI, source: "barcode" }]); // exactly what the manual input sends

    // The barcode is still in view, but scanning is paused: it is not added again by itself.
    const looked = camera.looks;
    await new Promise((r) => setTimeout(r, 500));
    expect(camera.looks).toBe(looked);
    expect(added()).toHaveLength(1);

    // Scanning the same product again adds one more to the same line.
    await user.click(panel.getByRole("button", { name: "Scan next product" }));
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("2 in this bill"));
    expect((within(bill()).getByLabelText("Quantity of Maggi 70g") as HTMLInputElement).value).toBe("2");
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹28.00");

    // A manually typed code joins the very same bill.
    await scan(user, ATTA);
    await waitFor(() => expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹323.00"));
    expect(calls.filter((c) => c.route === "POST /api/v1/carts")).toHaveLength(1); // one cart, not two
  });

  it("adds nothing for an unknown, out-of-stock or ambiguous barcode read by the camera", async () => {
    fakeCamera();
    products.push(product("p-twin-a", "Twin A", "5.00", "9.000", "5000000000017"), product("p-twin-b", "Twin B", "6.00", "9.000", "5000000000017"));
    const { user, panel } = await openBarcode();
    await startCamera(user);

    camera.reading = { kind: "one", code: "8999999999993" };
    expect(within(await panel.findByRole("alert")).getByText("Barcode not found")).toBeTruthy();

    camera.reading = { kind: "one", code: SALT };
    await user.click(panel.getByRole("button", { name: "Scan next product" }));
    await waitFor(() => expect(panel.getByRole("alert").textContent).toContain("No more Tata Salt 1kg in stock"));

    camera.reading = { kind: "one", code: "5000000000017" };
    await user.click(panel.getByRole("button", { name: "Scan next product" }));
    await waitFor(() => expect(panel.getByRole("alert").textContent).toContain("This barcode is on more than one product"));

    // Two different barcodes in the picture: neither is chosen.
    camera.reading = { kind: "several", codes: [MAGGI, ATTA] };
    await user.click(panel.getByRole("button", { name: "Scan next product" }));
    await waitFor(() => expect(cameraStatus()).toBe("More than one barcode is in view. Show one at a time."));

    expect(added()).toEqual([]);
    expect(within(bill()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();
  });

  it("stops every camera track on Stop camera, and can be started and stopped again", async () => {
    const cam = fakeCamera();
    const { user, panel } = await openBarcode();

    for (const round of [1, 2, 3]) {
      await startCamera(user);
      await waitFor(() => expect(cameraStatus()).toBe("Hold the product's barcode inside the frame."));
      expect(cam.tracks).toHaveLength(round);
      await user.click(panel.getByRole("button", { name: "Stop camera" }));
      expect(cam.tracks[round - 1].stop).toHaveBeenCalledTimes(1);
      expect(cam.attached()).toBeNull(); // the preview lets go of the stream
      expect(panel.queryByLabelText("Camera status")).toBeNull();
      expect(panel.getByRole("button", { name: "Start camera" })).toBeTruthy();
    }
    // Stopped means stopped: nothing is looked at any more, even with a barcode in view.
    camera.reading = { kind: "one", code: MAGGI };
    const looked = camera.looks;
    await new Promise((r) => setTimeout(r, 500));
    expect(camera.looks).toBe(looked);
    expect(added()).toEqual([]);
  });

  it("stops the camera when the merchant leaves the barcode screen or the page", async () => {
    const cam = fakeCamera();
    const { user } = await openBarcode();
    await startCamera(user);
    await waitFor(() => expect(cameraStatus()).toBe("Hold the product's barcode inside the frame."));

    await user.click(screen.getByRole("button", { name: "Manual billing" })); // another Counter mode
    expect(screen.queryByRole("region", { name: "Scan barcode" })).toBeNull();
    expect(cam.tracks[0].stop).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Scan barcode" }));
    expect(cam.getUserMedia).toHaveBeenCalledTimes(1); // coming back does not restart it by itself
    await startCamera(user);
    await waitFor(() => expect(cam.tracks).toHaveLength(2));
    cleanup(); // the page goes away
    expect(cam.tracks[1].stop).toHaveBeenCalledTimes(1);
  });

  it("stops a camera that is granted only after the merchant has already pressed Stop", async () => {
    const cam = fakeCamera();
    let grant = (_: MediaStream) => {};
    const late = { stop: vi.fn(), addEventListener: () => {} };
    cam.getUserMedia.mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (grant = resolve)));
    const { user, panel } = await openBarcode();
    await startCamera(user);
    expect(cameraStatus()).toContain("Starting camera…");
    await user.click(panel.getByRole("button", { name: "Stop camera" }));

    grant({ getTracks: () => [late] } as unknown as MediaStream); // the permission prompt is answered late
    await waitFor(() => expect(late.stop).toHaveBeenCalledTimes(1));
    expect(panel.getByRole("button", { name: "Start camera" })).toBeTruthy();
    expect(camera.looks).toBe(0);
  });

  it.each([
    ["permission denied", new DOMException("no", "NotAllowedError"), "Camera permission was denied."],
    ["no camera", new DOMException("none", "NotFoundError"), "No camera was found on this device."],
    ["camera busy", new DOMException("busy", "NotReadableError"), "Could not start the camera."],
    ["no camera support", "missing" as const, "This browser can't open the camera here."],
  ])("says so when the camera cannot be used (%s) and leaves the manual input working", async (_, behaviour, message) => {
    fakeCamera(behaviour);
    const { user, panel } = await openBarcode();
    await startCamera(user);
    const alert = await panel.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("You can still type the barcode below.");
    expect(panel.getByRole("button", { name: "Try camera again" })).toBeTruthy();
    expect(camera.looks).toBe(0);

    await scan(user, MAGGI);
    await waitFor(() => expect(panel.getByRole("status").textContent).toContain("Maggi 70g"));
    expect(added()).toEqual([{ barcode: MAGGI, source: "barcode" }]);
  });

  it("reports a camera that stops on its own, or a reader that fails, and releases the camera", async () => {
    const cam = fakeCamera();
    const { user, panel } = await openBarcode();
    await startCamera(user);
    await waitFor(() => expect(cameraStatus()).toBe("Hold the product's barcode inside the frame."));
    cam.tracks[0].end(); // unplugged, or taken by another app
    expect((await panel.findByRole("alert")).textContent).toContain("The camera stopped.");
    expect(cam.tracks[0].stop).toHaveBeenCalled();

    camera.broken = true;
    await user.click(panel.getByRole("button", { name: "Try camera again" }));
    await waitFor(() => expect(panel.getByRole("alert").textContent).toContain("The barcode reader stopped working."));
    expect(cam.tracks[1].stop).toHaveBeenCalledTimes(1);
    expect(added()).toEqual([]);
  });
});
