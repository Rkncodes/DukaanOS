import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

/** Backend domain types, generated from FastAPI's OpenAPI schema (`npm run gen:api`). */
export type Schemas = components["schemas"];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Parses the backend envelope: {"error": {"code", "message", "details"}}. */
  static from(status: number, body: unknown): ApiError {
    const err = (body as { error?: Partial<Schemas["ErrorBody"]> } | undefined)?.error;
    return new ApiError(status, err?.code ?? "http_error", err?.message ?? `Request failed (${status})`, err?.details);
  }
}

export function createApi(baseUrl = "", fetchImpl?: typeof fetch) {
  // credentials: "include" sends the HTTP-only session cookie.
  return createClient<paths>({ baseUrl, credentials: "include", fetch: fetchImpl });
}

export const api = createApi(import.meta.env.VITE_API_BASE_URL ?? "");

/** Turns an openapi-fetch result into data, or throws ApiError. */
export async function unwrap<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw ApiError.from(response.status, error);
  return data as T;
}
