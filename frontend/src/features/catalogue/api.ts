import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../lib/api/client";

/** Catalogue screens over the existing catalog and inventory APIs. The backend validates and owns every value. */

export type Product = Schemas["ProductRead"];
export type Category = Schemas["CategoryRead"];

/** Stock below this is flagged as low: the same line the Dashboard draws. */
export const LOW_STOCK = 10;

export type StockLevel = "out" | "low" | "ok";
export const stockLevel = (p: Product): StockLevel =>
  Number(p.stock_quantity) <= 0 ? "out" : Number(p.stock_quantity) < LOW_STOCK ? "low" : "ok";
/** How each level is named and coloured, everywhere in the Catalogue. */
export const STOCK_LEVEL = {
  out: { key: "catalogue.outOfStock", tone: "red" },
  low: { key: "stock.level.low", tone: "amber" },
  ok: { key: "stock.level.ok", tone: "emerald" },
} as const;

/** Every product, including the ones taken off sale. (The Counter and Shop read only active ones.) */
export function useAllProducts() {
  return useQuery({
    queryKey: ["products", "all"],
    queryFn: () => unwrap(api.GET("/api/v1/products", { params: { query: { include_inactive: true } } })),
  });
}

export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: () => unwrap(api.GET("/api/v1/categories")) });
}

/** Products changed: every screen that lists them (Counter, Shop, Dashboard, Catalogue) reads them again. */
function useRefresh(...keys: string[]) {
  const qc = useQueryClient();
  return () => {
    for (const key of keys) qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useSaveProduct() {
  const refresh = useRefresh("products");
  return useMutation({
    mutationFn: (product: { id: string; body: Schemas["ProductUpdate"] } | { id: null; body: Schemas["ProductCreate"] }) =>
      product.id === null
        ? unwrap(api.POST("/api/v1/products", { body: product.body }))
        : unwrap(api.PATCH("/api/v1/products/{product_id}", { params: { path: { product_id: product.id } }, body: product.body })),
    onSuccess: refresh,
  });
}

/** Taking a product off sale keeps it (old bills refer to it); it can be put back. */
export function useSetProductActive() {
  const refresh = useRefresh("products");
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => {
      const params = { path: { product_id: id } };
      return active
        ? unwrap(api.PATCH("/api/v1/products/{product_id}", { params, body: { is_active: true } }))
        : unwrap(api.DELETE("/api/v1/products/{product_id}", { params }));
    },
    onSuccess: refresh,
  });
}

export function useSaveCategory() {
  const refresh = useRefresh("categories");
  return useMutation({
    mutationFn: ({ id, name }: { id: string | null; name: string }) =>
      id === null
        ? unwrap(api.POST("/api/v1/categories", { body: { name } }))
        : unwrap(api.PATCH("/api/v1/categories/{category_id}", { params: { path: { category_id: id } }, body: { name } })),
    onSuccess: refresh,
  });
}

export function useDeleteCategory() {
  const refresh = useRefresh("categories", "products");
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/categories/{category_id}", { params: { path: { category_id: id } } })),
    onSuccess: refresh,
  });
}

/** Stock only ever changes through the backend's inventory service: here by a signed adjustment. */
export function useAdjustStock() {
  const refresh = useRefresh("products");
  return useMutation({
    mutationFn: (body: Schemas["StockAdjustment"]) => unwrap(api.POST("/api/v1/inventory/adjustments", { body })),
    onSuccess: refresh,
  });
}
