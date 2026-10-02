/**
 * Test-only: an in-memory fake of the backend endpoints the Counter + vision UI uses, so
 * component tests exercise the real CounterPage/cart panel without a server.
 */
import type { Schemas } from "../../../lib/api/client";

type Json = Record<string, unknown>;

export const P = (id: string, name: string, price: string) =>
  ({
    id,
    name,
    price,
    stock_quantity: "50.000",
    unit: "pcs",
    barcode: null,
    sku: null,
    category_id: null,
    cost_price: null,
    image_url: null,
    is_active: true,
    created_at: "",
    updated_at: "",
  }) satisfies Schemas["ProductRead"];

export const maggi = P("p-maggi", "Maggi 2-Minute Noodles 70g", "14.00");
export const coke = P("p-coke", "Coke 750ml", "40.00");
export const pepsi = P("p-pepsi", "Pepsi 750ml", "40.00");
export const parle = P("p-parle", "Parle-G Biscuits 250g", "25.00");
export const colgate = P("p-colgate", "Colgate Strong Teeth 200g", "110.00");
export const lays = P("p-lays", "Lays Classic Salted 52g", "20.00");
export const dairy = P("p-dairy", "Dairy Milk Chocolate 50g", "50.00");
export const PRODUCTS = [colgate, coke, dairy, lays, maggi, parle, pepsi];

export const det = (
  id: string,
  label: string,
  match: Schemas["MatchState"],
  extra: Partial<Schemas["Detection"]> = {},
) =>
  ({
    id,
    label,
    barcode: null,
    quantity: "1.000",
    confidence: 0.9,
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    match,
    product: null,
    candidates: [],
    ...extra,
  }) satisfies Schemas["Detection"];

/** A photo result as the real provider returns it, already matched to PRODUCTS (test data only). */
export const VISION_RESULT: Schemas["VisionResult"] = {
  provider: "local-cv (owl-vit + clip)",
  is_mock: false,
  detections: [
    det("d0", "Maggi 2-Minute Noodles", "matched", { product: maggi, quantity: "2.000", confidence: 0.94 }),
    det("d1", "Coke 750ml", "matched", { product: coke }),
    det("d2", "Cold drink 750ml", "ambiguous", { candidates: [coke, pepsi] }),
    det("d3", "Parle-G Biscuits", "low_confidence", { candidates: [parle], confidence: 0.41 }),
    det("d4", "Red toothpaste tube", "unmatched"),
  ],
};

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Live detections as the backend returns them, already matched to PRODUCTS (test data only). */
export const LIVE = {
  maggi: det("d0", "Maggi 2-Minute Noodles", "matched", { product: maggi, confidence: 0.94, bbox: box(0.06, 0.3, 0.22, 0.3) }),
  maggi2: det("d0", "Maggi 2-Minute Noodles", "matched", {
    product: maggi,
    quantity: "2.000",
    confidence: 0.94,
    bbox: box(0.06, 0.3, 0.22, 0.3),
  }),
  lays: det("d1", "Lays Classic Salted", "matched", { product: lays, confidence: 0.89, bbox: box(0.32, 0.2, 0.16, 0.34) }),
  drink: det("d2", "Cold drink 750ml", "ambiguous", { candidates: [coke, pepsi], confidence: 0.72, bbox: box(0.52, 0.1, 0.11, 0.52) }),
  parle: det("d3", "Parle-G Biscuits", "low_confidence", { candidates: [parle], confidence: 0.41, bbox: box(0.68, 0.58, 0.24, 0.18) }),
  dairy: det("d1", "Dairy Milk Chocolate", "matched", { product: dairy, confidence: 0.88, bbox: box(0.68, 0.25, 0.2, 0.14) }),
  unknown: det("d2", "Red toothpaste tube", "unmatched", { confidence: 0.66, bbox: box(0.08, 0.74, 0.34, 0.12) }),
};

/** What the real provider reports for a frame (test data only; the app has no fake provider). */
export const REAL_PROVIDER = "local-cv (owl-vit + clip)";

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export type Call = { method: string; path: string; body: unknown };

export function createFakeBackend() {
  const state = {
    calls: [] as Call[],
    cart: null as Json | null,
    recognize: async (): Promise<Response> => json(VISION_RESULT),
    /** `n` = how many frames were sent before this one (the client's sequence). The default "camera"
     * shows one Maggi packet; tests change what is in view with showScene(). */
    frame: async (n: number): Promise<Response> =>
      json({ provider: REAL_PROVIDER, is_mock: false, sequence: n, detections: [LIVE.maggi] }),
  };

  function addToCart(items: { product_id: string; quantity?: string }[], source: string) {
    const lines = state.cart!.items as Json[];
    for (const item of items) {
      const product = PRODUCTS.find((p) => p.id === item.product_id)!;
      const quantity = Number(item.quantity ?? 1);
      const existing = lines.find((l) => l.product_id === product.id);
      if (existing) existing.quantity = String(Number(existing.quantity) + quantity);
      else
        lines.push({
          id: `line-${product.id}`,
          product_id: product.id,
          product_name: product.name,
          quantity: quantity.toFixed(3),
          unit_price: product.price,
          source,
        });
    }
    for (const l of lines) l.line_total = (Number(l.quantity) * Number(l.unit_price)).toFixed(2);
    state.cart!.subtotal = lines.reduce((s, l) => s + Number(l.line_total), 0).toFixed(2);
    return state.cart;
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = req.headers.get("content-type")?.includes("application/json") ? await req.json() : null;
    const route = `${req.method} ${path}`;
    const framesBefore = state.calls.filter((c) => c.path === "/api/v1/vision/frames").length;
    state.calls.push({ method: req.method, path, body });

    if (route === "GET /api/v1/auth/me") return json({ user: { name: "Ramesh" }, merchant: { store_name: "Test Store" } });
    if (route === "GET /api/v1/products") return json(PRODUCTS);
    if (route === "GET /api/v1/customers" || route === "GET /api/v1/khata/balances") return json([]);
    if (route === "POST /api/v1/vision/recognize") return state.recognize();
    if (route === "POST /api/v1/vision/frames") return state.frame(framesBefore);
    const reference = /^POST \/api\/v1\/vision\/products\/([^/]+)\/reference-images$/.exec(route);
    if (reference) return json({ id: "ref-1", product_id: reference[1], created_at: "" }, 201);
    if (route === "POST /api/v1/carts") {
      state.cart = { id: "cart-1", customer_id: null, channel: "counter", status: "open", items: [], subtotal: "0.00" };
      return json(state.cart, 201);
    }
    if (route === "GET /api/v1/carts/cart-1") return json(state.cart);
    if (route === "POST /api/v1/carts/cart-1/recognized-items") {
      const b = body as Schemas["ConfirmedItemsAdd"];
      return json(addToCart(b.items as { product_id: string; quantity?: string }[], b.source ?? "vision"));
    }
    return json({ error: { code: "not_found", message: `No fake for ${route}` } }, 404);
  }

  /** What is in front of the (fake) camera from now on: every frame returns these detections. */
  const showScene = (detections: Schemas["Detection"][]) => {
    state.frame = async (n) => json({ provider: REAL_PROVIDER, is_mock: false, sequence: n, detections });
  };

  const cartCalls = () => state.calls.filter((c) => c.path.startsWith("/api/v1/carts"));
  return { state, handle, cartCalls, showScene };
}
