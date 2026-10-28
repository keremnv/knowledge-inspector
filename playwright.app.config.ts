import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The local application (owner decision O19), end to end: `bin/ki open`
// serves the built frontend and the Source API from one loopback origin.
// No webServer here on purpose: nothing but the launcher serves the page.
export default defineConfig({
  ...base,
  testMatch: /\.app\.ts$/,
  webServer: undefined,
  use: { ...base.use, baseURL: undefined },
});
