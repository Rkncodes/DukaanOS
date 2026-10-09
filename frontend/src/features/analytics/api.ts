import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../../lib/api/client";

export function useSalesTrend(days: number) {
  return useQuery({
    queryKey: ["analytics", "sales-trend", days],
    queryFn: () => unwrap(api.GET("/api/v1/analytics/sales-trend", { params: { query: { days } } })),
  });
}

export function useTopProducts(days: number, limit = 8) {
  return useQuery({
    queryKey: ["analytics", "top-products", days, limit],
    queryFn: () => unwrap(api.GET("/api/v1/analytics/top-products", { params: { query: { days, limit } } })),
  });
}

export function useTopCustomers(days: number, limit = 8) {
  return useQuery({
    queryKey: ["analytics", "top-customers", days, limit],
    queryFn: () => unwrap(api.GET("/api/v1/analytics/top-customers", { params: { query: { days, limit } } })),
  });
}

export function useCategoryBreakdown(days: number) {
  return useQuery({
    queryKey: ["analytics", "category-breakdown", days],
    queryFn: () => unwrap(api.GET("/api/v1/analytics/category-breakdown", { params: { query: { days } } })),
  });
}
