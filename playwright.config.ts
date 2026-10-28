import { defineConfig } from "@playwright/test";
import { freemem } from "node:os";

/**
 * Parallel browsers, bounded by memory. A worker is a Chromium and, for live
 * tests, a Python source server: about 0.8–0.9 GB at peak (Source suite at 4
 * workers, 2026-10-24: available memory fell from 6.1 GB to 3.0 GB). Leave
 * 1.5 GB for everything else on the machine; never fewer than the 2 this ran
 * with before, never more than 4. `KI_TEST_WORKERS` overrides.
 */
const PER_WORKER_MB = 900, RESERVE_MB = 1500;
const fits = Math.floor((freemem() / 2 ** 20 - RESERVE_MB) / PER_WORKER_MB);
const workers = Number(process.env.KI_TEST_WORKERS) || Math.min(4, Math.max(2, fits));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers,
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: "http://127.0.0.1:8143",
    viewport: { width: 1440, height: 1000 },
    reducedMotion: process.env.KI_MOTION === "ordinary" ? "no-preference" : "reduce",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 8143 --strictPort",
    url: "http://127.0.0.1:8143",
    reuseExistingServer: false,
  },
});
