import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../../lib/api/client";

export function useInsights(includeResolved = false) {
  return useQuery({
    queryKey: ["insights", { includeResolved }],
    queryFn: () => unwrap(api.GET("/api/v1/insights", { params: { query: { include_resolved: includeResolved } } })),
  });
}

export function useInsightSummary() {
  return useQuery({ queryKey: ["insights", "summary"], queryFn: () => unwrap(api.GET("/api/v1/insights/summary")) });
}

/** Snoozes, dismisses or resolves one insight by its stable key. Any staff member's action is visible to all. */
export function useActOnInsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...body }: { key: string } & Schemas["InsightActionIn"]) =>
      unwrap(api.POST("/api/v1/insights/{insight_key}/actions", { params: { path: { insight_key: key } }, body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insights"] }),
  });
}
