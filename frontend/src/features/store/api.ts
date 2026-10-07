import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../lib/api/client";

/** The public storefront API: no login, and the store in the URL is the only one it can reach. */

export type StoreOrder = Schemas["StoreOrderRead"];

/** How often an order's status is re-read, so changes show without a manual refresh. */
export const ORDER_POLL_MS = 5000;

export function useStore(slug: string) {
  return useQuery({
    queryKey: ["store", slug],
    queryFn: () => unwrap(api.GET("/api/v1/public/stores/{store_slug}", { params: { path: { store_slug: slug } } })),
    retry: false,
  });
}

export function useStoreProducts(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ["store", slug, "products"],
    enabled,
    queryFn: () =>
      unwrap(api.GET("/api/v1/public/stores/{store_slug}/products", { params: { path: { store_slug: slug } } })),
  });
}

export function placeOrder(slug: string, body: Schemas["StoreOrderCreate"]) {
  return unwrap(api.POST("/api/v1/public/stores/{store_slug}/orders", { params: { path: { store_slug: slug } }, body }));
}

const FINISHED: StoreOrder["status"][] = ["completed", "cancelled"];

export function useStoreOrder(slug: string, orderId: string, pollMs = ORDER_POLL_MS) {
  return useQuery({
    queryKey: ["store", slug, "order", orderId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/public/stores/{store_slug}/orders/{order_id}", {
          params: { path: { store_slug: slug, order_id: orderId } },
        }),
      ),
    retry: false,
    // Keep following the order until the store has finished with it.
    refetchInterval: (query) => (query.state.data && FINISHED.includes(query.state.data.status) ? false : pollMs),
  });
}
