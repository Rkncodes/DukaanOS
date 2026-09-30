import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev: the HTTP-only session cookie just works, no CORS.
    proxy: { "/api": "http://localhost:8000" },
  },
  test: { environment: "node" },
});
