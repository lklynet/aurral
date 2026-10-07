import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });

test("turning off a flow warns that its songs are removed", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("auth_token", "fixture-token"));
  const writes = [];
  await page.routeWebSocket("**/ws**", (socket) => socket.close());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const json = (body) => route.fulfill({ json: body });
    if (path === "/health/bootstrap") return json({ authRequired: false, onboardingRequired: false });
    if (path === "/auth/me") return json({ user: { id: 1, username: "test", role: "admin" } });
    if (path === "/health") return json({ setupComplete: true, lidarrConfigured: false });
    if (path === "/playlists/status") return json({ flows: [{ id: "fixture-flow", name: "Nightly mix", enabled: true, size: 20 }] });
    if (request.method() !== "GET") writes.push({ path, method: request.method() });
    return json({});
  });
  await page.goto("/flows");
  const toggle = page.getByRole("switch", { name: "Nightly mix on" });
  await toggle.click();
  const dialog = page.getByRole("alertdialog", { name: "Turn off Nightly mix?" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("flow-disable-confirmation.png") });
  await expect(dialog).toContainText("It stops updating and its current songs are removed. Turning it back on picks a fresh set.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeChecked();
  expect(writes).toEqual([]);
});
