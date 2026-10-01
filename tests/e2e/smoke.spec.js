import { expect, test } from "@playwright/test";
import { assertSafeCredentialTransport, credentials, requireCredentials } from "./helpers.js";

requireCredentials();

test.use({ storageState: { cookies: [], origins: [] } });

test("health, login, and authenticated navigation work", async ({ page }) => {
  const health = await page.request.get("/api/health/live");
  expect(health.ok()).toBe(true);

  await page.goto("/");
  assertSafeCredentialTransport(page.url());
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByLabel("Primary navigation")).toBeVisible();
  await expect(page.getByRole("link", { name: "Discover", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Library", exact: true })).toBeVisible();

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  await expect(page).toHaveTitle(/Settings/);
});

test("sign-in explains a rate limit instead of reporting bad credentials", async ({ page }) => {
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ status: 429, contentType: "text/plain", body: "Too many requests, please try again later." }));
  await page.goto("/");
  await page.getByLabel("Username").fill("rate-limited-user");
  await page.getByLabel("Password").fill("not-checked");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Too many sign-in attempts. Wait a few minutes, then try again.");
});
