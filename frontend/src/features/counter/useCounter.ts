import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ApiError, api, unwrap, type Schemas } from "../../lib/api/client";

type Cart = Schemas["CartRead"];

const STORAGE_KEY = "dukaanos.counter.cartId";
const cartKey = (id: string | null) => ["cart", id] as const;

// The open bill survives a page reload, so a refresh mid-billing doesn't lose the cart.
function loadCartId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveCartId(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the bill just won't survive a reload.
  }
}

/**
 * State for one counter bill. The cart is created lazily on the first add, so opening the
 * Counter page never leaves empty carts behind. Every mutation returns the updated cart,
 * which replaces the cached copy.
 */
export function useCounter() {
  const qc = useQueryClient();
  const [cartId, setCartIdState] = useState<string | null>(loadCartId);
  const pendingCart = useRef<Promise<string> | null>(null);

  const setCartId = useCallback((id: string | null) => {
    saveCartId(id);
    setCartIdState(id);
  }, []);

  const cart = useQuery({
    queryKey: cartKey(cartId),
    enabled: cartId !== null,
    queryFn: async () => {
      try {
        const data = await unwrap(api.GET("/api/v1/carts/{cart_id}", { params: { path: { cart_id: cartId! } } }));
        if (data.status === "open") return data;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      // Stored cart is gone or already checked out: start fresh on the next add.
      setCartId(null);
      return null;
    },
  });

  /** Existing cart id, or create one. Concurrent callers (fast scans) share one creation. */
  const ensureCartId = useCallback(async (): Promise<string> => {
    if (cartId) return cartId;
    pendingCart.current ??= unwrap(api.POST("/api/v1/carts", { body: {} })).then((created) => {
      qc.setQueryData(cartKey(created.id), created);
      setCartId(created.id);
      return created.id;
    });
    try {
      return await pendingCart.current;
    } finally {
      pendingCart.current = null;
    }
  }, [cartId, qc, setCartId]);

  const onCart = (updated: Cart) => qc.setQueryData(cartKey(updated.id), updated);

  const addItem = useMutation({
    mutationFn: async (item: Schemas["CartItemAdd"]) => {
      const id = await ensureCartId();
      return unwrap(api.POST("/api/v1/carts/{cart_id}/items", { params: { path: { cart_id: id } }, body: item }));
    },
    onSuccess: onCart,
  });

  const setQuantity = useMutation({
    mutationFn: ({ itemId, quantity }: { itemId: string; quantity: string }) =>
      unwrap(
        api.PATCH("/api/v1/carts/{cart_id}/items/{item_id}", {
          params: { path: { cart_id: cartId!, item_id: itemId } },
          body: { quantity },
        }),
      ),
    onSuccess: onCart,
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) =>
      unwrap(
        api.DELETE("/api/v1/carts/{cart_id}/items/{item_id}", {
          params: { path: { cart_id: cartId!, item_id: itemId } },
        }),
      ),
    onSuccess: onCart,
  });

  const setCustomer = useMutation({
    mutationFn: async (customerId: string | null) => {
      const id = await ensureCartId();
      return unwrap(
        api.PATCH("/api/v1/carts/{cart_id}", { params: { path: { cart_id: id } }, body: { customer_id: customerId } }),
      );
    },
    onSuccess: onCart,
  });

  const checkout = useMutation({
    mutationFn: async (body: Schemas["CheckoutRequest"]) => {
      const order = await unwrap(
        api.POST("/api/v1/carts/{cart_id}/checkout", { params: { path: { cart_id: cartId! } }, body }),
      );
      return unwrap(api.GET("/api/v1/orders/{order_id}/bill", { params: { path: { order_id: order.id } } }));
    },
    onSuccess: () => {
      qc.removeQueries({ queryKey: cartKey(cartId) });
      setCartId(null);
      // Stock, recent bills and khata balances all changed: every module reads the same data.
      for (const key of [["products"], ["orders"], ["khata"], ["customers"]]) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => {
      // A stock shortfall means our product list is stale; refresh it so the warnings show.
      if (e instanceof ApiError && e.code === "insufficient_stock") qc.invalidateQueries({ queryKey: ["products"] });
    },
  });

  return { cart: cart.data ?? null, cartLoading: cart.isFetching, addItem, setQuantity, removeItem, setCustomer, checkout };
}
