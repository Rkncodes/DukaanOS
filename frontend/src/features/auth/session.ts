import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, unwrap, type Schemas } from "../../lib/api/client";

export const SESSION_KEY = ["session"] as const;

export type Session = Schemas["SessionRead"];

/** Current user + merchant, or null when logged out. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async (): Promise<Session | null> => {
      try {
        return await unwrap(api.GET("/api/v1/auth/me"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["LoginRequest"]) => unwrap(api.POST("/api/v1/auth/login", { body })),
    onSuccess: (session) => qc.setQueryData(SESSION_KEY, session),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["RegisterRequest"]) => unwrap(api.POST("/api/v1/auth/register", { body })),
    onSuccess: (session) => qc.setQueryData(SESSION_KEY, session),
  });
}

/** Store-profile fields the owner can change after registration (today: just the GSTIN). */
export function useUpdateMerchant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["MerchantUpdate"]) => unwrap(api.PATCH("/api/v1/auth/merchant", { body })),
    onSuccess: (merchant) => qc.setQueryData(SESSION_KEY, (session: Session | null) => (session ? { ...session, merchant } : session)),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/auth/logout")),
    onSuccess: () => {
      // The backend has dropped the session cookie. End the session on the very query the route guards
      // watch (clearing the cache instead would detach them, and the page would stay as it was), ...
      qc.setQueryData(SESSION_KEY, null);
      // ... then forget this merchant's data, so the next login on this device starts empty.
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
    },
  });
}
