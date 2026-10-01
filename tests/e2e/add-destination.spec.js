import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

const lidarrArtist = { mbid: "69158f97-4c07-4c4e-baf8-4e4ab1ed666e", name: "Boards of Canada" };
const aurralArtist = { mbid: "f22942a1-6f70-4f48-866e-238cb2308fbd", name: "Aphex Twin" };

requireCredentials();

const lookupArtist = async (page, mbid) =>
  (await apiRequest(page, `/api/library/lookup/${mbid}`)).body;

async function tabTo(page, locator) {
  for (let step = 0; step < 120; step += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard focus never reached the Add to… menu");
}

test("a connected user adds to Lidarr, then adds to Aurral from the keyboard", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);

  const ownerBefore = await apiRequest(page, "/api/users/me/library-owner");
  expect(ownerBefore.ok).toBe(true);
  for (const artist of [lidarrArtist, aurralArtist]) {
    expect(
      (await apiRequest(page, `/api/library/artists/${artist.mbid}`)).status,
      `${artist.name} must start outside the library; use a fresh candidate database`,
    ).toBe(404);
  }

  try {
    await page.goto(`/artist/${lidarrArtist.mbid}`);
    await expect(page.getByRole("heading", { name: lidarrArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.locator(".artist-action-bar").getByRole("button", { name: "Add to…", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add to Lidarr", exact: true }).click();
    await expect(page.getByRole("button", { name: /In library/ })).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 }).toBe(true);
    const lidarrRecord = await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}`);
    expect(lidarrRecord.status).toBe(200);
    expect(lidarrRecord.body?.managedBy).not.toBe("aurral");

    await page.goto(`/artist/${aurralArtist.mbid}`);
    await expect(page.getByRole("heading", { name: aurralArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const menuTrigger = page.locator(".artist-action-bar").getByRole("button", { name: "Add to…", exact: true });
    await expect(menuTrigger).toBeVisible({ timeout: 30_000 });
    await expect(menuTrigger).toBeEnabled();
    await expect(menuTrigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "false");

    await page.locator("body").focus();
    await tabTo(page, menuTrigger);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Add to…" });
    const aurralItem = menu.getByRole("menuitem", { name: "Add to Aurral" });
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem", { name: "Add to Lidarr", exact: true })).toBeFocused();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(menuTrigger).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(aurralItem).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /In library/ })).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => (await apiRequest(page, `/api/library/artists/${aurralArtist.mbid}`)).body?.managedBy, {
        timeout: 15_000,
      })
      .toBe("aurral");
    const ownerAfter = await apiRequest(page, "/api/users/me/library-owner");
    expect(ownerAfter.body).toEqual(ownerBefore.body);
  } finally {
    for (const artist of [lidarrArtist, aurralArtist]) {
      if (!(await lookupArtist(page, artist.mbid))?.exists) continue;
      const response = await apiRequest(
        page,
        `/api/library/artists/${artist.mbid}?deleteFiles=false`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      await expect
        .poll(async () => (await lookupArtist(page, artist.mbid))?.exists, { timeout: 30_000 })
        .toBe(false);
    }
  }
});
