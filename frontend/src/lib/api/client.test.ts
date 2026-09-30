import { describe, expect, it } from "vitest";
import { ApiError, createApi, unwrap } from "./client";

function apiReturning(status: number, body: unknown) {
  return createApi("http://test", async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

describe("api client", () => {
  it("returns typed data on success", async () => {
    const health = await unwrap(apiReturning(200, { status: "ok", database: "ok" }).GET("/api/v1/health"));
    expect(health).toEqual({ status: "ok", database: "ok" });
  });

  it("throws ApiError parsed from the backend error envelope", async () => {
    const api = apiReturning(409, { error: { code: "insufficient_stock", message: "Only 1 left", details: null } });
    const request = unwrap(
      api.POST("/api/v1/carts/{cart_id}/checkout", { params: { path: { cart_id: "c1" } }, body: { method: "cash" } }),
    );
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({ status: 409, code: "insufficient_stock", message: "Only 1 left" });
  });
});
