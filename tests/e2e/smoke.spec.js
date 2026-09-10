import { isIP } from "node:net";
import { expect, test } from "@playwright/test";

const username = String(process.env.AUTH_USER || "").trim();
const password = String(process.env.AUTH_PASSWORD || "");

test.beforeAll(() => {
  if (!username || !password) {
    throw new Error("AUTH_USER and AUTH_PASSWORD are required for the full browser suite");
  }
});

test("health, login, and authenticated navigation work", async ({ page }) => {
  const health = await page.request.get("/api/health/live");
  expect(health.ok()).toBe(true);

  await page.goto("/");
  const signInUrl = new URL(page.url());
  const hostname = signInUrl.hostname.replace(/^\[|\]$/g, "");
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
  if (signInUrl.protocol !== "https:" && !isLoopback) {
    throw new Error("Refusing to submit test credentials over insecure transport");
  }
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByLabel("Primary navigation")).toBeVisible();
  await expect(page.getByRole("link", { name: "Discover", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Library", exact: true })).toBeVisible();

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings/);
  await expect(page).toHaveTitle(/Settings/);
});
