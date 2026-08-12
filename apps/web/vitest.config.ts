import path from "node:path";
import { defineConfig } from "vitest/config";

// Minimal test config (mirrors apps/renderer's plain `vitest run` setup):
// pure-logic tests only, so plain node — no jsdom, no React plugins. Having
// this file also stops vitest from loading vite.config.ts (dev-server proxy,
// tailwind) for tests.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
