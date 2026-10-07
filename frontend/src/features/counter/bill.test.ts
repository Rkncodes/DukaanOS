import { describe, expect, it } from "vitest";
import type { Schemas } from "../../lib/api/client";
import { availableStock, billTotals, resolveScan, stockShortfalls, toPaise } from "./bill";

function product(overrides: Partial<Schemas["ProductRead"]>): Schemas["ProductRead"] {
  return {
    id: "p1",
    category_id: null,
    name: "Maggi",
    sku: null,
    barcode: null,
    price: "14.00",
    cost_price: null,
    stock_quantity: "10.000",
    unit: "pcs",
    image_url: null,
    is_active: true,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("toPaise", () => {
  it("parses rupee strings exactly", () => {
    expect(toPaise("14.00")).toBe(1400);
    expect(toPaise("0.1")).toBe(10);
    expect(toPaise("2.05")).toBe(205);
    expect(toPaise(" ")).toBe(0);
  });

  it("rejects negatives, junk and sub-paise precision", () => {
    expect(toPaise("-1")).toBeNull();
    expect(toPaise("abc")).toBeNull();
    expect(toPaise("1.005")).toBeNull();
  });
});

describe("billTotals", () => {
  it("subtracts the discount without float drift", () => {
    expect(billTotals("0.30", "0.10")).toEqual({ ok: true, subtotal: "0.30", discount: "0.10", total: "0.20" });
    expect(billTotals("58.00", "")).toMatchObject({ ok: true, total: "58.00" });
  });

  it("blocks a discount larger than the subtotal", () => {
    expect(billTotals("50.00", "50.01")).toMatchObject({ ok: false });
    expect(billTotals("50.00", "50")).toMatchObject({ ok: true, total: "0.00" });
  });
});

describe("stockShortfalls", () => {
  it("flags lines that need more than is in stock", () => {
    const items = [
      { id: "line1", product_id: "p1", quantity: "3.000" },
      { id: "line2", product_id: "p2", quantity: "1.000" },
    ] as Schemas["CartItemRead"][];
    const products = [product({ id: "p1", stock_quantity: "2.000" }), product({ id: "p2" })];
    expect(stockShortfalls(items, products)).toEqual(new Map([["line1", "2.000"]]));
  });
});

describe("resolveScan", () => {
  const products = [
    product({ id: "maggi", name: "Maggi Noodles", barcode: "8901058000017" }),
    product({ id: "milk", name: "Amul Milk", barcode: "A12" }),
    product({ id: "masala", name: "Maggi Masala" }),
  ];

  it("treats a known barcode or a long digit string as a scan", () => {
    expect(resolveScan("A12", products)).toEqual({ kind: "barcode", barcode: "A12" });
    expect(resolveScan("8901058000017", products)).toEqual({ kind: "barcode", barcode: "8901058000017" });
    expect(resolveScan("99999999", products)).toEqual({ kind: "barcode", barcode: "99999999" });
  });

  it("adds a product when the search text matches exactly one", () => {
    expect(resolveScan("milk", products)).toEqual({ kind: "product", productId: "milk" });
  });

  it("asks the cashier to pick when the search is ambiguous or empty", () => {
    expect(resolveScan("maggi", products)).toMatchObject({ kind: "none" });
    expect(resolveScan("soap", products)).toMatchObject({ kind: "none" });
  });
});

describe("availableStock", () => {
  const line = (product_id: string, quantity: string): Schemas["CartItemRead"] => ({
    id: `l-${product_id}`,
    product_id,
    product_name: product_id,
    quantity,
    unit_price: "1.00",
    line_total: "1.00",
    source: "manual",
  });
  const products = [
    product({ id: "atta", stock_quantity: "70.000" }),
    product({ id: "salt", stock_quantity: "15.000" }),
    product({ id: "none", stock_quantity: "0.000" }),
    product({ id: "loose", stock_quantity: "2.500" }),
  ];
  const left = (items: Schemas["CartItemRead"][]) => Object.fromEntries(availableStock(products, items));

  it("is the catalogue's stock minus what the bill holds, per product", () => {
    expect(left([])).toEqual({ atta: 70, salt: 15, none: 0, loose: 2.5 });
    expect(left([line("atta", "1.000")]).atta).toBe(69);
    expect(left([line("atta", "7.000")])).toEqual({ atta: 63, salt: 15, none: 0, loose: 2.5 });
    expect(left([line("atta", "6.000")]).atta).toBe(64);
    expect(left([line("atta", "70.000"), line("salt", "14.000")])).toEqual({ atta: 0, salt: 1, none: 0, loose: 2.5 });
  });

  it("never goes below zero and keeps loose quantities exact", () => {
    expect(left([line("salt", "16.000")]).salt).toBe(0); // more on the bill than in stock (e.g. added by photo)
    expect(left([line("loose", "0.700")]).loose).toBe(1.8);
    expect(left([line("unknown", "3.000")])).toEqual({ atta: 70, salt: 15, none: 0, loose: 2.5 });
  });
});
