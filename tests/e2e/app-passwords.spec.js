import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

requireCredentials();
test.use({ trace: "off", screenshot: "off", video: "off" });

const layouts = [
  {
    viewport: { width: 1280, height: 800 },
    navigation: "Primary navigation",
    trigger: (page) => page.getByRole("button", { name: "User menu" }),
    entry: (page) => page.getByRole("menuitem", { name: "Connect an app" }),
  },
  {
    viewport: { width: 390, height: 844 },
    navigation: "Mobile navigation",
    trigger: (page) => page.getByRole("button", { name: "More navigation options" }),
    entry: (page) => page.getByRole("dialog", { name: "More navigation options" }).getByRole("button", { name: "Connect an app" }),
  },
];

for (const { viewport, navigation, trigger, entry } of layouts) {
  test(`connect and revoke an app at ${viewport.width}px`, async ({ page }, testInfo) => {
    const openConnect = async () => {
      await trigger(page).click();
      await entry(page).click();
    };
    await page.setViewportSize(viewport);
    await openApp(page, navigation);
    await openConnect();
    const dialog = page.getByRole("dialog", { name: "Connect an app" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Device name")).toBeFocused();
    const screenshot = testInfo.outputPath(`connect-app-${viewport.width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Connect an app form", { path: screenshot, contentType: "image/png" });
    const name = `Browser device ${viewport.width} ${Date.now()}`;
    let created;
    try {
      await dialog.getByLabel("Device name").fill(name);
      await dialog.getByLabel("Server address").fill("https://music.example.test");
      const response = page.waitForResponse((result) => result.url().endsWith("/api/auth/app-passwords") && result.request().method() === "POST");
      await dialog.getByRole("button", { name: "Create app password" }).click();
      const result = await response;
      expect(result.status()).toBe(201);
      created = await result.json();
      await expect(dialog.getByRole("img", { name: "Scan this QR code in the Aurral app to sign in" })).toBeVisible();
      const createdScreenshot = testInfo.outputPath(`connect-app-created-${viewport.width}.png`);
      await page.screenshot({ path: createdScreenshot });
      await testInfo.attach("App password created", { path: createdScreenshot, contentType: "image/png" });
      expect(Boolean(await dialog.getByLabel("App password").inputValue())).toBe(true);
      expect((await page.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${created.secret}` } })).status()).toBe(200);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(trigger(page)).toBeFocused();
      await openConnect();
      await expect(dialog.getByLabel("App password")).toHaveCount(0);
      const device = dialog.getByRole("listitem").filter({ hasText: name });
      await expect(device).toBeVisible();
      await device.getByRole("button", { name: `Revoke ${name}` }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Revoke device" }).click();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(dialog.getByRole("heading", { name: "Connected devices" })).toBeVisible();
      await expect(device).toHaveCount(0);
      expect((await page.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${created.secret}` } })).status()).toBe(401);
      created = null;
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      if (created) await apiRequest(page, `/api/auth/app-passwords/${created.device.id}`, { method: "DELETE" });
    }
  });
}
