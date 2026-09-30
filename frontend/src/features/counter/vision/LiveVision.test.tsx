// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CounterPage } from "../CounterPage";
import { LiveVision } from "./LiveVision";
import { PRODUCTS, coke, createFakeBackend, json, maggi } from "./testing";

/**
 * Live Vision Counter against the real CounterPage + an in-memory backend. The browser camera
 * (getUserMedia) is faked at the navigator level so our permission/error handling runs for real;
 * only canvas frame capture is replaced, because jsdom cannot decode video.
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

function withQuery(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function openVisionCounter(user = userEvent.setup()) {
  render(withQuery(<CounterPage />));
  await user.click(await screen.findByRole("button", { name: "Vision counter" }));
  return user;
}

const billPanel = () => screen.getByRole("heading", { name: "Bill" }).parentElement!;
const boxes = () => within(screen.getByRole("list", { name: "Detections" })).queryAllByRole("listitem");
const frameCalls = () => backend.state.calls.filter((c) => c.path === "/api/v1/vision/frames");

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
    expect(frameCalls()).toHaveLength(0);

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

describe("Vision counter: live detections", () => {
  it("draws boxes with product name, price and confidence, flagged as mock, without touching the bill", async () => {
    await openVisionCounter();

    const [box] = await waitFor(() => {
      const found = boxes();
      expect(found).toHaveLength(1);
      return found;
    });
    expect(box.getAttribute("aria-label")).toBe(`Box 1: ${maggi.name}`);
    expect(box.textContent).toContain(maggi.name);
    expect(box.textContent).toContain("₹14.00");
    expect(box.textContent).toContain("94%");
    expect(box.getAttribute("style")).toContain("left: 10%");
    expect(screen.getByRole("note").textContent).toContain("not real AI");

    expect(backend.cartCalls()).toHaveLength(0);
    expect(within(billPanel()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();
  });

  it("updates as products appear and disappear between scans", async () => {
    render(
      withQuery(<LiveVision products={PRODUCTS} onConfirm={vi.fn()} onClose={vi.fn()} scanIntervalMs={5} />),
    );
    const labels = () => boxes().map((b) => b.getAttribute("aria-label"));

    await waitFor(() => expect(labels()).toEqual([`Box 1: ${maggi.name}`, `Box 2: ${coke.name}`])); // Coke appears
    await waitFor(() => expect(labels()).toContain("Box 3: Cold drink 750ml")); // whole counter
    // Maggi taken away, an unknown item placed: checked on one snapshot, as scans keep cycling.
    await waitFor(() => {
      expect(labels()).toEqual([`Box 1: ${coke.name}`, "Box 2: Red toothpaste tube"]);
      expect(boxes()[1].dataset.match).toBe("unmatched");
      expect(boxes()[1].textContent).toContain("not in catalog");
    });
  });

  it("shows recognition errors while staying live", async () => {
    backend.state.frame = async () =>
      json({ error: { code: "vision_unavailable", message: "Live camera recognition is not set up" } }, 503);
    await openVisionCounter();
    expect((await screen.findByRole("alert")).textContent).toContain("Live camera recognition is not set up");
    expect(screen.getByText("● Live")).toBeTruthy();
  });
});

describe("Vision counter: read the whole counter", () => {
  it("reads, requires confirmation, then adds to the existing bill and keeps scanning", async () => {
    const user = await openVisionCounter();
    await waitFor(() => expect(boxes()).toHaveLength(1)); // first live frame

    await user.click(screen.getByRole("button", { name: "Read the whole counter" }));
    expect(await screen.findByText("Paused for review")).toBeTruthy();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(within(screen.getByRole("listitem", { name: /^Detection 1:/ })).getByText(maggi.name)).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: /^Detection 2:/ })).getByText(coke.name)).toBeTruthy();

    // Nothing is in the bill before confirmation.
    expect(backend.cartCalls()).toHaveLength(0);
    expect(within(billPanel()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add 2 to bill" }));

    expect(await within(billPanel()).findByText(maggi.name)).toBeTruthy();
    expect(within(billPanel()).getByText(coke.name)).toBeTruthy();
    expect(within(billPanel()).getAllByText("vision")).toHaveLength(2);
    const confirm = backend.state.calls.find((c) => c.path.endsWith("/recognized-items"))!;
    expect(confirm.body).toEqual({
      source: "vision",
      items: [
        { product_id: maggi.id, quantity: "2" },
        { product_id: coke.id, quantity: "1" },
      ],
    });
    expect(screen.getByRole("button", { name: /Collect/ }).textContent).toContain("₹68.00"); // 2 × 14 + 40
    expect(await screen.findByText("● Live")).toBeTruthy();
    expect(screen.getByText(/Added to the bill/)).toBeTruthy();
  });

  it("discarding a read adds nothing", async () => {
    const user = await openVisionCounter();
    await waitFor(() => expect(boxes()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Read the whole counter" }));
    await user.click(await screen.findByRole("button", { name: "Discard and keep scanning" }));

    expect(await screen.findByText("● Live")).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0);
  });
});

describe("Vision counter: stop", () => {
  it("stop releases the camera and leaves the bill unchanged, even mid-review", async () => {
    const user = await openVisionCounter();
    await waitFor(() => expect(boxes()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Read the whole counter" }));
    await screen.findByText("Paused for review");

    await user.click(screen.getByRole("button", { name: "Stop camera" }));

    expect(track.stop).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Vision counter" })).toBeNull();
    expect(screen.getByRole("button", { name: "Vision counter" })).toBeTruthy();
    expect(backend.cartCalls()).toHaveLength(0);
    expect(within(billPanel()).getByText("Scan or tap a product to start the bill.")).toBeTruthy();
  });
});
