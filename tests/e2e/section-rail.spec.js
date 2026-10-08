import { expect, test } from "@playwright/test";

test("the profile section rail previews, jumps to, and tracks sections", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/profile");
  const nextFrames = () =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const rail = page.getByRole("navigation", { name: "Profile sections" });
  const tick = (name) => rail.getByRole("button", { name, exact: true });
  await expect(tick("Appearance")).toHaveAttribute("aria-current", "location");
  await expect(tick("Listening history")).toBeVisible();
  await expect(tick("Discovery tastes")).toBeVisible();

  await tick("Listening history").hover();
  const card = page.locator(".section-rail__card");
  await expect(card).toContainText("Listening history");
  await expect(card).toContainText("Connect a service to personalize discovery.");
  await testInfo.attach("section-rail-hover", { body: await page.screenshot(), contentType: "image/png" });

  await tick("Connected accounts").click();
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeInViewport();
  await nextFrames();
  await expect(tick("Connected accounts")).toHaveAttribute("aria-current", "location");

  await page.evaluate(() => {
    const first = document.querySelector(".profile-settings__section");
    const inserted = first.cloneNode(false);
    inserted.innerHTML = '<h3 class="settings-page__section-title">Inserted section</h3>';
    first.before(inserted);
  });
  await expect(tick("Inserted section")).toBeVisible();
  await nextFrames();
  await expect(tick("Connected accounts")).toHaveAttribute("aria-current", "location");

  const secondToLast = rail.getByRole("button").nth(-2);
  const secondToLastName = await secondToLast.getAttribute("aria-label");
  await secondToLast.click();
  await expect(page.getByRole("heading", { name: secondToLastName, exact: true })).toBeInViewport();
  await nextFrames();
  await expect(secondToLast).toHaveAttribute("aria-current", "location");

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(rail).toHaveCount(0);
});
