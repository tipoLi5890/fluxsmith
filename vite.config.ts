// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Tauri webview build. No external network at runtime: everything is bundled.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Optional telemetry peer of a provider SDK inside pi-ai; stubbed (zero telemetry).
      "@opentelemetry/api": fileURLToPath(new URL("./src/shims/otel-api.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: false },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: ["es2022", "safari16"],
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
  },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"] },
});
