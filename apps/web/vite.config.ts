import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In dev the UI is served by Vite and API calls are proxied to the control
    // plane. In production both are served from the same origin by the control
    // plane itself, so no CORS handling exists anywhere.
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  build: {
    // Build straight into the control plane's static directory, so that
    // `pnpm build && pnpm --filter @justpostgres/control-plane start` serves
    // the real thing without any copying.
    outDir: "../control-plane/public",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
