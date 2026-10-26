import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["app/**/__tests__/**/*.test.{ts,tsx}"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "."),
    },
  },
});
