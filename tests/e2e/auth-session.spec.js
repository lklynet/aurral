import { expect, test } from "@playwright/test";
import { openApp, requireCredentials } from "./helpers.js";

requireCredentials();

test("a signed-in session survives a temporary bootstrap failure", async ({ page }) => {
  await page.clock.install();
  await openApp(page);

  let failedBootstraps = 0;
  await page.route("**/api/health/bootstrap", (route) => {
    failedBootstraps += 1;
    return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
  });
  await page.clock.fastForward(30_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect.poll(() => failedBootstraps).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel("Primary navigation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
});
