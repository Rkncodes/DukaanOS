import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";

/** Shared server-state hooks. Every module reads the same merchant data. */

export function useProducts() {
  return useQuery({ queryKey: ["products"], queryFn: () => unwrap(api.GET("/api/v1/products")) });
}

export function useCustomers() {
  return useQuery({ queryKey: ["customers"], queryFn: () => unwrap(api.GET("/api/v1/customers")) });
}

export function useKhataBalances() {
  return useQuery({ queryKey: ["khata", "balances"], queryFn: () => unwrap(api.GET("/api/v1/khata/balances")) });
}

export function useOrders(limit = 10) {
  return useQuery({
    queryKey: ["orders", { limit }],
    queryFn: () => unwrap(api.GET("/api/v1/orders", { params: { query: { limit } } })),
  });
}
