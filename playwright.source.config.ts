import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// A separate port allows source development without reloading baseline World
// tests. This configuration also exercises the explicit source-first entry.
process.env.KI_SOURCE_VITE_PORT = "8147";
process.env.KI_SOURCE_ENTRY = "1";
export default defineConfig({
  ...base,
  testMatch: /\/source-[^/]+\.spec\.ts$/,
  use: { ...base.use, baseURL: "http://127.0.0.1:8147" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8147 --strictPort",
    url: "http://127.0.0.1:8147",
    env: { VITE_INSPECTOR_ENTRY: "source" },
    reuseExistingServer: false,
  },
});
