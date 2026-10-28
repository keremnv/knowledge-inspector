import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    proxy: {
      // Only API reads are proxied; /source itself serves the application.
      "/source/v1": {
        target: process.env.VITE_SOURCE_TARGET ?? "http://127.0.0.1:8159",
        changeOrigin: true,
      },
      // The explicit /world page stays on Vite, including source-first builds.
      "/world/": {
        target: process.env.VITE_WORLD_TARGET ?? "http://127.0.0.1:8139",
        changeOrigin: true,
      },
      // API reads only: the /sqlite page itself must serve index.html.
      "/sqlite/schema": {
        target:
          process.env.VITE_SQLITE_TARGET ??
          process.env.VITE_WORLD_TARGET ??
          "http://127.0.0.1:8139",
        changeOrigin: true,
      },
      "/sqlite/rows": {
        target:
          process.env.VITE_SQLITE_TARGET ??
          process.env.VITE_WORLD_TARGET ??
          "http://127.0.0.1:8139",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
