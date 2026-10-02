import { expect, test } from "@playwright/test";
import { apiRequest, openApp, requireCredentials } from "./helpers.js";

const lidarrArtist = { mbid: "69158f97-4c07-4c4e-baf8-4e4ab1ed666e", name: "Boards of Canada" };

requireCredentials();

const lookupArtist = async (page, mbid) =>
  (await apiRequest(page, `/api/library/lookup/${mbid}`)).body;

async function tabTo(page, locator) {
  for (let step = 0; step < 120; step += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Keyboard focus never reached the library menu");
}

test("a connected user adds an artist to Lidarr, then changes its monitoring from the keyboard", async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect(
    (await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}`)).status,
    `${lidarrArtist.name} must start outside the library; use a fresh candidate database`,
  ).toBe(404);

  try {
    await page.goto(`/artist/${lidarrArtist.mbid}`);
    await expect(page.getByRole("heading", { name: lidarrArtist.name, level: 1 })).toBeVisible({ timeout: 30_000 });
    const actionBar = page.locator(".artist-action-bar");
    await expect(actionBar.getByRole("button", { name: /^Monitoring: / })).toHaveCount(0);
    await actionBar.getByRole("button", { name: "Add to Lidarr", exact: true }).click();
    await page.getByRole("menuitem", { name: "Add without monitoring", exact: true }).click();
    const menuTrigger = actionBar.getByRole("button", { name: "In library. Lidarr monitoring: None", exact: true });
    await expect(menuTrigger).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 }).toBe(true);
    const monitoring = await apiRequest(page, `/api/library/artists/${lidarrArtist.mbid}/monitoring`);
    expect(monitoring.body).toMatchObject({ manager: "lidarr", added: true, monitorOption: "none" });

    await expect(menuTrigger).toHaveAttribute("aria-haspopup", "menu");
    await page.locator("body").focus();
    await tabTo(page, menuTrigger);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Library" });
    await expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("menuitem", { name: "Remove from Lidarr", exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuTrigger).toBeFocused();

    await menuTrigger.click();
    await menu.getByRole("menuitem", { name: "Monitor: None", exact: true }).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(7);
    await page.getByRole("menuitemradio", { name: "Future albums", exact: true }).click();
    await expect(actionBar.getByRole("button", { name: "In library. Lidarr monitoring: Future albums" }))
      .toBeVisible({ timeout: 60_000 });
  } finally {
    if ((await lookupArtist(page, lidarrArtist.mbid))?.exists) {
      const response = await apiRequest(
        page,
        `/api/library/artists/${lidarrArtist.mbid}?deleteFiles=false`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      await expect
        .poll(async () => (await lookupArtist(page, lidarrArtist.mbid))?.exists, { timeout: 30_000 })
        .toBe(false);
    }
  }
});
