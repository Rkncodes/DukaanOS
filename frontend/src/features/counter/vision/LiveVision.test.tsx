// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CounterPage } from "../CounterPage";
import { LIVE, createFakeBackend, json, lays, maggi, parle, pepsi } from "./testing";

/**
 * Continuous Vision Counter against the real CounterPage (+ its existing bill) and an in-memory
 * backend. getUserMedia is faked at the navigator level so our permission/error handling runs for
 * real; only canvas frame capture is replaced, because jsdom cannot decode video.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

vi.mock("./camera", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./camera")>()),
  captureFrame: vi.fn(async () => new Blob(["frame"], { type: "image/jpeg" })),
  captureRegion: vi.fn(async () => new Blob(["packet"], { type: "image/jpeg" })),
}));

let backend: ReturnType<typeof createFakeBackend>;
let track: { stop: ReturnType<typeof vi.fn> };
let stream: MediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  backend = createFakeBackend();
  server.handle = backend.handle;
  track = { stop: vi.fn() };
  stream = { getTracks: () => [track] } as unknown as MediaStream;
  getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openVisionCounter(scanIntervalMs = 20, user = userEvent.setup()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CounterPage scanIntervalMs={scanIntervalMs} />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Vision counter" }));
  return user;
}

const billPanel = () => screen.getByRole("heading", { name: "Bill" }).parentElement!;
const billIsEmpty = () => !!within(billPanel()).queryByText("Scan or tap a product to start the bill.");
const boxes = () => within(screen.getByRole("list", { name: "Detections" })).queryAllByRole("listitem");
const counterRow = (name: string | RegExp) =>
  within(screen.getByRole("list", { name: "On the counter" })).getByRole("listitem", { name });
const frameCalls = () => backend.state.calls.filter((c) => c.path === "/api/v1/vision/frames").length;
const confirmCalls = () => backend.state.calls.filter((c) => c.path.endsWith("/recognized-items"));
const addButton = (qty: number, product: { name: string }) =>
  screen.findByRole("button", { name: `Add ${qty} ${product.name} to bill` });

/** Let the live loop run a few more frames. */
async function moreFrames(n = 4) {
  const target = frameCalls() + n;
  await waitFor(() => expect(frameCalls()).toBeGreaterThanOrEqual(target));
}

describe("Vision counter: camera", () => {
  it("asks for the camera, shows a starting state, then the live stream", async () => {
    let grant!: () => void;
    getUserMedia.mockImplementation(() => new Promise((resolve) => (grant = () => resolve(stream))));
    await openVisionCounter();

    expect(screen.getByRole("region", { name: "Vision counter" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Starting camera");
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    grant();

    expect(await screen.findByText("● Live")).toBeTruthy();
    expect((screen.getByLabelText("Live camera") as HTMLVideoElement).srcObject).toBe(stream);
  });

  it("explains a denied permission and can try again", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const user = await openVisionCounter();

    expect((await screen.findByRole("alert")).textContent).toContain("Camera permission was denied");
    expect(frameCalls()).toBe(0);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("● Live")).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("reports a missing camera and an unsupported browser", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("none", "NotFoundError"));
    await openVisionCounter();
    expect((await screen.findByRole("alert")).textContent).toContain("No camera was found");
    cleanup();

    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    await openVisionCounter();
    expect((await screen.findByRole("alert")).textContent).toContain("can't open the camera");
  });
});

describe("Vision counter: continuous detection", () => {
  it("detects on its own: boxes with name, price and confidence, the provider badge, and an untouched bill", async () => {
    await openVisionCounter();

    const box = await screen.findByRole("listitem", { name: `Box 1: ${maggi.name}` });
    expect(box.textContent).toContain("₹14.00");
    expect(box.textContent).toContain("94%");
    expect(box.getAttribute("style")).toContain("left: 6%");
    expect(screen.getByRole("note", { name: "Vision provider" }).textContent).toContain("recognizing from the camera image");
    expect(screen.queryByText(/not real recognition/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Read the whole counter/ })).toBeNull();

    await moreFrames(6); // keeps scanning with no button press
    expect(backend.cartCalls()).toHaveLength(0);
    expect(billIsEmpty()).toBe(true);
  });

  it("follows products as they are placed, stay and are taken away", async () => {
    backend.showScene([LIVE.maggi]);
    await openVisionCounter(150); // slow enough to observe the one-frame "new" state

    await waitFor(() => expect(counterRow(maggi.name).dataset.status).toBe("new"));
    expect(counterRow(maggi.name).textContent).toContain("New");
    await waitFor(() => expect(counterRow(maggi.name).dataset.status).toBe("present"));

    backend.showScene([LIVE.maggi2, LIVE.lays]);
    await waitFor(() => expect(counterRow(lays.name).dataset.status).toBe("new"));
    expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual([`Box 1: ${maggi.name}`, `Box 2: ${lays.name}`]);
    expect(counterRow(maggi.name).textContent).toContain("×2"); // second packet placed: same product, qty 2

    backend.showScene([LIVE.lays]);
    await waitFor(() => expect(counterRow(`${maggi.name} (leaving)`).dataset.status).toBe("leaving"));
    expect(boxes().find((b) => b.getAttribute("aria-label") === `Box 2: ${maggi.name}`)?.dataset.faded).toBe("true");
    await waitFor(() => expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual([`Box 1: ${lays.name}`]));
  });

  it("keeps showing recognition errors while staying live", async () => {
    backend.state.frame = async () =>
      json({ error: { code: "vision_unavailable", message: "Live camera recognition is not set up" } }, 503);
    await openVisionCounter();
    expect((await screen.findByRole("alert")).textContent).toContain("Live camera recognition is not set up");
    expect(screen.getByText("● Live")).toBeTruthy();
  });
});

describe("Vision counter: committing to the existing bill", () => {
  it("adds a product once; repeated frames never add it again; a second packet adds only the extra one", async () => {
    backend.showScene([LIVE.maggi]);
    const user = await openVisionCounter();

    await user.click(await addButton(1, maggi));
    expect(await within(billPanel()).findByText(maggi.name)).toBeTruthy();
    expect(confirmCalls().map((c) => c.body)).toEqual([
      { source: "vision", items: [{ product_id: maggi.id, quantity: "1" }] },
    ]);

    await moreFrames(6); // the same packet stays in view
    expect(confirmCalls()).toHaveLength(1);
    expect(counterRow(maggi.name).textContent).toContain("✓ Added");
    expect(screen.getByRole("listitem", { name: `Box 1: ${maggi.name}` }).textContent).toContain("✓ in bill ×1");

    backend.showScene([LIVE.maggi2]); // a second Maggi placed
    const addMore = await addButton(1, maggi);
    expect(addMore.textContent).toBe("Add 1 more");
    await user.click(addMore);
    await waitFor(() => expect(confirmCalls()).toHaveLength(2));
    expect(confirmCalls()[1].body).toEqual({ source: "vision", items: [{ product_id: maggi.id, quantity: "1" }] });
    await waitFor(() =>
      expect((within(billPanel()).getByLabelText(`Quantity of ${maggi.name}`) as HTMLInputElement).value).toBe("2"),
    );

    await moreFrames(6);
    expect(confirmCalls()).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹28.00");
  });

  it("ambiguous needs a choice; low-confidence and unknown items are never added on their own", async () => {
    backend.showScene([LIVE.drink, LIVE.parle, LIVE.unknown]);
    const user = await openVisionCounter();

    await waitFor(() => expect(counterRow("Cold drink 750ml")).toBeTruthy());
    await moreFrames(6);
    expect(confirmCalls()).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /to bill$/ })).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Add all ready (0)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(counterRow("Cold drink 750ml").textContent).toContain("Which product is it?");
    expect(counterRow(parle.name).textContent).toContain("Unsure");
    expect(counterRow("Red toothpaste tube").textContent).toContain("Not in catalog · won't be added");

    await user.click(screen.getByRole("button", { name: `Choose ${pepsi.name}` }));
    await user.click(await addButton(1, pepsi));
    await user.click(screen.getByRole("button", { name: `Yes, it's ${parle.name}` }));
    await user.click(await addButton(1, parle));

    await waitFor(() => expect(confirmCalls()).toHaveLength(2));
    expect(confirmCalls().map((c) => (c.body as { items: { product_id: string }[] }).items[0].product_id)).toEqual([
      pepsi.id,
      parle.id,
    ]);
    const bill = billPanel();
    expect(await within(bill).findByText(parle.name)).toBeTruthy();
    expect(within(bill).getByText(pepsi.name)).toBeTruthy();
    expect(within(bill).queryByText(/toothpaste/i)).toBeNull();
  });

  it("after the merchant says what an unsure packet is, it can be remembered as that product's reference photo", async () => {
    backend.showScene([LIVE.parle, LIVE.maggi]);
    const user = await openVisionCounter();
    const references = () => backend.state.calls.filter((c) => c.path.includes("/reference-images"));

    await waitFor(() => expect(counterRow(parle.name)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Remember this packet/ })).toBeNull(); // nothing chosen yet
    await user.click(screen.getByRole("button", { name: `Yes, it's ${parle.name}` }));
    await user.click(screen.getByRole("button", { name: `Remember this packet as ${parle.name}` }));

    await waitFor(() => expect(counterRow(parle.name).textContent).toContain("✓ remembered"));
    expect(references().map((c) => [c.method, c.path])).toEqual([
      ["POST", `/api/v1/vision/products/${parle.id}/reference-images`],
    ]);
    await moreFrames(3);
    expect(references()).toHaveLength(1); // saved once, by an explicit action only
    expect(confirmCalls()).toHaveLength(0); // remembering a packet never bills it
  });

  it("says what a real recognition rests on", async () => {
    const evidence = { visual: 0.5, text: 0.8, reference: 0, read_text: "MAGGI NOODLES" };
    backend.showScene([
      { ...LIVE.maggi, evidence },
      { ...LIVE.lays, evidence: { ...evidence, text: 0, reference: 0.9 } },
      { ...LIVE.parle, evidence: { ...evidence, text: 0 } },
    ]);
    await openVisionCounter();
    await waitFor(() => expect(counterRow(maggi.name).textContent).toContain("name read on pack"));
    expect(counterRow(lays.name).textContent).toContain("matches your photo");
    expect(counterRow(parle.name).textContent).toContain("by look only");
  });

  it("'Add all ready' adds every decided product in one call to the existing cart", async () => {
    backend.showScene([LIVE.maggi2, LIVE.lays, LIVE.unknown]);
    const user = await openVisionCounter();

    await user.click(await screen.findByRole("button", { name: "Add all ready (2)" }));
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0].body).toEqual({
      source: "vision",
      items: [
        { product_id: maggi.id, quantity: "2" },
        { product_id: lays.id, quantity: "1" },
      ],
    });
    expect(await within(billPanel()).findByText(lays.name)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹48.00"); // 2 × 14 + 20
    await waitFor(() => expect(screen.getByRole("button", { name: "Add all ready (0)" })).toBeTruthy());
  });

  it("stopping the camera stops recognition and leaves the bill exactly as it was", async () => {
    backend.showScene([LIVE.maggi, LIVE.lays]);
    const user = await openVisionCounter();
    await user.click(await addButton(1, maggi));
    expect(await within(billPanel()).findByText(maggi.name)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop camera" }));
    const framesAtStop = frameCalls();
    const cartCallsAtStop = backend.cartCalls().length;

    expect(track.stop).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Vision counter" })).toBeNull();
    await new Promise((r) => setTimeout(r, 120)); // several scan intervals
    expect(frameCalls()).toBe(framesAtStop);
    expect(backend.cartCalls()).toHaveLength(cartCallsAtStop);
    expect(within(billPanel()).getByText(maggi.name)).toBeTruthy();
    expect(within(billPanel()).queryByText(lays.name)).toBeNull();
  });
});

describe("Vision counter: real provider", () => {
  const realFrame = (sequence: number, detections: unknown[]) =>
    json({ provider: "local-cv (owl-vit + clip)", is_mock: false, sequence, detections });
  const realMaggi = { ...LIVE.maggi, label: "Maggi", confidence: 0.83 };
  const unknownPacket = {
    ...LIVE.unknown,
    label: "Unknown product",
    confidence: 0.71,
    bbox: { x: 0.55, y: 0.2, width: 0.2, height: 0.3 },
  };

  it("renders real detections with catalog name and price, and no demo notice", async () => {
    backend.state.frame = async (n) => realFrame(n, [realMaggi, unknownPacket]);
    await openVisionCounter();

    const box = await screen.findByRole("listitem", { name: `Box 1: ${maggi.name}` });
    expect(box.textContent).toContain("₹14.00"); // price from the catalog, not the model
    expect(box.textContent).toContain("83%");
    expect(screen.getByRole("note", { name: "Vision provider" }).textContent).toContain("local-cv (owl-vit + clip)");
    expect(screen.queryByText(/not real recognition/)).toBeNull();

    // An unknown packet is shown safely and cannot be billed.
    expect(counterRow("Unknown product").textContent).toContain("Not in catalog · won't be added");
    expect(screen.getByRole("button", { name: "Add all ready (1)" })).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0);
  });

  it("shows a provider failure clearly and keeps the bill untouched", async () => {
    backend.state.frame = async () =>
      json({ error: { code: "vision_failed", message: "The vision provider could not process this image" } }, 502);
    await openVisionCounter();
    expect((await screen.findByRole("alert")).textContent).toContain("could not process this image");
    expect(screen.queryByText(/not real recognition/)).toBeNull();
    expect(backend.cartCalls()).toHaveLength(0);
  });

  it("never lets an older (stale) frame result overwrite a newer one", async () => {
    let calls = 0;
    backend.state.frame = async () => {
      calls += 1;
      // First reply is frame 5 (Maggi); every later reply claims to be an *older* frame (Lays).
      return calls === 1 ? realFrame(5, [realMaggi]) : realFrame(2, [{ ...LIVE.lays, label: "Lays" }]);
    };
    await openVisionCounter();

    await screen.findByRole("listitem", { name: `Box 1: ${maggi.name}` });
    await moreFrames(4);
    expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual([`Box 1: ${maggi.name}`]);
    expect(screen.queryByRole("listitem", { name: /Lays/ })).toBeNull();
  });
});
