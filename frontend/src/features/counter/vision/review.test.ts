import { describe, expect, it } from "vitest";
import { confirmPlan, imageFileError, initialRows, isValidQuantity, type Detection, type Product } from "./review";

const product = (id: string, name: string): Product =>
  ({ id, name, price: "10.00", stock_quantity: "5.000", unit: "pcs" }) as Product;

const detection = (id: string, match: Detection["match"], extra: Partial<Detection> = {}): Detection => ({
  id,
  label: id,
  barcode: null,
  quantity: "1.000",
  confidence: 0.9,
  bbox: null,
  match,
  product: null,
  candidates: [],
  ...extra,
});

describe("imageFileError", () => {
  it("accepts supported photos and rejects other files", () => {
    expect(imageFileError(new File(["x"], "a.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(imageFileError(new File(["x"], "a.gif", { type: "image/gif" }))).toMatch(/JPEG, PNG or WebP/);
    expect(imageFileError(new File([], "a.png", { type: "image/png" }))).toMatch(/empty/);
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "a.png", { type: "image/png" });
    expect(imageFileError(huge)).toMatch(/8 MB/);
  });
});

describe("initialRows", () => {
  it("preselects only confident single matches", () => {
    const maggi = product("p1", "Maggi");
    const rows = initialRows([
      detection("d0", "matched", { product: maggi, quantity: "2.000" }),
      detection("d1", "low_confidence", { candidates: [maggi] }),
      detection("d2", "ambiguous", { candidates: [maggi, product("p2", "Other")] }),
      detection("d3", "unmatched"),
    ]);
    expect(rows.map((r) => r.product?.id ?? null)).toEqual(["p1", null, null, null]);
    expect(rows[0].quantity).toBe("2");
  });
});

describe("confirmPlan", () => {
  it("sends chosen rows only and counts the rest as skipped", () => {
    const rows = initialRows([
      detection("d0", "matched", { product: product("p1", "Maggi") }),
      detection("d1", "unmatched"),
    ]);
    expect(confirmPlan(rows)).toEqual({ items: [{ product_id: "p1", quantity: "1" }], skipped: 1, invalid: false });
  });

  it("blocks confirmation on a bad quantity", () => {
    const [row] = initialRows([detection("d0", "matched", { product: product("p1", "Maggi") })]);
    expect(confirmPlan([{ ...row, quantity: "0" }]).invalid).toBe(true);
    expect(isValidQuantity("1.5")).toBe(true);
    expect(isValidQuantity("-1")).toBe(false);
    expect(isValidQuantity("abc")).toBe(false);
  });
});
