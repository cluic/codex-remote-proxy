import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  outputDir: resolve(import.meta.dirname, "../output/playwright/task11"),
  preserveOutput: "always",
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 }
      }
    }
  ]
});
