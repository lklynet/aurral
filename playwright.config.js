import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH } from "./tests/e2e/global-setup.js";

if (existsSync("backend/.env")) process.loadEnvFile("backend/.env");

const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.js",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["line"],
    [
      "html",
      {
        outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || "playwright-report",
        open: "never",
      },
    ],
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE || `${outputDir}/results.json` }],
  ],
  use: {
    baseURL: process.env.AURRAL_BASE_URL || `http://127.0.0.1:${process.env.AURRAL_DEV_WEB_PORT || 3017}`,
    storageState: AUTH_STATE_PATH,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
    ...devices["Desktop Chrome"],
  },
  outputDir,
});
