import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { AUTH_STATE_PATH } from "./tests/e2e/global-setup.js";

const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const labPublicTls = process.env.AURRAL_LAB_PUBLIC_TLS;
const labPublicHosts = labPublicTls
  ? JSON.parse(readFileSync(new URL("./tests/lab/services/public-hosts.json", import.meta.url), "utf8"))
  : [];

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
    baseURL: process.env.AURRAL_BASE_URL || "http://127.0.0.1:3017",
    storageState: AUTH_STATE_PATH,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
    ...devices["Desktop Chrome"],
    ...(labPublicTls
      ? {
          ignoreHTTPSErrors: true,
          launchOptions: { args: [`--host-rules=${labPublicHosts.map((host) => `MAP ${host} ${labPublicTls}`).join(",")}`] },
        }
      : {}),
  },
  outputDir,
});
